/**
 * ============================================================================
 * BOT END-TO-END TEST
 * ============================================================================
 *
 * Runs the real bot process against:
 *   • a stub Telegram Bot API that records every outgoing call and lets the
 *     test inject updates through getUpdates long-polling, and
 *   • the real game server bundle, on a temporary data directory.
 *
 * Nothing is mocked inside the bot itself, so this exercises the full path a
 * player actually takes:
 *
 *   /start → /register → admin taps ЗАРЕГИСТРИРОВАТЬ →
 *   password is generated, stored hashed and delivered to the player →
 *   the same password works at /api/login, and the Mini App lets the player
 *   straight in with no password at all.
 *
 * Run with:  npm run test:e2e
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const TG_PORT = 5100 + Math.floor(Math.random() * 30);
const GAME_PORT = 5200 + Math.floor(Math.random() * 30);
const GAME_URL = `http://127.0.0.1:${GAME_PORT}`;

const BOT_TOKEN = "7654321:E2E-FAKE-BOT-TOKEN-NOT-A-REAL-CREDENTIAL";
const INTERNAL_SECRET = "e2e-internal-secret-" + "c".repeat(20);
const SESSION_SECRET = "e2e-session-secret-" + "d".repeat(20);
const ADMIN_PASSWORD = "E2eAdminPassword2026";

const ADMIN_HANDLE = "e2e_boss";
const ADMIN_CHAT = 111;
const PLAYER_HANDLE = "e2e_rookie";
const PLAYER_CHAT = 222;
const PLAYER_TG_ID = 987001;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Stub Telegram Bot API
// ---------------------------------------------------------------------------

interface SentMessage {
  chat_id: string | number;
  text: string;
  reply_markup?: { inline_keyboard?: Array<Array<Record<string, unknown>>> };
}

interface EditedMessage {
  chat_id: string | number;
  message_id: number;
  text: string;
}

/** Everything the bot tried to send, in order. */
const sent: SentMessage[] = [];
const edited: EditedMessage[] = [];
/** Файлы, которые бот пытался отправить. */
const documents: any[] = [];
const answeredCallbacks: Array<{ text?: string }> = [];

/** Updates waiting to be handed to the bot's next getUpdates call. */
let updateQueue: unknown[] = [];
let updateSeq = 1;
let messageSeq = 1000;

let tgServer: http.Server;
let gameServer: ChildProcess;
let botProcess: ChildProcess;
let dataDir: string;

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        /*
         * Файлы Telegram принимает как multipart/form-data, а не JSON.
         * Возвращаем сырой текст: тест по нему проверяет имя файла и
         * содержимое, не разбирая формат целиком.
         */
        resolve({ __raw: raw });
      }
    });
  });
}

function startTelegramStub(): Promise<void> {
  return new Promise((resolve) => {
    tgServer = http.createServer(async (req, res) => {
      const method = (req.url || "").split("/").pop() || "";
      const body = await readBody(req);
      const reply = (result: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      };

      switch (method) {
        case "getMe":
          return reply({ id: 1, is_bot: true, username: "hcg_test_bot", first_name: "HCG" });

        case "getUpdates": {
          // Long-poll: hold the request briefly, then hand over anything queued.
          const deadline = Date.now() + 700;
          const poll = () => {
            if (updateQueue.length > 0 || Date.now() > deadline) {
              const batch = updateQueue;
              updateQueue = [];
              return reply(batch);
            }
            setTimeout(poll, 25);
          };
          return poll();
        }

        case "sendMessage": {
          sent.push(body);
          return reply({
            message_id: messageSeq++,
            chat: { id: body.chat_id },
            text: body.text,
          });
        }

        case "sendDocument": {
          documents.push(body);
          return reply({ message_id: messageSeq++, document: { file_name: "export.csv" } });
        }

        case "editMessageText": {
          edited.push(body);
          return reply({ message_id: body.message_id, text: body.text });
        }

        case "answerCallbackQuery":
          answeredCallbacks.push(body);
          return reply(true);

        case "setMyCommands":
        case "deleteWebhook":
          return reply(true);

        default:
          return reply(true);
      }
    });
    tgServer.listen(TG_PORT, "127.0.0.1", () => resolve());
  });
}

// --- Update builders --------------------------------------------------------

function textUpdate(text: string, from: { username: string; id: number; chatId: number }) {
  return {
    update_id: updateSeq++,
    message: {
      message_id: messageSeq++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: from.chatId, type: "private" },
      from: { id: from.id, is_bot: false, first_name: from.username, username: from.username },
      text,
      entities: text.startsWith("/")
        ? [{ offset: 0, length: text.length, type: "bot_command" }]
        : [],
    },
  };
}

