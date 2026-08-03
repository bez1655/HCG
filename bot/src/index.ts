import { Telegraf, Markup } from "telegraf";
import fs from "fs";
import path from "path";
import { TelegramAsyncQueue } from "./asyncQueue.js";
import { AdminManager } from "./adminManager.js";
import { config, loadBotConfig, describeBotConfig } from "./config.js";
import {
  submitRegistration,
  notifyAdminsAboutRequest,
  credentialsMessage,
  escapeHtml,
  normaliseHandle,
  type RegistrationDeps,
} from "./registration.js";
import { BUILD, FEATURES } from "./version.js";
import { buildTelegramAgent } from "./proxy.js";

// Announced before anything can fail, so it survives in the log even when the
// bot cannot reach Telegram. Without it, "nothing changed" cannot be told
// apart from "a stale image is running".
console.log(`[HCG bot] build ${BUILD} — ${FEATURES.join(", ")}`);

// Validate configuration before touching Telegram or the game server.
loadBotConfig();

const BOT_TOKEN = config.botToken;
const WEB_APP_URL = config.webAppUrl;
const GAME_SERVER_URL = config.gameServerUrl;
const GROUP_CHAT_ID = config.groupChatId;
const INTERNAL_API_SECRET = config.internalApiSecret;

/** fetch() wrapper that attaches the shared internal-API credential. */
async function internalFetch(pathname: string, init: RequestInit = {}) {
  return fetch(`${GAME_SERVER_URL}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": INTERNAL_API_SECRET,
      ...(init.headers || {}),
    },
  });
}

// Route Telegram traffic through a proxy when one is configured. Some hosts
// cannot reach api.telegram.org at all — every request dies with
// `connect ETIMEDOUT 149.154.x.x:443` — and no amount of retrying helps.
const telegramTransport = buildTelegramAgent(config.proxyUrl);
console.log(`[HCG bot] Telegram transport: ${telegramTransport.description}`);

export const bot = new Telegraf(BOT_TOKEN, {
  telegram: { apiRoot: config.apiRoot, agent: telegramTransport.agent },
});
export const asyncQueue = new TelegramAsyncQueue(bot);
export const adminManager = new AdminManager();

// User mapping storage (@username -> chatId)
const TELEGRAM_USERS_FILE = path.join(config.dataDir, "telegram_users.json");
let telegramUsers: Record<string, number> = {};

function loadTelegramUsers() {
  if (fs.existsSync(TELEGRAM_USERS_FILE)) {
    try {
      telegramUsers = JSON.parse(fs.readFileSync(TELEGRAM_USERS_FILE, "utf-8"));
    } catch (e) {
      console.error("[Bot] Error reading telegram_users.json", e);
    }
  }
}

function saveTelegramUser(username?: string, chatId?: number) {
  if (!username || !chatId) return;
  telegramUsers[normaliseHandle(username)] = chatId;
  try {
    fs.writeFileSync(TELEGRAM_USERS_FILE, JSON.stringify(telegramUsers, null, 2));
  } catch (e) {
    console.error("[Bot] Error writing telegram_users.json", e);
  }
}

/** Look up a cached chat id for a handle. */
function chatIdFor(username: string): number | undefined {
  return telegramUsers[normaliseHandle(username)];
}

loadTelegramUsers();

const registrationDeps: RegistrationDeps = {
  internalFetch,
  queue: asyncQueue,
  admins: adminManager,
  webAppUrl: WEB_APP_URL,
};

// ---------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------

/**
 * Buttons shown to a player.
 *
 * "ИГРАТЬ" is a web_app button: Telegram opens the Mini App and passes a
 * signed initData blob, which the game server verifies. A registered player is
 * therefore recognised without typing anything — that is the whole point of
 * binding the account at registration time.
 *
 * The button is only rendered when WEB_APP_URL is configured; without a public
 * HTTPS origin Telegram refuses to open a Mini App at all.
 */
type InlineButton =
  ReturnType<typeof Markup.button.webApp> | ReturnType<typeof Markup.button.callback>;

function playerKeyboard(registered: boolean) {
  const rows: InlineButton[][] = [];
  if (WEB_APP_URL) {
    rows.push([Markup.button.webApp("🎮 ИГРАТЬ", WEB_APP_URL)]);
  }
  if (!registered) {
    rows.push([Markup.button.callback("📝 ЗАПРОСИТЬ РЕГИСТРАЦИЮ", "self_register")]);
  }
  rows.push([Markup.button.callback("ℹ️ ПОМОЩЬ", "show_help")]);
  return Markup.inlineKeyboard(rows);
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Capture the @username -> chatId mapping. The bot is the single Telegram
// long-polling consumer, so it forwards what it observes to the game server
// (which used to run its own competing getUpdates loop).
bot.use(async (ctx, next) => {
  if (ctx.from?.username && ctx.chat?.id) {
    const formatted = normaliseHandle(ctx.from.username);
    const chatId = ctx.chat.id;
    const alreadyKnown = telegramUsers[formatted] === chatId;
    saveTelegramUser(ctx.from.username, chatId);

    if (!alreadyKnown) {
      internalFetch("/api/internal/telegram-user", {
        method: "POST",
        body: JSON.stringify({ username: formatted, chatId }),
      }).catch((e) =>
        console.warn("[Bot] Could not sync telegram user mapping to server:", e?.message || e)
      );
    }
  }
  return next();
});

// ---------------------------------------------------------------------------
// Player commands
// ---------------------------------------------------------------------------

/**
 * Ask the game server whether this Telegram account is already a player.
 *
 * Used only to decide which buttons to draw — the answer is advisory, and any
 * failure degrades to "show the registration button", which is harmless
 * because the server rejects a duplicate request anyway.
 */
async function isRegistered(username?: string): Promise<boolean> {
  if (!username) return false;
  try {
    const res = await internalFetch(
      `/api/internal/player-status?username=${encodeURIComponent(normaliseHandle(username))}`
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { registered?: boolean };
    return data.registered === true;
  } catch {
    return false;
  }
}

const WELCOME = (name: string, registered: boolean) =>
  `🤖 <b>HCG — Hapstore Cyber Game</b>\n\nПривет, ${escapeHtml(name)}!\n\n` +
  (registered
    ? "Вы зарегистрированы. Нажмите «🎮 ИГРАТЬ» — пароль вводить не нужно."
    : "Чтобы попасть в игру, нажмите «📝 ЗАПРОСИТЬ РЕГИСТРАЦИЮ».\n" +
      "Администратор подтвердит заявку, и бот пришлёт сюда ваш логин и пароль.");

bot.start(async (ctx) => {
  const display = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const registered = await isRegistered(ctx.from.username);
  return ctx.reply(WELCOME(display, registered), {
    parse_mode: "HTML",
    ...playerKeyboard(registered),
  });
});

/** Shared implementation for /register and the inline button. */
async function handleRegistrationRequest(ctx: any): Promise<void> {
  const outcome = await submitRegistration(registrationDeps, {
    username: ctx.from?.username,
    id: ctx.from?.id,
    firstName: ctx.from?.first_name,
    chatId: ctx.chat?.id ?? ctx.from?.id,
  });

  await ctx.reply(outcome.reply, {
    parse_mode: "HTML",
    ...(outcome.handle && !outcome.notifyAdmins ? playerKeyboard(true) : {}),
  });

  if (outcome.notifyAdmins) {
    await notifyAdminsAboutRequest(
      registrationDeps,
      { handle: outcome.handle, id: ctx.from.id, firstName: ctx.from.first_name },
      chatIdFor
    );
  }
}

bot.command("register", (ctx) => handleRegistrationRequest(ctx));

bot.action("self_register", async (ctx) => {
  await ctx.answerCbQuery();
  await handleRegistrationRequest(ctx);
});

bot.command("play", async (ctx) => {
  if (!WEB_APP_URL) {
    return ctx.reply("⚠️ Адрес игры не настроен. Сообщите администратору.");
  }
  const registered = await isRegistered(ctx.from.username);
  if (!registered) {
    return ctx.reply(
      "Вы ещё не зарегистрированы. Отправьте /register — администратор подтвердит заявку.",
      playerKeyboard(false)
    );
  }
  return ctx.reply("Открывайте доску 👇", playerKeyboard(true));
});

const HELP_TEXT =
  "<b>Команды HCG</b>\n\n" +
  "/start — начало работы и кнопки\n" +
  "/register — запросить регистрацию\n" +
  "/play — кнопка «ИГРАТЬ»\n" +
  "/help — эта справка\n\n" +
  "<b>Как это работает</b>\n" +
  "1. Вы отправляете заявку.\n" +
  "2. Администратор нажимает «ЗАРЕГИСТРИРОВАТЬ».\n" +
  "3. Бот присылает сюда логин и пароль.\n" +
  "4. Внутри Telegram пароль не нужен — кнопка «ИГРАТЬ» пускает сразу. " +
  "Пароль пригодится только для входа через браузер.";

bot.help((ctx) => ctx.reply(HELP_TEXT, { parse_mode: "HTML" }));

bot.action("show_help", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
});

// ---------------------------------------------------------------------------
// Admin commands
// ---------------------------------------------------------------------------

// Admin Command /admin_logs [search]
bot.command("admin_logs", adminManager.middleware(), async (ctx) => {
  const args = ctx.message.text.split(" ").slice(1).join(" ");
  try {
    const res = await internalFetch("/api/admin/logs-history");
    if (!res.ok) {
      return ctx.reply("❌ Не удалось получить логи с игрового сервера.");
    }
    const data = await res.json();
    let logs: any[] = data.logs || [];

    if (args) {
      const query = args.toLowerCase();
      logs = logs.filter(
        (l) =>
          l.message?.toLowerCase().includes(query) ||
          l.type?.toLowerCase().includes(query) ||
          l.timestamp?.toLowerCase().includes(query)
      );
    }

    const recent = logs.slice(0, 15);
    if (recent.length === 0) {
      return ctx.reply(`📋 Логи не найдены${args ? ` по запросу "${args}"` : ""}.`);
    }

    const formattedLogs = recent
      .map((l) => `• <b>[${l.timestamp || "—"}]</b> (${l.type || "sys"}): ${escapeHtml(l.message)}`)
      .join("\n");

    return ctx.reply(
      `📊 <b>История действий администратора (последние ${recent.length}):</b>\n\n${formattedLogs}`,
      { parse_mode: "HTML" }
    );
  } catch (e: any) {
    return ctx.reply(`⚠️ Ошибка подключения к серверу: ${e.message}`);
  }
});

/** Registration requests still awaiting a decision. */
bot.command("pending", adminManager.middleware(), async (ctx) => {
  try {
    const res = await internalFetch("/api/admin/registration-requests");
    if (!res.ok) return ctx.reply("❌ Не удалось получить список заявок.");

    const data = (await res.json()) as {
      requests?: Array<{ username: string; firstName?: string; requestedAt: number }>;
    };
    const requests = data.requests || [];

    if (requests.length === 0) {
      return ctx.reply("✅ Заявок на регистрацию нет.");
    }

    // Each request gets its own message so the buttons stay attached to it.
    await ctx.reply(`📋 <b>Заявок ожидает: ${requests.length}</b>`, { parse_mode: "HTML" });
    for (const r of requests) {
      const when = new Date(r.requestedAt).toLocaleString("ru-RU");
      await ctx.reply(
        `👤 <b>${escapeHtml(r.username)}</b>\n` +
          (r.firstName ? `Имя: ${escapeHtml(r.firstName)}\n` : "") +
          `Заявка от: ${when}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("✅ ЗАРЕГИСТРИРОВАТЬ", `approve_reg:${r.username}`)],
            [Markup.button.callback("❌ ОТКАЗАТЬ", `reject_reg:${r.username}`)],
          ]),
        }
      );
    }
  } catch (e: any) {
    return ctx.reply(`⚠️ Ошибка связи с сервером: ${e.message}`);
  }
});

