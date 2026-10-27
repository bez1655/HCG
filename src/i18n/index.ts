/**
 * ============================================================================
 * INTERNATIONALISATION
 * ============================================================================
 *
 * Every user-facing string was hardcoded in Russian across ~20 components,
 * so shipping another language meant editing every file.
 *
 * This is a deliberately small implementation — no runtime dependency, no
 * async loading, full type-safety on keys. Translating the UI now means adding
 * one dictionary; the components stay untouched.
 *
 *   import { t } from "@/src/i18n";
 *   t("login.enterName")
 *   t("game.playerReachedCell", { name: "@player", cell: 42 })
 */

export type Locale = "ru" | "en";

/** Russian is the source language: every key is defined here first. */
const ru = {
  // --- Login ---
  "login.enterName": "Укажите ваше игровое имя!",
  "login.enterPassword": "Введите пароль!",
  "login.connecting": "ПОДКЛЮЧЕНИЕ...",
  "login.connectionError": "Ошибка связи с сервером",
  "login.requestSent": "Запрос отправлен админу!",
  "login.requestFailed": "Не удалось отправить запрос. Попробуйте позже.",
  "login.namePlaceholder": "Например: @neon",
  "login.passwordPlaceholder": "Введите пароль",
  "login.requestRegistration": "ЗАПРОСИТЬ РЕГИСТРАЦИЮ",

  // --- Game ---
  "game.yourTurn": "ВАШ ХОД",
  "game.waitingApproval": "ОЖИДАНИЕ ОДОБРЕНИЯ",
  "game.requestTurn": "ЗАПРОСИТЬ ХОД",
  "game.roll": "БРОСОК",
  "game.notYourTurn": "Сейчас не ваш ход! Запросите одобрение у администратора.",
  "game.newLap": "НОВЫЙ ЦИКЛ",
  "game.finish": "ФИНИШ",

  // --- Chat ---
  "chat.title": "ЧАТ",
  "chat.placeholder": "Сообщение...",
  "chat.send": "Отправить",

  // --- Admin ---
  "admin.console": "КОНСОЛЬ АДМИНИСТРАТОРА",
  "admin.players": "ИГРОКИ",
  "admin.addPlayer": "ДОБАВИТЬ ИГРОКА",
  "admin.deletePlayer": "Удалить игрока",
  "admin.resetGame": "СБРОС ИГРЫ",
  "admin.approveTurn": "Одобрить ход",
  "admin.rejectTurn": "Отклонить",
  "admin.confirmBonus": "Подтвердить выдачу бонуса",
  "admin.passwordProtected": "🔐 Защищен (Хэш PBKDF2)",
  "admin.noPassword": "— (Без пароля)",

  // --- Errors ---
  "error.generic": "Произошла ошибка",
  "error.tooManyRequests": "Слишком много запросов. Попробуйте позже.",
  "error.notFound": "Не найдено",
  "error.forbidden": "Доступ запрещён",
} as const;

export type TranslationKey = keyof typeof ru;

/**
 * English translations. Partial on purpose: any missing key falls back to the
 * Russian source rather than rendering an empty string.
 */
const en: Partial<Record<TranslationKey, string>> = {
  "login.enterName": "Enter your player name!",
  "login.enterPassword": "Enter your password!",
  "login.connecting": "CONNECTING...",
  "login.connectionError": "Cannot reach the server",
  "login.requestSent": "Request sent to the admin!",
  "login.requestFailed": "Could not send the request. Try again later.",
  "login.namePlaceholder": "For example: @neon",
  "login.passwordPlaceholder": "Enter password",
  "login.requestRegistration": "REQUEST REGISTRATION",

  "game.yourTurn": "YOUR TURN",
  "game.waitingApproval": "AWAITING APPROVAL",
  "game.requestTurn": "REQUEST TURN",
  "game.roll": "ROLL",
  "game.notYourTurn": "It is not your turn. Ask an administrator to approve it.",
  "game.newLap": "NEW LAP",
  "game.finish": "FINISH",

  "chat.title": "CHAT",
  "chat.placeholder": "Message...",
  "chat.send": "Send",

  "admin.console": "ADMIN CONSOLE",
  "admin.players": "PLAYERS",
  "admin.addPlayer": "ADD PLAYER",
  "admin.deletePlayer": "Delete player",
  "admin.resetGame": "RESET GAME",
  "admin.approveTurn": "Approve turn",
  "admin.rejectTurn": "Reject",
  "admin.confirmBonus": "Confirm prize handover",
  "admin.passwordProtected": "🔐 Protected (PBKDF2 hash)",
  "admin.noPassword": "— (No password)",

  "error.generic": "Something went wrong",
  "error.tooManyRequests": "Too many requests. Try again later.",
  "error.notFound": "Not found",
  "error.forbidden": "Access denied",
};

const dictionaries: Record<Locale, Partial<Record<TranslationKey, string>>> = { ru, en };

let currentLocale: Locale = "ru";

/** Pick the active locale. Unknown values keep the current one. */
export function setLocale(locale: string): void {
  if (locale in dictionaries) currentLocale = locale as Locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

/** Detect a locale from Telegram or the browser, defaulting to Russian. */
export function detectLocale(): Locale {
  const tg = (globalThis as any).Telegram?.WebApp;
  const candidate: string | undefined =
    tg?.initDataUnsafe?.user?.language_code ??
    (typeof navigator !== "undefined" ? navigator.language : undefined);

  const base = candidate?.split("-")[0]?.toLowerCase();
  return base && base in dictionaries ? (base as Locale) : "ru";
}

/**
 * Translate a key, interpolating {placeholders}.
 * Falls back to Russian, then to the key itself, so nothing renders blank.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const template = dictionaries[currentLocale]?.[key] ?? ru[key] ?? key;
  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match
  );
}
