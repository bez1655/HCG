import { Telegraf, Markup, type Context } from "telegraf";
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
import { parseProxyEntry, parseProxyList, ProxyPool } from "./proxyPool.js";
import { LeaseHolder, leaseUrl } from "./leaseClient.js";
import { PendingCredentialStore } from "./pendingCredentials.js";
import { formatWorkingProxies, listWorkingProxies } from "./workingProxies.js";

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

// Пул прокси. Некоторые сети вообще не пропускают трафик до
// api.telegram.org — каждый запрос умирает с `connect ETIMEDOUT
// 149.154.x.x:443`. Бесплатные прокси при этом живут часы, поэтому одного
// адреса мало: нужен список с автоматическим переключением.
const { entries: proxyEntries, errors: proxyErrors } = parseProxyList(config.proxyUrl);

// Адреса из .env — только на время до первой выдачи сборщика.
// Дальше их полностью замещает аренда.

// Как часто перечитывать файл сборщика. Чаще, чем идёт цикл сборщика:
// файл появляется в произвольный момент, и ждать полный цикл незачем.
const HARVEST_POLL_MS = 15_000;

// Аренда: сколько рабочих прокси держать на руках.
const LEASE_SIZE = Number(process.env.PROXY_LEASE_SIZE) || 5;

export const lease = new LeaseHolder(config.dataDir, "bot", LEASE_SIZE, (m) => console.log(m));

// Сколько ждать список от сборщика, прежде чем сдаться и выйти.
// Чуть больше его цикла: успеть увидеть первый результат, но не висеть
// молча, если сборщика вовсе нет.
//
// Переопределяется переменной окружения: e2e-тесты проверяют, что бот
// выходит с ненулевым кодом, и 90 секунд ожидания там ни к чему —
// проверяется сам факт выхода, а не длительность паузы.
const HARVEST_RESCUE_MS = Number(process.env.BOT_HARVEST_RESCUE_MS) || 90_000;

for (const err of proxyErrors) {
  console.error(`[HCG bot] Проблема в TELEGRAM_PROXY: ${err}`);
}

// Прямое соединение — всегда последний запасной вариант: там, где Telegram
// доступен напрямую, список прокси может быть просто не нужен.
if (!proxyEntries.some((e) => e.kind === "direct")) {
  const { entries: direct } = parseProxyList("direct");
  proxyEntries.push(...direct);
}

export const proxyPool = new ProxyPool(
  proxyEntries,
  BOT_TOKEN,
  (m) => console.log(m),
  config.apiRoot
);

if (!config.useProxy) {
  const { entries: directOnly } = parseProxyList("direct");
  proxyPool.replaceEntries(directOnly);
  console.log("[HCG bot] Прокси бота выключены (BOT_USE_PROXY=0) — прямое соединение");
} else {
  console.log(
    `[HCG bot] Прокси: ${proxyEntries.length} вариант(ов) — ` +
      proxyEntries.map((e) => e.label).join(", ")
  );
}

export const bot = new Telegraf(BOT_TOKEN, {
  // Агент берётся у пула при каждом запросе: после переключения новые
  // соединения идут через новый адрес без перезапуска бота.
  telegram: {
    apiRoot: config.apiRoot,
    get agent() {
      return proxyPool.agent;
    },
  } as never,
});
export const asyncQueue = new TelegramAsyncQueue(bot);
export const adminManager = new AdminManager();

// User mapping storage (@username -> chatId)
const TELEGRAM_USERS_FILE = path.join(config.dataDir, "telegram_users.json");

/**
 * Passwords for players the administrator registered by hand.
 *
 * The server writes them into the shared volume; the bot hands each one over
 * the first time that player opens the chat, then deletes it. Until then
 * Telegram simply will not let us message someone who has never written to
 * the bot.
 */
const pendingCredentials = new PendingCredentialStore(config.dataDir, (m) => console.log(m));
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

  await ctx.reply(WELCOME(display, registered), {
    parse_mode: "HTML",
    ...playerKeyboard(registered),
  });

  // Пароль, оставленный сервером при ручной регистрации админом. Выдаётся
  // один раз и тут же удаляется: пока игрок не написал боту, отправить ему
  // ничего нельзя, поэтому первый /start — единственный момент для этого.
  await deliverPendingCredentials(ctx);
});

/**
 * Отдать пароль, если он ждёт этого пользователя.
 *
 * Ошибка отправки не должна стоить игроку пароля, поэтому запись удаляется
 * только после успешной доставки: claim() уже забрал её, и при сбое мы
 * кладём обратно. Иначе неудачная отправка означала бы пароль, потерянный
 * навсегда.
 */
async function deliverPendingCredentials(ctx: Context): Promise<void> {
  const username = ctx.from?.username;
  if (!username) return;

  const found = pendingCredentials.claim(username);
  if (!found) return;

  try {
    await ctx.reply(credentialsMessage(found.handle, found.password), {
      parse_mode: "HTML",
      ...playerKeyboard(true),
    });
  } catch (err) {
    pendingCredentials.put(found.handle, found.password);
    console.error(
      `[HCG bot] Не удалось передать пароль ${found.handle}: ${(err as Error).message}`
    );
  }
}

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

