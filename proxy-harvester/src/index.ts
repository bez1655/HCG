/**
 * HCG proxy harvester.
 *
 * Runs in its own container. Every cycle it:
 *   1. re-checks the addresses already on the list, deleting the dead ones;
 *   2. if the list is short, scrapes the public sources for new candidates;
 *   3. verifies candidates against api.telegram.org itself;
 *   4. writes the ranked result to a shared volume.
 *
 * The bot and the game server read that file and reload it on a timer, so a
 * refreshed list takes effect without restarting anything.
 *
 * Why a separate container: verification is bursty and slow — hundreds of
 * sockets, most of them timing out. Running that inside the bot process would
 * stall Telegram polling every cycle. Isolation also means a crash here
 * cannot take the game down; the bot simply keeps using the last good list.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { SOURCES, isSaneHost, type Protocol } from "./sources.js";
import { verifyAll, type Candidate } from "./verify.js";
import { ProxyStore } from "./store.js";
import {
  CONSUMERS,
  ackPath,
  isAckFile,
  isLeaseFile,
  leasePath,
  readJson,
  writeJsonAtomic,
  type AckFile,
  type Consumer,
  type LeaseFile,
  type LeasedProxy,
} from "./lease.js";

const BUILD = "2026-08-05.1";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CONFIG = {
  dataDir: process.env.PROXY_DATA_DIR || "/app/data",
  /** Full cycle interval. */
  intervalMs: num("HARVEST_INTERVAL_MS", 10 * 60_000),
  /** Simultaneous probes. */
  concurrency: num("HARVEST_CONCURRENCY", 120),
  /** Per-probe timeout. Free proxies are slow; too tight discards good ones. */
  timeoutMs: num("HARVEST_TIMEOUT_MS", 10_000),
  /**
   * Reserve to keep on hand: verified addresses nobody holds yet.
   *
   * 18 sits inside the 15-20 the operator asked for, with room to lose a few
   * between cycles without dropping below the floor.
   */
  targetSize: num("HARVEST_TARGET", 18),
  /** Never let the reserve fall below this before scraping becomes urgent. */
  minReserve: num("HARVEST_MIN_RESERVE", 15),
  /** Hard cap on the reserve. Issued addresses are not counted. */
  maxSize: num("HARVEST_MAX", 20),
  /** How many working proxies each consumer should hold. */
  leaseSize: num("HARVEST_LEASE", 5),
  /** Candidates verified per cycle, at most. */
  batchSize: num("HARVEST_BATCH", 1500),
  apiRoot: process.env.TELEGRAM_API_ROOT || "https://api.telegram.org",
  manual: process.env.TELEGRAM_PROXY || "",
};

