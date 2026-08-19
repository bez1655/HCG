/**
 * Proxy verification.
 *
 * The single rule this module exists to enforce: a proxy counts as working
 * only when api.telegram.org itself answers through it. Not "the port is
 * open" — the address that wasted a day of debugging, 163.5.189.41:7239, had
 * an open port and carried no traffic. Not "it fetched example.com" either:
 * plenty of proxies reach the open web while Telegram stays unreachable.
 *
 * A 401 is a pass. We probe with a deliberately fake token, so Telegram
 * replying "Unauthorized" proves the whole path works and keeps the real bot
 * token out of a request sent through an untrusted third-party proxy.
 */
import https from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Protocol } from "./sources.js";

/** Never sent anywhere but through a proxy we do not trust. */
const PROBE_TOKEN = "0:HARVESTER-PROBE";

export interface Candidate {
  /** host:port */
  address: string;
  protocol: Protocol;
  source: string;
}

export interface VerifyResult {
  candidate: Candidate;
  ok: boolean;
  ms: number;
  detail: string;
}

/** Full proxy URL as the bot and server expect it. */
export function toProxyUrl(c: Candidate): string {
  // socks5h so the PROXY resolves DNS: where Telegram is blocked its DNS
  // records usually are too, and a local lookup fails before the proxy is
  // ever contacted.
  return c.protocol === "socks5" ? `socks5://${c.address}` : `http://${c.address}`;
}

function makeAgent(c: Candidate, timeoutMs: number): https.Agent {
  // The agent gets its own timeout because request.timeout does NOT cover
  // the connection to the proxy itself — see the deadline comment below.
  if (c.protocol === "socks5") {
    return new SocksProxyAgent(`socks5h://${c.address}`, {
      timeout: timeoutMs,
    }) as unknown as https.Agent;
  }
  return new HttpsProxyAgent(`http://${c.address}`, {
    timeout: timeoutMs,
  }) as unknown as https.Agent;
}

/**
 * Probe one candidate against the real Bot API.
 *
 * Timeouts are the normal case here, not the exception: most free proxies are
 * dead. The socket is destroyed explicitly because a blocked route leaves it
 * open indefinitely, and a few thousand leaked sockets per cycle would
 * exhaust the container.
 */
export function verifyOne(
  candidate: Candidate,
  timeoutMs: number,
  apiRoot = "https://api.telegram.org"
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;

    // Assigned below, once the request exists; finish() closes over it and
    // can run before that, so it cannot be const.
    // eslint-disable-next-line prefer-const
    let deadline: NodeJS.Timeout | undefined;

    function finish(ok: boolean, detail: string): void {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve({ candidate, ok, ms: Date.now() - started, detail });
    }

    let agent: https.Agent;
    try {
      agent = makeAgent(candidate, timeoutMs);
    } catch (err) {
      finish(false, (err as Error).message);
      return;
    }

    let base: URL;
    try {
      base = new URL(apiRoot);
    } catch {
      base = new URL("https://api.telegram.org");
    }

    const req = https.request(
      {
        hostname: base.hostname,
        port: base.port || 443,
        path: `${base.pathname.replace(/\/$/, "")}/bot${PROBE_TOKEN}/getMe`,
        method: "GET",
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        // The body is drained rather than read: only the status matters, and
        // an unread response keeps the socket alive.
        res.resume();
        const status = res.statusCode ?? 0;
        // 401 = Telegram answered and rejected the fake token: route is live.
        if (status === 401 || (status > 0 && status < 400)) {
          finish(true, `HTTP ${status}`);
        } else {
          // Anything else is usually the proxy itself talking: 403 from a
          // filtering proxy, 502 from a dying one.
          finish(false, `HTTP ${status}`);
        }
        res.on("end", () => undefined);
      }
    );

    /**
     * Hard deadline covering the whole attempt.
     *
     * req.timeout only arms once the socket exists. With a SOCKS proxy the
     * socket is created by the agent, so a proxy that accepts TCP and then
     * stalls during the handshake is not covered at all: measured against a
     * real black-hole address, a 5 s timeout took 30 s to give up (Node's own
     * connect timeout). At 120 concurrent probes that turns a one-minute
     * cycle into a ten-minute one and pushes genuinely slow-but-working
     * proxies out of the batch.
     */
    deadline = setTimeout(() => {
      req.destroy();
      finish(false, `дедлайн ${timeoutMs} мс`);
    }, timeoutMs);
    // Do not keep the process alive just to fail a probe.
    deadline.unref?.();

    req.on("timeout", () => {
      req.destroy();
      finish(false, `таймаут ${timeoutMs} мс`);
    });
    req.on("error", (err) => finish(false, err.message));
    req.end();
  });
}

/**
 * Verify many candidates with bounded concurrency.
 *
 * Concurrency is capped rather than unbounded: firing 5000 simultaneous
 * connections trips the host's file-descriptor limit and gets the server's IP
 * flagged as a port scanner. A worker pool keeps memory flat regardless of
 * list size.
 */
export async function verifyAll(
  candidates: Candidate[],
  opts: {
    concurrency: number;
    timeoutMs: number;
    apiRoot?: string;
    /** Stop early once this many have passed. 0 = check everything. */
    stopAfter?: number;
    onResult?: (r: VerifyResult, done: number, total: number) => void;
  }
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  const queue = [...candidates];
  const total = queue.length;
  let done = 0;
  let passed = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return;
      const next = queue.shift();
      if (!next) return;

      const result = await verifyOne(next, opts.timeoutMs, opts.apiRoot);
      done += 1;
      if (result.ok) {
        passed += 1;
        results.push(result);
      }
      opts.onResult?.(result, done, total);

      // Enough good proxies found — the rest of the queue is wasted work.
      //
      // Note this is a floor, not a ceiling: the other workers are already
      // mid-probe and their results still count. Asking for 5 typically
      // yields a few dozen, which is fine — extra verified proxies are the
      // cheap kind of surplus, and the store trims to its cap anyway. What
      // it does prevent is grinding through the remaining thousands.
      if (opts.stopAfter && passed >= opts.stopAfter) {
        stopped = true;
        // Drop the backlog so in-flight workers exit after their current probe.
        queue.length = 0;
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(opts.concurrency, Math.max(1, total)) }, () =>
    worker()
  );
  await Promise.all(workers);

  // Fastest first: the pool treats list order as priority.
  results.sort((a, b) => a.ms - b.ms);
  return results;
}
