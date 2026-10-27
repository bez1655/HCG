/**
 * ============================================================================
 * BOT CONFIGURATION — THE ONLY PLACE IN bot/ THAT READS process.env
 * ============================================================================
 *
 * Mirrors src/config/env.ts on the server side. No token, username, hostname
 * or shared secret is hardcoded: everything is supplied by the environment.
 */
import dotenv from "dotenv";

dotenv.config();

export const IS_PRODUCTION = process.env.NODE_ENV === "production";

const fatalErrors: string[] = [];
const warnings: string[] = [];

function readRaw(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function required(name: string, hint: string): string {
  const value = readRaw(name);
  if (value) return value;
  fatalErrors.push(`${name} is required. ${hint}`);
  return "";
}

function optional(name: string): string | undefined {
  return readRaw(name);
}

function withDefault(name: string, fallback: string): string {
  return readRaw(name) ?? fallback;
}

export const config = {
  /** Telegram bot token from @BotFather. */
  botToken: required("TELEGRAM_BOT_TOKEN", "Obtain it from @BotFather."),

  /**
   * Shared credential for the game server's internal admin API.
   * Must match INTERNAL_API_SECRET on the server.
   */
  internalApiSecret: required(
    "INTERNAL_API_SECRET",
    "It must match the value configured on the game server."
  ),

  /** Internal address of the game server (docker-compose service name). */
  gameServerUrl: withDefault("GAME_SERVER_URL", "http://localhost:3000"),

  /**
   * Public Mini App URL. No default: a hardcoded production hostname would
   * point every fork of this project at somebody else's deployment.
   */
  webAppUrl: optional("WEB_APP_URL"),

  /**
   * Bootstrap administrator handle. No default: hardcoding a personal
   * username both leaked that identity and granted it admin rights in
   * every copy of the source.
   */
  adminUsername: optional("TELEGRAM_ADMIN_USERNAME"),

  /** Group chat that receives public game announcements. */
  groupChatId: optional("TELEGRAM_GROUP_CHAT_ID"),

  /** Writable directory for the admin list and username cache. */
  dataDir: withDefault("DATA_DIR", "."),

  /**
   * Bot API endpoint. Defaults to Telegram's own servers.
   *
   * Overridable because Telegram publishes a self-hosted Bot API server, and
   * because it is the only way to exercise the bot end to end without talking
   * to the real network — the integration test points it at a local stub.
   */
  apiRoot: withDefault("TELEGRAM_API_ROOT", "https://api.telegram.org"),

  /**
   * Outbound proxy for Telegram traffic, e.g. socks5://host:1080.
   *
   * Needed when the host cannot reach api.telegram.org directly — the symptom
   * is `connect ETIMEDOUT 149.154.x.x:443` on every request. Empty means a
   * direct connection.
   */
  /**
   * Один или несколько прокси через запятую, точку с запятой или перевод
   * строки. Бот пробует их по порядку и переключается на следующий, когда
   * текущий перестаёт отвечать.
   *
   * Поддерживаются socks5:// и http://. MTProto — нет: он проксирует протокол
   * клиентов Telegram, а бот ходит на api.telegram.org обычным HTTPS.
   */
  proxyUrl: optional("TELEGRAM_PROXY"),

  /** Как часто перепроверять текущий прокси, мс. По умолчанию 5 минут. */
  proxyCheckMs: Number(readRaw("TELEGRAM_PROXY_CHECK_MS")) || 5 * 60_000,

  /**
   * Ходить ли в Telegram через пул прокси.
   *
   * На сервере в Голландии Telegram доступен напрямую. Парсер при этом
   * остаётся — админу нужны живые адреса командой /proxies. Пустая строка,
   * 0, false, off, no — прямое соединение.
   */
  useProxy: !/^(0|false|off|no|direct)$/i.test(readRaw("BOT_USE_PROXY") ?? "1"),
} as const;

if (!config.webAppUrl) {
  warnings.push("WEB_APP_URL is not set — the 'Open game' button will be hidden.");
}

if (!config.adminUsername) {
  warnings.push(
    "TELEGRAM_ADMIN_USERNAME is not set — no bootstrap administrator exists, " +
      "so approval buttons will reject everyone until one is added to admin_list.json."
  );
}

/** Validate and report. Aborts when a required credential is missing. */
export function loadBotConfig(): void {
  for (const w of warnings) console.warn(`[Config] ${w}`);

  if (fatalErrors.length > 0) {
    console.error("\n[FATAL] Bot cannot start — missing configuration:\n");
    for (const e of fatalErrors) console.error(`  • ${e}`);
    console.error("\nSee .env.example in the repository root.\n");
    process.exit(1);
  }
}

/** Presence-only summary; secrets are never printed. */
export function describeBotConfig(): Record<string, string> {
  return {
    NODE_ENV: process.env.NODE_ENV || "development",
    GAME_SERVER_URL: config.gameServerUrl,
    WEB_APP_URL: config.webAppUrl ?? "not set",
    TELEGRAM_ADMIN_USERNAME: config.adminUsername ?? "not set",
    TELEGRAM_GROUP_CHAT_ID: config.groupChatId ? "set" : "not set",
    TELEGRAM_BOT_TOKEN: config.botToken ? "set" : "not set",
    INTERNAL_API_SECRET: config.internalApiSecret ? "set" : "not set",
    DATA_DIR: config.dataDir,
    TELEGRAM_API_ROOT: config.apiRoot,
    TELEGRAM_PROXY: config.proxyUrl
      ? `${config.proxyUrl.split(/[\n,;]+/).filter((x) => x.trim()).length} адрес(ов)`
      : "not set",
    BOT_USE_PROXY: config.useProxy ? "yes" : "no (direct)",
  };
}
