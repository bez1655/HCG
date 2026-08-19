/**
 * The living proxy list.
 *
 * Persisted to a shared Docker volume so the bot and the game server read the
 * same file the harvester writes. A restart of any container must not lose
 * the list: re-verifying thousands of candidates takes minutes, and during
 * that window the bot would be silent.
 *
 * Two properties matter more than they look:
 *
 * 1. Manual addresses from TELEGRAM_PROXY are pinned. They are never dropped
 *    no matter how they score — a paid proxy or the user's own VPS must not
 *    be evicted because it timed out once while the harvester was scraping.
 *
 * 2. Writes are atomic (temp file + rename). The bot polls this file on a
 *    timer; a partially written JSON would be read as corrupt exactly when
 *    the list is being improved.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Protocol } from "./sources.js";
import type { Consumer } from "./lease.js";

export interface ProxyRecord {
  /** host:port */
  address: string;
  protocol: Protocol;
  /** Where it was first seen. "manual" for TELEGRAM_PROXY entries. */
  source: string;
  /** Pinned entries survive every eviction rule. */
  manual: boolean;
  /** Last measured round trip to api.telegram.org, ms. */
  latencyMs: number;
  /** Consecutive failed checks. Reset on success. */
  strikes: number;
  /** ISO timestamps. */
  firstSeen: string;
  lastOk: string | null;
  lastChecked: string;
  /** Lifetime counters, for the report. */
  checks: number;
  successes: number;
  /**
   * Handed to a consumer and struck off our books.
   *
   * An issued address is no longer ours: we do not re-check it, do not count
   * it as reserve, and never grant it to anyone else. The consumer owns it
   * until it reports the address dead.
   */
  issuedTo?: Consumer;
  issuedAt?: string;
}

export interface StoreShape {
  version: 1;
  updatedAt: string;
  proxies: ProxyRecord[];
}

/**
 * How many consecutive failures before an address is deleted.
 *
 * Not 1: free proxies flap, and a single timeout during a network hiccup
 * would wipe a list that is actually fine. Three strikes across three cycles
 * is a real death, not a blip.
 */
export const MAX_STRIKES = 3;

export class ProxyStore {
  private records = new Map<string, ProxyRecord>();

  constructor(
    private readonly file: string,
    private readonly maxSize: number
  ) {}

  get size(): number {
    return this.records.size;
  }

  all(): ProxyRecord[] {
    return [...this.records.values()];
  }

