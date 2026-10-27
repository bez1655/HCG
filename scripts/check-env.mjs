#!/usr/bin/env node
/**
 * .env sanity check.
 *
 * check-deployment.sh answers "is everything present?".
 * This answers a different and easier-to-get-wrong question: "is anything
 * present that should NOT be, or filled with a value that will misbehave?"
 *
 * Filling every variable in .env.example is a natural instinct, but several
 * of them are legacy or migration-only knobs that change runtime behaviour
 * when set.
 *
 *   npm run check-env
 *
 * Never prints a secret value — only lengths and fingerprints.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const ENV_PATH = path.resolve(process.cwd(), ".env");

let problems = 0;
let warnings = 0;

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m, hint) => {
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (hint) console.log(`      ${hint}`);
  problems++;
};
const warn = (m, hint) => {
  console.log(`  \x1b[33m!\x1b[0m ${m}`);
  if (hint) console.log(`      ${hint}`);
  warnings++;
};

if (!fs.existsSync(ENV_PATH)) {
  console.error(`\n.env not found at ${ENV_PATH}\n`);
  console.error("Create it with: npm run setup-env -- --password '<admin>'\n");
  process.exit(1);
}

// --- parse (same rules as src/config/env.ts) --------------------------------
const env = {};
for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq === -1) continue;
  const key = t.slice(0, eq).trim();
  let value = t.slice(eq + 1).trim();
  const q = value[0];
  if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1) {
    value = value.slice(1, -1);
  }
  env[key] = value;
}
const set = (k) => typeof env[k] === "string" && env[k].length > 0;
const fp = (v) => crypto.createHash("sha256").update(v).digest("hex").slice(0, 8);

console.log(`\nChecking ${ENV_PATH}\n`);

// --- 1. placeholders left in place ------------------------------------------
console.log("=== 1. Placeholder values ===");
const PLACEHOLDER =
  /^(MY_[A-Z_]+|<[^>]+>|your[-_ ]|changeme|xxx+|TODO|example|placeholder|\.\.\.)/i;
const leftovers = Object.entries(env).filter(([, v]) => v && PLACEHOLDER.test(v));
if (leftovers.length === 0) {
  ok("No placeholder values remain");
} else {
  for (const [k] of leftovers) {
    bad(`${k} still holds a placeholder`, "Replace it with a real value or leave it empty.");
  }
}

// --- 2. required secrets -----------------------------------------------------
console.log("\n=== 2. Required secrets ===");
for (const key of ["ADMIN_PASSWORD_HASH", "SESSION_SECRET", "INTERNAL_API_SECRET"]) {
  if (!set(key)) {
    bad(`${key} is empty — the server refuses to start in production`);
    continue;
  }
  ok(`${key} is set (sha256:${fp(env[key])})`);
}

if (set("ADMIN_PASSWORD_HASH") && !/^[0-9a-f]{32}:[0-9a-f]{64}$/.test(env.ADMIN_PASSWORD_HASH)) {
  bad(
    "ADMIN_PASSWORD_HASH is not a valid salt:hash pair",
    "It must be the PBKDF2 output, not the password itself. Regenerate: npm run hash-password -- '<password>'"
  );
}

for (const key of ["SESSION_SECRET", "INTERNAL_API_SECRET"]) {
  if (set(key) && env[key].length < 24) {
    warn(`${key} is short (${env[key].length} chars)`, "32+ random characters recommended.");
  }
}

// Reusing one value for several secrets defeats the point of separating them.
const pairs = [
  ["SESSION_SECRET", "INTERNAL_API_SECRET"],
  ["SESSION_SECRET", "ADMIN_PASSWORD_HASH"],
  ["INTERNAL_API_SECRET", "ADMIN_PASSWORD_HASH"],
];
for (const [a, b] of pairs) {
  if (set(a) && set(b) && env[a] === env[b]) {
    bad(`${a} and ${b} share the same value`, "Each must be independent.");
  }
}

// --- 3. variables that change behaviour when set -----------------------------
console.log("\n=== 3. Legacy and migration knobs ===");

if (set("LEGACY_AES_PASSWORD")) {
  warn(
    "LEGACY_AES_PASSWORD is set",
    "Only needed once, to migrate credentials written by a pre-hardening release.\n" +
      "      If this deployment never ran that version, remove the line: it makes the\n" +
      "      server attempt AES decryption of stored passwords on every boot."
  );
} else {
  ok("LEGACY_AES_PASSWORD is unset (correct for a fresh deployment)");
}

const clientSdkVars = [
  "FIREBASE_API_KEY",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_APP_ID",
  "FIREBASE_CONFIG",
];
const filledClient = clientSdkVars.filter(set);
if (filledClient.length > 0) {
  warn(
    `Legacy client-SDK values are set: ${filledClient.join(", ")}`,
    "Ignored since the server moved to the Admin SDK. Harmless, but you can delete\n" +
      "      these lines to keep .env honest about what actually matters."
  );
} else {
  ok("No legacy client-SDK values set");
}

if (set("GEMINI_API_KEY")) {
  warn(
    "GEMINI_API_KEY is set but nothing reads it",
    "The AI dependency was removed during the audit. Safe to delete the line."
  );
}

// --- 4. Firestore credentials ------------------------------------------------
console.log("\n=== 4. Firestore credentials ===");

const hasInline = set("FIREBASE_SERVICE_ACCOUNT");
const hasPath = set("GOOGLE_APPLICATION_CREDENTIALS");

if (!hasInline && !hasPath) {
  warn(
    "No service account configured",
    "Firestore stays disabled and state lives only on the container disk."
  );
} else if (hasInline && hasPath) {
  warn(
    "Both FIREBASE_SERVICE_ACCOUNT and GOOGLE_APPLICATION_CREDENTIALS are set",
    "FIREBASE_SERVICE_ACCOUNT wins. Remove the other to avoid pointing at two projects."
  );
}

let saProject = null;
if (hasInline) {
  try {
    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const missing = ["type", "project_id", "private_key", "client_email"].filter((k) => !sa[k]);
    if (missing.length) {
      bad(
        `Service account JSON is missing: ${missing.join(", ")}`,
        "Download the key from Project settings → Service accounts → Generate new private key."
      );
    } else if (sa.type !== "service_account") {
      bad(`Expected "type":"service_account", found "${sa.type}"`);
    } else {
      saProject = sa.project_id;
      ok(`Service account is valid (project: ${sa.project_id})`);
    }
  } catch {
    bad(
      "FIREBASE_SERVICE_ACCOUNT is not valid JSON",
      "It must be the key contents on ONE line, single-quoted. `npm run setup-env` does this for you."
    );
  }
  if (env.FIREBASE_SERVICE_ACCOUNT.includes("\n")) {
    bad("FIREBASE_SERVICE_ACCOUNT spans multiple lines", "Collapse it to a single line.");
  }
}

if (hasPath) {
  if (fs.existsSync(env.GOOGLE_APPLICATION_CREDENTIALS)) {
    ok(`Key file exists: ${env.GOOGLE_APPLICATION_CREDENTIALS}`);
  } else {
    // In Docker the path is inside the container, so this is not conclusive.
    warn(
      `Key file not found on this host: ${env.GOOGLE_APPLICATION_CREDENTIALS}`,
      "Expected when the path refers to a path inside the container — check the volume mount."
    );
  }
}

if (saProject && set("FIREBASE_PROJECT_ID") && env.FIREBASE_PROJECT_ID !== saProject) {
  bad(
    `FIREBASE_PROJECT_ID (${env.FIREBASE_PROJECT_ID}) differs from the key's project (${saProject})`,
    "Writes would target a different project than intended."
  );
}

if (!set("FIREBASE_FIRESTORE_DATABASE_ID")) {
  warn(
    "FIREBASE_FIRESTORE_DATABASE_ID is empty — the (default) database will be used",
    "If your data lives in a named database, existing state will not be found."
  );
} else {
  ok(`Firestore database: ${env.FIREBASE_FIRESTORE_DATABASE_ID}`);
}

// --- 5. deployment settings ---------------------------------------------------
console.log("\n=== 5. Deployment ===");

if (env.NODE_ENV !== "production") {
  warn(`NODE_ENV is "${env.NODE_ENV || "unset"}"`, 'Use "production" on a server.');
} else {
  ok("NODE_ENV=production");
}

if (!set("WEB_APP_URL")) {
  warn("WEB_APP_URL is empty", "The CORS allow-list will reject browser origins.");
} else if (!/^https?:\/\//.test(env.WEB_APP_URL)) {
  bad(`WEB_APP_URL must include the scheme: ${env.WEB_APP_URL}`);
} else {
  ok(`WEB_APP_URL=${env.WEB_APP_URL}`);
}

if (set("TELEGRAM_BOT_TOKEN")) {
  if (!/^\d{8,10}:[A-Za-z0-9_-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN)) {
    bad("TELEGRAM_BOT_TOKEN does not look like a BotFather token");
  } else {
    ok(`TELEGRAM_BOT_TOKEN is set (sha256:${fp(env.TELEGRAM_BOT_TOKEN)})`);
  }
  if (!set("TELEGRAM_ADMIN_USERNAME")) {
    bad(
      "TELEGRAM_ADMIN_USERNAME is empty while a bot token is set",
      "Registration and turn requests would have nobody to notify."
    );
  } else if (!env.TELEGRAM_ADMIN_USERNAME.startsWith("@")) {
    warn(`TELEGRAM_ADMIN_USERNAME should start with "@": ${env.TELEGRAM_ADMIN_USERNAME}`);
  } else {
    ok(`Administrator: ${env.TELEGRAM_ADMIN_USERNAME}`);
  }
} else {
  warn("TELEGRAM_BOT_TOKEN is empty — Telegram features stay off");
}

// --- 6. file hygiene ----------------------------------------------------------
console.log("\n=== 6. File hygiene ===");
try {
  const mode = (fs.statSync(ENV_PATH).mode & 0o777).toString(8);
  if (mode === "600") {
    ok(".env permissions are 600");
  } else {
    warn(`.env permissions are ${mode}`, "Tighten with: chmod 600 .env");
  }
} catch {
  /* stat is best-effort */
}

console.log("\n─────────────────────────────────────────");
if (problems > 0) {
  console.log(`\x1b[31m ${problems} problem(s)\x1b[0m, ${warnings} warning(s)\n`);
  process.exit(1);
}
console.log(`\x1b[32m .env looks good\x1b[0m (${warnings} warning(s))\n`);
console.log(" Next:  bash scripts/check-deployment.sh\n");
