/**
 * Telegram Mini App `initData` verification.
 *
 * When Telegram opens a Mini App it passes a signed payload describing the
 * user. The signature is an HMAC keyed by the bot token, so a server that
 * knows the token can prove the payload really came from Telegram and was not
 * forged by the page itself.
 *
 * This is what lets a registered player press "ИГРАТЬ" and land straight in
 * the game without typing a password: the identity is asserted by Telegram,
 * not by the browser.
 *
 * Algorithm (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   secret_key       = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   data_check_string = every field except `hash`, as "key=value",
 *                       sorted alphabetically, joined with "\n"
 *   expected_hash    = HMAC_SHA256(key = secret_key, message = data_check_string)
 */
import crypto from "node:crypto";

export interface TelegramUser {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  languageCode?: string;
  isPremium?: boolean;
}

export type InitDataResult =
  | { ok: true; user: TelegramUser; authDate: number; error?: undefined }
  | { ok: false; error: string; user?: undefined; authDate?: undefined };

/** Default freshness window. Telegram recommends rejecting stale payloads. */
export const INIT_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Verify a raw `window.Telegram.WebApp.initData` string.
 *
 * @param initData Raw query-string exactly as Telegram produced it. Any
 *                 re-encoding by the client breaks the signature, so it must
 *                 be forwarded verbatim.
 * @param botToken The token of the bot that owns the Mini App.
 * @param maxAgeMs Reject payloads older than this. 0 disables the check.
 */
export function verifyInitData(
  initData: unknown,
  botToken: string | undefined,
  maxAgeMs: number = INIT_DATA_MAX_AGE_MS
): InitDataResult {
  if (!botToken) {
    return { ok: false, error: "Telegram-вход не настроен на сервере" };
  }
  if (typeof initData !== "string" || initData.length === 0) {
    return { ok: false, error: "Пустые данные Telegram" };
  }
  // A signed payload is small; anything larger is not worth parsing.
  if (initData.length > 4096) {
    return { ok: false, error: "Слишком большой пакет Telegram" };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, error: "Некорректные данные Telegram" };
  }

  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "Отсутствует подпись Telegram" };

  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  // Constant-time comparison; lengths must match first or timingSafeEqual throws.
  const provided = hash.toLowerCase();
  if (provided.length !== expected.length) {
    return { ok: false, error: "Подпись Telegram не совпадает" };
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"))) {
      return { ok: false, error: "Подпись Telegram не совпадает" };
    }
  } catch {
    return { ok: false, error: "Подпись Telegram не совпадает" };
  }

  const authDateRaw = Number(params.get("auth_date"));
  if (!Number.isFinite(authDateRaw) || authDateRaw <= 0) {
    return { ok: false, error: "Некорректная метка времени Telegram" };
  }
  const authDateMs = authDateRaw * 1000;
  if (maxAgeMs > 0 && Date.now() - authDateMs > maxAgeMs) {
    return { ok: false, error: "Сессия Telegram устарела, переоткройте приложение" };
  }

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, error: "Telegram не передал профиль пользователя" };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(userRaw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Не удалось разобрать профиль Telegram" };
  }

  const id = Number(parsed.id);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "Telegram не передал идентификатор пользователя" };
  }

  const username = typeof parsed.username === "string" ? parsed.username : undefined;

  return {
    ok: true,
    authDate: authDateMs,
    user: {
      id,
      username,
      firstName: typeof parsed.first_name === "string" ? parsed.first_name : undefined,
      lastName: typeof parsed.last_name === "string" ? parsed.last_name : undefined,
      languageCode: typeof parsed.language_code === "string" ? parsed.language_code : undefined,
      isPremium: parsed.is_premium === true,
    },
  };
}

/** Normalise a Telegram handle to the "@name" form used as a key everywhere. */
export function normaliseHandle(username: string): string {
  const lower = username.trim().toLowerCase();
  return lower.startsWith("@") ? lower : `@${lower}`;
}
