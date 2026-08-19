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
 *
 * TELEGRAM_PROXY holds a LIST, not a single address. That is not cosmetic:
 * the bot already accepted a comma-separated pool, and this module used to
 * hand the whole string to `new URL()`. A list therefore threw "Invalid URL"
 * and the server fell back to sending nothing at all — the exact silent
 * failure the shared transport exists to prevent. Free public proxies die
 * within hours, so a single address is not a realistic configuration.
 */
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { telegram as telegramConfig, app as appConfig } from "../config/env";
import { LeaseHolder, leaseUrl } from "./leaseClient";
import { createLogger, errorContext } from "../utils/logger";

const log = createLogger("Telegram");

interface Route {
  /** Safe for logs: scheme, host, port. Never the password. */
  label: string;
  agent: https.Agent | undefined;
  /** Consecutive failures, drives the quarantine backoff. */
  failures: number;
  /** Epoch ms before which this route is not retried. */
  quarantineUntil: number;
}

/** 30 s, 2 min, 8 min, capped at 30 min — a dead proxy must not spin. */
function quarantineMs(failures: number): number {
  return Math.min(30_000 * Math.pow(4, Math.max(0, failures - 1)), 30 * 60_000);
}

function directRoute(): Route {
  return {
    label: "direct connection",
    agent: new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000 }),
    failures: 0,
    quarantineUntil: 0,
  };
}

/**
 * Turn one configured address into a route.
 *
 * socks5:// is upgraded to socks5h:// so the PROXY resolves DNS: where
 * Telegram is blocked its DNS records usually are too, and a local lookup
 * fails before the proxy is ever contacted.
 */
