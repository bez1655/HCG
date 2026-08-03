/**
 * Outbound HTTP transport for Telegram calls made by the game server.
 *
 * The bot container got proxy support first, but the game server talks to
 * Telegram too — turn requests, prize announcements, registration alerts from
 * the web form — and it was still calling api.telegram.org directly. On a host
 * where Telegram is blocked the bot therefore worked while every notification
 * the server itself produced was silently swallowed.
 *
 * Node's global fetch (undici) cannot use a SOCKS proxy at all, and SOCKS is
 * what actually gets through in blocked networks. So requests here go through
 * node:https with an explicit agent — exactly the mechanism the bot uses, so
 * one TELEGRAM_PROXY value configures both containers identically.
 */
import https from "node:https";
import { URL } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { telegram as telegramConfig } from "../config/env";
import { createLogger, errorContext } from "../utils/logger";

const log = createLogger("Telegram");

let agent: https.Agent | undefined;
let resolved = false;

/**
 * Build the agent once.
 *
 * socks5:// is upgraded to socks5h:// so the PROXY resolves DNS: where
 * Telegram is blocked its DNS records usually are too, and a local lookup
 * fails before the proxy is ever contacted.
 */
function buildAgent(): https.Agent | undefined {
  const url = telegramConfig.proxyUrl;

  if (!url) {
    log.info("Telegram transport: direct connection");
    return new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000 });
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Never fall back silently: a typo would look exactly like the blocked
    // network this proxy was added to work around.
    log.error("TELEGRAM_PROXY is not a valid URL — notifications will not be sent");
    return undefined;
  }

  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  const safe = `${scheme}://${parsed.hostname}:${parsed.port || "(default)"}`;

  try {
    if (scheme.startsWith("socks")) {
      const upgraded = url.replace(/^socks5?:\/\//i, "socks5h://");
      log.info("Telegram transport: SOCKS proxy", { proxy: safe });
      return new SocksProxyAgent(upgraded) as unknown as https.Agent;
    }
    if (scheme === "http" || scheme === "https") {
      log.info("Telegram transport: HTTP proxy", { proxy: safe });
      return new HttpsProxyAgent(url) as unknown as https.Agent;
    }
  } catch (err) {
    log.error("Could not initialise the Telegram proxy", errorContext(err));
    return undefined;
  }

  log.error(`TELEGRAM_PROXY uses an unsupported scheme "${scheme}"`, { proxy: safe });
  return undefined;
}

function getAgent(): https.Agent | undefined {
  if (!resolved) {
    agent = buildAgent();
    resolved = true;
  }
  return agent;
}

export interface TelegramReply {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * POST a JSON payload to the Bot API.
 *
 * Always resolves: a failed notification must never take down a game action.
 * The timeout matters — a blocked network leaves the socket open indefinitely,
 * and without a deadline the pending request would leak on every event.
 */
export function callTelegram(
  token: string,
  method: string,
  payload: unknown,
  timeoutMs = 20_000
): Promise<TelegramReply> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/${method}`,
        method: "POST",
        agent: getAgent(),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, body: data })
        );
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => {
      resolve({ ok: false, status: 0, body: err.message });
    });

    req.write(body);
    req.end();
  });
}

/** Reset memoised state. Test-only. */
export function _resetTransport(): void {
  agent = undefined;
  resolved = false;
}