/**
 * Справка игроку.
 *
 * Админские команды отсюда убраны: раньше «/turns» и «/msg» видел любой
 * участник, хотя выполнить их всё равно не мог. Лишний повод пробовать чужие
 * возможности и задавать вопросы.
 */
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
  "3a. Купили несколько товаров — в игре при запросе хода укажите, сколько " +
  "бросков вам нужно. Одобрят все сразу, ждать между бросками не придётся.\n" +
  "4. Внутри Telegram пароль не нужен — кнопка «ИГРАТЬ» пускает сразу. " +
  "Пароль пригодится только для входа через браузер.\n\n" +
  "<i>В игре вас видят под игровым псевдонимом — ваш Telegram другим " +
  "участникам не показывается.</i>";

/** Полная справка для администратора: все команды, сгруппированные по делу. */
const ADMIN_HELP_TEXT =
  "<b>Команды HCG — администратор</b>\n\n" +
  "<b>Что ждёт решения</b>\n" +
  "/requests — сводка: заявки, запросы ходов, невыданные призы\n" +
  "/pending — заявки на регистрацию с кнопками\n" +
  "/players — выгрузить полный список игроков файлом\n\n" +
  "<b>Ходы</b>\n" +
  "/turns &lt;кого&gt; [сколько] — выдать ходы без заявки\n" +
  "   например: <code>/turns Бэтмен 3</code>\n\n" +
  "<b>Связь с игроком</b>\n" +
  "/msg &lt;кого&gt; &lt;текст&gt; — личное сообщение игроку\n" +
  "   по псевдониму: <code>/msg Бэтмен Ваш приз готов</code>\n" +
  "   по хендлу: <code>/msg @ivan Ваш приз готов</code>\n" +
  "   псевдоним из двух слов — в кавычках\n" +
  "/all &lt;текст&gt; — написать всем игрокам\n" +
  "/proxies — рабочие прокси с парсера\n" +
  "/prizes &lt;кого&gt; — кабинет призов\n" +
  "/report — отчёт за день\n\n" +
  "<b>Журнал и администраторы</b>\n" +
  "/admin_logs [поиск] — журнал игры\n" +
  "/set_admin @username — добавить администратора\n" +
  "/del_admin @username — снять администратора\n" +
  "/list_admins — список (только вам)\n" +
  "/reload_admins — перечитать список\n\n" +
  "<b>Общие</b>\n" +
  "/start · /play · /help\n\n" +
  "<i>Кого угодно можно назвать и псевдонимом, и настоящим @хендлом — " +
  "вы видите оба. Игроки видят только псевдонимы.</i>\n" +
  "<i>Обратиться к игроку можно и из чата игры: напишите его псевдоним " +
  "в сообщении, и он получит текст в Telegram.</i>";

/** Справка по роли: админ видит свои команды, игрок — свои. */
function helpFor(username?: string): string {
  return adminManager.isAdmin(username) ? ADMIN_HELP_TEXT : HELP_TEXT;
}

bot.help((ctx) => ctx.reply(helpFor(ctx.from?.username), { parse_mode: "HTML" }));

bot.action("show_help", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(helpFor(ctx.from?.username), { parse_mode: "HTML" });
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

/**
 * Admin command: /requests — что ждёт решения прямо сейчас.
 *
 * /pending показывает только заявки на регистрацию. Запросы ходов и
 * невыданные призы жили каждый в своём сообщении, и стоило пролистать чат,
 * как узнать «что вообще висит» было неоткуда.
 *
 * Здесь всё одним экраном, а под каждым запросом хода — рабочие кнопки, те
 * же, что приходят вместе с самим запросом.
 */
bot.command("requests", adminManager.middleware(), async (ctx) => {
  try {
    const res = await internalFetch("/api/admin/pending-summary");
    if (!res.ok) return ctx.reply("❌ Не удалось получить сводку.");

    const data = (await res.json()) as {
      registrations?: Array<{ username: string; firstName?: string; requestedAt: number }>;
      turnRequests?: Array<{
        id: string;
        name: string;
        alias: string | null;
        cell: number;
        requested: number;
        blockingBonus: string | null;
      }>;
      unredeemedPrizes?: Array<{ name: string; alias: string | null; prize: string }>;
      approvedTurns?: Array<{ name: string; alias: string | null; left: number }>;
      playersTotal?: number;
    };

    const regs = data.registrations || [];
    const turns = data.turnRequests || [];
    const prizes = data.unredeemedPrizes || [];
    const approved = data.approvedTurns || [];

    // Имя показываем как «Псевдоним (@хендл)»: по первому админ узнаёт
    // игрока на доске, по второму — пишет ему.
    const who = (p: { name: string; alias: string | null }) =>
      p.alias ? `${escapeHtml(p.alias)} (${escapeHtml(p.name)})` : escapeHtml(p.name);

    const lines: string[] = ["📋 <b>ЧТО ЖДЁТ РЕШЕНИЯ</b>", ""];

    lines.push(`📝 Заявок на регистрацию: <b>${regs.length}</b>`);
    lines.push(`🎲 Запросов хода: <b>${turns.length}</b>`);
    lines.push(`🎁 Невыданных призов: <b>${prizes.length}</b>`);
    lines.push(`✅ Игроков с открытыми ходами: <b>${approved.length}</b>`);
    lines.push(`👥 Всего игроков: <b>${data.playersTotal ?? 0}</b>`);

    if (regs.length > 0) {
      lines.push("", "<b>Заявки на регистрацию</b> — решить: /pending");
      for (const r of regs.slice(0, 10)) lines.push(`• ${escapeHtml(r.username)}`);
    }

    if (prizes.length > 0) {
      lines.push("", "<b>Призы к выдаче</b>");
      for (const p of prizes.slice(0, 10)) {
        lines.push(`• ${who(p)} — ${escapeHtml(p.prize)}`);
      }
    }

    if (approved.length > 0) {
      lines.push("", "<b>Ходы уже выданы</b>");
      for (const p of approved.slice(0, 10)) {
        lines.push(`• ${who(p)} — осталось ${p.left} ${pluralizeTurns(p.left)}`);
      }
    }

    if (regs.length + turns.length + prizes.length + approved.length === 0) {
      lines.push("", "✅ Ничего не ждёт — всё разобрано.");
    }

    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      // Кнопка рядом со сводкой: чаще всего список нужен именно здесь.
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📊 ВЫГРУЗИТЬ СПИСОК ИГРОКОВ", "export_players")],
      ]),
    });

    // Запросы ходов — отдельными сообщениями с кнопками, иначе решить их
    // прямо отсюда было бы нельзя.
    for (const t of turns.slice(0, 10)) {
      await ctx.reply(
        `🎲 <b>ЗАПРОС ХОДА</b> от <b>${who(t)}</b>\n` +
          `Клетка: ${t.cell} · просит: <b>${t.requested}</b> ${pluralizeTurns(t.requested)}` +
          (t.blockingBonus
            ? `\n⚠️ <b>НЕИСПОЛЬЗОВАННЫЙ БОНУС:</b> ${escapeHtml(t.blockingBonus)}\n` +
              `<i>Подтвердите использование перед одобрением.</i>`
            : ""),
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                `🟢 Одобрить ${t.requested} ${pluralizeTurns(t.requested)}`.slice(0, 60),
                `approve_turn:${t.id}:${t.requested}`
              ),
              Markup.button.callback("🔴 Отклонить", `reject_turn:${t.id}`),
            ],
            [1, 2, 3, 5]
              .filter((n) => n !== t.requested)
              .map((n) => Markup.button.callback(`${n}`, `approve_turn:${t.id}:${n}`)),
          ]),
        }
      );
    }
  } catch (e: any) {
    return ctx.reply(`⚠️ Ошибка связи с сервером: ${e.message}`);
  }
});