const STATE_FILE = path.join(CONFIG.dataDir, "proxies.json");
const STATUS_FILE = path.join(CONFIG.dataDir, "harvester-status.json");

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[harvester ${ts}] ${msg}`);
}

/** Download one source. A failure is a warning: other sources carry on. */
async function fetchSource(
  source: (typeof SOURCES)[number]
): Promise<{ candidates: Candidate[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        // Some lists reject the default Node user agent outright.
        "User-Agent": "Mozilla/5.0 (compatible; HCG-proxy-harvester/1.0)",
        Accept: "text/plain,application/json,*/*",
      },
    });
    if (!res.ok) return { candidates: [], error: `HTTP ${res.status}` };

    const body = await res.text();
    const pairs = source.parse(body);
    const seen = new Set<string>();
    const candidates: Candidate[] = [];

    for (const pair of pairs) {
      if (seen.has(pair)) continue;
      seen.add(pair);
      const host = pair.split(":")[0];
      if (!isSaneHost(host)) continue;
      candidates.push({ address: pair, protocol: source.protocol, source: source.name });
    }
    return { candidates };
  } catch (err) {
    const msg = (err as Error).name === "AbortError" ? "таймаут" : (err as Error).message;
    return { candidates: [], error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse TELEGRAM_PROXY into pinned entries. */
function manualEntries(raw: string): Array<{ address: string; protocol: Protocol }> {
  const out: Array<{ address: string; protocol: Protocol }> = [];
  for (const part of raw.split(/[\n,;]+/).map((s) => s.trim())) {
    if (!part || part.toLowerCase() === "direct") continue;
    try {
      const url = new URL(part);
      const scheme = url.protocol.replace(":", "").toLowerCase();
      // MTProto cannot work with the Bot API; skip rather than probe it.
      if (scheme === "tg" || scheme === "mtproto") continue;
      if (!url.hostname || !url.port) continue;
      out.push({
        address: `${url.hostname}:${url.port}`,
        protocol: scheme.startsWith("socks") ? "socks5" : "http",
      });
    } catch {
      // Ignore malformed entries; the bot reports them separately.
    }
  }
  return out;
}

/**
 * Settle up with one consumer: bury what it reported dead, top it back up.
 *
 * Runs before scraping so the reserve figure that decides whether to scrape
 * already accounts for everything handed out this cycle.
 */
async function serveConsumer(
  store: ProxyStore,
  who: Consumer,
  cycleLog: (msg: string) => void
): Promise<{ granted: number; buried: number; holding: number }> {
  const lease = await readJson<LeaseFile>(leasePath(CONFIG.dataDir, who), isLeaseFile);
  const ack = await readJson<AckFile>(ackPath(CONFIG.dataDir, who), isAckFile);

  let buried = 0;
  let holding: string[] = [];

  if (ack) {
    // The consumer probed these for real and found them unreachable. That is
    // better evidence than anything we could gather, so they go for good.
    for (const address of ack.dead) {
      if (store.discard(address)) buried += 1;
    }
    holding = ack.holding.filter((a) => typeof a === "string");

    // Anything we issued that the consumer no longer lists comes back to us.
    // Without this a crashed container would strand its allocation forever
    // and the reserve would shrink with every restart.
    const returned = store.reclaim(who, new Set(holding));
    if (returned > 0) cycleLog(`  ↩ ${who}: вернулось ${returned} невостребованных`);
  } else if (lease) {
    // No ack yet — the consumer has not started, or has not finished its
    // first pass. Assume it still holds everything we granted.
    holding = lease.proxies.map((p) => p.address);
  }

  const want = ack ? Math.max(0, ack.want) : CONFIG.leaseSize;
  const need = Math.max(0, Math.min(want, CONFIG.leaseSize - holding.length));

  if (need === 0 && buried === 0) {
    return { granted: 0, buried, holding: holding.length };
  }

  /**
   * Re-verify the reserve before handing anything out.
   *
   * The stored latency is from the last cycle, up to ten minutes ago, and a
   * free proxy can die in that window. Handing over a stale entry means the
   * consumer discovers the death itself and comes straight back for a
   * replacement — the round trip this is meant to avoid.
   *
   * Only the head of the reserve is checked, not all twenty: the list is
   * ordered by latency, so the candidates for a grant are at the front, and
   * probing the tail would spend time on addresses nobody is about to get.
   */
  if (need > 0) {
    const candidates = store.reserve().slice(0, Math.min(need * 3, 12));
    if (candidates.length > 0) {
      const checked = await verifyAll(
        candidates.map((r) => ({
          address: r.address,
          protocol: r.protocol,
          source: r.source,
        })),
        {
          concurrency: Math.min(candidates.length, 12),
          timeoutMs: CONFIG.timeoutMs,
          apiRoot: CONFIG.apiRoot,
        }
      );

      const alive = new Map(checked.map((c) => [c.candidate.address, c.ms]));
      for (const rec of candidates) {
        const ms = alive.get(rec.address);
        if (ms !== undefined) {
          // Refresh the latency too: the grant is ordered by it, and the
          // consumer tries the list top down.
          store.recordSuccess(rec.address, rec.protocol, rec.source, ms);
        } else if (store.recordFailure(rec.address)) {
          cycleLog(`  − ${rec.address} умер перед выдачей — удалён`);
        }
      }
      cycleLog(`  ⟳ ${who}: проверено ${candidates.length}, живых ${checked.length}`);
    }
  }

  const granted = store.issue(need, who);

  // The new lease is everything the consumer still holds plus the fresh
  // grants. Sending only the new ones would make the consumer's own list
  // depend on it having read every previous file — a single missed poll and
  // the two sides disagree about what is held.
  const keptRecords = store.all().filter((r) => r.issuedTo === who && holding.includes(r.address));

  const proxies: LeasedProxy[] = [...keptRecords, ...granted].map((r) => ({
    address: r.address,
    protocol: r.protocol,
    latencyMs: r.latencyMs,
    issuedAt: r.issuedAt ?? new Date().toISOString(),
  }));

  // Fastest first: consumers try them in order.
  proxies.sort((a, b) => a.latencyMs - b.latencyMs);

  const next: LeaseFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    generation: (lease?.generation ?? 0) + 1,
    proxies,
  };
  await writeJsonAtomic(leasePath(CONFIG.dataDir, who), next);

  if (granted.length > 0 || buried > 0) {
    cycleLog(
      `  → ${who}: выдано ${granted.length}, похоронено ${buried}, ` +
        `на руках ${proxies.length}/${CONFIG.leaseSize}`
    );
    for (const g of granted) cycleLog(`      ${g.protocol}://${g.address} (${g.latencyMs} мс)`);
  }

  if (proxies.length < CONFIG.leaseSize) {
    cycleLog(
      `  ! ${who}: не хватает ${CONFIG.leaseSize - proxies.length} — резерв пуст, добираю из источников`
    );
  }

  return { granted: granted.length, buried, holding: proxies.length };
}

