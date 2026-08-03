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
export const BUILD = "2026-07-30.5";
export const FEATURES = [
  "self-registration button",
  "password-free Telegram entry",
  "two-stage Docker build",
  "TELEGRAM_PROXY support",
] as const;