// Admin Command /set_admin @username
bot.command("set_admin", adminManager.middleware(), async (ctx) => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) {
    return ctx.reply("Использование: /set_admin @username");
  }
  const newAdmin = parts[1].trim();
  adminManager.addAdmin(newAdmin);
  return ctx.reply(
    `✅ Администратор <b>${escapeHtml(newAdmin)}</b> добавлен в доверенный список!`,
    {
      parse_mode: "HTML",
    }
  );
});

// Admin Command /list_admins
bot.command("list_admins", adminManager.middleware(), async (ctx) => {
  const admins = adminManager.getAdmins();
  return ctx.reply(`👑 <b>Список администраторов:</b>\n${escapeHtml(admins.join("\n"))}`, {
    parse_mode: "HTML",
  });
});

// Admin Command /reload_admins
bot.command("reload_admins", adminManager.middleware(), async (ctx) => {
  adminManager.reloadAdmins();
  const admins = adminManager.getAdmins();
  return ctx.reply(`🔄 <b>Список администраторов обновлен:</b>\n${escapeHtml(admins.join("\n"))}`, {
    parse_mode: "HTML",
  });
});

// ---------------------------------------------------------------------------
// Registration decisions
// ---------------------------------------------------------------------------

/**
 * ЗАРЕГИСТРИРОВАТЬ.
 *
 * The game server creates the player, generates the password and returns it
 * once. `deliverBy: "bot"` is passed because the bot holds the private chat id
 * even for a player the server has never messaged.
 */