function callbackUpdate(data: string, from: { username: string; id: number; chatId: number }) {
  return {
    update_id: updateSeq++,
    callback_query: {
      id: String(updateSeq),
      from: { id: from.id, is_bot: false, first_name: from.username, username: from.username },
      message: {
        message_id: messageSeq++,
        date: Math.floor(Date.now() / 1000),
        chat: { id: from.chatId, type: "private" },
        text: "…",
      },
      chat_instance: "1",
      data,
    },
  };
}

const PLAYER = { username: PLAYER_HANDLE, id: PLAYER_TG_ID, chatId: PLAYER_CHAT };
const ADMIN = { username: ADMIN_HANDLE, id: 987002, chatId: ADMIN_CHAT };

/** Push an update and give the bot time to process it. */
async function deliver(update: unknown, settleMs = 900) {
  updateQueue.push(update);
  await wait(settleMs);
}

/** Messages sent to a particular chat since an index. */
function messagesTo(chatId: number, since = 0): SentMessage[] {
  return sent.slice(since).filter((m) => Number(m.chat_id) === chatId);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-bot-e2e-"));

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

  await startTelegramStub();

  gameServer = spawn("node", ["dist/server.cjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(GAME_PORT),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
      SESSION_SECRET,
      INTERNAL_API_SECRET: INTERNAL_SECRET,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_ADMIN_USERNAME: `@${ADMIN_HANDLE}`,
      WEB_APP_URL: GAME_URL,
      LOG_LEVEL: "silent",
    },
    stdio: "ignore",
  });

  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${GAME_URL}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await wait(250);
  }

  // `detached` puts the bot in its own process group, so the whole group can
  // be killed at teardown. Without it, tsx's child Node process survives
  // SIGTERM and the suite hangs until the hook times out.
  botProcess = spawn("npx", ["tsx", "src/index.ts"], {
    detached: true,
    cwd: path.join(ROOT, "bot"),
    env: {
      ...process.env,
      NODE_ENV: "test",
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_API_ROOT: `http://127.0.0.1:${TG_PORT}`,
      INTERNAL_API_SECRET: INTERNAL_SECRET,
      GAME_SERVER_URL: GAME_URL,
      WEB_APP_URL: GAME_URL,
      TELEGRAM_ADMIN_USERNAME: `@${ADMIN_HANDLE}`,
      DATA_DIR: dataDir,
    },
    stdio: "ignore",
  });

  // Let long-polling come up.
  await wait(4000);
}, 60_000);

/** Kill a detached child together with everything it spawned. */
function killGroup(child: ChildProcess | undefined, signal: NodeJS.Signals) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal); // negative pid == the whole group
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

afterAll(async () => {
  killGroup(botProcess, "SIGTERM");
  gameServer?.kill("SIGTERM");
  await wait(700);
  killGroup(botProcess, "SIGKILL");
  gameServer?.kill("SIGKILL");
  // Sockets held open by the stub keep close() pending, so drop them.
  tgServer?.closeAllConnections?.();
  await new Promise<void>((r) => tgServer?.close(() => r()));
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}, 20_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bot: first contact", () => {
  it("learns the administrator's chat id when they start the bot", async () => {
    // Telegram will not deliver a private message addressed to "@handle" —
    // only to a numeric chat id. The bot therefore cannot reach an
    // administrator who has never opened it, which is exactly what happens on
    // a fresh deployment. /start is what registers that mapping.
    const before = sent.length;
    await deliver(textUpdate("/start", ADMIN));
    expect(messagesTo(ADMIN_CHAT, before).length).toBeGreaterThan(0);
  });

  it("greets an unregistered player and offers the registration button", async () => {
    const before = sent.length;
    await deliver(textUpdate("/start", PLAYER));

    const msgs = messagesTo(PLAYER_CHAT, before);
    expect(msgs.length).toBeGreaterThan(0);

    const greeting = msgs[0];
    expect(greeting.text).toContain("ЗАПРОСИТЬ РЕГИСТРАЦИЮ");

    const buttons = (greeting.reply_markup?.inline_keyboard || []).flat();
    expect(buttons.some((b) => b.callback_data === "self_register")).toBe(true);
    // The play button is present, but pressing it before approval is refused
    // by the server — the bot does not gatekeep the Mini App itself.
    expect(buttons.some((b) => b.web_app)).toBe(true);
  });
});

