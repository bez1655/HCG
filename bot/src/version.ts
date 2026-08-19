/**
 * Build marker.
 *
 * Printed at startup and readable from inside the container. Exists because
 * "nothing changed" is otherwise impossible to diagnose remotely: source on
 * disk, the built image and the running container can each be a different
 * generation, and none of them announces which one it is.
 *
 * Bump BUILD when shipping a change that must be verifiable on a server.
 */
export const BUILD = "2026-08-16.1";
export const FEATURES = [
  "self-registration button",
  "password-free Telegram entry",
  "two-stage Docker build",
  "proxy pool with failover",
  "new interface artwork",
  "server-side proxy failover too",
  "harvested list read before giving up",
  "harvested proxies outrank TELEGRAM_PROXY",
  "proxy leases: 5 per consumer, 15-20 in reserve",
  "batch turn approval: several rolls per approval",
  "roll reports to the admin, one per batch",
  "approved turns never expire",
  "shift cells no longer land on prize cells",
  "approvals cannot be granted twice",
  "players are never told about each other",
  "public aliases hide real Telegram handles",
  "admin can message one player by alias",
  "/requests summary and role-aware /help",
  "idle players' tokens fade from the board",
  "player roster export as CSV",
] as const;
