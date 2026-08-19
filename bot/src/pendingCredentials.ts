/**
 * Credentials waiting for their owner to open the bot.
 *
 * When the administrator registers a player by hand in the web console, the
 * server generates a password but has nowhere to send it: that player may
 * never have written to the bot, and Telegram forbids messaging a user who
 * has not started the conversation. So the pair is parked here, and handed
 * over the moment someone with a matching @username sends /start.
 *
 * Deleted immediately after delivery. A password sitting on disk is a
 * liability, and the player only needs it once — inside Telegram the Mini App
 * signs them in without it.
 *
 * Persisted because the wait is open-ended: the player might come back
 * tomorrow, and a container restart in between must not lose their password
 * with no way to recover it.
 *
 * The file doubles as the channel from the game server. The bot exposes no
 * HTTP port, so the server cannot call it; both containers do share a data
 * volume, and a file both sides agree on is the smaller mechanism. The bot
 * re-reads it when its mtime changes, so a hand-registration in the web
 * console reaches the bot within seconds and with no new moving parts.
 */
import fs from "node:fs";
import path from "node:path";

export interface PendingCredential {
  /** Login, normalised to "@name" in lower case. */
  handle: string;
  password: string;
  /** Epoch ms, for expiry and for the admin listing. */
  createdAt: number;
}

/**
 * How long an undelivered password stays valid.
 *
 * Not forever: a password that has been sitting unclaimed for a month is
 * more likely a mistake than a pending player, and the administrator can
 * always issue a new one.
 */
export const CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class PendingCredentialStore {
  private items = new Map<string, PendingCredential>();
  private readonly file: string;

  constructor(
    dataDir: string,
    private readonly log: (msg: string) => void = console.log
  ) {
    this.file = path.join(dataDir, "pending-credentials.json");
    this.load();
  }

  /** mtime of the last read, so an unchanged file is not re-parsed. */
  private lastMtimeMs = 0;

  /**
   * Re-read the file if the server has written to it.
   *
   * Called before every lookup rather than on a timer: the moment that
   * matters is /start, and a stale read there means the player is told they
   * have no password when one is sitting on disk.
   */
  refresh(): void {
    let mtime: number;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      return; // no file yet — nothing to pick up
    }
    if (mtime <= this.lastMtimeMs) return;
    this.items.clear();
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as PendingCredential[];
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.handle && item?.password) {
            this.items.set(normalise(item.handle), {
              ...item,
              createdAt: item.createdAt ?? Date.now(),
            });
          }
        }
      }
    } catch {
      // Missing or corrupt: start empty. Throwing here would stop the bot
      // over a file that is, by design, usually absent.
    }
    try {
      this.lastMtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.lastMtimeMs = 0;
    }
    this.expire();
  }

  private save(): void {
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Temp file plus rename: a half-written file would read as "no
      // credentials", losing a password with no trace.
      fs.writeFileSync(tmp, JSON.stringify([...this.items.values()], null, 2), {
        encoding: "utf-8",
        mode: 0o600, // passwords in clear — keep them off other users' eyes
      });
      fs.renameSync(tmp, this.file);
      this.lastMtimeMs = fs.statSync(this.file).mtimeMs;
    } catch (err) {
      this.log(`[credentials] не удалось сохранить: ${(err as Error).message}`);
    }
  }

  /** Drop anything past its TTL. Returns how many were removed. */
  private expire(): number {
    const cutoff = Date.now() - CREDENTIAL_TTL_MS;
    let dropped = 0;
    for (const [key, item] of this.items) {
      if (item.createdAt < cutoff) {
        this.items.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.items.size;
  }

  /**
   * Park a password for later delivery.
   *
   * A second registration for the same handle replaces the first: the newer
   * password is the one the server now considers valid, so delivering the
   * older one would lock the player out.
   */
  put(handle: string, password: string): void {
    const key = normalise(handle);
    this.items.set(key, { handle: key, password, createdAt: Date.now() });
    this.save();
    this.log(`[credentials] пароль для ${key} ждёт первого запуска бота`);
  }

  /**
   * Claim the credentials for a handle, if any are waiting.
   *
   * Removes them in the same step — deliberately not a separate "delete"
   * call. Two steps invite a path where the message is sent and the record
   * survives, and the password would then be re-sent on every /start.
   */
  claim(handle: string): PendingCredential | null {
    // Pick up anything the server wrote since the last check.
    this.refresh();
    const key = normalise(handle);
    const found = this.items.get(key);
    if (!found) return null;

    this.items.delete(key);
    this.save();

    if (Date.now() - found.createdAt > CREDENTIAL_TTL_MS) {
      this.log(`[credentials] пароль для ${key} просрочен — не выдаю`);
      return null;
    }

    this.log(`[credentials] выдан пароль для ${key}, запись удалена`);
    return found;
  }

  /** Handles still waiting. For diagnostics; never includes passwords. */
  waiting(): string[] {
    this.expire();
    return [...this.items.keys()];
  }
}

/** "Name", "@Name" and "@name" are the same person. */
export function normalise(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}
