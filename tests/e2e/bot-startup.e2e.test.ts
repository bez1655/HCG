/**
 * ============================================================================
 * BOT STARTUP CONTRACT
 * ============================================================================
 *
 * These tests exist because of a real outage.
 *
 * bot/Dockerfile set NODE_ENV=production *before* `npm ci`, which makes npm
 * skip devDependencies. tsx lived there, and the container's start command was
 * `tsx src/index.ts`. The image therefore built successfully and only failed
 * once running:
 *
 *     sh: 1: tsx: not found
 *
 * Docker restarted it forever. Nothing in the test suite noticed, because the
 * bot e2e test runs the bot through a locally installed tsx — it never
 * exercised the command Docker actually uses.
 *
 * So these check the *startup contract* rather than behaviour:
 *
 *   1. the command in the Dockerfile is one the runtime image can actually run
 *   2. every runtime import resolves without dev tooling
 *   3. a failed launch exits non-zero, so a supervisor sees a failure instead
 *      of a clean stop it should restart
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BOT = path.join(ROOT, "bot");
const DIST = path.join(BOT, "dist");

let tmpData: string;

beforeAll(() => {
  tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-startup-"));

  // Compile exactly as the Dockerfile's builder stage does.
  //
  // Always, not only when dist/ is missing. Skipping the build when the
  // directory already exists means testing whatever was compiled last time:
  // a change to src/ then runs against stale output, and the suite either
  // passes on code that no longer exists or hangs on behaviour that was
  // already fixed. Both happened. A rebuild costs a couple of seconds.
  execFileSync("npm", ["run", "build"], { cwd: BOT, stdio: "ignore" });
}, 120_000);

afterAll(() => {
  if (tmpData) fs.rmSync(tmpData, { recursive: true, force: true });

  // NOTE: bot/dist is deliberately NOT removed.
  //
  // It is shared state: bot.e2e.test.ts runs the bot from the same checkout,
  // and deleting the directory here raced with that suite — each file passed
  // alone and the pair failed together. Leaving the build artefact in place
  // costs nothing and keeps the suites independent.
});

describe("Dockerfile and package.json agree", () => {
  const dockerfile = () => fs.readFileSync(path.join(BOT, "Dockerfile"), "utf-8");

  it("does not set NODE_ENV=production before installing build dependencies", () => {
    // The exact mistake that caused the outage: with NODE_ENV=production set
    // beforehand, `npm ci` silently skips devDependencies.
    const lines = dockerfile()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    const prodIdx = lines.findIndex((l) => /^ENV\s+NODE_ENV\s*=\s*production/.test(l));
    const fullInstall = lines.findIndex((l) => /npm ci(?!.*--omit=dev)/.test(l));

    if (prodIdx !== -1 && fullInstall !== -1) {
      // A full `npm ci` after NODE_ENV=production only works if dev deps are
      // requested explicitly.
      const cmd = lines[fullInstall];
      const explicit = /--include=dev/.test(cmd);
      const differentStage = lines
        .slice(0, fullInstall)
        .some((l, i) => i > prodIdx && /^FROM /.test(l));

      expect(
        explicit || differentStage || fullInstall < prodIdx,
        `"${cmd}" runs after ENV NODE_ENV=production and would skip devDependencies`
      ).toBe(true);
    }
  });

  it("starts a command that exists in the runtime image", () => {
    const df = dockerfile();
    const cmdMatch = df.match(/^CMD\s+(\[.*\]|.+)$/m);
    expect(cmdMatch, "Dockerfile has no CMD").toBeTruthy();

    const cmd = cmdMatch![1];
    const pkg = JSON.parse(fs.readFileSync(path.join(BOT, "package.json"), "utf-8"));
    const devDeps = Object.keys(pkg.devDependencies || {});

    // Resolve `npm start` to the underlying script.
    const effective = /npm.*start/.test(cmd) ? pkg.scripts?.start || "" : cmd;

    // The runtime stage installs with --omit=dev, so anything from
    // devDependencies is absent. Running it is the bug we are guarding against.
    for (const tool of devDeps) {
      const usesTool = new RegExp(`(^|[\\s"'\\[])${tool}([\\s"'\\]]|$)`).test(effective);
      expect(
        usesTool,
        `start command "${effective}" invokes "${tool}", which is a devDependency ` +
          `and is not installed in the runtime image`
      ).toBe(false);
    }
  });

  it("ships compiled output rather than TypeScript sources", () => {
    expect(fs.existsSync(path.join(DIST, "index.js"))).toBe(true);
  });
});

describe("startup is announced correctly", () => {
  const source = () => fs.readFileSync(path.join(BOT, "src", "index.ts"), "utf-8");

  it("does not report success from launch().then()", () => {
    // launch() resolves when polling STOPS, not when it starts: for a healthy
    // bot the promise stays pending forever. Announcing success from .then()
    // meant the log of a working bot was indistinguishable from a broken one.
    // Telegraf's onLaunch callback is the correct hook.
    const src = source();
    expect(/\.launch\(\s*\)\s*\.then\(/.test(src)).toBe(false);
    expect(/\.launch\(\s*\(\s*\)\s*=>/.test(src)).toBe(true);
  });

  it("gives the Telegram connection a deadline", () => {
    // A connection that is accepted and never answered (a firewall dropping
    // packets) raises no error, so without a timeout the bot hangs silently.
    expect(source()).toMatch(/CONNECT_TIMEOUT_MS/);
  });
});

describe("the compiled bot runs without dev tooling", () => {
  /**
   * Run the built entry point with a deliberately invalid token.
   *
   * A missing module or unresolved import fails immediately and differently
   * from a rejected token, so this distinguishes "cannot even load" from
   * "loaded fine, Telegram said no".
   */
  function runCompiled() {
    return spawnSync(process.execPath, [path.join(DIST, "index.js")], {
      cwd: BOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        TELEGRAM_BOT_TOKEN: "123456:E2E-FAKE-BOT-TOKEN-NOT-A-REAL-CREDENTIAL",
        INTERNAL_API_SECRET: "e2e-internal-secret-startup-contract-check",
        DATA_DIR: tmpData,
        TELEGRAM_API_ROOT: "http://127.0.0.1:1", // refused instantly
        // The bot waits for the harvester to supply a list before giving up,
        // which is the whole point of that rescue path — but here we are
        // asserting the exit contract, not the wait. Without this the run
        // blows past the 30 s test timeout.
        BOT_HARVEST_RESCUE_MS: "1000",
      },
      encoding: "utf-8",
      timeout: 30_000,
    });
  }

  it("loads every import at runtime", () => {
    const out = runCompiled();
    const all = `${out.stdout || ""}${out.stderr || ""}`;

    expect(all).not.toMatch(/Cannot find module/);
    expect(all).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(all).not.toMatch(/not found/);
  });

  it("exits non-zero when it cannot start", () => {
    // A launch failure used to be logged and then ignored; the process exited
    // 0, which a supervisor reads as a clean stop — hence a silent restart
    // loop with the cause scrolled out of view.
    const out = runCompiled();
    expect(out.status).toBe(1);
  });

  it("explains the failure in the last thing it prints", () => {
    // Формулировка зависит от того, на каком шаге всё оборвалось: пул прокси
    // отчитывается раньше, чем Telegraf успевает сообщить об отказе запуска.
    // Проверяем сам факт внятного объяснения, а не конкретный текст.
    const out = runCompiled();
    const all = `${out.stdout || ""}${out.stderr || ""}`;
    expect(all).toMatch(
      /БОТ НЕ СМОГ ЗАПУСТИТЬСЯ|НИ ОДИН ПРОКСИ НЕ РАБОТАЕТ|НЕТ ОТВЕТА ОТ TELEGRAM/
    );
  });
});