bot.action(/approve_reg:(.+)/, async (ctx) => {
  const targetUser = normaliseHandle(ctx.match[1]);
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  if (!adminManager.isAdmin(ctx.from.username)) {
    return ctx.answerCbQuery("⛔ Только админ может утверждать регистрацию!", { show_alert: true });
  }

  try {
    const res = await internalFetch("/api/admin/bot-approve-registration", {
      method: "POST",
      body: JSON.stringify({ username: targetUser, admin: adminName, deliverBy: "bot" }),
    });

    const data = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      created?: boolean;
      password?: string;
      chatId?: number;
      error?: string;
    };

    if (!res.ok || !data.success) {
      return ctx.answerCbQuery(`Ошибка: ${data.error || "не удалось зарегистрировать"}`, {
        show_alert: true,
      });
    }

    if (!data.created) {
      await ctx.editMessageText(
        `ℹ️ <b>УЖЕ ЗАРЕГИСТРИРОВАН</b>\nИгрок: <b>${escapeHtml(targetUser)}</b>`,
        { parse_mode: "HTML" }
      );
      return ctx.answerCbQuery("Игрок уже был в базе");
    }

    // Deliver the credentials to the player's private chat. Prefer the chat id
    // the server returned (it came from the original request), then the cached
    // mapping, then the raw handle.
    const recipient = data.chatId ?? chatIdFor(targetUser) ?? targetUser;
    let delivered = true;
    try {
      await asyncQueue.sendMessage(
        recipient,
        credentialsMessage(targetUser, data.password || ""),
        WEB_APP_URL ? Markup.inlineKeyboard([[Markup.button.webApp("🎮 ИГРАТЬ", WEB_APP_URL)]]) : {}
      );
    } catch {
      delivered = false;
    }

    await ctx.editMessageText(
      `✅ <b>ЗАРЕГИСТРИРОВАН</b>\n` +
        `Игрок: <b>${escapeHtml(targetUser)}</b>\n` +
        `Администратор: ${escapeHtml(adminName)}\n\n` +
        (delivered
          ? `<i>Логин и пароль отправлены игроку в личный чат.</i>`
          : `⚠️ <b>Не удалось доставить пароль!</b> Игрок ещё не запускал бота. ` +
            `Попросите его нажать /start и выдайте пароль вручную через админ-панель.`),
      { parse_mode: "HTML" }
    );

    return ctx.answerCbQuery(
      delivered ? "Игрок зарегистрирован, пароль отправлен" : "Создан, но пароль не доставлен",
      { show_alert: !delivered }
    );
  } catch (e: any) {
    return ctx.answerCbQuery(`Ошибка связи с сервером: ${e.message}`, { show_alert: true });
  }
});