describe("bot: registration request", () => {
  let adminCardIndex = -1;

  it("confirms the request to the player", async () => {
    const before = sent.length;
    await deliver(textUpdate("/register", PLAYER));

    const toPlayer = messagesTo(PLAYER_CHAT, before);
    expect(toPlayer.some((m) => m.text.includes("Заявка отправлена"))).toBe(true);
  });

  it("notifies the administrator with ЗАРЕГИСТРИРОВАТЬ / ОТКАЗАТЬ buttons", () => {
    const toAdmin = messagesTo(ADMIN_CHAT).filter((m) => m.text.includes("НОВАЯ ЗАЯВКА"));
    expect(toAdmin.length).toBe(1);

    const card = toAdmin[0];
    adminCardIndex = sent.indexOf(card);
    expect(card.text).toContain(`@${PLAYER_HANDLE}`);
    // The numeric id is included so the admin can identify the account even
    // if the handle is later changed.
    expect(card.text).toContain(String(PLAYER_TG_ID));

    const buttons = (card.reply_markup?.inline_keyboard || []).flat();
    expect(buttons.map((b) => b.text)).toEqual(["✅ ЗАРЕГИСТРИРОВАТЬ", "❌ ОТКАЗАТЬ"]);
    expect(buttons[0].callback_data).toBe(`approve_reg:@${PLAYER_HANDLE}`);
  });

  it("does not spam the administrator when the player asks twice", async () => {
    const before = sent.length;
    await deliver(textUpdate("/register", PLAYER));

    expect(messagesTo(ADMIN_CHAT, before).filter((m) => m.text.includes("НОВАЯ ЗАЯВКА"))).toEqual(
      []
    );
    expect(messagesTo(PLAYER_CHAT, before).some((m) => m.text.includes("уже отправлена"))).toBe(
      true
    );
    expect(adminCardIndex).toBeGreaterThanOrEqual(0);
  });

  it("refuses a stranger's attempt to approve somebody", async () => {
    const stranger = { username: "e2e_nobody", id: 987003, chatId: 333 };
    const before = sent.length;
    await deliver(callbackUpdate(`approve_reg:@${PLAYER_HANDLE}`, stranger));

    const alert = answeredCallbacks.at(-1);
    expect(alert?.text).toContain("Только админ");

    // Nothing was created.
    const state = await fetch(`${GAME_URL}/api/state`).then((r) => r.json());
    expect(state.players.some((p: any) => p.name === `@${PLAYER_HANDLE}`)).toBe(false);
    expect(messagesTo(PLAYER_CHAT, before)).toEqual([]);
  });
});