interface CycleReport {
  startedAt: string;
  durationMs: number;
  rechecked: number;
  removed: number;
  scraped: number;
  verified: number;
  listSize: number;
  sources: Array<{ name: string; got: number; error?: string }>;
}

async function runCycle(store: ProxyStore, cycle: number): Promise<CycleReport> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  log(`═══ Цикл ${cycle} ═══`);

  // ---- Stage 1: re-check what we already have -----------------------------
  // Existing addresses are checked first and always: this is the half of the
  // job that removes the dead ones. A harvester that only adds would grow a
  // list where most entries are corpses.
  let removed = 0;
  const known = store.dueForRecheck();
  if (known.length > 0) {
    log(`Перепроверяю ${known.length} адрес(ов) из списка...`);
    const asCandidates: Candidate[] = known.map((r) => ({
      address: r.address,
      protocol: r.protocol,
      source: r.source,
    }));

    const results = await verifyAll(asCandidates, {
      concurrency: Math.min(CONFIG.concurrency, 40),
      timeoutMs: CONFIG.timeoutMs,
      apiRoot: CONFIG.apiRoot,
    });

    const okSet = new Map(results.map((r) => [r.candidate.address, r.ms]));
    for (const rec of known) {
      const ms = okSet.get(rec.address);
      if (ms !== undefined) {
        store.recordSuccess(rec.address, rec.protocol, rec.source, ms);
      } else if (store.recordFailure(rec.address)) {
        removed += 1;
        log(`  − удалён ${rec.address} (${3} неудачи подряд)`);
      }
    }
    log(`  Живых: ${okSet.size} из ${known.length}, удалено: ${removed}`);
  }

  // ---- Stage 2: serve the consumers ---------------------------------------
  // Before deciding whether to scrape: grants come out of the reserve, so the
  // reserve figure must already reflect them or we would under-order.
  let granted = 0;
  let buried = 0;
  const holdings: Record<string, number> = {};

  for (const who of CONSUMERS) {
    const result = await serveConsumer(store, who, log);
    granted += result.granted;
    buried += result.buried;
    holdings[who] = result.holding;
  }

  // ---- Stage 3: scrape, only if the reserve needs it ----------------------
  // Skipping the scrape when the reserve is full keeps us from hammering the
  // source sites every ten minutes, which is how a harvester gets IP-banned
  // from the very lists it depends on.
  //
  // The figure is the RESERVE: verified, responding on the last check, and
  // not already issued. Counting issued addresses would let a full set of
  // grants disguise an empty reserve — and the moment a consumer reported a
  // death there would be nothing to replace it with.
  const alive = store.reserve().length;
  const sourceReport: CycleReport["sources"] = [];
  let scraped = 0;
  let verified = 0;

  // Anyone short of a full lease makes this urgent regardless of the reserve.
  const consumerShort = Object.values(holdings).some((n) => n < CONFIG.leaseSize);

  if (alive < CONFIG.targetSize || consumerShort) {
    log(
      consumerShort
        ? `Кому-то не хватает прокси (резерв ${alive}) — качаю списки...`
        : `Резерв ${alive} < цели ${CONFIG.targetSize} — качаю списки...`
    );

    const settled = await Promise.all(
      SOURCES.map(async (s) => ({ source: s, result: await fetchSource(s) }))
    );

    const pool = new Map<string, Candidate>();
    for (const { source, result } of settled) {
      sourceReport.push({
        name: source.name,
        got: result.candidates.length,
        error: result.error,
      });
      if (result.error) {
        log(`  ! ${source.name}: ${result.error}`);
        continue;
      }
      for (const c of result.candidates) {
        if (!pool.has(c.address)) pool.set(c.address, c);
      }
    }

    // Already-known addresses are not re-verified here; stage 1 did that.
    for (const rec of store.all()) pool.delete(rec.address);

    scraped = pool.size;
    log(`  Собрано ${scraped} уникальных кандидатов из ${SOURCES.length} источников`);

    // SOCKS5 first: preferred for the Bot API, HTTP is the fallback.
    const candidates = [...pool.values()]
      .sort((a, b) => (a.protocol === b.protocol ? 0 : a.protocol === "socks5" ? -1 : 1))
      .slice(0, CONFIG.batchSize);

    const missing = Object.values(holdings).reduce(
      (sum, n) => sum + Math.max(0, CONFIG.leaseSize - n),
      0
    );
    const need = Math.max(1, CONFIG.targetSize - alive + missing);
    log(`  Проверяю ${candidates.length} кандидат(ов), нужно ещё ${need}...`);

    let lastLog = Date.now();
    const results = await verifyAll(candidates, {
      concurrency: CONFIG.concurrency,
      timeoutMs: CONFIG.timeoutMs,
      apiRoot: CONFIG.apiRoot,
      stopAfter: need,
      onResult: (_r, done, total) => {
        // Progress every 15 s: a silent 10-minute container looks hung.
        if (Date.now() - lastLog > 15_000) {
          lastLog = Date.now();
          log(`    ...проверено ${done}/${total}`);
        }
      },
    });

    for (const r of results) {
      store.recordSuccess(r.candidate.address, r.candidate.protocol, r.candidate.source, r.ms);
      log(
        `  + ${r.candidate.address} (${r.candidate.protocol}, ${r.ms} мс, ${r.candidate.source})`
      );
    }
    verified = results.length;
    log(`  Найдено рабочих: ${verified}`);
  } else {
    log(`Резерв ${alive} ≥ цели ${CONFIG.targetSize} — источники не трогаю`);
  }

  // ---- Stage 4: top up anyone still short ---------------------------------
  // The scrape may have just refilled the reserve. A consumer that came up
  // empty in stage 2 must not wait a whole cycle for addresses that exist
  // now — that wait is exactly the silence this system exists to prevent.
  if (verified > 0 && consumerShort) {
    for (const who of CONSUMERS) {
      if (holdings[who] >= CONFIG.leaseSize) continue;
      const again = await serveConsumer(store, who, log);
      granted += again.granted;
      holdings[who] = again.holding;
    }
  }

  const trimmed = store.trim();
  if (trimmed > 0) log(`Обрезал ${trimmed} худших (лимит ${CONFIG.maxSize})`);

  await store.save();

  const report: CycleReport = {
    startedAt,
    durationMs: Date.now() - started,
    rechecked: known.length,
    removed,
    scraped,
    verified,
    listSize: store.reserve().length,
    sources: sourceReport,
  };

  await fs
    .writeFile(STATUS_FILE, JSON.stringify({ build: BUILD, cycle, ...report }, null, 2), "utf-8")
    .catch(() => undefined);

  log(
    `Итог цикла: резерв ${report.listSize}, ` +
      `бот ${holdings.bot ?? 0}/${CONFIG.leaseSize}, сервер ${holdings.server ?? 0}/${CONFIG.leaseSize}, ` +
      `+${verified} новых, −${removed + buried} мёртвых, выдано ${granted}, ` +
      `за ${Math.round(report.durationMs / 1000)} с`
  );

  const top = store
    .ranked()
    .filter((r) => r.lastOk !== null)
    .slice(0, 5);
  for (const r of top) {
    log(`  ▸ ${r.protocol}://${r.address} — ${r.latencyMs} мс${r.manual ? " (свой)" : ""}`);
  }

  return report;
}

