#!/usr/bin/env node
/**
 * Secret scanner — last line of defence before a credential reaches Git.
 *
 * Runs in two modes:
 *   node scripts/check-secrets.mjs            → scan staged changes (pre-commit)
 *   node scripts/check-secrets.mjs --all      → scan the whole working tree (CI)
 *
 * Exits non-zero when a likely secret is found.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const scanAll = process.argv.includes("--all");

/** Patterns that indicate a real credential rather than a placeholder. */
const RULES = [
  { name: "Google/Firebase API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{32,}/ },
  { name: "Google OAuth client id", re: /\b\d+-[a-z0-9]{20,}\.apps\.googleusercontent\.com/ },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "Stripe live key", re: /\bsk_live_[0-9A-Za-z]{20,}/ },
  {
    name: "Generic assigned secret",
    re: /(?:password|passwd|secret|api[_-]?key|token|credential)\s*[:=]\s*["'`][^"'`\s${}<>]{8,}["'`]/i,
  },
];

/** Values that are obviously not real credentials. */
const ALLOWLIST = [
  /placeholder|example|dummy|sample|changeme|your[-_ ]|<your|my_|xxx+|\.\.\./i,
  /process\.env|import\.meta\.env|\$\{|:\?|:-/,
  /"password"|'password'|`password`/i, // JSON keys and type literals
  /test-(session|internal)-secret/, // fixtures in unit tests
  /e2e-(session|internal)-secret/, // fixtures in the end-to-end suite
  /E2eAdminPassword/, // throwaway password generated per e2e run
  // Bot tokens used only to sign test initData. They are not credentials:
  // the HMAC is computed and verified inside the same process, and no request
  // is ever made to api.telegram.org with them. The shape must stay realistic
  // ("<digits>:<rest>") because that is what the verifier is fed.
  /TEST-TOKEN-FOR-UNIT-TESTS|E2E-FAKE-BOT-TOKEN-NOT-A-REAL-CREDENTIAL/,
  /SOMEONE-ELSES-TOKEN|WRONG-TOKEN/, // negative fixtures: wrong-key signatures
  // The harvester's probe token. Deliberately invalid: it is sent to
  // api.telegram.org THROUGH UNTRUSTED THIRD-PARTY PROXIES to test whether a
  // route works, and the 401 that comes back is the success signal. Using the
  // real token here would hand it to every free proxy on the internet, which
  // is precisely what this constant exists to avoid.
  /0:HARVESTER-PROBE/,
];

/** Files that never contain live secrets. */
const SKIP_PATHS = [
  /^node_modules\//,
  /^dist\//,
  /^coverage\//,
  /^\.git\//,
  /package-lock\.json$/,
  /bun\.lock$/,
  /^scripts\/check-secrets\.mjs$/, // this file lists the patterns
  /^\.env\.example$/, // documented placeholders
  /^src\/utils\/security\.test\.ts$/, // deterministic test fixtures
  /^HCG-AUDIT\//,
];

const BINARY = /\.(png|jpe?g|gif|webp|mp4|mov|woff2?|ttf|eot|ico|pdf|zip|gz)$/i;

function inGitRepo() {
  try {
    execSync("git rev-parse --git-dir", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Recursive walk, used when the tree is not a git checkout (e.g. a release archive). */
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(process.cwd(), path.join(dir, entry.name));
    if (
      SKIP_PATHS.some((p) => p.test(rel)) ||
      /^(node_modules|\.git|dist|coverage)$/.test(entry.name)
    ) {
      continue;
    }
    if (entry.isDirectory()) walk(path.join(dir, entry.name), acc);
    else acc.push(rel);
  }
  return acc;
}

function listFiles() {
  if (!inGitRepo()) {
    if (!scanAll) {
      console.log("Not a git repository — nothing staged to scan.");
      process.exit(0);
    }
    return walk(process.cwd());
  }
  if (scanAll) {
    // Tracked files plus anything untracked and not ignored. Using
    // `git ls-files` alone missed new files that had not been added yet —
    // exactly the moment a leaked credential is most likely to appear.
    const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n");
    const untracked = execSync("git ls-files --others --exclude-standard", {
      encoding: "utf8",
    }).split("\n");
    return [...new Set([...tracked, ...untracked])].filter(Boolean);
  }
  return execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

const findings = [];

for (const file of listFiles()) {
  if (SKIP_PATHS.some((p) => p.test(file)) || BINARY.test(file)) continue;
  if (!fs.existsSync(file)) continue;

  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes("\u0000")) continue; // binary

  content.split("\n").forEach((line, i) => {
    if (ALLOWLIST.some((a) => a.test(line))) return;
    for (const rule of RULES) {
      const m = line.match(rule.re);
      if (m) {
        findings.push({
          file,
          line: i + 1,
          rule: rule.name,
          // Redacted preview: enough to locate, not enough to leak.
          preview: m[0].slice(0, 12) + "…",
        });
        break;
      }
    }
  });
}

if (findings.length > 0) {
  console.error("\n\x1b[41m\x1b[37m  POSSIBLE SECRET DETECTED — commit blocked  \x1b[0m\n");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}`);
    console.error(`    ${f.rule}: ${f.preview}\n`);
  }
  console.error("  Move the value into .env and read it via the config module.");
  console.error("  If this is a false positive, add an allowlist entry in");
  console.error("  scripts/check-secrets.mjs and explain why in the commit message.\n");
  process.exit(1);
}

console.log(`✅ No secrets detected (${scanAll ? "full tree" : "staged changes"}).`);
