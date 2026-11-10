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
export const BUILD = "2026-11-08.15";
export const FEATURES = [
  "bot /start /help /hero in Russian: 1 purchase = 1 turn, boss 63, shop finish 64",
  "tabletop RPG cards on cells 6/10/16/20/26/32/36/44/48/50/58/63, finish 64 shop only",
  "loyalty credits are cosmetic — never buy turns or inventory",
  "server D20 for encounters, original floor aliases",
  "inventory shield dice magnet, fever, drop boxes, skins, gifts, haptics",
  "board FPS: no ambient blur, no particle canvas, eco default off so board video plays",
  "neon magnet prize attractor and luck streak fever mode x2",
  "auto-gift cyber-gear for batch purchases and admin quick-grant controls",
  "custom cyber-chip skins and neon aura customisation",
  "cyber-inventory (shield firewall and loaded dice chips)",
  "cyber-drop 3-box interactive choice",
  "tactile telegram haptic feedback and token neon trails",
  "horror alias swap on next login",
  "halloween chips and horror aliases",
  "turn request journal",
  "public origin hapstore.cyber-game.online",
  "login is current @ only, cannot type someone else's handle",
  "same telegram id stays one player after @ rename",
  "telegram handle refresh by numeric id",
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
  "admin /all broadcast",
  "admin /proxies from harvester",
  "bot uses direct Telegram; harvester stays",
  "boot prefers newer disk over stale Firestore",
  "5h idle token hide, turn reminders, quiet hours, daily report, prize cabinet",
] as const;