/** ОТКАЗАТЬ. Drops the queued request; nothing is created. */
bot.action(/reject_reg:(.+)/, async (ctx) => {
  const targetUser = normaliseHandle(ctx.match[1]);
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  if (!adminManager.isAdmin(ctx.from.username)) {
    return ctx.answerCbQuery("⛔ Только админ!", { show_alert: true });
  }

  let chatId: number | undefined;
  try {
    const res = await internalFetch("/api/admin/bot-reject-registration", {
      method: "POST",
      body: JSON.stringify({ username: targetUser, admin: adminName }),
    });
    const data = (await res.json().catch(() => ({}))) as { chatId?: number };
    chatId = data.chatId;
  } catch {
    // The server may be down; the player should still be told.
  }

  await ctx.editMessageText(
    `❌ <b>В РЕГИСТРАЦИИ ОТКАЗАНО</b>\n` +
      `Игрок: <b>${escapeHtml(targetUser)}</b>\n` +
      `Администратор: ${escapeHtml(adminName)}`,
    { parse_mode: "HTML" }
  );

  const recipient = chatId ?? chatIdFor(targetUser) ?? targetUser;
  try {
    await asyncQueue.sendMessage(
      recipient,
      "❌ Ваша заявка на регистрацию отклонена администратором.\n\n" +
        "Если это ошибка — свяжитесь с администратором и отправьте /register ещё раз."
    );
  } catch {
    /* the player may never have started the bot */
  }

  return ctx.answerCbQuery("Заявка отклонена");
});

