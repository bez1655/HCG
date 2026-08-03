import { describe, it, expect } from "vitest";
import { buildTelegramAgent } from "./proxy";

describe("buildTelegramAgent", () => {
  it("connects directly when no proxy is configured", () => {
    for (const empty of [undefined, "", "   "]) {
      const choice = buildTelegramAgent(empty);
      expect(choice.description).toContain("direct");
      expect(choice.agent).toBeTruthy();
    }
  });

  it("upgrades socks5:// to socks5h:// so the proxy resolves DNS", () => {
    // Plain socks5:// resolves locally. Where Telegram is blocked, DNS for
    // api.telegram.org is usually blocked too, so the lookup fails before the
    // proxy is ever contacted and the proxy silently does nothing. Verified
    // against a real SOCKS server: socks5:// produced zero CONNECTs,
    // socks5h:// produced a successful one.
    const choice = buildTelegramAgent("socks5://10.0.0.5:1080");
    expect(choice.description).toContain("DNS resolved by the proxy");
  });

  it("accepts every supported scheme", () => {
    const schemes = [
      "socks://h:1080",
      "socks4://h:1080",
      "socks4a://h:1080",
      "socks5://h:1080",
      "socks5h://h:1080",
      "http://h:3128",
      "https://h:3128",
    ];
    for (const url of schemes) {
      expect(() => buildTelegramAgent(url), url).not.toThrow();
    }
  });

  it("never puts credentials in the description", () => {
    const choice = buildTelegramAgent("socks5://secretuser:secretpass@10.0.0.5:1080");
    expect(choice.description).not.toContain("secretuser");
    expect(choice.description).not.toContain("secretpass");
    expect(choice.description).toContain("10.0.0.5");
  });

  it("rejects a malformed URL instead of silently connecting directly", () => {
    // Falling back to a direct connection would reproduce the very timeout the
    // proxy was added to avoid, and hide the typo.
    expect(() => buildTelegramAgent("not a url")).toThrow(/not a valid URL/);
    expect(() => buildTelegramAgent("://broken")).toThrow(/not a valid URL/);
  });

  it("rejects an unsupported scheme", () => {
    expect(() => buildTelegramAgent("ftp://h:21")).toThrow(/unsupported scheme/);
  });
});