/**
 * Выгрузка полного списка игроков файлом.
 *
 * Админка показывает таблицу на экране, но сохранить её было нельзя.
 * Отдаём CSV: открывается в Excel и Google Таблицах, годится и чтобы
 * посчитать что-то, и чтобы просто сохранить срез.
 *
 * Общая функция для команды /players и для кнопки под сводкой /requests.
 */
async function sendPlayersExport(ctx: any) {
  try {
    const res = await internalFetch("/api/admin/players-export");
    if (!res.ok) return ctx.reply("❌ Не удалось получить список игроков.");

    const data = (await res.json()) as {
      csv?: string;
      total?: number;
      generatedAt?: string;
    };

    if (!data.csv || !data.total) {
      return ctx.reply("📭 Игроков пока нет — выгружать нечего.");
    }

    const stamp = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(
      {
        source: Buffer.from(data.csv, "utf-8"),
        filename: `HCG-игроки-${stamp}.csv`,
      },
      {
        caption:
          `📊 <b>Список игроков</b>\n` +
          `Всего: <b>${data.total}</b>\n` +
          `Собрано: ${escapeHtml(data.generatedAt || "")}`,
        parse_mode: "HTML",
      }
    );
  } catch (e: any) {
    return ctx.reply(`⚠️ Ошибка связи с сервером: ${e.message}`);
  }
}

bot.command("players", adminManager.middleware(), (ctx) => sendPlayersExport(ctx));

bot.action("export_players", async (ctx) => {
  if (!adminManager.isAdmin(ctx.from.username)) {
    return ctx.answerCbQuery("⛔ Только админ!", { show_alert: true });
  }
  await ctx.answerCbQuery("Готовлю файл…");
  await sendPlayersExport(ctx);
});

// Admin Command /set_admin @username
bot.command("set_admin", adminManager.middleware(), async (ctx) => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) {
    return ctx.reply("Использование: /set_admin @username");
  }
  const newAdmin = parts[1].trim();
  if (!adminManager.isValidHandle(newAdmin)) {
    return ctx.reply("Нужен настоящий Telegram-хендл: /set_admin @username");
  }
  adminManager.addAdmin(newAdmin);
  const handle = newAdmin.startsWith("@") ? newAdmin : `@${newAdmin}`;
  const chatId = chatIdFor(handle);
  if (chatId) {
    try {
      await asyncQueue.sendMessage(
        chatId,
        "👑 Вас назначили администратором HCG. Команды: /help"
      );
    } catch {
      /* they may have blocked the bot */
    }
  }
  return ctx.reply(
    `✅ Администратор <b>${escapeHtml(handle)}</b> добавлен.\n` +
      `<i>Игрокам этот хендл не показывается. Список виден только админам: /list_admins</i>` +
      (chatId ? "" : "\n⚠️ Человек ещё не писал боту /start — команды дойдут после первого сообщения."),
    { parse_mode: "HTML" }
  );
});