// ---------------------------------------------------------------------------
// Turn approval
// ---------------------------------------------------------------------------

bot.action(/approve_turn:(.+)/, async (ctx) => {
  const playerId = ctx.match[1];
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  if (!adminManager.isAdmin(ctx.from.username)) {
    return ctx.answerCbQuery("⛔ Только админ!", { show_alert: true });
  }

  await handleTurnApproval(ctx, playerId, adminName, false);
});

// Same as above, but the admin has confirmed the outstanding prize was handed
// over in real life, so the prize-control block can be released.
bot.action(/approve_turn_bonus:(.+)/, async (ctx) => {
  const playerId = ctx.match[1];
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  if (!adminManager.isAdmin(ctx.from.username)) {
    return ctx.answerCbQuery("⛔ Только админ!", { show_alert: true });
  }

  await handleTurnApproval(ctx, playerId, adminName, true);
});

async function handleTurnApproval(
  ctx: any,
  playerId: string,
  adminName: string,
  confirmBonusUse: boolean
) {
  try {
    const res = await internalFetch("/api/admin/bot-approve-turn", {
      method: "POST",
      body: JSON.stringify({ playerId, admin: adminName, confirmBonusUse }),
    });

    const data = await res.json();

    if (res.ok && data.success) {
      const playerName = data.playerName || playerId;
      await ctx.editMessageText(
        `🟢 <b>ХОД ОДОБРЕН</b>\nИгрок: <b>${escapeHtml(playerName)}</b>\nАдминистратор: ${escapeHtml(adminName)}` +
          (confirmBonusUse ? `\n<i>Бонус подтверждён и списан.</i>` : ""),
        { parse_mode: "HTML" }
      );
      sendDirectMessageToUser(playerName, "ПОРА СДЕЛАТЬ БРОСОК");
      return ctx.answerCbQuery("Ход одобрен!");
    }

    // 409 => the player still holds an unredeemed prize. Offer an explicit
    // confirmation button instead of silently failing.
    if (res.status === 409) {
      await ctx.editMessageText(
        `⚠️ <b>ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ БОНУСА</b>\n\n${escapeHtml(data.error)}`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "✅ Бонус выдан — одобрить ход",
                `approve_turn_bonus:${playerId}`
              ),
            ],
            [Markup.button.callback("🔴 Отклонить", `reject_turn:${playerId}`)],
          ]),
        }
      );
      return ctx.answerCbQuery("Подтвердите выдачу бонуса", { show_alert: true });
    }

    return ctx.answerCbQuery(`Ошибка: ${data.error || "Не удалось одобрить ход"}`, {
      show_alert: true,
    });
  } catch (e: any) {
    return ctx.answerCbQuery(`Ошибка сервера: ${e.message}`, { show_alert: true });
  }
}

