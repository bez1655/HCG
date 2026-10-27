/**
 * Consumer side of the proxy lease.
 *
 * The harvester grants a handful of verified addresses; from that moment they
 * are ours. This module owns them: it decides which is current, drops one the
 * instant it stops answering, and tells the harvester what died and how many
 * replacements we need.
 *
 * The rule that matters: never wait on a dead proxy. A failing address is
 * discarded on the spot and the next one is used immediately — no retry, no
 * quarantine, no second chance. Retrying was how the bot used to sit on a
 * single broken proxy while nineteen working ones went unused.
 *
 * Both the bot and the game server use this: they talk to Telegram
 * independently, so a fix applied to only one of them leaves the other
 * silently broken — which has happened here before.
 *
 * NOTE: this file is duplicated in bot/src/leaseClient.ts on purpose. The two
 * containers build from separate contexts with no shared package, and a
 * symlink or relative import across them breaks the Docker build. The file is
 * self-contained and small; a guard test keeps the copies identical.
 */
import fs from "node:fs";
import path from "node:path";

export type Consumer = "bot" | "server";

export interface LeasedProxy {
  address: string;
  protocol: "socks5" | "http";
  latencyMs: number;
  issuedAt: string;
}

interface LeaseFile {
  version: number;
  generation: number;
  proxies: LeasedProxy[];
}

export function leaseUrl(p: LeasedProxy): string {
  // socks5h so the PROXY resolves DNS: where Telegram is blocked its DNS
  // records usually are too, and a local lookup fails before the proxy is
  // ever contacted.
  return p.protocol === "socks5" ? `socks5://${p.address}` : `http://${p.address}`;
}

/**
 * Holds the addresses granted to one consumer.
 *
 * Deliberately dumb about networking: it tracks which addresses exist and
 * which are current, while probing stays with the caller. That keeps the
 * bookkeeping testable without opening a socket.
 */
export class LeaseHolder {
  private proxies: LeasedProxy[] = [];
  private index = 0;
  private generation = 0;
  /** Reported to the harvester, cleared once it confirms by reissuing. */
  private dead = new Set<string>();
  private lastLeaseMtime = 0;

  constructor(
    private readonly dataDir: string,
    private readonly who: Consumer,
    private readonly leaseSize = 5,
    private readonly log: (msg: string) => void = console.log
  ) {}

  get size(): number {
    return this.proxies.length;
  }

  /** Address in use, or null when the lease is empty. */
  get current(): LeasedProxy | null {
    return this.proxies[this.index] ?? null;
  }

  list(): LeasedProxy[] {
    return [...this.proxies];
  }

  private leasePath(): string {
    return path.join(this.dataDir, `lease-${this.who}.json`);
  }

  private ackPath(): string {
    return path.join(this.dataDir, `lease-${this.who}.ack.json`);
  }

  /**
   * Pick up a new grant from the harvester.
   *
   * Returns true when the set of addresses changed. Unchanged files are
   * skipped by mtime: re-parsing on every poll would rebuild agents and drop
   * live keep-alive sockets for nothing.
   */
  refresh(): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.leasePath());
    } catch {
      return false; // no grant yet — normal before the harvester's first cycle
    }
    if (stat.mtimeMs <= this.lastLeaseMtime) return false;
    this.lastLeaseMtime = stat.mtimeMs;

    let parsed: LeaseFile;
    try {
      parsed = JSON.parse(fs.readFileSync(this.leasePath(), "utf-8")) as LeaseFile;
    } catch {
      return false;
    }
    if (!parsed || !Array.isArray(parsed.proxies)) return false;

    const currentAddress = this.current?.address;

    // Anything we already reported dead must not come back: the harvester may
    // have written this file before reading our ack.
    const incoming = parsed.proxies.filter(
      (p) => p && typeof p.address === "string" && !this.dead.has(p.address)
    );

    const before = this.proxies.map((p) => p.address).join(",");
    const after = incoming.map((p) => p.address).join(",");
    if (before === after) return false;

    this.proxies = incoming;
    this.generation = parsed.generation ?? 0;

    // Stay on the address we are using if it survived the update; switching
    // for no reason would drop a working connection.
    const keep = currentAddress ? incoming.findIndex((p) => p.address === currentAddress) : -1;
    this.index = keep >= 0 ? keep : 0;

    this.log(
      `[${this.who}] Аренда обновлена: ${incoming.length} прокси` +
        (incoming.length > 0 ? ` — ${incoming.map((p) => p.address).join(", ")}` : "")
    );
    return true;
  }

  /**
   * Discard the current address and move to the next.
   *
   * Called the moment a request fails. Returns the new current address, or
   * null when the lease is exhausted and we must wait for a refill.
   */
  dropCurrent(reason: string): LeasedProxy | null {
    const failed = this.current;
    if (!failed) return null;

    this.dead.add(failed.address);
    this.proxies.splice(this.index, 1);
    if (this.index >= this.proxies.length) this.index = 0;

    this.log(
      `[${this.who}] ✗ ${failed.address} не отвечает (${reason}) — выбросил, ` +
        `осталось ${this.proxies.length}`
    );

    // Ask for a replacement straight away rather than at the next poll: the
    // harvester acts on this file, and a delay here is silence for the user.
    this.writeAck();

    const next = this.current;
    if (next) {
      this.log(`[${this.who}] → перехожу на ${next.address}`);
    } else {
      this.log(`[${this.who}] Аренда пуста — жду пополнения от сборщика`);
    }
    return next;
  }

  /**
   * Discard a specific address, wherever it sits in the lease.
   *
   * The server picks routes by index rather than tracking a "current" one,
   * so it needs to name the casualty explicitly.
   */
  dropCurrentByAddress(address: string, reason: string): void {
    const at = this.proxies.findIndex((p) => p.address === address);
    if (at === -1) return;
    const saved = this.index;
    this.index = at;
    this.dropCurrent(reason);
    this.index = Math.min(saved, Math.max(0, this.proxies.length - 1));
  }

  /** Move to the next address without declaring the current one dead. */
  rotate(): LeasedProxy | null {
    if (this.proxies.length === 0) return null;
    this.index = (this.index + 1) % this.proxies.length;
    return this.current;
  }

  /**
   * Tell the harvester what died and how many we need.
   *
   * Written on every change rather than on a timer: the harvester reads this
   * at the start of its cycle, and a stale file means a cycle wasted.
   */
  writeAck(): void {
    const ack = {
      version: 1 as const,
      updatedAt: new Date().toISOString(),
      generation: this.generation,
      dead: [...this.dead],
      holding: this.proxies.map((p) => p.address),
      want: Math.max(0, this.leaseSize - this.proxies.length),
    };

    // Atomic write: the harvester polls this file, and a half-written one
    // parses as "nothing is dead and nothing is needed" — the worst possible
    // misreading.
    const file = this.ackPath();
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(ack, null, 2), "utf-8");
      fs.renameSync(tmp, file);
    } catch {
      // A failed ack costs us a replacement, not the connection. Never throw
      // here: this runs on the failure path, where throwing would mask the
      // original problem.
    }

    // Once reported, forget them: the harvester has deleted them for good,
    // and keeping the list growing would filter out addresses forever if one
    // were ever recycled.
    if (this.dead.size > 50) this.dead.clear();
  }
}
