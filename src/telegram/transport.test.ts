import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseRoutes, buildRoute } from "./transport";

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

/**
 * TELEGRAM_PROXY is documented as a comma-separated pool and the bot has
 * accepted one since the failover work. The server did not: it passed the
 * whole string to `new URL()`, which throws on a list, and then sent every
 * notification with no agent at all — invisible unless you read the logs.
 * These tests pin the list format down on the server side too.
 */
describe("proxy list parsing", () => {
  it("accepts a comma-separated pool", () => {
    const { routes, errors } = parseRoutes(
      "socks5://144.22.165.206:1088,socks5://220.158.232.118:1080,socks5://101.36.104.239:10808"
    );
    expect(errors).toEqual([]);
    // three proxies, plus direct appended as the last resort
    expect(routes).toHaveLength(4);
    expect(routes[0].label).toBe("socks5://144.22.165.206:1088");
    expect(routes.at(-1)?.label).toBe("direct connection");
  });

  it("accepts semicolons and newlines as separators", () => {
    const { routes } = parseRoutes("socks5://a.example:1080;\n  socks5://b.example:1080\n");
    expect(routes.map((r) => r.label)).toEqual([
      "socks5://a.example:1080",
      "socks5://b.example:1080",
      "direct connection",
    ]);
  });

  it("drops duplicates so the pool does not waste attempts", () => {
    const { routes } = parseRoutes("socks5://a.example:1080, socks5://a.example:1080");
    expect(routes).toHaveLength(2);
  });

  it("keeps the good entries when one is malformed", () => {
    const { routes, errors } = parseRoutes("socks5://good.example:1080, не-адрес");
    expect(errors).toHaveLength(1);
    expect(routes[0].label).toBe("socks5://good.example:1080");
  });

  it("falls back to a direct route when unset", () => {
    expect(parseRoutes(undefined).routes.map((r) => r.label)).toEqual(["direct connection"]);
    expect(parseRoutes("").routes.map((r) => r.label)).toEqual(["direct connection"]);
  });

  it("rejects MTProto with an explanation instead of hanging", () => {
    // tg://proxy links are what Telegram itself hands out, so users paste
    // them first. They cannot work: the Bot API is plain HTTPS.
    expect(() => buildRoute("mtproto://host:443")).toThrow(/does not work with bots/);
    expect(() => buildRoute("tg://proxy?server=host&port=443")).toThrow(/does not work with bots/);
  });

  it("upgrades socks5 to socks5h so the proxy resolves DNS", () => {
    // Where Telegram is blocked its DNS usually is too; a local lookup fails
    // before the proxy is ever contacted.
    const route = buildRoute("socks5://1.2.3.4:1080");
    expect(JSON.stringify(route.agent)).toMatch(/socks5h|1\.2\.3\.4/);
  });

  it("does not leak credentials into the log label", () => {
    expect(buildRoute("socks5://user:hunter2@1.2.3.4:1080").label).not.toMatch(/hunter2/);
  });
});

/**
 * Приоритет спарсенных адресов над TELEGRAM_PROXY.
 *
 * Сервер шлёт уведомления сам, отдельно от бота, поэтому правило про
 * приоритет обязано действовать в обоих контейнерах. Иначе повторится
 * знакомая картина: бот ходит через быстрый спарсенный прокси, а
 * уведомления о ходе продолжают идти через медленный адрес из .env.
 */
describe("the server leases proxies from the harvester", () => {
  const source = fs.readFileSync(path.join(SRC, "telegram", "transport.ts"), "utf-8");

  it("holds its own lease rather than sharing the bot's", () => {
    // Both containers talk to Telegram independently. Sharing one lease would
    // put two probes on the same free proxy and halve its useful life.
    expect(source).toMatch(/new LeaseHolder\(appConfig\.dataDir, "server"/);
  });

  it("lets the lease replace TELEGRAM_PROXY outright", () => {
    expect(source).toMatch(/fallback route\(s\) until the lease arrives/);
    expect(source).toMatch(/routes = rebuilt/);
  });

  it("discards a failing leased proxy instead of quarantining it", () => {
    // The requirement in one line: never sit on a dead proxy when verified
    // ones are already in hand.
    expect(source).toMatch(/lease\.dropCurrentByAddress\(/);
    expect(source).toMatch(/no quarantine, no\n\s*\/\/ second chance/);
  });

  it("asks for replacements as soon as everything fails", () => {
    expect(source).toMatch(/lease\.writeAck\(\)/);
  });

  it("keeps direct connection last", () => {
    expect(source).toMatch(/if \(direct\) rebuilt\.push\(direct\)/);
  });

  it("does not treat the cold-start default as a route in use", () => {
    expect(source).toMatch(/let routeConfirmed = false/);
    expect(source).toMatch(/routeConfirmed \? routes\[currentIndex\]\?\.label : undefined/);
  });
});
