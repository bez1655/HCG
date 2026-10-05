/**
 * Keep player.name in sync with the current Telegram @handle.
 *
 * Identity is telegramId (stable). The handle can change; the game used to
 * keep the handle from registration forever, so the admin table showed @old.
 */
import type { Player } from "../types";

export interface HandleSyncResult {
  renamed: boolean;
  conflict: boolean;
  previousName: string;
}

function withAt(handle: string): string {
  const bare = handle.replace(/^@/, "");
  return `@${bare}`;
}

function rememberPrevious(player: Player, oldName: string): void {
  const key = withAt(oldName).toLowerCase();
  if (!player.previousHandles) player.previousHandles = [];
  if (!player.previousHandles.some((h) => h.toLowerCase() === key)) {
    player.previousHandles.push(withAt(oldName));
    if (player.previousHandles.length > 8) {
      player.previousHandles = player.previousHandles.slice(-8);
    }
  }
}

/** `handle` is already normalised (`@name`). */
export { withAt };

export function applyTelegramHandle(
  players: Player[],
  player: Player,
  handle: string
): HandleSyncResult {
  const previousName = player.name;
  const formatted = withAt(handle);
  const bare = formatted.slice(1);
  player.telegramUsername = bare;

  const taken = players.find(
    (p) => p.id !== player.id && p.name.toLowerCase() === formatted.toLowerCase()
  );
  if (taken) {
    return { renamed: false, conflict: true, previousName };
  }

  if (player.name.toLowerCase() !== formatted.toLowerCase()) {
    rememberPrevious(player, previousName);
    player.name = formatted;
    return { renamed: true, conflict: false, previousName };
  }
  return { renamed: false, conflict: false, previousName };
}

export function findPlayerByTelegram(
  players: Player[],
  opts: { telegramId?: number; handle?: string | null }
): Player | undefined {
  if (opts.telegramId) {
    const byId = players.find((p) => p.telegramId === opts.telegramId);
    if (byId) return byId;
  }
  const handle = (opts.handle || "").toLowerCase();
  if (!handle) return undefined;
  const bare = handle.replace(/^@/, "");
  const withAtHandle = `@${bare}`;
  return players.find(
    (p) =>
      p.name.toLowerCase() === handle ||
      p.name.toLowerCase() === withAtHandle ||
      p.name.toLowerCase().replace(/^@/, "") === bare ||
      (p.telegramUsername || "").toLowerCase() === bare ||
      (p.previousHandles || []).some((h) => h.toLowerCase().replace(/^@/, "") === bare)
  );
}

/** Same Telegram account — username may have changed. */
export function findPlayerByStableId(players: Player[], telegramId?: number): Player | undefined {
  if (!telegramId) return undefined;
  return players.find((p) => p.telegramId === telegramId);
}

/** Login field must be the player's current @handle, not an old one or someone else's. */
export function isCurrentLoginHandle(player: Player, typed: string): boolean {
  const want = withAt(typed).toLowerCase();
  return player.name.toLowerCase() === want;
}