bot.command("del_admin", adminManager.middleware(), async (ctx) => {
  const parts = ctx.message.text.split(" ");
  if (parts.length < 2) {
    return ctx.reply("Использование: /del_admin @username");
  }
  const result = adminManager.removeAdmin(parts[1].trim());
  if (result === "bootstrap") {
    return ctx.reply(
      "Основного администратора из .env снять командой нельзя. Смените TELEGRAM_ADMIN_USERNAME на сервере."
    );
  }
  if (result === "missing") {
    return ctx.reply("Этого хендла нет в списке администраторов.");
  }
  return ctx.reply("Администратор снят. Список: /list_admins");
});

/**
 * Admin command: /turns <имя игрока> [количество]
 *
 * Hands out a batch of rolls without waiting for the player to ask. The point
 * of the whole batch feature: somebody who bought several items should not
 * ping the admin after every single roll.
 *
 * The server accepts a player id or a name, so the admin can type what they
 * see in the console.
 */
bot.command("turns", adminManager.middleware(), async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  if (parts.length === 0) {
    return ctx.reply(
      "Использование: /turns <имя игрока> [сколько ходов]\n" +
        "Например: /turns Кибер 3 — выдать игроку «Кибер» три хода сразу."
    );
  }

  // Trailing number is the count; everything before it is the name, which may
  // contain spaces.
  const tail = parts[parts.length - 1];
  const hasCount = parts.length > 1 && /^\d+$/.test(tail);
  const turns = hasCount ? Math.min(10, Math.max(1, Number(tail))) : 1;
  const playerName = (hasCount ? parts.slice(0, -1) : parts).join(" ");
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  try {
    const res = await internalFetch("/api/admin/bot-approve-turn", {
      method: "POST",
      // Заявки может не быть вовсе — администратор выдаёт ход сам.
      body: JSON.stringify({ playerId: playerName, admin: adminName, turns }),
    });
    const data = (await res.json()) as {
      success?: boolean;
      playerName?: string;
      turns?: number;
      error?: string;
    };

    if (res.ok && data.success) {
      const granted = Number(data.turns) || turns;
      sendDirectMessageToUser(
        data.playerName || playerName,
        granted > 1
          ? `ПОРА СДЕЛАТЬ БРОСОК — одобрено ${granted} ${pluralizeTurns(granted)} подряд.`
          : "ПОРА СДЕЛАТЬ БРОСОК"
      );
      return ctx.reply(
        `🟢 Игроку <b>${escapeHtml(data.playerName || playerName)}</b> выдано ` +
          `<b>${granted}</b> ${pluralizeTurns(granted)}. Срок не ограничен.`,
        { parse_mode: "HTML" }
      );
    }

    // 409 — у игрока неиспользованный приз. Предлагаем ту же кнопку, что и
    // при обычном запросе, вместо молчаливого отказа.
    if (res.status === 409) {
      return ctx.reply(`⚠️ ${escapeHtml(data.error || "Требуется подтверждение бонуса")}`, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              `✅ Бонус выдан — одобрить ${turns} ${pluralizeTurns(turns)}`,
              `approve_turn_bonus:${playerName}:${turns}`
            ),
          ],
        ]),
      });
    }

    return ctx.reply(`❌ ${escapeHtml(data.error || "Не удалось выдать ходы")}`, {
      parse_mode: "HTML",
    });
  } catch (e: any) {
    return ctx.reply(`⚠️ Ошибка связи с сервером: ${e.message}`);
  }
});

/**
 * Admin command: /msg <кого> <текст>
 *
 * Написать игроку в Telegram, не заходя в игру. Искать можно и по @хендлу,
 * и по игровому псевдониму — на экране у администратора видно и то и другое,
 * а держать в голове соответствие незачем.
 */
bot.command("msg", adminManager.middleware(), async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/).slice(1);
  if (parts.length < 2) {
    return ctx.reply(
      "Использование: /msg <@хендл или Псевдоним> <текст>\n" +
        "Например: /msg Бэтмен Ваш приз ждёт в магазине\n" +
        'Псевдоним из двух слов берите в кавычки: /msg "Гарри Поттер" текст'
    );
  }

  /*
   * Псевдоним может состоять из двух слов («Гарри Поттер»), поэтому
   * поддерживаем кавычки. Без них берём первое слово — так работает
   * привычное /msg @user текст.
   */
  const raw = parts.join(" ");
  const quoted = raw.match(/^"([^"]+)"\s+(.+)$/) || raw.match(/^«([^»]+)»\s+(.+)$/);
  const target = quoted ? quoted[1] : parts[0];
  const text = quoted ? quoted[2] : parts.slice(1).join(" ");
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  try {
    const res = await internalFetch("/api/admin/bot-message-player", {
      method: "POST",
      body: JSON.stringify({ target, text, admin: adminName }),
    });
    const data = (await res.json()) as {
      success?: boolean;
      playerName?: string;
      alias?: string | null;
      error?: string;
    };

    if (res.ok && data.success) {
      // Администратору показываем и псевдоним, и настоящий хендл: он имеет
      // право знать, кому именно ушло сообщение.
      const who = data.alias
        ? `${escapeHtml(data.alias)} (${escapeHtml(data.playerName || "")})`
        : escapeHtml(data.playerName || target);
      return ctx.reply(`✅ Сообщение отправлено игроку <b>${who}</b>.`, {
        parse_mode: "HTML",
      });
    }

    return ctx.reply(`❌ ${escapeHtml(data.error || "Не удалось отправить сообщение")}`, {
      parse_mode: "HTML",
    });
  } catch (e: any) {
    return ctx.reply(`⚠️ Ошибка связи с сервером: ${e.message}`);
  }
});

