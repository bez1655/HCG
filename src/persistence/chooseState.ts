/**
 * Pick which persisted snapshot to boot from.
 *
 * Firestore is written at most once every 5 seconds. Local disk is written
 * every 500 ms. Preferring Firestore unconditionally (the old behaviour)
 * reloads a snapshot from *before* the last batch of rolls whenever the
 * process restarts in that window — the player jumps back to where they
 * stood before the pack. That is the rollback @hapalka228 reported.
 *
 * Rule: the newer snapshot wins. When neither side has a clock, local disk
 * wins, because it is the more frequently written copy.
 */
export type PersistedLike = {
  updatedAt?: number;
  revision?: number;
  players?: Array<{ id?: string; cell?: number; lastSeenAt?: number }>;
};

export type ChosenSource = "local" | "remote" | "none";

export function snapshotRecency(state: PersistedLike | null | undefined): number {
  if (!state) return -1;
  const revision = typeof state.revision === "number" ? state.revision : 0;
  const updatedAt = typeof state.updatedAt === "number" ? state.updatedAt : 0;
  if (revision > 0 || updatedAt > 0) {
    // Always above the lastSeen fallback (~1e15). Revision is the authority.
    return 4_000_000_000_000_000 + revision * 1_000_000_000_000 + updatedAt;
  }
  const players = Array.isArray(state.players) ? state.players : [];
  let lastSeen = 0;
  let cellSum = 0;
  for (const p of players) {
    if (typeof p.lastSeenAt === "number" && p.lastSeenAt > lastSeen) lastSeen = p.lastSeenAt;
    if (typeof p.cell === "number") cellSum += p.cell;
  }
  // Weak fallback for pre-clock snapshots: more recent activity, then
  // further-along pieces. Never used once updatedAt is being written.
  return lastSeen * 1000 + cellSum;
}

export function choosePersistedState<T extends PersistedLike>(
  local: T | null,
  remote: T | null
): { state: T | null; source: ChosenSource; reason: string } {
  if (!local && !remote) return { state: null, source: "none", reason: "no snapshots" };
  if (!local) return { state: remote, source: "remote", reason: "only remote present" };
  if (!remote) return { state: local, source: "local", reason: "only local present" };

  const localScore = snapshotRecency(local);
  const remoteScore = snapshotRecency(remote);

  if (localScore > remoteScore) {
    return {
      state: local,
      source: "local",
      reason: `local is newer (${localScore} > ${remoteScore})`,
    };
  }
  if (remoteScore > localScore) {
    return {
      state: remote,
      source: "remote",
      reason: `remote is newer (${remoteScore} > ${localScore})`,
    };
  }

  // Equal scores and neither has a clock: keep the local copy. Firestore
  // lagging the disk is the failure mode we are closing.
  return { state: local, source: "local", reason: "tied — prefer local disk" };
}
