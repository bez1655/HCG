/**
 * Outbound proxy for Telegram traffic.
 *
 * Some hosting providers cannot reach api.telegram.org at all: the TCP
 * connection is silently dropped and every request ends in `connect
 * ETIMEDOUT 149.154.x.x:443`. Nothing in the bot can fix that — the packets
 * never leave the network — so the only remedy is to route them through a
 * proxy that can.
 *
 * Configured with a single variable, TELEGRAM_PROXY, understanding the usual
 * URL forms:
 *
 *     socks5://user:pass@host:1080     (recommended: works with any protocol)
 *     socks5h://host:1080              (h = resolve DNS on the proxy side)
 *     http://user:pass@host:3128
 *     https://host:3128
 *
 * Absent or empty, the bot connects directly, exactly as before.
 */
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import https from "node:https";

/** Default agent: keep-alive, matching Telegraf's own default. */
export function directAgent(): https.Agent {
  return new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000 });
}

export interface ProxyChoice {
  agent: https.Agent;
  /** Safe for logs: scheme and host only, never credentials. */
  description: string;
}

/**
 * Build the agent Telegraf should use.
 *
 * A malformed URL is a configuration error worth failing on: silently falling
 * back to a direct connection would reproduce the very timeout the proxy was
 * added to avoid, and the operator would be none the wiser.
 */
export function buildTelegramAgent(proxyUrl: string | undefined): ProxyChoice {
  if (!proxyUrl || proxyUrl.trim() === "") {
    return { agent: directAgent(), description: "direct (no proxy)" };
  }

  const raw = proxyUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `TELEGRAM_PROXY is not a valid URL: "${raw}". ` +
        `Expected something like socks5://host:1080 or http://host:3128`
    );
  }

  // Credentials must never reach a log.
  const safe = `${parsed.protocol}//${parsed.hostname}:${parsed.port || "(default)"}`;
  const scheme = parsed.protocol.replace(":", "").toLowerCase();

  switch (scheme) {
    case "socks":
    case "socks4":
    case "socks5": {
      // Plain socks5:// resolves the hostname LOCALLY and sends the proxy an
      // IP address. Where Telegram is blocked, DNS for api.telegram.org is
      // often poisoned or blocked too, so that lookup fails before the proxy
      // is ever contacted — the proxy appears to do nothing at all.
      //
      // socks5h:// (the "h" means hostname) defers resolution to the proxy,
      // which is what is wanted in every case here. Upgrade silently and say
      // so, rather than handing the operator a proxy that quietly fails.
      const upgraded = raw.replace(/^socks5?:\/\//i, "socks5h://");
      return {
        agent: new SocksProxyAgent(upgraded),
        description: `SOCKS proxy ${safe} (DNS resolved by the proxy)`,
      };
    }
    case "socks4a":
    case "socks5h":
      return { agent: new SocksProxyAgent(raw), description: `SOCKS proxy ${safe}` };

    case "http":
    case "https":
      return { agent: new HttpsProxyAgent(raw), description: `HTTP proxy ${safe}` };

    default:
      throw new Error(
        `TELEGRAM_PROXY uses an unsupported scheme "${scheme}". ` +
          `Use socks5://, socks4://, http:// or https://`
      );
  }
}