  /** Load from disk. A missing or corrupt file starts empty, never throws. */
  async load(): Promise<{ loaded: number; warning?: string }> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf-8");
    } catch {
      return { loaded: 0 };
    }

    try {
      const parsed = JSON.parse(raw) as StoreShape;
      if (!parsed || !Array.isArray(parsed.proxies)) {
        return { loaded: 0, warning: "файл списка повреждён, начинаю с пустого" };
      }
      for (const rec of parsed.proxies) {
        if (rec && typeof rec.address === "string") {
          this.records.set(rec.address, { ...rec, strikes: rec.strikes ?? 0 });
        }
      }
      return { loaded: this.records.size };
    } catch {
      return { loaded: 0, warning: "файл списка повреждён, начинаю с пустого" };
    }
  }

  /** Register a verified address, or refresh one already known. */
  recordSuccess(address: string, protocol: Protocol, source: string, latencyMs: number): void {
    const now = new Date().toISOString();
    const existing = this.records.get(address);

    if (existing) {
      existing.latencyMs = latencyMs;
      existing.strikes = 0;
      existing.lastOk = now;
      existing.lastChecked = now;
      existing.checks += 1;
      existing.successes += 1;
      return;
    }

    this.records.set(address, {
      address,
      protocol,
      source,
      manual: source === "manual",
      latencyMs,
      strikes: 0,
      firstSeen: now,
      lastOk: now,
      lastChecked: now,
      checks: 1,
      successes: 1,
    });
  }

  /** Register a failure. Returns true when the entry was deleted. */
  recordFailure(address: string): boolean {
    const rec = this.records.get(address);
    if (!rec) return false;

    rec.strikes += 1;
    rec.checks += 1;
    rec.lastChecked = new Date().toISOString();

    // Pinned entries accumulate strikes for the report but are never removed:
    // the operator chose them deliberately.
    if (rec.manual) return false;

    if (rec.strikes >= MAX_STRIKES) {
      this.records.delete(address);
      return true;
    }
    return false;
  }

  /** Pin an address supplied through TELEGRAM_PROXY. */
  pinManual(address: string, protocol: Protocol): void {
    const existing = this.records.get(address);
    if (existing) {
      existing.manual = true;
      existing.source = "manual";
      return;
    }
    const now = new Date().toISOString();
    this.records.set(address, {
      address,
      protocol,
      source: "manual",
      manual: true,
      // Unverified yet, but sorted after verified ones rather than dropped.
      latencyMs: Number.MAX_SAFE_INTEGER,
      strikes: 0,
      firstSeen: now,
      lastOk: null,
      lastChecked: now,
      checks: 0,
      successes: 0,
    });
  }

  /**
   * Best addresses first.
   *
   * Manual entries lead: the operator's own proxy should be preferred over a
   * scraped one even when the scraped one is marginally faster. After that,
   * latency decides — the pool treats position as priority.
   */
  ranked(): ProxyRecord[] {
    // Sorted purely by measured latency. Manual entries used to be forced to
    // the front, which meant one address in .env captured all traffic while
    // twenty freshly verified, faster proxies sat unused behind it. A hand-
    // written address ages; a harvested one was checked minutes ago. It earns
    // its place by responding quickly, like everything else in the list.
    return this.all().sort((a, b) => a.latencyMs - b.latencyMs);
  }

  /**
   * Drop the worst entries once the list outgrows maxSize.
   *
   * Without a cap the file grows unbounded across cycles, and the bot would
   * spend its startup probing hundreds of mediocre addresses before finding
   * the good one.
   */
  trim(): number {
    // The cap applies to the reserve. Issued addresses are excluded from the
    // count and from eviction alike: they are in active use, and dropping one
    // here would leave a consumer holding an address we no longer know about.
    const ours = this.ranked().filter((r) => !r.issuedTo);
    if (ours.length <= this.maxSize) return 0;
    const doomed = ours.slice(this.maxSize).filter((r) => !r.manual);
    for (const rec of doomed) this.records.delete(rec.address);
    return doomed.length;
  }

  /**
   * Addresses due for a re-check.
   *
   * Issued ones are excluded: they belong to a consumer now, which probes
   * them on its own. Re-checking here would double the traffic to a free
   * proxy that is already marginal, and would spend the cycle budget on
   * addresses we cannot hand to anyone anyway.
   */
  dueForRecheck(): ProxyRecord[] {
    return this.ranked().filter((r) => !r.issuedTo);
  }

  /**
   * Verified addresses nobody holds yet — the reserve.
   *
   * This is the number that decides whether the harvester goes scraping, so
   * it counts only what could actually be handed out right now: responding on
   * the last check and not already issued.
   */
  reserve(): ProxyRecord[] {
    return this.ranked().filter((r) => !r.issuedTo && r.strikes === 0 && r.lastOk !== null);
  }

  /** Addresses currently held by consumers. */
  issued(): ProxyRecord[] {
    return this.all().filter((r) => r.issuedTo);
  }

  /**
   * Hand out up to `count` addresses, best first, and strike them off.
   *
   * Marked rather than deleted so a record of what went where survives in
   * proxies.json; the eviction rules below drop them once the consumer
   * confirms they are dead.
   */
  issue(count: number, who: Consumer): ProxyRecord[] {
    const granted = this.reserve().slice(0, Math.max(0, count));
    const now = new Date().toISOString();
    for (const rec of granted) {
      rec.issuedTo = who;
      rec.issuedAt = now;
    }
    return granted;
  }

  /**
   * A consumer reports an address dead. Remove it for good.
   *
   * Returns true when something was removed. Manual pins are deleted here
   * too: the consumer probed the address for real and found it unreachable,
   * which is better evidence than the pin, and keeping it would mean handing
   * back the same dead address forever.
   */
  discard(address: string): boolean {
    return this.records.delete(address);
  }

  /**
   * Release addresses a consumer no longer claims.
   *
   * Covers the crash case: a container that dies without acking would
   * otherwise strand its allocation as "issued" and shrink the reserve
   * permanently. Anything issued to this consumer but missing from its
   * holding list comes back to us, unverified, to be re-checked next cycle.
   */
  reclaim(who: Consumer, holding: Set<string>): number {
    let count = 0;
    for (const rec of this.records.values()) {
      if (rec.issuedTo !== who) continue;
      if (holding.has(rec.address)) continue;
      delete rec.issuedTo;
      delete rec.issuedAt;
      // Force a re-check before it can be handed out again: we have no idea
      // what happened to it while the consumer held it.
      rec.strikes = 1;
      count += 1;
    }
    return count;
  }

  /**
   * Addresses that answered on the LAST check.
   *
   * Distinct from "has ever worked", and the difference decides whether the
   * harvester goes scraping. Counting lastOk !== null meant an entry stayed
   * "alive" for the two cycles it spends on strikes 1 and 2 — so a list where
   * every single proxy had just stopped answering still reported its full
   * size and the scrape was skipped. The log gave it away: "Живых: 15 из 22"
   * on one line and "в списке 20 рабочих" on the next.
   *
   * Pinned manual entries are excluded from the count for the same reason:
   * they are never evicted, so counting a dead one would hold the total above
   * target forever and permanently suppress scraping.
   */
  respondingNow(): ProxyRecord[] {
    return this.all().filter((r) => r.strikes === 0 && r.lastOk !== null);
  }

  /**
   * Write both files atomically.
   *
   * proxies.json is the harvester's own state; proxies.txt is the plain list
   * the bot and server consume. Two formats because the consumers must not
   * need to understand the harvester's bookkeeping to read a list of
   * addresses — and a human can `cat` the txt to see what is live.
   */
  async save(): Promise<void> {
    const payload: StoreShape = {
      version: 1,
      updatedAt: new Date().toISOString(),
      proxies: this.ranked(),
    };

    await writeAtomic(this.file, JSON.stringify(payload, null, 2));

    // proxies.txt carries the RESERVE, for humans and for diagnostics. What
    // the bot and the server actually use arrives through their lease files;
    // listing issued addresses here too would suggest they are up for grabs.
    const list = this.reserve().map((r) =>
      r.protocol === "socks5" ? `socks5://${r.address}` : `http://${r.address}`
    );

    const txt = path.join(path.dirname(this.file), "proxies.txt");
    await writeAtomic(txt, list.join("\n") + (list.length ? "\n" : ""));
  }
}

/**
 * Temp file plus rename.
 *
 * A plain fs.writeFile truncates first and fills after; a reader landing in
 * that window sees an empty or half-written file. This exact bug already cost
 * us truncated game state once, so no new writer gets to repeat it.
 */
export async function writeAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, file);
}