describe("bot: approval", () => {
  let deliveredPassword = "";

  it("creates the player and sends them a generated login and password", async () => {
    const before = sent.length;
    await deliver(callbackUpdate(`approve_reg:@${PLAYER_HANDLE}`, ADMIN), 1500);

    const toPlayer = messagesTo(PLAYER_CHAT, before);
    const creds = toPlayer.find((m) => m.text.includes("РЕГИСТРАЦИЯ ОДОБРЕНА"));
    expect(creds).toBeTruthy();

    expect(creds!.text).toContain(`@${PLAYER_HANDLE}`);

    // Password is inside the second <code> block.
    //
    // The message is HTML, so the value has to be un-escaped before it is
    // measured or replayed. The alphabet contains &, and 15% of generated
    // passwords carry one: as "&amp;" a 10-character password reads as 14,
    // and this test failed roughly one run in seven. The password itself was
    // always correct — the assertion was measuring the wrong string.
    const unescapeHtml = (s: string) =>
      s
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"); // last: otherwise "&amp;lt;" collapses wrongly

    const codes = [...creds!.text.matchAll(/<code>([^<]+)<\/code>/g)].map((m) =>
      unescapeHtml(m[1])
    );
    expect(codes.length).toBe(2);
    deliveredPassword = codes[1];

    expect(deliveredPassword.length).toBeGreaterThanOrEqual(8);
    expect(deliveredPassword.length).toBeLessThanOrEqual(10);
    expect(deliveredPassword).toMatch(/[a-z]/);
    expect(deliveredPassword).toMatch(/[A-Z]/);
    expect(deliveredPassword).toMatch(/[0-9]/);
    expect(deliveredPassword).toMatch(/[!@#$%^&*+\-=?]/);

    // The credentials message carries the play button.
    const buttons = (creds!.reply_markup?.inline_keyboard || []).flat();
    expect(buttons.some((b) => b.web_app)).toBe(true);
  });

  it("records the player in the game state", async () => {
    /*
     * Хендл ищем в админском состоянии: публичное отдаёт игровой псевдоним,
     * чтобы участники не видели Telegram-аккаунты друг друга.
     */
    const state = await fetch(`${GAME_URL}/api/admin/state`, {
      headers: { "X-Internal-Token": INTERNAL_SECRET },
    }).then((r) => r.json());
    const player = state.players.find((p: any) => p.name === `@${PLAYER_HANDLE}`);
    expect(player).toBeTruthy();
    expect(player.cell).toBe(0);
    // И псевдоним выдан — без него игрок засветил бы хендл в журнале.
    expect(player.alias).toBeTruthy();
  });

  it("updates the admin's message to show the decision", () => {
    const confirmation = edited.find((e) => e.text.includes("ЗАРЕГИСТРИРОВАН"));
    expect(confirmation).toBeTruthy();
    expect(confirmation!.text).toContain(`@${PLAYER_HANDLE}`);
    expect(confirmation!.text).toContain(`@${ADMIN_HANDLE}`);
    // The password must never appear in the administrator's chat.
    expect(confirmation!.text).not.toContain(deliveredPassword);
  });

  it("never writes the password anywhere except the player's private chat", () => {
    const leaks = sent.filter(
      (m) => Number(m.chat_id) !== PLAYER_CHAT && m.text.includes(deliveredPassword)
    );
    expect(leaks).toEqual([]);
  });

  it("stores the password hashed, not in the clear", () => {
    const authFile = path.join(dataDir, "game-auth-persistent.json");
    const raw = fs.readFileSync(authFile, "utf-8");
    expect(raw).not.toContain(deliveredPassword);
    // PBKDF2 "salt:hash" record.
    const stored = Object.values(JSON.parse(raw) as Record<string, string>);
    expect(stored.some((v) => /^[0-9a-f]{32}:[0-9a-f]{64}$/.test(v))).toBe(true);
  });

  it("accepts the delivered password at the browser login", async () => {
    const r = await fetch(`${GAME_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `@${PLAYER_HANDLE}`, password: deliveredPassword }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).token).toBeTruthy();
  });

  it("lets the player into the Mini App with no password at all", async () => {
    // This is the point of binding the Telegram id during registration.
    const fields: Record<string, string> = {
      user: JSON.stringify({ id: PLAYER_TG_ID, username: PLAYER_HANDLE }),
      auth_date: String(Math.floor(Date.now() / 1000)),
    };
    const check = Object.keys(fields)
      .sort()
      .map((k) => `${k}=${fields[k]}`)
      .join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const params = new URLSearchParams(fields);
    params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));

    const r = await fetch(`${GAME_URL}/api/telegram/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: params.toString() }),
    });
    expect(r.status).toBe(200);

    const body = await r.json();
    expect(body.name).toBe(`@${PLAYER_HANDLE}`);
    expect(body.token).toBeTruthy();
  });

  it("greets the now-registered player without the registration button", async () => {
    const before = sent.length;
    await deliver(textUpdate("/start", PLAYER));

    const greeting = messagesTo(PLAYER_CHAT, before)[0];
    expect(greeting.text).toContain("Вы зарегистрированы");

    const buttons = (greeting.reply_markup?.inline_keyboard || []).flat();
    expect(buttons.some((b) => b.callback_data === "self_register")).toBe(false);
    expect(buttons.some((b) => b.web_app)).toBe(true);
  });

  it("tells a player who asks again that they are already in", async () => {
    const before = sent.length;
    await deliver(textUpdate("/register", PLAYER));
    expect(
      messagesTo(PLAYER_CHAT, before).some((m) => m.text.includes("уже зарегистрированы"))
    ).toBe(true);
  });
});

describe("bot: rejection", () => {
  const DENIED = { username: "e2e_denied", id: 987004, chatId: 444 };

  it("informs the player and creates nobody", async () => {
    await deliver(textUpdate("/register", DENIED));

    const before = sent.length;
    await deliver(callbackUpdate(`reject_reg:@${DENIED.username}`, ADMIN), 1200);

    expect(messagesTo(DENIED.chatId, before).some((m) => m.text.includes("отклонена"))).toBe(true);
    expect(edited.some((e) => e.text.includes("В РЕГИСТРАЦИИ ОТКАЗАНО"))).toBe(true);

    const state = await fetch(`${GAME_URL}/api/state`).then((r) => r.json());
    expect(state.players.some((p: any) => p.name === `@${DENIED.username}`)).toBe(false);
  });

  it("lets the same player apply again after a rejection", async () => {
    const before = sent.length;
    await deliver(textUpdate("/register", DENIED));
    expect(messagesTo(ADMIN_CHAT, before).some((m) => m.text.includes("НОВАЯ ЗАЯВКА"))).toBe(true);
  });
});