bot.action(/reject_turn:(.+)/, async (ctx) => {
  const playerId = ctx.match[1];
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  if (!adminManager.isAdmin(ctx.from.username)) {
    return ctx.answerCbQuery("⛔ Только админ!", { show_alert: true });
  }

  await ctx.editMessageText(
    `🔴 <b>ХОД ОТКЛОНЕН</b>\nИгрок: <b>${escapeHtml(playerId)}</b>\nАдминистратор: ${escapeHtml(adminName)}`,
    { parse_mode: "HTML" }
  );
  return ctx.answerCbQuery("Запрос хода отклонен.");
});

// ---------------------------------------------------------------------------
// Outbound helpers
// ---------------------------------------------------------------------------

export async function sendDirectMessageToUser(username: string, message: string) {
  loadTelegramUsers();
  const formatted = normaliseHandle(username);
  const chatId = telegramUsers[formatted];

  if (chatId) {
    await asyncQueue.sendMessage(chatId, message);
  } else {
    // If numeric chatId isn't cached yet, try sending to @username directly
    try {
      await asyncQueue.sendMessage(formatted, message);
    } catch {
      console.warn(`[Bot] Could not deliver message to ${username}`);
    }
  }
}

export async function sendAlertToAdmins(message: string, extraKeyboard?: any) {
  loadTelegramUsers();
  for (const adminUser of adminManager.getAdmins()) {
    const recipient = chatIdFor(adminUser) ?? adminUser;
    try {
      await asyncQueue.sendMessage(recipient, message, extraKeyboard);
    } catch (e) {
      console.error(`[Bot] Failed to send admin alert to ${adminUser}:`, e);
    }
  }
}

