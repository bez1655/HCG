/**
 * Telegram delivery.
 *
 * The bot container owns long-polling; this module only sends outbound
 * messages and keeps the "@username -> chat id" map the bot pushes to us.
 *
 * Extracted from server.ts, where the username map was originally declared
 * inside start() while sendTelegramMessage() referenced it from module scope —
 * a ReferenceError that silently dropped every admin notification.
 */
import fs from "node:fs";
import path from "node:path";
import { telegram as telegramConfig } from "../config/env";
import { createLogger, errorContext } from "../utils/logger";
import { callTelegram } from "./transport";

const log = createLogger("Telegram");

let usersFile = "";
let telegramUsers: Record<string, number> = {};

/** Point the module at DATA_DIR and load any cached mapping. */
export function initTelegram(dataDir: string): void {
  usersFile = path.join(dataDir, "telegram_users.json");
  if (!fs.existsSync(usersFile)) return;
  try {
    telegramUsers = JSON.parse(fs.readFileSync(usersFile, "utf-8"));
  } catch (err) {
    log.error("Failed to read telegram_users.json", errorContext(err));
  }
}

/** Normalise to the "@handle" form used as the map key. */
function normalise(username: string): string {
  const lower = username.toLowerCase();
  return lower.startsWith("@") ? lower : `@${lower}`;
}

export function getChatId(username: string): number | undefined {
  return telegramUsers[normalise(username)];
}

/** Record a mapping. Returns true when something actually changed. */
export function rememberUser(username: string, chatId: number): boolean {
  const key = normalise(username);
  if (telegramUsers[key] === chatId) return false;
  telegramUsers[key] = chatId;
  persist();
  return true;
}

/** Write the map atomically; `sync` is used on shutdown. */
export function persist(sync = false): void {
  if (!usersFile) return;
  const contents = JSON.stringify(telegramUsers, null, 2);
  const tmp = `${usersFile}.tmp`;

  if (sync) {
    try {
      fs.writeFileSync(tmp, contents, "utf-8");
      fs.renameSync(tmp, usersFile);
    } catch (err) {
      log.error("Failed to persist telegram_users.json", errorContext(err));
    }
    return;
  }

  fs.writeFile(tmp, contents, "utf-8", (err) => {
    if (err) {
      log.error("Failed to persist telegram_users.json", errorContext(err));
      return;
    }
    fs.rename(tmp, usersFile, (renameErr) => {
      if (renameErr) log.error("Failed to replace telegram_users.json", errorContext(renameErr));
    });
  });
}

/** Send a message. `chatId` may be a numeric id or an "@username". */
export async function sendMessage(
  chatId: string | number,
  text: string,
  replyMarkup?: unknown
): Promise<void> {
  const token = telegramConfig.botToken;
  if (!token || !chatId) return;

  // Resolve "@username" to a numeric chat id when we know it.
  let resolved = chatId;
  if (typeof chatId === "string" && chatId.startsWith("@")) {
    resolved = getChatId(chatId) ?? chatId;
  }

  try {
    const payload: Record<string, unknown> = {
      chat_id: resolved,
      text,
      parse_mode: "HTML",
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    // Goes through src/telegram/transport.ts rather than global fetch: the
    // host may only reach Telegram through a proxy, and fetch() cannot use
    // a SOCKS one. Previously every server-side notification — turn requests
    // above all — was swallowed here without a trace.
    const reply = await callTelegram(token, "sendMessage", payload);

    if (!reply.ok) {
      log.error("Telegram rejected a message", {
        status: reply.status,
        chat: typeof resolved === "string" ? resolved : String(resolved),
        detail: reply.body.slice(0, 200),
      });
    }
  } catch (err) {
    log.error("Failed to send message", errorContext(err));
  }
}

/** Broadcast to the configured group chat, when there is one. */
export async function sendGroupMessage(text: string): Promise<void> {
  if (telegramConfig.groupChatId) await sendMessage(telegramConfig.groupChatId, text);
}

/** Send by username, falling back to the raw handle when unmapped. */
export async function sendToUsername(
  username: string,
  text: string,
  replyMarkup?: unknown
): Promise<void> {
  const chatId = getChatId(username);
  await sendMessage(chatId ?? normalise(username), text, replyMarkup);
}

/** Notify the configured administrator. */
export async function sendToAdmin(text: string, replyMarkup?: unknown): Promise<void> {
  const admin = telegramConfig.adminUsername?.toLowerCase();
  if (!admin) {
    log.warn("TELEGRAM_ADMIN_USERNAME is not configured — dropping admin notification");
    return;
  }
  await sendToUsername(admin, text, replyMarkup);
}