describe("bot: admin surface", () => {
  it("lists pending requests with working buttons", async () => {
    const before = sent.length;
    await deliver(textUpdate("/pending", ADMIN), 1200);

    const msgs = messagesTo(ADMIN_CHAT, before);
    expect(msgs.some((m) => m.text.includes("Заявок ожидает"))).toBe(true);

    const card = msgs.find((m) => m.text.includes("e2e_denied"));
    expect(card).toBeTruthy();
    const buttons = (card!.reply_markup?.inline_keyboard || []).flat();
    expect(buttons[0].callback_data).toBe("approve_reg:@e2e_denied");
  });

  it("refuses /pending to a non-admin", async () => {
    const before = sent.length;
    await deliver(textUpdate("/pending", PLAYER));
    expect(messagesTo(PLAYER_CHAT, before).some((m) => m.text.includes("нет прав"))).toBe(true);
  });

  it("answers /requests with a summary of everything waiting", async () => {
    const before = sent.length;
    await deliver(textUpdate("/requests", ADMIN), 1500);

    const msgs = messagesTo(ADMIN_CHAT, before);
    const summary = msgs.find((m) => m.text.includes("ЧТО ЖДЁТ РЕШЕНИЯ"));
    expect(summary, "сводка не пришла").toBeTruthy();

    // Все четыре счётчика на месте: иначе админ не поймёт, что где висит.
    for (const line of [
      "Заявок на регистрацию",
      "Запросов хода",
      "Невыданных призов",
      "Всего игроков",
    ]) {
      expect(summary!.text).toContain(line);
    }
  });

  it("refuses /requests to a non-admin", async () => {
    const before = sent.length;
    await deliver(textUpdate("/requests", PLAYER));
    expect(messagesTo(PLAYER_CHAT, before).some((m) => m.text.includes("нет прав"))).toBe(true);
  });
});

describe("bot: players export", () => {
  it("sends a CSV file on /players", async () => {
    documents.length = 0;
    await deliver(textUpdate("/players", ADMIN), 1500);

    expect(documents.length, "файл не отправлен").toBe(1);
    const raw = String(documents[0].__raw ?? "");
    // Имя файла и заголовок таблицы — внутри multipart-тела.
    expect(raw).toContain("HCG-игроки-");
    expect(raw).toContain("Псевдоним");
    expect(raw).toContain("Telegram");
  });

  it("refuses /players to a non-admin", async () => {
    documents.length = 0;
    const before = sent.length;
    await deliver(textUpdate("/players", PLAYER), 900);

    expect(documents.length).toBe(0);
    expect(messagesTo(PLAYER_CHAT, before).some((m) => m.text.includes("нет прав"))).toBe(true);
  });

  it("offers the export button under the /requests summary", async () => {
    const before = sent.length;
    await deliver(textUpdate("/requests", ADMIN), 1500);

    const summary = messagesTo(ADMIN_CHAT, before).find((m) => m.text.includes("ЧТО ЖДЁТ РЕШЕНИЯ"));
    const buttons = (summary?.reply_markup?.inline_keyboard || []).flat();
    expect(buttons.some((b: any) => b.callback_data === "export_players")).toBe(true);
  });
});

describe("bot: help depends on who is asking", () => {
  it("shows the admin every command", async () => {
    const before = sent.length;
    await deliver(textUpdate("/help", ADMIN), 900);

    const help = messagesTo(ADMIN_CHAT, before).at(-1);
    expect(help).toBeTruthy();
    for (const cmd of ["/requests", "/players", "/turns", "/msg", "/admin_logs", "/set_admin"]) {
      expect(help!.text, `${cmd} нет в справке администратора`).toContain(cmd);
    }
  });

  it("does not show admin commands to a player", async () => {
    /*
     * Раньше «/turns» и «/msg» видел любой участник, хотя выполнить их всё
     * равно не мог: лишний повод пробовать чужие возможности.
     */
    const before = sent.length;
    await deliver(textUpdate("/help", PLAYER), 900);

    const help = messagesTo(PLAYER_CHAT, before).at(-1);
    expect(help).toBeTruthy();
    for (const cmd of ["/turns", "/msg", "/requests", "/players", "/set_admin"]) {
      expect(help!.text, `${cmd} не должно быть видно игроку`).not.toContain(cmd);
    }
    // Свои команды при этом на месте.
    expect(help!.text).toContain("/register");
    expect(help!.text).toContain("/play");
  });
});
