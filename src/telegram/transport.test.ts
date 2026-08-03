import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Guards the rule that cost two rounds of debugging: the game server sends to
 * Telegram just as much as the bot does, so every place that reaches
 * api.telegram.org must go through the shared transport.
 *
 * The failure mode is invisible — global fetch() to a blocked host simply
 * never resolves, and the notification disappears without an error. Turn
 * requests were lost exactly this way while the bot looked perfectly healthy.
 */
const SRC = path.resolve(__dirname, "..");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe("Telegram traffic uses the shared transport", () => {
  it("never calls api.telegram.org through global fetch", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf-8");
      // transport.ts is the one place allowed to name the host.
      if (file.endsWith(path.join("telegram", "transport.ts"))) continue;

      for (const [i, line] of text.split("\n").entries()) {
        if (/fetch\s*\(/.test(line) && /api\.telegram\.org/.test(line)) {
          offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
        }
      }
    }

    expect(
      offenders,
      `these call Telegram directly and will silently drop every message on a ` +
        `host that needs a proxy: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("keeps the server and the bot on the same proxy variable", () => {
    // One TELEGRAM_PROXY must configure both containers. Two names, or a
    // variable wired to only one service, reproduces the original bug: the
    // bot answers /start while in-game notifications vanish.
    const compose = fs.readFileSync(path.resolve(SRC, "..", "docker-compose.yml"), "utf-8");
    const occurrences = compose.match(/TELEGRAM_PROXY/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("reads the proxy from the central config module", () => {
    const env = fs.readFileSync(path.join(SRC, "config", "env.ts"), "utf-8");
    expect(env).toMatch(/proxyUrl:\s*optional\("TELEGRAM_PROXY"\)/);
  });
});