/**
 * /all <текст> — написать каждому зарегистрированному игроку в личку.
 */
bot.command("all", adminManager.middleware(), async (ctx) => {
  const text = ctx.message.text.replace(/^\/all(@\S+)?\s*/i, "").trim();
  if (!text) {
    return ctx.reply("Использование: /all <текст>\nНапример: /all Магазин завтра закрыт до 14:00");
  }
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  try {
    const res = await internalFetch("/api/admin/bot-broadcast", {
      method: "POST",
      body: JSON.stringify({ text, admin: adminName }),
    });
    const data = (await res.json()) as {
      success?: boolean;
      sent?: number;
      total?: number;
      failed?: string[];
      error?: string;
    };

    if (!res.ok || !data.success) {
      return ctx.reply(`❌ ${escapeHtml(data.error || "Не удалось разослать")}`, {
        parse_mode: "HTML",
      });
    }

    const failed = data.failed?.length
      ? `\nНе доставлено: ${escapeHtml(data.failed.join(", "))}`
      : "";
    return ctx.reply(
      `✅ Разослано <b>${data.sent ?? 0}</b> из <b>${data.total ?? 0}</b>.${failed}`,
      { parse_mode: "HTML" }
    );
  } catch (e: any) {
    return ctx.reply(`⚠️ Ошибка связи с сервером: ${e.message}`);
  }
});

/**
 * /proxies — живые адреса из парсера. Бот сам ими не пользуется.
 */
bot.command("proxies", adminManager.middleware(), async (ctx) => {
  const list = listWorkingProxies(config.dataDir, 8);
  return ctx.reply(formatWorkingProxies(list), { parse_mode: "HTML" });
});

/**
 * /history <кого> — все перемещения одного игрока.
 */
bot.command("history", adminManager.middleware(), async (ctx) => {
  const target = ctx.message.text.replace(/^\/history(@\S+)?\s*/i, "").trim();
  if (!target) {
    return ctx.reply(
      "Использование: /history <@хендл или Псевдоним>\nНапример: /history hapalka228"
    );
  }

  try {
    const res = await internalFetch(
      `/api/admin/player-history?target=${encodeURIComponent(target)}`
    );
    const data = (await res.json()) as {
      success?: boolean;
      error?: string;
      html?: string;
      text?: string;
      name?: string;
      alias?: string | null;
      moves?: unknown[];
    };

    if (!res.ok || !data.success) {
      return ctx.reply(`❌ ${escapeHtml(data.error || "Не удалось получить историю")}`, {
        parse_mode: "HTML",
      });
    }

    await ctx.reply(data.html || "Пусто", { parse_mode: "HTML" });

    const full = data.text || "";
    if (full.length > 3500 || (data.moves && data.moves.length > 40)) {
      const stamp = new Date().toISOString().slice(0, 10);
      const who = (data.alias || data.name || target).replace(/[^\w\-а-яё]+/gi, "_");
      await ctx.replyWithDocument({
        source: Buffer.from(full, "utf-8"),
        filename: `HCG-история-${who}-${stamp}.txt`,
      });
    }
  } catch (e: any) {
    return ctx.reply(`⚠️ Ошибка связи с сервером: ${e.message}`);
  }
});

// Admin Command /list_admins
bot.command("prizes", adminManager.middleware(), async (ctx) => {
  const target = ctx.message.text.replace(/^\/prizes(@\S+)?\s*/i, "").trim();
  if (!target) {
    return ctx.reply("Использование: /prizes <@хендл или Псевдоним>");
  }
  try {
    const res = await internalFetch(`/api/admin/player-prizes?target=${encodeURIComponent(target)}`);
    const data = (await res.json()) as { success?: boolean; html?: string; error?: string };
    if (!res.ok || !data.success) {
      return ctx.reply(`❌ ${escapeHtml(data.error || "нет данных")}`, { parse_mode: "HTML" });
    }
    return ctx.reply(data.html || "Пусто", { parse_mode: "HTML" });
  } catch (e: any) {
    return ctx.reply(`⚠️ ${e.message}`);
  }
});

bot.command("report", adminManager.middleware(), async (ctx) => {
  try {
    const res = await internalFetch("/api/admin/daily-report");
    const data = (await res.json()) as { success?: boolean; html?: string; error?: string };
    if (!res.ok || !data.success) {
      return ctx.reply("❌ Не удалось собрать отчёт");
    }
    return ctx.reply(data.html || "Пусто", { parse_mode: "HTML" });
  } catch (e: any) {
    return ctx.reply(`⚠️ ${e.message}`);
  }
});

bot.command("list_admins", adminManager.middleware(), async (ctx) => {
  return ctx.reply(
    `👑 <b>Список администраторов</b>\n<i>Виден только вам. Игрокам не отправляется.</i>\n\n${escapeHtml(adminManager.describeAdmins())}`,
    { parse_mode: "HTML" }
  );
});