export async function broadcastToGroup(message: string) {
  if (GROUP_CHAT_ID) {
    try {
      await asyncQueue.sendMessage(GROUP_CHAT_ID, message);
    } catch (e) {
      console.error(`[Bot] Failed group broadcast:`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

if (BOT_TOKEN) {
  // Published command list, so players see them in the Telegram menu.
  void bot.telegram
    .setMyCommands([
      { command: "start", description: "Начало работы" },
      { command: "register", description: "Запросить регистрацию" },
      { command: "play", description: "Открыть игру" },
      { command: "help", description: "Справка" },
    ])
    .catch((e) => console.warn("[Bot] Could not publish command list:", e?.message || e));

  // launch() resolves only when polling STOPS, not when it starts — the
  // promise stays pending for the entire life of a healthy bot. Chaining
  // .then() onto it therefore meant the success line was never printed while
  // the bot was running, which made a working bot look identical to a broken
  // one in the log.
  //
  // The second argument is Telegraf's callback for "connected to Telegram,
  // about to poll" — that is the moment worth announcing.
  // Watchdog. A TCP connection to api.telegram.org that is accepted and then
  // never answered — a firewall that DROPs instead of REJECTing, a dead
  // proxy — leaves getMe pending forever. No error is raised, so the bot sits
  // silent: no "started" line, no reply to /start, nothing in the log but the
  // build marker. Give the connection a deadline and fail loudly instead.
  const CONNECT_TIMEOUT_MS = Number(process.env.BOT_CONNECT_TIMEOUT_MS) || 45_000;
  let connected = false;
  const watchdog = setTimeout(() => {
    if (connected) return;
    console.error("\n" + "=".repeat(64));
    console.error("❌ НЕТ ОТВЕТА ОТ TELEGRAM / TELEGRAM IS NOT RESPONDING");
    console.error("=".repeat(64));
    console.error(
      `Соединение установлено, но за ${CONNECT_TIMEOUT_MS / 1000} с Telegram не ответил.\n\n` +
        "Обычно это значит, что запросы к api.telegram.org отбрасываются:\n" +
        "  • блокировка со стороны провайдера или firewall сервера;\n" +
        "  • нерабочий прокси;\n" +
        "  • сломанный DNS.\n\n" +
        "Проверьте прямо с сервера:\n" +
        "  curl -s -m 10 https://api.telegram.org/bot<ТОКЕН>/getMe\n" +
        "Если команда тоже висит — проблема в сети, а не в боте."
    );
    console.error("=".repeat(64) + "\n");
    process.exit(1);
  }, CONNECT_TIMEOUT_MS);
  watchdog.unref?.();

  bot
    .launch(() => {
      connected = true;
      clearTimeout(watchdog);
      console.log("🤖 Telegram Bot started successfully via Long Polling!");
      console.log("[Config]", JSON.stringify(describeBotConfig(), null, 2));
    })
    .catch((err) => {
      clearTimeout(watchdog);
      // A failed launch used to be logged and then ignored. Nothing else kept
      // the event loop alive, so the process exited with status 0 — which
      // Docker's `restart: always` reads as a clean stop and restarts anyway.
      // The result was a silent restart loop whose only symptom was
      // "hcg_bot: restarting", with the actual reason scrolled out of the log.
      //
      // Fail loudly and exit non-zero instead: the message below is the last
      // thing in the log, and the status makes the failure unambiguous.
      const code = err?.response?.error_code ?? err?.code;
      const description = err?.response?.description ?? err?.message ?? String(err);

      console.error("\n" + "=".repeat(64));
      console.error("❌ БОТ НЕ СМОГ ЗАПУСТИТЬСЯ / BOT FAILED TO START");
      console.error("=".repeat(64));
      console.error(`Причина: ${description}`);

      if (code === 401) {
        console.error(
          "\nTelegram отверг токен (401 Unauthorized).\n" +
            "  • Токен в TELEGRAM_BOT_TOKEN неверный, либо был отозван в @BotFather.\n" +
            "  • Получите новый: @BotFather → /mybots → Bot Settings → API Token\n" +
            "  • Впишите его в .env и выполните: docker compose up -d --force-recreate hcg_bot"
        );
      } else if (code === 409) {
        console.error(
          "\nКонфликт (409): этот же токен уже используется другим процессом.\n" +
            "  • Скорее всего работает старый контейнер с тем же ботом.\n" +
            "  • Проверьте: docker ps -a | grep -i hapstore\n" +
            "  • Уберите лишнее: docker compose up -d --remove-orphans"
        );
      } else if (
        code === "ETIMEDOUT" ||
        code === "ECONNRESET" ||
        /ETIMEDOUT|ECONNRESET/.test(description)
      ) {
        // The connection was never established: packets left the host and
        // nothing came back. That is a network-level block, not a bot fault.
        console.error(
          "\nСоединение с api.telegram.org не устанавливается (таймаут).\n" +
            "Пакеты уходят и не возвращаются — Telegram недоступен с этого сервера.\n\n" +
            "  • Проверьте прямо на сервере:\n" +
            "      curl -v -m 15 https://api.telegram.org\n" +
            "    Если команда тоже висит — блокирует провайдер или firewall.\n\n" +
            "  • Решение: пропишите прокси в .env и перезапустите бота\n" +
            "      TELEGRAM_PROXY=socks5://пользователь:пароль@хост:1080\n" +
            "      docker compose up -d --force-recreate hcg_bot"
        );
      } else if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN") {
        console.error(
          "\nНет сети до api.telegram.org.\n" +
            "  • Проверьте интернет и DNS на сервере.\n" +
            "  • Если Telegram блокируется — потребуется прокси:\n" +
            "      TELEGRAM_PROXY=socks5://хост:1080"
        );
      }

      console.error("=".repeat(64) + "\n");
      process.exit(1);
    });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