async function main(): Promise<void> {
  log(`build ${BUILD} — сбор и проверка прокси`);
  log(
    `Настройки: цикл ${CONFIG.intervalMs / 1000} с, цель ${CONFIG.targetSize}, ` +
      `лимит ${CONFIG.maxSize}, потоков ${CONFIG.concurrency}, таймаут ${CONFIG.timeoutMs} мс`
  );

  await fs.mkdir(CONFIG.dataDir, { recursive: true });

  const store = new ProxyStore(STATE_FILE, CONFIG.maxSize);
  const { loaded, warning } = await store.load();
  if (warning) log(`! ${warning}`);
  log(`Загружено из файла: ${loaded} адрес(ов)`);

  // Pin the operator's own addresses so a scraped list can never evict them.
  const manual = manualEntries(CONFIG.manual);
  for (const m of manual) store.pinManual(m.address, m.protocol);
  if (manual.length > 0) log(`Закреплено своих адресов: ${manual.length}`);

  let cycle = 0;
  let running = false;

  const tick = async () => {
    // Overlapping cycles would double the socket load and corrupt counters.
    if (running) {
      log("Предыдущий цикл ещё идёт — пропускаю");
      return;
    }
    running = true;
    cycle += 1;
    try {
      await runCycle(store, cycle);
    } catch (err) {
      // A crash must not end the container: the next cycle may well succeed,
      // and meanwhile the bot keeps using the last saved list.
      log(`✗ Цикл упал: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  await tick();
  const timer = setInterval(() => void tick(), CONFIG.intervalMs);

  const shutdown = (signal: string) => {
    log(`${signal} — останавливаюсь`);
    clearInterval(timer);
    void store.save().finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

export { main, manualEntries, runCycle, CONFIG, BUILD };