export function buildRoute(raw: string): Route {
  const url = raw.trim();

  if (url === "" || url.toLowerCase() === "direct") return directRoute();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid address: "${url}"`);
  }

  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  const label = `${scheme}://${parsed.hostname}:${parsed.port || "(default)"}`;

  // MTProto is the most common misconfiguration. Explain, do not hang:
  // MTProto proxies the Telegram CLIENT protocol, while the Bot API is
  // ordinary HTTPS. The official Bot API docs say so outright.
  if (scheme === "mtproto" || scheme === "tg") {
    throw new Error(
      `MTProto proxy (${label}) does not work with bots — the Bot API is plain HTTPS. Use socks5:// or http://`
    );
  }

  if (scheme.startsWith("socks")) {
    const upgraded = url.replace(/^socks5?:\/\//i, "socks5h://");
    return {
      label,
      agent: new SocksProxyAgent(upgraded) as unknown as https.Agent,
      failures: 0,
      quarantineUntil: 0,
    };
  }

  if (scheme === "http" || scheme === "https") {
    return {
      label,
      agent: new HttpsProxyAgent(url) as unknown as https.Agent,
      failures: 0,
      quarantineUntil: 0,
    };
  }

  throw new Error(`unsupported scheme "${scheme}" in ${label}`);
}

/**
 * Parse the configured list.
 *
 * Separators are comma, semicolon and newline so the value reads well both
 * inline and as a block in .env.
 */
export function parseRoutes(raw: string | undefined): { routes: Route[]; errors: string[] } {
  const routes: Route[] = [];
  const errors: string[] = [];

  const parts = (raw ?? "")
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

  if (parts.length === 0) return { routes: [directRoute()], errors };

  const seen = new Set<string>();
  for (const part of parts) {
    try {
      const route = buildRoute(part);
      if (seen.has(route.label)) continue;
      seen.add(route.label);
      routes.push(route);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  // Direct is appended as the last resort. On a host where Telegram is
  // reachable a stale proxy list would otherwise disable notifications
  // entirely; trying direct last costs one attempt and can save the feature.
  if (!seen.has("direct connection")) routes.push(directRoute());

  return { routes, errors };
}

let routes: Route[] | undefined;
let currentIndex = 0;

// True once a route has actually carried a request. Before that, currentIndex
// is merely the default 0 and means nothing — treating it as "the route in
// use" made the cold-start entry from TELEGRAM_PROXY survive the harvested
// rebuild and jump back to the front, which is the exact behaviour this
// change removes.
let routeConfirmed = false;

/** How many working proxies to hold. Matches the harvester's grant size. */
const LEASE_SIZE = Number(process.env.PROXY_LEASE_SIZE) || 5;

/**
 * Routes leased from the harvester.
 *
 * The server talks to Telegram on its own — turn requests, prize
 * announcements, registration alerts — so it holds its own lease rather than
 * sharing the bot's. Two consumers probing the same free proxy would double
 * the load on an address that is already marginal.
 */
const lease = new LeaseHolder(appConfig.dataDir, "server", LEASE_SIZE, (m) => log.info(m));

function leasedRoutes(): Route[] {
  const built: Route[] = [];
  for (const p of lease.list()) {
    try {
      built.push(buildRoute(leaseUrl(p)));
    } catch {
      // A malformed grant is the harvester's problem, not a reason to stop.
    }
  }
  return built;
}

function getRoutes(): Route[] {
  if (!routes) {
    const { routes: parsed, errors } = parseRoutes(telegramConfig.proxyUrl);
    for (const err of errors) log.error(`TELEGRAM_PROXY: ${err}`);
    log.info(`Telegram transport: ${parsed.length} fallback route(s) until the lease arrives`);
    routes = parsed;
    currentIndex = 0;
    lease.writeAck(); // announce ourselves so the harvester grants a lease
  }

  // A changed lease replaces the list outright. TELEGRAM_PROXY is only a
  // stand-in for the window before the first grant.
  if (lease.refresh()) {
    const leased = leasedRoutes();
    if (leased.length > 0) {
      const direct = routes.find((r) => r.label === "direct connection");
      const previous = new Map(routes.map((r) => [r.label, r]));
      const rebuilt = leased.map((r) => previous.get(r.label) ?? r);
      if (direct) rebuilt.push(direct);

      const keepLabel = routeConfirmed ? routes[currentIndex]?.label : undefined;
      routes = rebuilt;
      currentIndex = keepLabel ? routes.findIndex((r) => r.label === keepLabel) : 0;
      if (currentIndex < 0) currentIndex = 0;
      log.info(`Telegram transport: ${leased.length} leased route(s)`);
    }
  }

  return routes;
}

/**
 * Routes to try for one call, current first, quarantined ones last.
 *
 * Quarantined routes stay in the list rather than being skipped: if every
 * proxy is cooling down, a slow proxy still beats a dropped notification.
 */
function attemptOrder(): number[] {
  const all = getRoutes();
  const now = Date.now();
  const order: number[] = [];

  for (let step = 0; step < all.length; step++) {
    const i = (currentIndex + step) % all.length;
    if (all[i].quarantineUntil <= now) order.push(i);
  }
  for (let step = 0; step < all.length; step++) {
    const i = (currentIndex + step) % all.length;
    if (all[i].quarantineUntil > now) order.push(i);
  }
  return order;
}

export interface TelegramReply {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * Where the Bot API lives.
 *
 * Normally api.telegram.org. The bot container has honoured
 * TELEGRAM_API_ROOT since it was written; the server did not, so anything it
 * sent — turn requests, prize announcements, roll reports — could not be
 * pointed at a stub and therefore could not be verified end to end. One
 * variable now configures both, exactly like TELEGRAM_PROXY.
 */
function apiTarget(): { hostname: string; port?: number; secure: boolean } {
  const raw = (process.env.TELEGRAM_API_ROOT || "").trim();
  if (!raw) return { hostname: "api.telegram.org", secure: true };

  try {
    const url = new URL(raw);
    const secure = url.protocol !== "http:";
    return {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      secure,
    };
  } catch {
    log.error(`TELEGRAM_API_ROOT is not a valid URL: "${raw}" — using api.telegram.org`);
    return { hostname: "api.telegram.org", secure: true };
  }
}

/** One HTTPS attempt over a specific agent. Never throws. */
function attempt(
  agent: https.Agent | undefined,
  token: string,
  method: string,
  body: string,
  timeoutMs: number
): Promise<TelegramReply> {
  return new Promise((resolve) => {
    const target = apiTarget();
    // A plain-http target is only ever a local stub; a proxy agent built for
    // HTTPS would not apply to it.
    const client = target.secure ? https : http;

    const req = client.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `/bot${token}/${method}`,
        method: "POST",
        agent: target.secure ? agent : undefined,
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

/**
 * POST a JSON payload to the Bot API, failing over between routes.
 *
 * Always resolves: a failed notification must never take down a game action.
 *
 * Only transport failures (status 0) trigger a retry on the next route. An
 * HTTP answer — including 400 or 401 — means the route works and Telegram
 * disliked the request; retrying that elsewhere would send the same message
 * repeatedly through every proxy in the list.
 */
export async function callTelegram(
  token: string,
  method: string,
  payload: unknown,
  timeoutMs = 20_000
): Promise<TelegramReply> {
  const all = getRoutes();
  const body = JSON.stringify(payload);
  const order = attemptOrder();
  let last: TelegramReply = { ok: false, status: 0, body: "no route configured" };

  for (const i of order) {
    const route = all[i];
    const reply = await attempt(route.agent, token, method, body, timeoutMs);

    if (reply.status > 0) {
      route.failures = 0;
      route.quarantineUntil = 0;
      routeConfirmed = true;
      if (i !== currentIndex) {
        log.info(`Telegram route switched to ${route.label}`);
        currentIndex = i;
      }
      return reply;
    }

    // A leased address that fails is discarded outright — no quarantine, no
    // second chance. Four more verified proxies are already in hand and the
    // harvester holds a reserve of fifteen; nursing a dead one back to life
    // is the loop this design exists to break.
    const address = route.label.replace(/^\w+:\/\//, "");
    if (lease.list().some((p) => p.address === address)) {
      lease.dropCurrentByAddress(address, reply.body);
      routes = all.filter((r) => r.label !== route.label);
      if (currentIndex >= routes.length) currentIndex = 0;
    } else {
      route.failures += 1;
      route.quarantineUntil = Date.now() + quarantineMs(route.failures);
    }
    log.error(`Telegram route ${route.label} failed`, errorContext(new Error(reply.body)));
    last = reply;
  }

  log.error(`All ${all.length} Telegram route(s) failed — message not delivered`);
  // Ask for replacements now rather than at the next call: the next call may
  // be a turn request, and by then the reserve should already be here.
  lease.writeAck();
  return last;
}

/** Current route label. Diagnostics and tests. */
export function currentRouteLabel(): string {
  const all = getRoutes();
  return all[currentIndex]?.label ?? "none";
}

/** Reset memoised state. Test-only. */
export function _resetTransport(): void {
  routes = undefined;
  currentIndex = 0;
  routeConfirmed = false;
}
