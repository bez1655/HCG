/**
 * Where the game server lives, and how this build talks to it.
 *
 * Two builds share this file:
 *
 *   • Browser / Telegram Mini App — the client is served BY the game server,
 *     so relative paths resolve to the right host on their own. API_BASE is
 *     empty and everything behaves exactly as before.
 *
 *   • Android APK — the page is loaded from the device itself
 *     (https://localhost via Capacitor), so a relative path would resolve to
 *     the app bundle rather than the server. The absolute origin is baked in
 *     at build time through VITE_API_BASE_URL.
 *
 * Keeping one implementation matters more than it looks: a second copy of the
 * UI for the APK would drift from this one within a week, and the two would
 * disagree about how login works.
 */

/** Set at build time. Empty in the browser build. */
const RAW = (import.meta.env.VITE_API_BASE_URL ?? "").trim();

/** Absolute server origin without a trailing slash, or "" for same-origin. */
export const API_BASE: string = RAW.replace(/\/+$/, "");

/** True when this build targets a remote server (the APK case). */
export const IS_STANDALONE_BUILD = API_BASE !== "";

/**
 * Whether the Telegram sign-in path should even be attempted.
 *
 * The standalone app is opened from the launcher, never from Telegram, so
 * there is no signed initData to verify. Skipping the attempt avoids a
 * pointless request and a confusing "session expired" message on first run.
 */
export const TELEGRAM_LOGIN_ENABLED = !IS_STANDALONE_BUILD;

/** Build a full URL for an API path. */
export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${suffix}`;
}

/**
 * fetch() against the game server.
 *
 * `credentials: "omit"` is deliberate: authentication uses a signed session
 * token carried in the body and the socket handshake, never cookies. Asking
 * for credentials cross-origin would demand stricter CORS for no benefit.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiUrl(path), { ...init, credentials: "omit" });
}

/**
 * Origin for the Socket.IO client.
 *
 * socket.io-client accepts undefined to mean "same origin as the page", which
 * is what the browser build needs.
 */
export function socketUrl(): string | undefined {
  return API_BASE === "" ? undefined : API_BASE;
}
