/**
 * Handing proxies out to the bot and the game server.
 *
 * The model is a lease, not a shared list. The harvester keeps a reserve of
 * verified addresses; each consumer asks for a handful, and whatever it takes
 * is struck off the harvester's books immediately. From that moment the
 * consumer owns those addresses: it decides when they are dead and asks for
 * replacements. The harvester never checks them again and never hands them
 * to anyone else.
 *
 * Why hand out instead of share:
 *
 *  - Two containers probing the same address doubles the load on a free
 *    proxy that is already marginal, and both then discover it is dead
 *    separately.
 *  - "Already issued" is the only reliable way to stop re-verifying an
 *    address the consumers are actively using — the harvester cannot tell a
 *    proxy that is busy from one that is slow.
 *  - Ownership makes the failure path obvious: the consumer drops what does
 *    not answer and takes the next from its own allocation, with no round
 *    trip to the harvester and no shared state to get out of step.
 *
 * The exchange is two files per consumer in the shared volume:
 *
 *   lease-bot.json      what the harvester granted
 *   lease-bot.ack.json  what the consumer reports back (dead addresses, need)
 *
 * Files rather than a socket because the containers already share a volume,
 * and a missing file is a normal state that needs no error handling — a
 * consumer that has not started yet simply has not written its request.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Protocol } from "./sources.js";

/** Consumers that can hold a lease. */
export type Consumer = "bot" | "server";

export const CONSUMERS: Consumer[] = ["bot", "server"];

export interface LeasedProxy {
  address: string;
  protocol: Protocol;
  /** Latency measured by the harvester when it verified the address. */
  latencyMs: number;
  /** ISO timestamp of the grant. */
  issuedAt: string;
}

/** What the harvester grants. Written by the harvester, read by the consumer. */
export interface LeaseFile {
  version: 1;
  updatedAt: string;
  /** Grant identifier: increments on every change, so consumers can skip re-parsing. */
  generation: number;
  proxies: LeasedProxy[];
}

/** What the consumer reports. Written by the consumer, read by the harvester. */
export interface AckFile {
  version: 1;
  updatedAt: string;
  /** Which grant this refers to. Stale acks are ignored. */
  generation: number;
  /** Addresses the consumer found dead and has discarded. */
  dead: string[];
  /** Addresses still in use — the harvester must not reissue these. */
  holding: string[];
  /** How many more the consumer wants. */
  want: number;
}

export function leasePath(dataDir: string, who: Consumer): string {
  return path.join(dataDir, `lease-${who}.json`);
}

export function ackPath(dataDir: string, who: Consumer): string {
  return path.join(dataDir, `lease-${who}.ack.json`);
}

/**
 * Write JSON atomically.
 *
 * Both sides poll these files on a timer. A plain write truncates first and
 * fills after, so a reader landing in that window sees an empty or partial
 * file — which parses as "no proxies at all" precisely when the list is being
 * refreshed. Temp file plus rename makes the swap indivisible.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

/** Read and validate JSON. Returns null for missing or malformed files. */
export async function readJson<T>(
  file: string,
  validate: (v: unknown) => v is T
): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return null; // absent is normal, not an error
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isAckFile(v: unknown): v is AckFile {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Partial<AckFile>;
  return (
    Array.isArray(a.dead) &&
    Array.isArray(a.holding) &&
    typeof a.want === "number" &&
    typeof a.generation === "number"
  );
}

export function isLeaseFile(v: unknown): v is LeaseFile {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Partial<LeaseFile>;
  return Array.isArray(l.proxies) && typeof l.generation === "number";
}