// Admin Command /reload_admins
bot.command("reload_admins", adminManager.middleware(), async (ctx) => {
  adminManager.reloadAdmins();
  return ctx.reply(
    `🔄 <b>Список обновлён</b>\n\n${escapeHtml(adminManager.describeAdmins())}`,
    { parse_mode: "HTML" }
  );
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

/**
 * Callback payload: `approve_turn:<playerId>[:<turns>]`.
 *
 * The trailing count is optional so buttons produced by an older server build
 * keep working — without it the server falls back to what the player asked
 * for, exactly as before batches existed.
 */
function splitTurnPayload(raw: string): { playerId: string; turns?: number } {
  const sep = raw.lastIndexOf(":");
  if (sep === -1) return { playerId: raw };
  const tail = raw.slice(sep + 1);
  if (!/^\d+$/.test(tail)) return { playerId: raw };
  return { playerId: raw.slice(0, sep), turns: Number(tail) };
}

/** Russian pluralisation for "ход" (1 ход / 2 хода / 5 ходов). */
export function pluralizeTurns(count: number): string {
  const n = Math.abs(count) % 100;
  if (n >= 11 && n <= 14) return "ходов";
  const last = n % 10;
  if (last === 1) return "ход";
  if (last >= 2 && last <= 4) return "хода";
  return "ходов";
}

bot.action(/approve_turn:(.+)/, async (ctx) => {
  const { playerId, turns } = splitTurnPayload(ctx.match[1]);
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  if (!adminManager.isAdmin(ctx.from.username)) {
    return ctx.answerCbQuery("⛔ Только админ!", { show_alert: true });
  }

  await handleTurnApproval(ctx, playerId, adminName, false, turns);
});

// Same as above, but the admin has confirmed the outstanding prize was handed
// over in real life, so the prize-control block can be released.
bot.action(/approve_turn_bonus:(.+)/, async (ctx) => {
  const { playerId, turns } = splitTurnPayload(ctx.match[1]);
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  if (!adminManager.isAdmin(ctx.from.username)) {
    return ctx.answerCbQuery("⛔ Только админ!", { show_alert: true });
  }

  await handleTurnApproval(ctx, playerId, adminName, true, turns);
});

async function handleTurnApproval(
  ctx: any,
  playerId: string,
  adminName: string,
  confirmBonusUse: boolean,
  turns?: number
) {
  try {
    const res = await internalFetch("/api/admin/bot-approve-turn", {
      method: "POST",
      // requireRequest: это нажатие кнопки под конкретной заявкой. Если
      // решение уже приняли в другом месте, сервер откажет, и ход не
      // выдастся повторно.
      body: JSON.stringify({
        playerId,
        admin: adminName,
        confirmBonusUse,
        turns,
        requireRequest: true,
      }),
    });

    const data = await res.json();

    if (res.ok && data.success) {
      const playerName = data.playerName || playerId;
      const granted = Number(data.turns) || 1;
      await ctx.editMessageText(
        `🟢 <b>ХОД ОДОБРЕН</b>\nИгрок: <b>${escapeHtml(playerName)}</b>\n` +
          `Выдано: <b>${granted}</b> ${pluralizeTurns(granted)}\n` +
          `Администратор: ${escapeHtml(adminName)}` +
          (confirmBonusUse ? `\n<i>Бонус подтверждён и списан.</i>` : ""),
        { parse_mode: "HTML" }
      );
      sendDirectMessageToUser(
        playerName,
        granted > 1
          ? `ПОРА СДЕЛАТЬ БРОСОК — одобрено ${granted} ${pluralizeTurns(granted)} подряд.`
          : "ПОРА СДЕЛАТЬ БРОСОК"
      );
      return ctx.answerCbQuery(`Одобрено: ${granted} ${pluralizeTurns(granted)}`);
    }

    /*
     * 410 => решение по этой заявке уже принято (в админке, на доске или
     * этой же кнопкой секунду назад).
     *
     * Кнопка остаётся в чате навсегда, и повторное нажатие выдавало ход
     * второй раз. Теперь сервер отказывает, а мы убираем кнопки, чтобы
     * нажать было уже нечего.
     */
    if (res.status === 410) {
      await ctx.editMessageText(
        `✅ <b>ЗАПРОС УЖЕ ОБРАБОТАН</b>\n\n${escapeHtml(data.error || "Повторная выдача не требуется.")}`,
        { parse_mode: "HTML" }
      );
      return ctx.answerCbQuery("Уже обработано — ход повторно не выдан", {
        show_alert: true,
      });
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
                `✅ Бонус выдан — одобрить ${turns || 1} ${pluralizeTurns(turns || 1)}`,
                `approve_turn_bonus:${playerId}:${turns || 1}`
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
  const { playerId } = splitTurnPayload(ctx.match[1]);
  const adminName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  if (!adminManager.isAdmin(ctx.from.username)) {
    return ctx.answerCbQuery("⛔ Только админ!", { show_alert: true });
  }

  /*
   * Раньше кнопка ТОЛЬКО переписывала текст сообщения.
   *
   * Серверу никто ничего не говорил: заявка оставалась открытой, игрок ждал
   * решения, которого уже не будет, а в админке висел мёртвый запрос. Теперь
   * отказ доходит до сервера, и заявка закрывается по-настоящему.
   */
  try {
    const res = await internalFetch("/api/admin/bot-reject-turn", {
      method: "POST",
      body: JSON.stringify({ playerId, admin: adminName }),
    });
    const data = (await res.json()) as {
      success?: boolean;
      playerName?: string;
      error?: string;
      alreadyHandled?: boolean;
    };

    if (res.status === 410) {
      await ctx.editMessageText(
        `✅ <b>ЗАПРОС УЖЕ ОБРАБОТАН</b>\n\n${escapeHtml(data.error || "Решение принято ранее.")}`,
        { parse_mode: "HTML" }
      );
      return ctx.answerCbQuery("Уже обработано", { show_alert: true });
    }

    if (!res.ok || !data.success) {
      return ctx.answerCbQuery(`Ошибка: ${data.error || "не удалось отклонить"}`, {
        show_alert: true,
      });
    }

    await ctx.editMessageText(
      `🔴 <b>ХОД ОТКЛОНЁН</b>\nИгрок: <b>${escapeHtml(data.playerName || playerId)}</b>\n` +
        `Администратор: ${escapeHtml(adminName)}`,
      { parse_mode: "HTML" }
    );
    return ctx.answerCbQuery("Запрос хода отклонён.");
  } catch (e: any) {
    return ctx.answerCbQuery(`Ошибка связи с сервером: ${e.message}`, { show_alert: true });
  }
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

/**
 * Найти рабочий прокси и держать его рабочим.
 *
 * Выполняется ДО запуска бота: без живого маршрута до Telegram запускаться
 * бессмысленно — polling просто зависнет молча. Дальше маршрут периодически
 * перепроверяется, и при отказе пул переключается сам.
 */
async function ensureRoute(): Promise<boolean> {
  console.log("[HCG bot] Ищу рабочий маршрут до Telegram...");
  const chosen = await proxyPool.selectWorking();

  if (!chosen) {
    console.error("\n" + "=".repeat(64));
    console.error("❌ НИ ОДИН ПРОКСИ НЕ РАБОТАЕТ");
    console.error("=".repeat(64));
    console.error("Проверены все варианты из TELEGRAM_PROXY, включая прямое соединение.\n");
    for (const line of proxyPool.describe()) console.error("  " + line);
    console.error(
      "\nЧто делать:\n" +
        "  • добавьте больше адресов через запятую:\n" +
        "      TELEGRAM_PROXY=socks5://a:1080,socks5://b:1080\n" +
        "  • бесплатные прокси живут часы — надёжнее свой VPS за рубежом;\n" +
        "  • проверить вручную:  bash deploy/ВСЁ-НА-VPS.sh бот"
    );
    console.error("=".repeat(64) + "\n");
    return false;
  }

  console.log(`[HCG bot] Маршрут: ${chosen.label}`);
  return true;
}

/**
 * Перепроверка на ходу.
 *
 * Прокси умирает беззвучно: соединения продолжают приниматься, но ответов нет.
 * Периодическая проверка ловит это раньше, чем заметит пользователь.
 */
function startRouteWatch(): void {
  const period = config.proxyCheckMs;
  const timer = setInterval(async () => {
    const current = proxyPool.current;
    if (!current) {
      await ensureRoute();
      return;
    }

    const { probeProxy } = await import("./proxyPool.js");
    const result = await probeProxy(current, BOT_TOKEN, 10_000, config.apiRoot);
    if (!result.ok) {
      // Никаких повторов и карантина: адрес выбрасывается сразу.
      // Смысл аренды в том, что рядом лежат ещё четыре проверенных прокси,
      // а сборщик держит полтора десятка в запасе. Ждать оживления одного
      // мёртвого адреса, имея такой резерв, — ровно то зацикливание,
      // из-за которого бот молчал.
      const address = current.label.replace(/^\w+:\/\//, "");
      const held = lease.list().some((p) => p.address === address);

      if (held) {
        lease.dropCurrent(result.detail);
        const entries = lease
          .list()
          .map((p) => {
            try {
              return parseProxyEntry(leaseUrl(p));
            } catch {
              return null;
            }
          })
          .filter((e): e is NonNullable<typeof e> => e !== null);
        proxyPool.replaceEntries(entries);
      } else {
        console.warn(`[HCG bot] ${current.label} перестал отвечать (${result.detail})`);
      }

      const next = await proxyPool.selectWorking();
      if (next) {
        console.log(`[HCG bot] Переключился на ${next.label}`);
      } else {
        console.error("[HCG bot] Рабочих маршрутов не осталось — жду пополнения аренды");
        // Не ждём следующего опроса: сборщик мог уже прислать замену.
        void reloadLeaseNow();
      }
    }
  }, period);

  // Периодическая проверка не должна удерживать процесс при выходе.
  timer.unref?.();
  console.log(`[HCG bot] Проверка маршрута каждые ${Math.round(period / 1000)} с`);
}

/**
 * Подхватывать список, который поддерживает контейнер-сборщик прокси.
 *
 * Сборщик пишет proxies.txt в общий том: находит живые адреса и вычёркивает
 * умершие. Читаем файл по таймеру, а не при старте: смысл в том, чтобы новый
 * список начинал работать без перезапуска бота.
 *
 * Файла может не быть — это нормально. Сборщик может быть ещё в первом цикле
 * или вообще не развёрнут; тогда работает список из TELEGRAM_PROXY.
 */
/**
 * Дождаться, пока сборщик пришлёт список с рабочим адресом.
 *
 * Вызывается перед тем, как сдаться и выйти. Полный цикл сборщика занимает
 * до минуты, а перезапуск контейнера обходится дороже ожидания: без этой
 * паузы бот падал, поднимался, снова пробовал те же мёртвые адреса и падал
 * опять — бесконечно, пока рядом лежал уже готовый список живых прокси.
 *
 * Возвращает true, как только маршрут найден.
 */
async function waitForHarvestedRoute(maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  const step = 10_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, step));

    // Сообщаем о нужде на каждой итерации: сборщик мог подняться позже нас
    // и не увидеть первый запрос.
    lease.writeAck();
    if (!lease.refresh()) continue;

    const entries = lease
      .list()
      .map((pr) => {
        try {
          return parseProxyEntry(leaseUrl(pr));
        } catch {
          return null;
        }
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    if (entries.length === 0) continue;

    proxyPool.replaceEntries(entries);
    console.log(`[HCG bot] Сборщик выдал ${entries.length} прокси — проверяю`);

    if (await proxyPool.selectWorking()) return true;
  }
  return false;
}

/**
 * Загрузить арендованные адреса в пул. Ничего не проверяет.
 *
 * Отделено от reload() ровно затем, чтобы стартовый путь не запускал второй
 * поиск маршрута параллельно с тем, что идёт из main.
 */
function loadLeaseIntoPool(): boolean {
  if (!lease.refresh()) return false;

  const entries = lease
    .list()
    .map((p) => {
      try {
        return parseProxyEntry(leaseUrl(p));
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (entries.length === 0) return false;

  const diff = proxyPool.replaceEntries(entries);
  console.log(
    `[HCG bot] Прокси в аренде: ${entries.length} ` +
      `(+${diff.added}, −${diff.removed}, прежних ${diff.kept})`
  );
  return true;
}

/** Перечитать аренду немедленно. Используется на пути отказа. */
let reloadLeaseNow: () => Promise<void> = async () => {};

function startHarvestWatch(): void {
  const reload = async () => {
    // Аренда полностью замещает список: адреса из .env нужны только до
    // первой выдачи сборщика.
    if (!loadLeaseIntoPool()) return;
    if (!proxyPool.current) await ensureRoute();
  };

  reloadLeaseNow = reload;

  /*
   * Первое чтение — синхронно, БЕЗ поиска маршрута.
   *
   * Раньше здесь вызывался reload(), который при пустом пуле сам звал
   * ensureRoute(); следом стартовал ensureRoute() из main. Два поиска шли
   * параллельно по одному пулу: оба одновременно проверяли один адрес,
   * оба писали в него результат, и проигравший мог пометить рабочий прокси
   * как отказавший — прямо перед тем, как второй его выберет. Отсюда
   * «вручную работает, автоматически нет»: маршрут из .env находился до
   * старта гонки, а выданный арендой — уже в ней.
   *
   * Список забираем сразу, чтобы ensureRoute() ниже увидел арендованные
   * адреса, а не одно прямое соединение.
   */
  loadLeaseIntoPool();
  const timer = setInterval(() => void reload(), HARVEST_POLL_MS);
  timer.unref?.();

  // Сообщаем сборщику, сколько нужно, ещё до первой проверки маршрута:
  // иначе он не узнает о нас до первого отказа.
  lease.writeAck();
  console.log(
    `[HCG bot] Аренда прокси: ${config.dataDir}/lease-bot.json ` +
      `(проверка раз в ${Math.round(HARVEST_POLL_MS / 1000)} с)`
  );
}

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

  // Слежение за списком от сборщика включается ДО поиска маршрута.
  //
  // Раньше оно стояло после: если ни один адрес не отвечал, ensureRoute()
  // возвращал false, процесс выходил с кодом 1 — и до чтения списка дело
  // не доходило никогда. Docker перезапускал бота, тот снова пробовал те же
  // два мёртвых адреса и снова падал. У пользователя это дало 168
  // перезапусков подряд: сборщик рядом набрал живых прокси, а бот их так
  // и не увидел, потому что умирал раньше, чем успевал заглянуть в файл.
  //
  // Порядок здесь — не стилистика: список от сборщика и есть способ
  // выбраться из состояния «все известные адреса мертвы».
  if (config.useProxy) {
    startHarvestWatch();
  } else {
    console.log("[HCG bot] Аренда прокси для бота не используется — парсер работает отдельно");
  }

  // Сначала маршрут, потом бот. Запускать polling без живого соединения
  // бессмысленно: он зависнет молча, и причина потеряется.
  void ensureRoute().then(async (routeOk) => {
    if (!routeOk) {
      if (!config.useProxy) {
        clearTimeout(watchdog);
        console.error("[HCG bot] Прямое соединение с Telegram не отвечает.");
        process.exit(1);
      }
      // Последний шанс перед выходом: сборщик мог записать свежий список
      // прямо сейчас. Ждём один его цикл, перечитывая файл, и только потом
      // сдаёмся — перезапуск контейнера стоит дороже, чем эта пауза.
      console.error(
        `[HCG bot] Жду список от сборщика прокси (до ${Math.round(HARVEST_RESCUE_MS / 1000)} с)...`
      );

      const rescued = await waitForHarvestedRoute(HARVEST_RESCUE_MS);
      if (!rescued) {
        clearTimeout(watchdog);
        console.error(
          "[HCG bot] Рабочих маршрутов нет. Проверьте контейнер hcg_proxy:\n" +
            "      docker compose logs --tail 30 hcg_proxy"
        );
        process.exit(1);
      }
      console.log("[HCG bot] Маршрут найден по списку сборщика — продолжаю запуск");
    }

    if (config.useProxy) startRouteWatch();

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
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
