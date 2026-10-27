/**
 * ============================================================================
 * END-TO-END TESTS
 * ============================================================================
 *
 * Boots the real production bundle in a child process against a temporary
 * data directory, then exercises it over HTTP and Socket.IO exactly as a
 * client would.
 *
 * These cover the paths that unit tests cannot: authentication, authorisation,
 * rate limiting, validation and the full roll → prize → prize-control loop.
 *
 * Run with:  npm run test:e2e
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { io, Socket } from "socket.io-client";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = 4950 + Math.floor(Math.random() * 40);
const URL = `http://127.0.0.1:${PORT}`;
const SESSION_SECRET = "e2e-session-secret-" + "a".repeat(20);
const INTERNAL_SECRET = "e2e-internal-secret-" + "b".repeat(20);
const ADMIN_PASSWORD = "E2eAdminPassword2026";
const BOT_TOKEN = "1234567:E2E-FAKE-BOT-TOKEN-NOT-A-REAL-CREDENTIAL";

let server: ChildProcess;
let dataDir: string;

const internalHeaders = {
  "Content-Type": "application/json",
  "X-Internal-Token": INTERNAL_SECRET,
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function signToken(sub: string, role: "admin" | "player"): string {
  const body = Buffer.from(
    JSON.stringify({ sub, role, exp: Date.now() + 3_600_000 }),
    "utf8"
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function connect(token?: string): Promise<{ ok: boolean; socket?: Socket; error?: string }> {
  return new Promise((resolve) => {
    const s = io(URL, {
      transports: ["websocket"],
      auth: token ? { token } : {},
      reconnection: false,
      timeout: 4000,
    });
    s.on("connect", () => resolve({ ok: true, socket: s }));
    s.on("connect_error", (e) => resolve({ ok: false, error: e.message }));
  });
}

async function getState(): Promise<any> {
  return fetch(`${URL}/api/state`).then((r) => r.json());
}

/**
 * Состояние глазами администратора: с настоящими Telegram-хендлами.
 *
 * Публичное /api/state теперь отдаёт псевдонимы — искать игрока по «@handle»
 * в нём нельзя, и это ровно то поведение, ради которого псевдонимы вводились.
 */
async function getAdminState(): Promise<any> {
  return fetch(`${URL}/api/admin/state`, { headers: internalHeaders }).then((r) => r.json());
}

/**
 * Build a signed Telegram initData blob, exactly as the Telegram client does.
 * Lets the password-free entry path be exercised end to end.
 */
function signInitData(
  user: Record<string, unknown>,
  token = BOT_TOKEN,
  authDate = Math.floor(Date.now() / 1000)
): string {
  const fields: Record<string, string> = {
    user: JSON.stringify(user),
    auth_date: String(authDate),
  };
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

const tgAuth = (initData: string) =>
  fetch(`${URL}/api/telegram/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData }),
  });

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-e2e-"));

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

  server = spawn("node", ["dist/server.cjs"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
      ADMIN_LOGIN: "admin",
      SESSION_SECRET,
      INTERNAL_API_SECRET: INTERNAL_SECRET,
      WEB_APP_URL: URL,
      // A token is required for /api/telegram/auth to verify initData at
      // all. It is a fake: no outbound call is made on the paths tested here.
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_ADMIN_USERNAME: "@e2e_admin",
      LOG_LEVEL: "silent",
    },
    stdio: "ignore",
  });

  // Wait for the health endpoint to answer.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${URL}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await wait(250);
  }
  throw new Error("server did not start in time");
}, 30_000);

afterAll(async () => {
  server?.kill("SIGTERM");
  await wait(500);
  server?.kill("SIGKILL");
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("health and configuration", () => {
  it("reports healthy", async () => {
    const r = await fetch(`${URL}/healthz`).then((x) => x.json());
    expect(r.status).toBe("ok");
  });

  it("runs on disk persistence without Firestore credentials", async () => {
    const r = await fetch(`${URL}/healthz`).then((x) => x.json());
    expect(r.firestore).toBe("disabled");
  });

  it("sets security headers", async () => {
    const r = await fetch(`${URL}/healthz`);
    expect(r.headers.get("content-security-policy")).toBeTruthy();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-powered-by")).toBeNull();
  });
});

describe("authentication", () => {
  it("accepts the configured admin password", async () => {
    const r = await fetch(`${URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "admin", password: ADMIN_PASSWORD }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.role).toBe("admin");
    expect(body.token).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    const r = await fetch(`${URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "admin", password: "nope" }),
    });
    expect(r.status).toBe(403);
  });

  it("rejects the retired hardcoded password", async () => {
    const r = await fetch(`${URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "adm_hap", password: "bez1655" }),
    });
    expect(r.status).toBe(403);
  });

  it("does not let unknown users self-register", async () => {
    const r = await fetch(`${URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "@stranger", password: "x" }),
    });
    expect(r.status).toBe(403);
  });
});

describe("internal API authorisation", () => {
  it.each([
    ["/api/admin/bot-approve-registration", "POST"],
    ["/api/admin/bot-approve-turn", "POST"],
    ["/api/admin/logs-history", "GET"],
    ["/metrics", "GET"],
  ])("rejects %s without the internal token", async (endpoint, method) => {
    const r = await fetch(`${URL}${endpoint}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({ username: "@intruder" }) } : {}),
    });
    expect(r.status).toBe(403);
  });

  it("accepts a valid internal token", async () => {
    const r = await fetch(`${URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: "@e2e_player", admin: "@admin" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    // A one-time password is generated instead of the old hardcoded "123".
    expect(body.password).toBeTruthy();
    expect(body.password).not.toBe("123");
  });
});

describe("input validation", () => {
  it("rejects a malformed Telegram username", async () => {
    const r = await fetch(`${URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: "!!" }),
    });
    expect(r.status).toBe(400);
  });

  it("rejects an oversized body", async () => {
    const r = await fetch(`${URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a".repeat(200_000) }),
    });
    expect(r.status).toBe(413);
  });
});

describe("privacy", () => {
  it("omits personal Telegram identifiers from the public state", async () => {
    const state = await getState();
    for (const p of state.players) {
      expect(p.telegramId).toBeUndefined();
      expect(p.telegramUsername).toBeUndefined();
    }
  });
});

describe("socket authentication", () => {
  it("rejects a handshake without a token", async () => {
    const r = await connect();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("UNAUTHORIZED");
  });

  it("rejects a token signed with the wrong secret", async () => {
    const body = Buffer.from(
      JSON.stringify({ sub: "admin_user", role: "admin", exp: Date.now() + 60_000 }),
      "utf8"
    ).toString("base64url");
    const forged = `${body}.${crypto.createHmac("sha256", "wrong").update(body).digest("base64url")}`;
    expect((await connect(forged)).ok).toBe(false);
  });

  it("rejects a tampered payload that claims admin", async () => {
    const valid = signToken("p_1", "player");
    const [, sig] = valid.split(".");
    const evil = Buffer.from(
      JSON.stringify({ sub: "p_1", role: "admin", exp: Date.now() + 60_000 }),
      "utf8"
    ).toString("base64url");
    expect((await connect(`${evil}.${sig}`)).ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const body = Buffer.from(
      JSON.stringify({ sub: "p_1", role: "player", exp: Date.now() - 1000 }),
      "utf8"
    ).toString("base64url");
    const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
    expect((await connect(`${body}.${sig}`)).ok).toBe(false);
  });

  it("accepts a valid player token", async () => {
    const state = await getState();
    const player = state.players[0];
    const r = await connect(signToken(player.id, "player"));
    expect(r.ok).toBe(true);
    r.socket?.close();
  });
});

describe("gameplay", () => {
  it("refuses a roll before the turn is approved", async () => {
    const state = await getState();
    const player = state.players[0];
    const { socket } = await connect(signToken(player.id, "player"));

    let error: string | null = null;
    socket!.on("error", (m: string) => (error = m));
    socket!.emit("roll:request");
    await wait(400);

    expect(error).not.toBeNull();
    socket!.close();
  });

  it("produces a server-side dice value between 1 and 6, ignoring client input", async () => {
    const state = await getState();
    const player = state.players[0];
    const { socket } = await connect(signToken(player.id, "player"));

    const results: number[] = [];
    socket!.on("roll:result", (d: { steps: number }) => results.push(d.steps));
    socket!.on("error", () => {});

    for (let i = 0; i < 6; i++) {
      await fetch(`${URL}/api/admin/bot-approve-turn`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ playerId: player.id, admin: "@admin", confirmBonusUse: true }),
      });
      // A malicious client tries to force the final cell.
      socket!.emit("roll:request", player.id, 64);
      await wait(400);
    }

    expect(results.length).toBeGreaterThan(0);
    for (const v of results) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
    socket!.close();
  }, 20_000);

  it("opens the roll button when a turn is approved", async () => {
    /*
     * Регрессия, из-за которой «не работала анимация броска».
     *
     * Кнопка требует ДВА условия: одобренный ход у игрока и
     * gameState.turnStatus === "waiting_roll". approveTurn() выставлял
     * только первое, turnStatus оставался "idle", и нажатие молча
     * возвращалось, не отправив roll:request. Кубик не появлялся — со
     * стороны это выглядит как сломанная анимация, хотя ломался вход в неё.
     */
    const player = (await getState()).players[0];

    /*
     * Сначала закрываем ход администратором.
     *
     * Без этого тест проходил на turnStatus, оставшемся waiting_roll от
     * предыдущего теста, — и не проверял ровно то, ради чего написан.
     * Обнаружено при попытке откатить исправление: тест остался зелёным.
     */
    const admin = await connect(signToken("admin", "admin"));
    admin.socket!.on("error", () => {});
    admin.socket!.emit("admin:reject_player_turn", player.id);
    await wait(300);
    expect((await getState()).turnStatus).not.toBe("waiting_roll");
    admin.socket!.close();

    await fetch(`${URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ playerId: player.id, admin: "@admin", confirmBonusUse: true }),
    });
    await wait(300);

    const state = await getState();
    expect(state.turnStatus).toBe("waiting_roll");
    expect(state.currentPlayerId).toBe(player.id);

    // И бросок действительно проходит, а не отклоняется как «не ваш ход».
    const { socket } = await connect(signToken(player.id, "player"));
    const rolls: number[] = [];
    const errors: string[] = [];
    socket!.on("roll:result", (d: { steps: number }) => rolls.push(d.steps));
    socket!.on("error", (m: string) => errors.push(m));

    socket!.emit("roll:request");
    await wait(600);
    socket!.close();

    expect(errors.filter((e) => /не ваш ход/i.test(e))).toEqual([]);
    expect(rolls.length).toBe(1);
  }, 20_000);

  it("a roll does not freeze the game for other players", async () => {
    /*
     * «Чёрный экран у ВСЕХ игроков» после броска.
     *
     * Клиентская отрисовка не может повесить чужие устройства, значит либо
     * обработчик roll:request падает и оставляет состояние незавершённым,
     * либо в эфир уходит что-то, на чём спотыкаются все клиенты. Проверяем
     * оба исхода: второй игрок должен получить обновление и продолжать
     * отвечать после того, как первый бросил кубик.
     */
    const state = await getState();
    const roller = state.players[0];
    const bystander = state.players[1] ?? state.players[0];

    const a = await connect(signToken(roller.id, "player"));
    const b = await connect(signToken(bystander.id, "player"));
    a.socket!.on("error", () => {});
    b.socket!.on("error", () => {});

    // Наблюдатель слушает всё, что рассылается всем.
    const patches: unknown[] = [];
    const events: unknown[] = [];
    b.socket!.on("state:patch", (p: unknown) => patches.push(p));
    b.socket!.on("event:trigger", (e: unknown) => events.push(e));
    b.socket!.on("toast:achievement", (e: unknown) => events.push(e));

    await fetch(`${URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ playerId: roller.id, admin: "@admin", confirmBonusUse: true }),
    });
    await wait(300);

    a.socket!.emit("roll:request");
    await wait(800);

    // 1. Сервер жив и продолжает отвечать на HTTP.
    const after = await getState();
    expect(after.players.length).toBe(state.players.length);

    // 2. Наблюдатель получил обновление состояния — значит рассылка дошла.
    expect(patches.length).toBeGreaterThan(0);

    // 3. Сокет наблюдателя всё ещё живой: событий он не пропускает.
    expect(b.socket!.connected).toBe(true);

    // 4. И сервер по-прежнему принимает от него команды.
    const chatBefore = (await getState()).chatMessages.length;
    b.socket!.emit("chat:send", { text: "проверка связи" });
    await wait(500);
    expect((await getState()).chatMessages.length).toBe(chatBefore + 1);

    a.socket!.close();
    b.socket!.close();
  }, 25_000);

  it("a session with no player record is told so, not left hanging", async () => {
    /*
     * Админ играет как обычный игрок, но isMyTurn у него истинно всегда.
     * Если при этом turnStatus остался "idle" — кнопка молча отказывает,
     * roll:request не уходит, и в логе сервера нет ни следа. Ровно то, что
     * мы увидели: сервер здоров, а броска в журнале нет.
     */
    const admin = await connect(signToken("admin", "admin"));
    admin.socket!.on("error", () => {});

    // Приводим игру в состояние «ход никем не запрошен».
    const players = (await getState()).players;
    for (const p of players) {
      admin.socket!.emit("admin:reject_player_turn", p.id);
    }
    await wait(400);
    expect((await getState()).turnStatus).not.toBe("waiting_roll");

    const rolls: number[] = [];
    const errors: string[] = [];
    admin.socket!.on("roll:result", (d: { steps: number }) => rolls.push(d.steps));
    admin.socket!.on("error", (m: string) => errors.push(m));
    admin.socket!.emit("roll:request");
    await wait(700);

    /*
     * Учётная запись администратора не является игроком: фишки на поле у неё
     * нет. Сервер обязан СКАЗАТЬ об этом, а не молчать — молчание оставляло
     * клиент ждать roll:result вечно, с оверлеем на весь экран.
     */
    expect(rolls.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/не участвует в игре/);

    admin.socket!.close();
  }, 20_000);

  it("logs the build marker at startup", async () => {
    // Без неё по журналу невозможно понять, работает ли выкаченная версия.
    // Это уже стоило одного круга диагностики.
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "server.ts"), "utf-8");
    expect(src).toMatch(/log\.info\("Server build"/);
    expect(src).toMatch(/const SERVER_BUILD = "\d{4}-\d{2}-\d{2}\.\d+"/);
  });

  it("never rejects a roll without saying why", async () => {
    /*
     * Каждый выход из roll:request обязан оставить строку в журнале.
     * Молчаливый `return` дважды приводил к одному и тому же тупику: на
     * сервере пусто, на клиенте висит оверлей, и непонятно, дошёл ли запрос.
     */
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "server.ts"), "utf-8");
    const start = src.indexOf('socket.on("roll:request"');
    const end =
      src.indexOf('socket.on("chat:send"', start) > start
        ? src.indexOf('socket.on("chat:send"', start)
        : start + 9000;
    const handler = src.slice(start, end);

    // Вход в обработчик фиксируется всегда.
    expect(handler).toMatch(/log\.info\("roll:request received"/);

    // Ни один return не остаётся без объяснения.
    const returns = handler.match(/^\s*return;/gm) || [];
    const logs = handler.match(/log\.(warn|info|error)\(/g) || [];
    expect(logs.length).toBeGreaterThanOrEqual(returns.length);
  });

  it("ignores privileged events sent by a plain player", async () => {
    const before = (await getState()).players.length;
    const player = (await getState()).players[0];
    const { socket } = await connect(signToken(player.id, "player"));

    socket!.on("error", () => {});
    socket!.emit("admin:delete_player", player.id);
    socket!.emit("admin:reset_game", { clearPlayers: true, confirm: "УДАЛИТЬ ВСЕХ" });
    await wait(700);

    expect((await getState()).players.length).toBe(before);
    socket!.close();
  });

  it("prevents chat impersonation", async () => {
    const player = (await getState()).players[0];
    const { socket } = await connect(signToken(player.id, "player"));

    socket!.emit("chat:send", {
      text: "impersonation attempt",
      senderName: "Admin",
      isAdmin: true,
    });
    await wait(700);

    const last = (await getState()).chatMessages.at(-1);
    expect(last.isAdmin).toBe(false);
    expect(last.senderId).toBe(player.id);
    socket!.close();
  });
});

// ---------------------------------------------------------------------------
// Registration through the bot, and password-free entry afterwards.
// ---------------------------------------------------------------------------

describe("registration flow", () => {
  const HANDLE = "@e2e_recruit";
  const TG_ID = 900001;
  let issuedPassword = "";

  it("queues a request forwarded by the bot", async () => {
    const r = await fetch(`${URL}/api/internal/registration-request`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        username: HANDLE,
        telegramId: TG_ID,
        chatId: 555,
        firstName: "Рекрут",
      }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("queued");
  });

  it("reports a repeated request as already pending instead of re-notifying", async () => {
    const r = await fetch(`${URL}/api/internal/registration-request`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: HANDLE, telegramId: TG_ID, chatId: 555 }),
    });
    expect((await r.json()).status).toBe("already_pending");
  });

  it("rejects a registration request without the internal token", async () => {
    const r = await fetch(`${URL}/api/internal/registration-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "@intruder", telegramId: 1, chatId: 1 }),
    });
    expect(r.status).toBe(403);
  });

  it("lists the pending request for the admin", async () => {
    const r = await fetch(`${URL}/api/admin/registration-requests`, { headers: internalHeaders });
    const body = await r.json();
    const found = body.requests.find((x: any) => x.username === HANDLE);
    expect(found).toBeTruthy();
    expect(found.chatId).toBe(555);
  });

  it("reports the handle as not yet registered", async () => {
    const r = await fetch(
      `${URL}/api/internal/player-status?username=${encodeURIComponent(HANDLE)}`,
      { headers: internalHeaders }
    );
    const body = await r.json();
    expect(body.registered).toBe(false);
    expect(body.pending).toBe(true);
  });

  it("creates the player on approval and returns a strong one-time password", async () => {
    const r = await fetch(`${URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: HANDLE, admin: "@e2e_admin", deliverBy: "bot" }),
    });
    expect(r.status).toBe(200);

    const body = await r.json();
    expect(body.created).toBe(true);
    expect(body.chatId).toBe(555); // taken from the queued request
    issuedPassword = body.password;

    // 8–10 characters drawn from four classes, as specified.
    expect(issuedPassword.length).toBeGreaterThanOrEqual(8);
    expect(issuedPassword.length).toBeLessThanOrEqual(10);
    expect(issuedPassword).toMatch(/[a-z]/);
    expect(issuedPassword).toMatch(/[A-Z]/);
    expect(issuedPassword).toMatch(/[0-9]/);
    expect(issuedPassword).toMatch(/[!@#$%^&*+\-=?]/);

    // Хендл виден только администратору: в публичном состоянии псевдоним.
    const state = await getAdminState();
    expect(state.players.some((p: any) => p.name === HANDLE)).toBe(true);
  });

  it("clears the request from the pending list once approved", async () => {
    const r = await fetch(`${URL}/api/admin/registration-requests`, { headers: internalHeaders });
    const body = await r.json();
    expect(body.requests.some((x: any) => x.username === HANDLE)).toBe(false);
  });

  it("lets the new player sign in with the generated password", async () => {
    const r = await fetch(`${URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: HANDLE, password: issuedPassword }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).token).toBeTruthy();
  });

  it("refuses a wrong password for that player", async () => {
    const r = await fetch(`${URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: HANDLE, password: issuedPassword + "x" }),
    });
    expect(r.status).toBe(403);
  });

  it("is idempotent: approving twice does not duplicate the player", async () => {
    const before = (await getState()).players.length;
    const r = await fetch(`${URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: HANDLE, admin: "@e2e_admin", deliverBy: "bot" }),
    });
    const body = await r.json();
    expect(body.created).toBe(false);
    expect(body.password).toBeUndefined();
    expect((await getState()).players.length).toBe(before);
  });

  it("drops the request on rejection without creating anybody", async () => {
    const handle = "@e2e_denied";
    await fetch(`${URL}/api/internal/registration-request`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: handle, telegramId: 900002, chatId: 556 }),
    });

    const r = await fetch(`${URL}/api/admin/bot-reject-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: handle, admin: "@e2e_admin" }),
    });
    const body = await r.json();
    expect(body.found).toBe(true);
    expect(body.chatId).toBe(556);

    expect((await getState()).players.some((p: any) => p.name === handle)).toBe(false);
  });

  it("binds an existing player instead of queueing a duplicate request", async () => {
    const r = await fetch(`${URL}/api/internal/registration-request`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: HANDLE, telegramId: TG_ID, chatId: 555 }),
    });
    expect((await r.json()).status).toBe("already_registered");
  });

  it("does not leak the Telegram id of a registered player into public state", async () => {
    /*
     * Хендл в публичном состоянии больше не встречается вовсе — там
     * псевдонимы. Находим игрока по id, взятому из админского вида.
     */
    const real = (await getAdminState()).players.find((x: any) => x.name === HANDLE);
    const p = (await getState()).players.find((x: any) => x.id === real.id);
    expect(p.telegramId).toBeUndefined();
    expect(p.telegramUsername).toBeUndefined();
    // И сам хендл наружу не ушёл.
    expect(p.name).not.toContain("@");
  });
});

describe("password-free entry from Telegram", () => {
  const HANDLE = "@e2e_recruit";
  const TG_ID = 900001;

  it("signs in a registered player with a valid initData and no password", async () => {
    const r = await tgAuth(signInitData({ id: TG_ID, username: "e2e_recruit", first_name: "Р" }));
    expect(r.status).toBe(200);

    const body = await r.json();
    expect(body.name).toBe(HANDLE);
    expect(body.role).toBe("player");
    expect(body.token).toBeTruthy();

    // The token really works: it must open a socket.
    const c = await connect(body.token);
    expect(c.ok).toBe(true);
    c.socket?.close();
  });

  it("matches by numeric id even after the player renamed their handle", async () => {
    // Handles can be changed by their owner; the numeric id cannot. Matching
    // on the handle alone would lock the player out of their own account.
    const r = await tgAuth(signInitData({ id: TG_ID, username: "totally_new_handle" }));
    expect(r.status).toBe(200);
    expect((await r.json()).name).toBe(HANDLE);
  });

  it("rejects initData signed with somebody else's bot token", async () => {
    const forged = signInitData({ id: TG_ID, username: "e2e_recruit" }, "999:WRONG-TOKEN");
    expect((await tgAuth(forged)).status).toBe(403);
  });

  it("rejects a payload whose user object was swapped after signing", async () => {
    const real = signInitData({ id: TG_ID, username: "e2e_recruit" });
    const params = new URLSearchParams(real);
    params.set("user", JSON.stringify({ id: 1, username: "admin" }));
    expect((await tgAuth(params.toString())).status).toBe(403);
  });

  it("rejects a stale payload", async () => {
    const old = Math.floor((Date.now() - 48 * 3600 * 1000) / 1000);
    expect((await tgAuth(signInitData({ id: TG_ID }, BOT_TOKEN, old))).status).toBe(403);
  });

  it("does not create an account for an unknown Telegram user", async () => {
    const before = (await getState()).players.length;
    const r = await tgAuth(signInitData({ id: 987654, username: "e2e_stranger" }));
    expect(r.status).toBe(404);

    const body = await r.json();
    expect(body.needsRegistration).toBe(true);
    expect((await getState()).players.length).toBe(before);
  });

  it("rejects an empty or malformed payload", async () => {
    expect((await tgAuth("")).status).toBe(400);
    expect((await tgAuth("hash=deadbeef&auth_date=1")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// CORS. The standalone Android build runs in a WebView that serves the page
// from the device, so its requests are cross-origin and the browser discards
// the response unless the server explicitly allows that origin.
// ---------------------------------------------------------------------------

describe("cross-origin access", () => {
  const ask = (origin: string, method = "OPTIONS") =>
    fetch(`${URL}/api/login`, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(method === "OPTIONS" ? { "Access-Control-Request-Method": "POST" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify({ name: "admin", password: "no" }) } : {}),
    });

  it.each([
    ["https://localhost", "Android WebView"],
    ["capacitor://localhost", "Android WebView, older scheme"],
    ["https://web.telegram.org", "Telegram Mini App"],
    [URL, "the configured WEB_APP_URL"],
  ])("allows %s (%s)", async (origin) => {
    const r = await ask(origin);
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("refuses an unlisted origin", async () => {
    const r = await ask("https://evil.example.com");
    expect(r.status).toBe(403);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sends no allow header to an unlisted origin on a real request", async () => {
    // Belt and braces: a preflight can be skipped for simple requests, so the
    // actual response must not carry the header either.
    const r = await ask("https://evil.example.com", "POST");
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("varies on Origin so a cache cannot leak one origin's headers to another", async () => {
    const r = await ask("https://localhost");
    expect(r.headers.get("vary")).toContain("Origin");
  });
});

// ---------------------------------------------------------------------------
// Фишки игроков.
// ---------------------------------------------------------------------------

describe("player chips", () => {
  it("gives every player a distinct chip", async () => {
    // Выбор случайного номера из 13 без оглядки на занятые давал совпадение
    // у 6 игроков в 74% партий, а две одинаковые фишки на доске не различить.
    const names = ["@chip_a", "@chip_b", "@chip_c", "@chip_d", "@chip_e", "@chip_f"];
    for (const username of names) {
      await fetch(`${URL}/api/admin/bot-approve-registration`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ username, admin: "@admin", deliverBy: "bot" }),
      });
    }

    const state = await getAdminState();
    const chips = state.players
      .filter((p: any) => names.includes(p.name))
      .map((p: any) => p.chipImage);

    expect(chips).toHaveLength(names.length);
    expect(new Set(chips).size).toBe(chips.length);
  });

  it("assigns a chip to every registered player", async () => {
    const state = await getState();
    for (const p of state.players.filter((x: any) => x.role === "player")) {
      expect(p.chipImage, `${p.name} has no chip`).toBeTruthy();
      expect(p.chipImage).toMatch(/^\/chips\/chip_\d+\.svg$/);
    }
  });

  it("exposes chips in the public state so the board can draw them", async () => {
    // Фишка приходит клиенту вместе с состоянием: если её вырезать как
    // персональные данные, доска останется пустой.
    const state = await getState();
    const player = state.players.find((p: any) => p.role === "player");
    expect(player.chipImage).toBeTruthy();
    expect(player.cell).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Пакетное одобрение хода.
//
// Игрок, купивший несколько товаров, раньше ждал отдельного одобрения после
// КАЖДОГО броска. Одобрение теперь открывает пачку бросков.
// ---------------------------------------------------------------------------

describe("batch turn approval", () => {
  /** Свежий игрок для каждого сценария: чужие остатки ходов ломают проверку. */
  async function freshPlayer(handle: string) {
    await fetch(`${URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: handle, admin: "@admin", deliverBy: "bot" }),
    });
    const state = await getAdminState();
    return state.players.find((p: any) => p.name === handle);
  }

  async function approve(playerId: string, turns?: number) {
    return fetch(`${URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        playerId,
        admin: "@admin",
        confirmBonusUse: true,
        ...(turns === undefined ? {} : { turns }),
      }),
    });
  }

  const playerIn = async (id: string) => (await getState()).players.find((p: any) => p.id === id);

  it("opens as many rolls as the admin asked for", async () => {
    const player = await freshPlayer("@batch_three");
    const res = await approve(player.id, 3);
    expect(res.status).toBe(200);
    expect((await res.json()).turns).toBe(3);

    expect((await playerIn(player.id)).turnsApproved).toBe(3);
  });

  it("lets the player roll three times without asking again", async () => {
    /*
     * Смысл всей задачи. Раньше второй бросок отбивался с «Сейчас не ваш
     * ход!», потому что одобрение сгорало после первого.
     */
    const player = await freshPlayer("@batch_roller");
    await approve(player.id, 3);
    await wait(200);

    const { socket } = await connect(signToken(player.id, "player"));
    const rolls: number[] = [];
    const errors: string[] = [];
    socket!.on("roll:result", (d: { steps: number }) => rolls.push(d.steps));
    socket!.on("error", (m: string) => errors.push(m));

    for (let i = 0; i < 3; i++) {
      socket!.emit("roll:request");
      await wait(500);
    }
    socket!.close();

    expect(errors.filter((e) => /не ваш ход/i.test(e))).toEqual([]);
    expect(rolls.length).toBe(3);
  }, 25_000);

  it("stops the player once the batch is spent", async () => {
    const player = await freshPlayer("@batch_limit");
    await approve(player.id, 2);
    await wait(200);

    const { socket } = await connect(signToken(player.id, "player"));
    const rolls: number[] = [];
    const errors: string[] = [];
    socket!.on("roll:result", (d: { steps: number }) => rolls.push(d.steps));
    socket!.on("error", (m: string) => errors.push(m));

    for (let i = 0; i < 4; i++) {
      socket!.emit("roll:request");
      await wait(500);
    }
    socket!.close();

    // Ровно два броска, дальше — внятный отказ, а не молчание.
    expect(rolls.length).toBe(2);
    expect(errors.some((e) => /не ваш ход/i.test(e))).toBe(true);
    expect((await playerIn(player.id)).turnsApproved).toBe(0);
  }, 25_000);

  it("counts down one roll at a time", async () => {
    const player = await freshPlayer("@batch_countdown");
    await approve(player.id, 3);
    await wait(200);

    const { socket } = await connect(signToken(player.id, "player"));
    socket!.on("error", () => {});

    socket!.emit("roll:request");
    await wait(600);
    expect((await playerIn(player.id)).turnsApproved).toBe(2);

    socket!.emit("roll:request");
    await wait(600);
    expect((await playerIn(player.id)).turnsApproved).toBe(1);

    socket!.close();
  }, 25_000);

  it("defaults to a single roll when no count is given", async () => {
    // Старые сборки бота и APK не передают turns вовсе. Они обязаны работать
    // ровно так, как работали.
    const player = await freshPlayer("@batch_default");
    const res = await approve(player.id);
    expect((await res.json()).turns).toBe(1);
    expect((await playerIn(player.id)).turnsApproved).toBe(1);
  });

  it("honours the number the player asked for in their request", async () => {
    const player = await freshPlayer("@batch_asked");
    const { socket } = await connect(signToken(player.id, "player"));
    socket!.on("error", () => {});
    socket!.emit("player:request_turn", 4);
    await wait(400);

    expect((await playerIn(player.id)).turnsRequested).toBe(4);

    // Админ жмёт «одобрить», ничего не уточняя — игрок получает свои четыре.
    await approve(player.id);
    await wait(200);
    expect((await playerIn(player.id)).turnsApproved).toBe(4);
    socket!.close();
  }, 20_000);

  it("caps a batch at ten rolls", async () => {
    // Опечатка «100» вместо «10» не должна раздавать полдоски.
    const player = await freshPlayer("@batch_cap");
    const { socket } = await connect(signToken(player.id, "player"));
    socket!.on("error", () => {});
    socket!.emit("player:request_turn", 999);
    await wait(400);
    socket!.close();

    await approve(player.id);
    await wait(200);
    expect((await playerIn(player.id)).turnsApproved).toBe(10);
  }, 20_000);

  it("withdraws the whole batch on rejection", async () => {
    const player = await freshPlayer("@batch_reject");
    await approve(player.id, 5);
    await wait(200);

    const admin = await connect(signToken("admin", "admin"));
    admin.socket!.on("error", () => {});
    admin.socket!.emit("admin:reject_player_turn", player.id);
    await wait(400);
    admin.socket!.close();

    expect((await playerIn(player.id)).turnsApproved).toBe(0);
  }, 20_000);

  it("keeps the board open for another player who still has turns", async () => {
    /*
     * turnStatus — общий флаг, а кнопка броска смотрит и на него. Если
     * закрывать его, как только один игрок доиграл свою пачку, второй с
     * живым одобрением остался бы без хода.
     */
    const a = await freshPlayer("@batch_pair_a");
    const b = await freshPlayer("@batch_pair_b");
    await approve(a.id, 1);
    await approve(b.id, 3);
    await wait(200);

    const sa = await connect(signToken(a.id, "player"));
    sa.socket!.on("error", () => {});
    sa.socket!.emit("roll:request");
    await wait(600);
    sa.socket!.close();

    // Первый израсходовал свой единственный ход.
    expect((await playerIn(a.id)).turnsApproved).toBe(0);
    expect((await getState()).turnStatus).toBe("waiting_roll");

    const sb = await connect(signToken(b.id, "player"));
    const rolls: number[] = [];
    const errors: string[] = [];
    sb.socket!.on("roll:result", (d: { steps: number }) => rolls.push(d.steps));
    sb.socket!.on("error", (m: string) => errors.push(m));
    sb.socket!.emit("roll:request");
    await wait(600);
    sb.socket!.close();

    expect(errors.filter((e) => /не ваш ход/i.test(e))).toEqual([]);
    expect(rolls.length).toBe(1);
  }, 30_000);

  it("closes the board when nobody has a turn left", async () => {
    const state = await getState();
    const admin = await connect(signToken("admin", "admin"));
    admin.socket!.on("error", () => {});
    for (const p of state.players) {
      admin.socket!.emit("admin:reject_player_turn", p.id);
    }
    await wait(600);
    admin.socket!.close();

    expect((await getState()).turnStatus).toBe("idle");
  }, 20_000);

  /**
   * Прокатить пачку из десяти бросков и вернуть, на каком по счёту броске
   * впервые появился приз.
   *
   * Кубик случайный, поэтому «подвести игрока к призовой клетке» одним
   * броском нельзя: тест, зависящий от выпавшей грани, мигал бы. Десять
   * бросков по доске, где призовых клеток десять из шестидесяти пяти,
   * дают приз почти наверняка — а если не дали, попытка повторяется.
   */
  async function rollBatchUntilPrize(handle: string) {
    const player = await freshPlayer(handle);
    const admin = await connect(signToken("admin", "admin"));
    admin.socket!.on("error", () => {});

    const { socket } = await connect(signToken(player.id, "player"));
    const errors: string[] = [];
    let rolls = 0;
    socket!.on("roll:result", () => rolls++);
    socket!.on("error", (m: string) => errors.push(m));

    for (let attempt = 0; attempt < 4; attempt++) {
      admin.socket!.emit("admin:consume_bonus", player.id);
      admin.socket!.emit("admin:update_player", {
        id: player.id,
        cell: 0,
        color: player.color,
        name: player.name,
      });
      await wait(300);
      await approve(player.id, 10);
      await wait(250);

      rolls = 0;
      errors.length = 0;
      let prizeAtRoll = 0;

      for (let i = 1; i <= 10; i++) {
        socket!.emit("roll:request");
        await wait(420);
        const now = await playerIn(player.id);
        if (!prizeAtRoll && now.activeBonus) prizeAtRoll = i;
      }

      // Приз строго до последнего броска — иначе проверять нечего.
      if (prizeAtRoll > 0 && prizeAtRoll < 10) {
        socket!.close();
        admin.socket!.close();
        return { player, rolls, errors: [...errors], prizeAtRoll };
      }
    }

    socket!.close();
    admin.socket!.close();
    throw new Error("за четыре пачки приз ни разу не выпал в середине");
  }

  it("does not cut the batch short when a prize is won mid-way", async () => {
    /*
     * Найдено живым прогоном, а не чтением кода.
     *
     * Приз, полученный ВНУТРИ оплаченной пачки, не должен её обрывать:
     * игрок уже заплатил за эти броски. Контроль призов срабатывает на
     * следующем ОДОБРЕНИИ, а не посреди выданного.
     *
     * Первая версия исправления считала начало пачки как
     * turnApprovedUntil − 12ч, а клетка «+1 ХОД» окно продлевает. После неё
     * начало «уезжало» вперёд, приз оказывался «старым» — и остаток пачки
     * отбивался как при неиспользованном бонусе.
     */
    const { rolls, errors, prizeAtRoll } = await rollBatchUntilPrize("@batch_prize_mid");

    expect(prizeAtRoll).toBeGreaterThan(0);
    expect(errors.filter((e) => /КОНТРОЛЯ ПРИЗОВ/i.test(e))).toEqual([]);
    expect(rolls).toBe(10);
  }, 90_000);

  it("still blocks the NEXT approval while the prize is unredeemed", async () => {
    // Обратная сторона: правило контроля призов никуда не делось.
    const { player } = await rollBatchUntilPrize("@batch_prize_next");
    expect((await playerIn(player.id)).activeBonus).toBeTruthy();

    /*
     * Остаток пачки на этот момент может быть любым: клетка «+1 ХОД»
     * законно добавляет броски. Проверяется не он, а то, что отказанное
     * одобрение НИЧЕГО не открыло.
     */
    const before = (await playerIn(player.id)).turnsApproved;

    const res = await fetch(`${URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ playerId: player.id, admin: "@admin", turns: 2 }),
    });
    expect(res.status).toBe(409);
    expect((await playerIn(player.id)).turnsApproved).toBe(before);
  }, 90_000);

  it("reports unspent turns in the metrics", async () => {
    const player = await freshPlayer("@batch_metrics");
    await approve(player.id, 4);
    await wait(200);

    const body = await fetch(`${URL}/metrics`, { headers: internalHeaders }).then((r) => r.text());
    const line = body.split("\n").find((l) => l.startsWith("hcg_turns_approved_total "));
    expect(line).toBeTruthy();
    expect(Number(line!.split(" ")[1])).toBeGreaterThanOrEqual(4);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Обновление уже работающего сервера.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Отчёт администратору о результатах бросков.
//
// Призы выдаются вручную, поэтому админ обязан видеть каждый бросок. Проверка
// идёт до самого конца: сервер поднимается против ПОДСТАВНОГО Bot API и в
// тесте читается то, что он реально отправил. Проверять формат текста, не
// проверяя доставку, здесь бессмысленно — именно доставка ломалась дважды.
// ---------------------------------------------------------------------------

describe("roll reports reach the administrator", () => {
  const RP_PORT = PORT + 211;
  const TG_PORT = PORT + 212;
  const RP_URL = `http://127.0.0.1:${RP_PORT}`;
  const ADMIN_HANDLE = "@report_boss";
  const ADMIN_CHAT = 4242;

  /** Всё, что сервер отправил в Telegram, по порядку. */
  let sent: Array<{ chat_id: string | number; text: string }> = [];

  let rpServer: ChildProcess;
  let tgStub: http.Server;
  let rpDir: string;

  /*
   * Сообщения администратору — остальное (игроку, в группу) отсеиваем.
   *
   * Отбор строго по заголовку отчёта. Первая версия ловила любое «ХОД» в
   * тексте и подхватывала поздравление игрока с призом, которое уходит в тот
   * же подставной API: тест падал на «пустом отчёте», хотя отчёт был отправлен
   * и лежал вторым в списке.
   */
  const toAdmin = () => sent.filter((m) => String(m.chat_id) === String(ADMIN_CHAT));
  const reports = () => toAdmin().filter((m) => /^🎲 <b>(ХОД|СЕРИЯ ХОДОВ):/.test(String(m.text)));

  beforeAll(async () => {
    rpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-report-"));

    // Подставной Bot API: отвечает как настоящий и записывает отправленное.
    tgStub = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.endsWith("/sendMessage")) {
          try {
            sent.push(JSON.parse(body));
          } catch {
            /* тело не JSON — не наш вызов */
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
      });
    });
    await new Promise<void>((r) => tgStub.listen(TG_PORT, "127.0.0.1", r));

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    rpServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(RP_PORT),
        DATA_DIR: rpDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: RP_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: ADMIN_HANDLE,
        TELEGRAM_API_ROOT: `http://127.0.0.1:${TG_PORT}`,
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${RP_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }

    // Привязываем чат администратора, иначе адресат неизвестен.
    await fetch(`${RP_URL}/api/internal/telegram-user`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: ADMIN_HANDLE, chatId: ADMIN_CHAT }),
    });
  }, 40_000);

  afterAll(async () => {
    rpServer?.kill("SIGTERM");
    await wait(400);
    rpServer?.kill("SIGKILL");
    await new Promise<void>((r) => tgStub.close(() => r()));
    if (rpDir) fs.rmSync(rpDir, { recursive: true, force: true });
  });

  async function newPlayer(handle: string) {
    await fetch(`${RP_URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: handle, admin: "@admin", deliverBy: "bot" }),
    });
    // Публичное состояние отдаёт псевдонимы, хендл виден только админу.
    const state = await fetch(`${RP_URL}/api/admin/state`, { headers: internalHeaders }).then((r) =>
      r.json()
    );
    return state.players.find((p: any) => p.name === handle);
  }

  async function grant(playerId: string, turns: number) {
    await fetch(`${RP_URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ playerId, admin: "@admin", confirmBonusUse: true, turns }),
    });
    await wait(250);
  }

  /**
   * Админский сокет ЭТОГО сервера.
   *
   * Общий connect() из шапки файла ходит на основной сервер, а не на тот, что
   * поднят для отчётов. Первая версия теста дёргала не тот процесс: команда
   * уходила в пустоту, а падение выглядело как «отчёт не отправился».
   */
  /** Текущее состояние игрока на этом сервере. */
  const playerIn2 = async (id: string) =>
    (await fetch(`${RP_URL}/api/state`).then((r) => r.json())).players.find(
      (p: any) => p.id === id
    );

  async function adminSocket() {
    const s = io(RP_URL, {
      transports: ["websocket"],
      auth: { token: signToken("admin", "admin") },
      reconnection: false,
      timeout: 4000,
    });
    await new Promise<void>((resolve, reject) => {
      s.on("connect", () => resolve());
      s.on("connect_error", reject);
    });
    s.on("error", () => {});
    return s;
  }

  async function playerSocket(id: string) {
    const s = io(RP_URL, {
      transports: ["websocket"],
      auth: { token: signToken(id, "player") },
      reconnection: false,
      timeout: 4000,
    });
    await new Promise<void>((resolve, reject) => {
      s.on("connect", () => resolve());
      s.on("connect_error", reject);
    });
    s.on("error", () => {});
    return s;
  }

  it("sends the administrator a report after a single roll", async () => {
    const player = await newPlayer("@report_single");
    await grant(player.id, 1);
    sent = [];

    const sock = await playerSocket(player.id);
    sock.emit("roll:request");
    await wait(900);
    sock.close();

    expect(reports().length).toBe(1);
    const text = reports()[0].text;

    // Имя игрока, грань кубика и переход между клетками.
    expect(text).toContain("@report_single");
    expect(text).toMatch(/🎲 <b>[1-6]<\/b>/);
    expect(text).toMatch(/клетка 0 ➔/);
  }, 30_000);

  it("says outright when nothing was won", async () => {
    /*
     * Пустое место админ читает как «сообщение потерялось». Отсутствие приза
     * должно быть написано словами — это половина смысла отчёта.
     *
     * Пачка на один бросок: ищем расклад, где кубик привёл на обычную клетку.
     */
    const player = await newPlayer("@report_noprize");

    for (let attempt = 0; attempt < 15; attempt++) {
      const admin = await adminSocket();
      admin.emit("admin:consume_bonus", player.id);
      admin.emit("admin:update_player", {
        id: player.id,
        cell: 0,
        color: player.color,
        name: player.name,
      });
      await wait(280);
      admin.close();

      await grant(player.id, 1);
      sent = [];

      const sock = await playerSocket(player.id);
      sock.emit("roll:request");
      await wait(800);
      sock.close();

      const now = await playerIn2(player.id);
      // Пачка должна закрыться: «+1 ХОД» её продлевает, и тогда отчёта ещё нет.
      if ((now.turnsApproved ?? 0) > 0 || now.activeBonus) continue;

      const text = reports()[0]?.text ?? "";
      expect(text).toContain("Призов нет");
      return;
    }
    throw new Error("за 15 попыток не нашлось броска без приза и без лишнего хода");
  }, 90_000);

  it("names the prize when one is won", async () => {
    /*
     * Подвести игрока к призу одним броском нельзя: ни с одной клетки все
     * шесть граней не ведут на призовую. Поэтому катим пачку и ждём приза —
     * призовых клеток десять из шестидесяти пяти.
     *
     * Броски идут ДО ИСЧЕРПАНИЯ пачки, а не фиксированное число раз: клетки
     * «+1 ХОД» добавляют броски, и после десяти вызовов пачка вполне может
     * быть ещё открыта. Тогда отчёт законно ждёт продолжения, а тест,
     * считавший до десяти, падал на пустой сводке и обвинял код.
     */
    const player = await newPlayer("@report_prize");

    for (let attempt = 0; attempt < 6; attempt++) {
      const admin = await adminSocket();
      admin.emit("admin:consume_bonus", player.id);
      admin.emit("admin:update_player", {
        id: player.id,
        cell: 0,
        color: player.color,
        name: player.name,
      });
      await wait(300);
      admin.close();

      await grant(player.id, 10);
      sent = [];

      const sock = await playerSocket(player.id);
      let left = 10;
      for (let guard = 0; guard < 20 && left > 0; guard++) {
        sock.emit("roll:request");
        await wait(420);
        left = (await playerIn2(player.id)).turnsApproved ?? 0;
      }
      await wait(700);
      sock.close();

      const now = await playerIn2(player.id);
      if (now.activeBonus && left === 0) {
        const text = reports()[0]?.text ?? "";
        expect(text).toContain("К ВЫДАЧЕ");
        expect(text).toContain("🎁");
        expect(text).not.toContain("Призов нет");
        // Приз назван, а не просто отмечен значком.
        expect(text).toContain(now.activeBonus.extra || now.activeBonus.name);
        return;
      }
    }
    throw new Error("за шесть пачек приз ни разу не выпал");
  }, 180_000);

  it("sends ONE report per batch, not one per roll", async () => {
    /*
     * Ровно то, о чём просил пользователь: серия из пяти бросков — одно
     * сообщение в конце, а не пять подряд.
     */
    const player = await newPlayer("@report_batch");
    await grant(player.id, 5);
    sent = [];

    // До исчерпания пачки, а не ровно пять раз: «+1 ХОД» добавляет броски.
    const sock = await playerSocket(player.id);
    let left = 5;
    for (let guard = 0; guard < 20 && left > 0; guard++) {
      sock.emit("roll:request");
      await wait(430);
      left = (await playerIn2(player.id)).turnsApproved ?? 0;
    }
    await wait(700);
    sock.close();

    expect(left).toBe(0);
    expect(reports().length).toBe(1);
  }, 40_000);

  it("describes every roll of the batch in that one message", async () => {
    const player = await newPlayer("@report_batch_detail");
    await grant(player.id, 4);
    sent = [];

    const sock = await playerSocket(player.id);
    let rolled = 0;
    let left = 4;
    for (let guard = 0; guard < 20 && left > 0; guard++) {
      sock.emit("roll:request");
      await wait(430);
      rolled += 1;
      left = (await playerIn2(player.id)).turnsApproved ?? 0;
    }
    await wait(700);
    sock.close();

    const text = reports()[0].text;
    expect(text).toContain("СЕРИЯ ХОДОВ");

    // Каждый сделанный бросок пронумерован и описан.
    for (let n = 1; n <= rolled; n++) expect(text).toContain(`${n}.`);
    expect(text).toContain(`Бросков: <b>${rolled}</b>`);

    // Путь начинается с нулевой клетки и заканчивается там, где стоит фишка.
    const now = await playerIn2(player.id);
    expect(text).toContain(`0 ➔ <b>${now.cell}</b>`);
  }, 40_000);

  it("stays silent until the batch is finished", async () => {
    // После первого броска из трёх админу писать рано.
    const player = await newPlayer("@report_quiet");
    await grant(player.id, 3);
    sent = [];

    const sock = await playerSocket(player.id);
    sock.emit("roll:request");
    await wait(800);

    expect(reports().length).toBe(0);

    let left = (await playerIn2(player.id)).turnsApproved ?? 0;
    for (let guard = 0; guard < 20 && left > 0; guard++) {
      sock.emit("roll:request");
      await wait(430);
      left = (await playerIn2(player.id)).turnsApproved ?? 0;
    }
    await wait(700);
    sock.close();

    expect(reports().length).toBe(1);
  }, 40_000);

  it("does not strand the report when the admin withdraws the rest", async () => {
    /*
     * Игрок бросил один раз из трёх, администратор отозвал остаток. Сводка
     * по сыгранному обязана уйти, иначе она осталась бы в буфере навсегда.
     */
    const player = await newPlayer("@report_withdrawn");
    await grant(player.id, 3);
    sent = [];

    const sock = await playerSocket(player.id);
    sock.emit("roll:request");
    await wait(800);
    sock.close();
    expect(reports().length).toBe(0);

    const admin = await adminSocket();
    admin.emit("admin:reject_player_turn", player.id);
    await wait(700);
    admin.close();

    expect(reports().length).toBe(1);
  }, 40_000);

  it("reports the roll that was refused nothing at all", async () => {
    // Бросок без одобрения не должен порождать отчёт: хода не было.
    const player = await newPlayer("@report_unapproved");
    sent = [];

    const sock = await playerSocket(player.id);
    sock.emit("roll:request");
    await wait(800);
    sock.close();

    expect(reports().length).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Ход без ограничения по времени.
//
// Раньше одобрение сгорало через 12 часов: игрок, купивший несколько товаров
// вечером, к утру терял оплаченные броски. Проверяется главное обещание —
// одобренный ход дожидается игрока, сколько бы времени ни прошло.
// ---------------------------------------------------------------------------

describe("approved turns never expire", () => {
  const EX_PORT = PORT + 131;
  const EX_URL = `http://127.0.0.1:${EX_PORT}`;
  let exServer: ChildProcess;
  let exDir: string;

  const stateOf = async () => fetch(`${EX_URL}/api/state`).then((r) => r.json());
  const playerOf = async (id: string) => (await stateOf()).players.find((p: any) => p.id === id);

  beforeAll(async () => {
    exDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-expiry-"));

    /*
     * Состояние, в котором одобрение УЖЕ протухло по старым правилам: дата
     * на год в прошлом, а счётчик хранит два невыбранных броска. Прежний
     * сервер сжёг бы их первым же тиком таймера.
     */
    fs.writeFileSync(
      path.join(exDir, "game-state-persistent.json"),
      JSON.stringify({
        schemaVersion: 3,
        players: [
          {
            id: "p_stale",
            name: "@stale_turns",
            role: "player",
            cell: 2,
            color: "#00ffaa",
            isOnline: false,
            lastRoll: null,
            skipNextTurn: false,
            turnApprovedUntil: Date.now() - 365 * 24 * 60 * 60 * 1000,
            turnsApproved: 2,
            turnBatchStartedAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
          },
        ],
        cells: [],
        currentPlayerId: "p_stale",
        turnRequestUserId: null,
        turnStatus: "waiting_roll",
        chatMessages: [],
        logs: [],
        boardImage: null,
        calibrationMode: false,
        selectedCalibrationCellId: null,
      }),
      "utf-8"
    );

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    exServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(EX_PORT),
        DATA_DIR: exDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: EX_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: "@e2e_admin",
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${EX_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }
  }, 40_000);

  afterAll(async () => {
    exServer?.kill("SIGTERM");
    await wait(400);
    exServer?.kill("SIGKILL");
    if (exDir) fs.rmSync(exDir, { recursive: true, force: true });
  });

  it("keeps turns whose 12-hour window ran out a year ago", async () => {
    expect((await playerOf("p_stale")).turnsApproved).toBe(2);
  });

  it("lets the player actually roll them", async () => {
    /*
     * Проверка не на поле в состоянии, а на самом броске: именно он раньше
     * отбивался словами «Сейчас не ваш ход».
     */
    const sock = io(EX_URL, {
      transports: ["websocket"],
      auth: { token: signToken("p_stale", "player") },
      reconnection: false,
      timeout: 4000,
    });
    await new Promise<void>((resolve, reject) => {
      sock.on("connect", () => resolve());
      sock.on("connect_error", reject);
    });

    const rolls: number[] = [];
    const errors: string[] = [];
    sock.on("roll:result", (d: { steps: number }) => rolls.push(d.steps));
    sock.on("error", (m: string) => errors.push(m));

    sock.emit("roll:request");
    await wait(700);
    sock.close();

    expect(errors.filter((e) => /не ваш ход/i.test(e))).toEqual([]);
    expect(rolls.length).toBe(1);
    expect((await playerOf("p_stale")).turnsApproved).toBe(1);
  }, 30_000);

  it("no longer runs a timer that burns unspent turns", async () => {
    /*
     * Таймер обходил игроков раз в минуту. Ждать минуту в тесте — плохая
     * идея, поэтому проверяем, что кода, который сжигал ходы, в сборке
     * попросту нет: строка сообщения об истечении исчезла вместе с ним.
     */
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "server.ts"), "utf-8");
    expect(src).not.toMatch(/ВРЕМЯ НА ХОД ИСТЕКЛО/);
    expect(src).not.toMatch(/turnExpiryTimer/);
  });

  it("keeps the roll button open for a stale approval", async () => {
    // turnStatus — второе условие кнопки броска. Оно тоже не должно зависеть
    // от возраста одобрения.
    expect((await stateOf()).turnStatus).toBe("waiting_roll");
  });
});

// ---------------------------------------------------------------------------
// Контроль выдачи разрешений.
//
// Кнопка «Одобрить» живёт в чате Telegram и после того, как решение принято
// в другом месте. Нажатие по ней выдавало ход ВТОРОЙ раз — жалоба
// пользователя. Проверяем весь контур: сервер отказывает, кнопки гаснут,
// заявка закрывается из любой точки.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Приватность: игрок не должен узнавать о чужих делах.
//
// Сервер рассылал в ОБЩУЮ группу «игрок X получил приз», «игрок X победил»
// и «игрок X запросил ход». Группа — это чат, где сидят все участники сразу,
// так что каждый видел, кто сколько выигрывает и как часто играет.
//
// Теперь всё это уходит лично администратору. Игроку приходит только то,
// что касается его самого.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Псевдонимы: игрок не видит Telegram-хендлы других участников.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Сводка «что ждёт решения» для администратора.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Отметка присутствия: по ней доска прячет фишки давно ушедших игроков.
// ---------------------------------------------------------------------------

describe("last-seen stamp drives token visibility", () => {
  const LS_PORT = PORT + 251;
  const LS_URL = `http://127.0.0.1:${LS_PORT}`;
  let lsServer: ChildProcess;
  let lsDir: string;

  const adminStateOf = async () =>
    fetch(`${LS_URL}/api/admin/state`, { headers: internalHeaders }).then((r) => r.json());
  const playerOf = async (handle: string) =>
    (await adminStateOf()).players.find((p: any) => p.name === handle);

  beforeAll(async () => {
    lsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-lastseen-"));

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    lsServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(LS_PORT),
        DATA_DIR: lsDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: LS_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: "@ls_boss",
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${LS_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }

    await fetch(`${LS_URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: "@ls_player", admin: "@admin", deliverBy: "bot" }),
    });
  }, 40_000);

  afterAll(async () => {
    lsServer?.kill("SIGTERM");
    await wait(400);
    lsServer?.kill("SIGKILL");
    if (lsDir) fs.rmSync(lsDir, { recursive: true, force: true });
  });

  it("stamps the player when a socket connects", async () => {
    const player = await playerOf("@ls_player");

    const sock = io(LS_URL, {
      transports: ["websocket"],
      auth: { token: signToken(player.id, "player") },
      reconnection: false,
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.on("error", () => {});
    await wait(400);
    sock.close();

    const after = await playerOf("@ls_player");
    expect(typeof after.lastSeenAt).toBe("number");
    expect(Date.now() - after.lastSeenAt).toBeLessThan(10_000);
  }, 25_000);

  it("refreshes the stamp on a roll, not only on a visit", async () => {
    /*
     * Игрок может подолгу не открывать доску, но играть. Без этой отметки
     * его фишка исчезла бы прямо посреди партии.
     */
    const player = await playerOf("@ls_player");

    // Отматываем отметку назад, будто игрок не появлялся неделю.
    const admin = io(LS_URL, {
      transports: ["websocket"],
      auth: { token: signToken("admin", "admin") },
      reconnection: false,
    });
    await new Promise<void>((r) => admin.on("connect", () => r()));
    admin.on("error", () => {});

    await fetch(`${LS_URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        playerId: player.id,
        admin: "@admin",
        confirmBonusUse: true,
        turns: 1,
      }),
    });
    await wait(250);

    const sock = io(LS_URL, {
      transports: ["websocket"],
      auth: { token: signToken(player.id, "player") },
      reconnection: false,
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.on("error", () => {});
    const before = (await playerOf("@ls_player")).lastSeenAt;
    await wait(1100);

    sock.emit("roll:request");
    await wait(700);
    sock.close();
    admin.close();

    const after = (await playerOf("@ls_player")).lastSeenAt;
    expect(after).toBeGreaterThan(before);
  }, 30_000);

  it("ships the timeout setting to clients", async () => {
    // Доска не сможет применить правило, если настройка до неё не доедет.
    const state = await fetch(`${LS_URL}/api/state`).then((r) => r.json());
    expect(typeof state.hideTokensAfterHours).toBe("number");
  });

  it("lets the admin change the timeout", async () => {
    const admin = io(LS_URL, {
      transports: ["websocket"],
      auth: { token: signToken("admin", "admin") },
      reconnection: false,
    });
    await new Promise<void>((r) => admin.on("connect", () => r()));
    admin.on("error", () => {});

    admin.emit("admin:set_token_timeout", 72);
    await wait(500);
    expect((await adminStateOf()).hideTokensAfterHours).toBe(72);

    // 0 выключает правило целиком.
    admin.emit("admin:set_token_timeout", 0);
    await wait(500);
    expect((await adminStateOf()).hideTokensAfterHours).toBe(0);

    admin.close();
  }, 25_000);

  it("clamps an absurd timeout instead of trusting it", async () => {
    const admin = io(LS_URL, {
      transports: ["websocket"],
      auth: { token: signToken("admin", "admin") },
      reconnection: false,
    });
    await new Promise<void>((r) => admin.on("connect", () => r()));
    admin.on("error", () => {});

    admin.emit("admin:set_token_timeout", 999_999);
    await wait(500);
    expect((await adminStateOf()).hideTokensAfterHours).toBe(8760);

    admin.emit("admin:set_token_timeout", 24);
    await wait(400);
    admin.close();
  }, 25_000);

  it("does not let a plain player change the timeout", async () => {
    const player = await playerOf("@ls_player");
    const before = (await adminStateOf()).hideTokensAfterHours;

    const sock = io(LS_URL, {
      transports: ["websocket"],
      auth: { token: signToken(player.id, "player") },
      reconnection: false,
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.on("error", () => {});
    sock.emit("admin:set_token_timeout", 0);
    await wait(500);
    sock.close();

    expect((await adminStateOf()).hideTokensAfterHours).toBe(before);
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Выгрузка списка игроков файлом.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Живое обновление экрана.
//
// Изменения должны доезжать до открытой игры сами. Регрессия, из-за которой
// появился этот блок: рассылку разделили на две версии (игрокам —
// псевдонимы, администратору — настоящие хендлы), а очистка списка изменений
// осталась ПЕРЕД сборкой. Обе версии обходили пустой набор и отправляли {}.
// Снаружи: удалил игрока — он не исчезает, пока не перезапустишь приложение.
// ---------------------------------------------------------------------------

describe("live updates reach open clients", () => {
  const LV_PORT = PORT + 291;
  const LV_URL = `http://127.0.0.1:${LV_PORT}`;
  let lvServer: ChildProcess;
  let lvDir: string;

  beforeAll(async () => {
    lvDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-live-"));

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    lvServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(LV_PORT),
        DATA_DIR: lvDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: LV_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: "@live_boss",
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${LV_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }
  }, 40_000);

  afterAll(async () => {
    lvServer?.kill("SIGTERM");
    await wait(400);
    lvServer?.kill("SIGKILL");
    if (lvDir) fs.rmSync(lvDir, { recursive: true, force: true });
  });

  async function register(handle: string) {
    await fetch(`${LV_URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: handle, admin: "@admin", deliverBy: "bot" }),
    });
    const state = await fetch(`${LV_URL}/api/admin/state`, { headers: internalHeaders }).then((r) =>
      r.json()
    );
    return state.players.find((p: any) => p.name === handle);
  }

  /** Открытое окно игры: собирает всё, что присылает сервер. */
  async function watcher(id: string, role: "player" | "admin" = "player") {
    const sock = io(LV_URL, {
      transports: ["websocket"],
      auth: { token: signToken(id, role) },
      reconnection: false,
      timeout: 4000,
    });
    const patches: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      sock.on("connect", () => resolve());
      sock.on("connect_error", reject);
    });
    sock.on("error", () => {});
    sock.on("state:patch", (p: Record<string, unknown>) => patches.push(p));
    return { sock, patches };
  }

  it("never sends an empty patch", async () => {
    /*
     * Главная проверка. Пустой патч — это «обновление пришло, но в нём
     * ничего нет»: клиент честно его применяет и ничего не меняет.
     */
    const player = await register("@live_watch");
    const { sock, patches } = await watcher(player.id);
    await wait(300);
    patches.length = 0;

    const admin = await watcher("admin", "admin");
    admin.sock.emit("admin:update_player", {
      id: player.id,
      cell: 7,
      color: player.color,
      name: player.name,
    });
    await wait(800);
    admin.sock.close();
    sock.close();

    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      expect(Object.keys(patch).length, "пустой патч — экран не обновится").toBeGreaterThan(0);
    }
  }, 30_000);

  it("tells an open client that a player was deleted", async () => {
    // Ровно то, о чём сообщил пользователь: удалил игрока, а он не исчезает.
    const victim = await register("@live_victim");
    const { sock, patches } = await watcher("live_observer");
    await wait(300);
    patches.length = 0;

    const admin = await watcher("admin", "admin");
    admin.sock.emit("admin:delete_player", victim.id);
    await wait(800);
    admin.sock.close();
    sock.close();

    const withPlayers = patches.filter((p) => Array.isArray((p as any).players));
    expect(withPlayers.length, "список игроков не пришёл").toBeGreaterThan(0);

    const last = withPlayers.at(-1) as any;
    expect(last.players.some((p: any) => p.id === victim.id)).toBe(false);
  }, 30_000);

  it("delivers a roll to a watching player", async () => {
    const roller = await register("@live_roller");
    const { sock, patches } = await watcher("live_observer2");
    await wait(300);

    await fetch(`${LV_URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        playerId: roller.id,
        admin: "@admin",
        confirmBonusUse: true,
        turns: 1,
      }),
    });
    await wait(300);
    patches.length = 0;

    const rollerSock = await watcher(roller.id);
    rollerSock.sock.emit("roll:request");
    await wait(900);
    rollerSock.sock.close();
    sock.close();

    // Наблюдатель узнал о ходе, не перезагружая страницу.
    const withPlayers = patches.filter((p) => Array.isArray((p as any).players));
    expect(withPlayers.length).toBeGreaterThan(0);
  }, 30_000);

  it("keeps masking handles in live updates", async () => {
    /*
     * Исправление не должно вернуть утечку: патч игроку по-прежнему идёт с
     * псевдонимами, администратору — с настоящими хендлами.
     */
    const secret = await register("@live_secret");

    const watch = await watcher("live_observer3");
    const adminWatch = await watcher("admin", "admin");
    await wait(300);
    watch.patches.length = 0;
    adminWatch.patches.length = 0;

    const admin = await watcher("admin", "admin");
    admin.sock.emit("admin:update_player", {
      id: secret.id,
      cell: 3,
      color: secret.color,
      name: secret.name,
    });
    await wait(800);
    admin.sock.close();
    watch.sock.close();
    adminWatch.sock.close();

    expect(JSON.stringify(watch.patches)).not.toContain("live_secret");
    expect(JSON.stringify(adminWatch.patches)).toContain("live_secret");
  }, 30_000);
});

describe("players export", () => {
  const EX2_PORT = PORT + 271;
  const EX2_URL = `http://127.0.0.1:${EX2_PORT}`;
  let exServer: ChildProcess;
  let exDir: string;

  const exportCsv = async () =>
    fetch(`${EX2_URL}/api/admin/players-export`, { headers: internalHeaders }).then((r) =>
      r.json()
    );

  beforeAll(async () => {
    exDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-export-"));

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    exServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(EX2_PORT),
        DATA_DIR: exDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: EX2_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: "@export_boss",
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${EX2_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }
  }, 40_000);

  afterAll(async () => {
    exServer?.kill("SIGTERM");
    await wait(400);
    exServer?.kill("SIGKILL");
    if (exDir) fs.rmSync(exDir, { recursive: true, force: true });
  });

  it("refuses without the internal token", async () => {
    const r = await fetch(`${EX2_URL}/api/admin/players-export`);
    expect(r.status).toBe(403);
  });

  it("reports an empty roster honestly", async () => {
    const body = await exportCsv();
    expect(body.success).toBe(true);
    expect(body.total).toBe(0);
  });

  it("lists every player with both alias and real handle", async () => {
    for (const handle of ["@exp_one", "@exp_two"]) {
      await fetch(`${EX2_URL}/api/admin/bot-approve-registration`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ username: handle, admin: "@admin", deliverBy: "bot" }),
      });
    }

    const body = await exportCsv();
    expect(body.total).toBe(2);
    // Настоящий хендл нужен: по нему админ находит человека в Telegram.
    expect(body.csv).toContain("@exp_one");
    expect(body.csv).toContain("@exp_two");

    // И псевдоним — по нему админ узнаёт игрока на доске.
    const state = await fetch(`${EX2_URL}/api/admin/state`, { headers: internalHeaders }).then(
      (r) => r.json()
    );
    for (const p of state.players.filter((x: any) => x.role === "player")) {
      expect(body.csv).toContain(p.alias);
    }
  }, 25_000);

  it("starts with a BOM so Excel reads Russian correctly", () => {
    /*
     * Без BOM Excel читает UTF-8 как кодировку системы, и весь русский текст
     * превращается в кракозябры. Файл при этом «открывается успешно» —
     * заметил бы только тот, кто в него заглянул.
     */
    return exportCsv().then((body) => {
      expect(body.csv.charCodeAt(0)).toBe(0xfeff);
    });
  });

  it("has a header row with the columns the admin needs", async () => {
    const body = await exportCsv();
    const header = body.csv.split("\r\n")[0];
    for (const column of ["Псевдоним", "Telegram", "Клетка", "Ходов осталось", "Невыданный приз"]) {
      expect(header).toContain(column);
    }
  });

  it("gives one row per player plus the header", async () => {
    const body = await exportCsv();
    const rows = body.csv.trim().split("\r\n");
    expect(rows.length).toBe(body.total + 1);
  });

  it("escapes quotes and commas so columns do not shift", async () => {
    /*
     * Псевдоним «Ц-3ПО (бета)» или имя с запятой без экранирования разъедут
     * таблицу по соседним столбцам, и файл станет мусором.
     */
    const admin = io(EX2_URL, {
      transports: ["websocket"],
      auth: { token: signToken("admin", "admin") },
      reconnection: false,
    });
    await new Promise<void>((r) => admin.on("connect", () => r()));
    admin.on("error", () => {});

    const state = await fetch(`${EX2_URL}/api/admin/state`, { headers: internalHeaders }).then(
      (r) => r.json()
    );
    const victim = state.players.find((p: any) => p.role === "player");
    admin.emit("admin:update_player", {
      id: victim.id,
      cell: victim.cell,
      color: victim.color,
      name: 'Игрок, "кавычки"',
    });
    await wait(500);
    admin.close();

    const body = await exportCsv();
    // Кавычки удвоены по RFC 4180, запятая осталась внутри поля.
    expect(body.csv).toContain('"Игрок, ""кавычки"""');
    // Строк по-прежнему по числу игроков: таблица не разъехалась.
    expect(body.csv.trim().split("\r\n").length).toBe(body.total + 1);
  }, 25_000);

  it("shows how long a player has been idle", async () => {
    const body = await exportCsv();
    expect(body.csv.split("\r\n")[0]).toContain("Часов без активности");
  });
});

describe("pending summary for the admin", () => {
  const SM_PORT = PORT + 231;
  const SM_URL = `http://127.0.0.1:${SM_PORT}`;
  let smServer: ChildProcess;
  let smDir: string;

  const summary = async () =>
    fetch(`${SM_URL}/api/admin/pending-summary`, { headers: internalHeaders }).then((r) =>
      r.json()
    );
  const adminStateOf = async () =>
    fetch(`${SM_URL}/api/admin/state`, { headers: internalHeaders }).then((r) => r.json());

  beforeAll(async () => {
    smDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-summary-"));

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    smServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(SM_PORT),
        DATA_DIR: smDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: SM_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: "@summary_boss",
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${SM_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }
  }, 40_000);

  afterAll(async () => {
    smServer?.kill("SIGTERM");
    await wait(400);
    smServer?.kill("SIGKILL");
    if (smDir) fs.rmSync(smDir, { recursive: true, force: true });
  });

  it("refuses without the internal token", async () => {
    const r = await fetch(`${SM_URL}/api/admin/pending-summary`);
    expect(r.status).toBe(403);
  });

  it("reports an empty board honestly", async () => {
    const body = await summary();
    expect(body.success).toBe(true);
    expect(body.registrations).toEqual([]);
    expect(body.turnRequests).toEqual([]);
    expect(body.unredeemedPrizes).toEqual([]);
    expect(body.playersTotal).toBe(0);
  });

  it("lists a queued registration request", async () => {
    await fetch(`${SM_URL}/api/internal/registration-request`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: "@sum_recruit", telegramId: 90210, chatId: 4242 }),
    });

    const body = await summary();
    expect(body.registrations.some((r: any) => r.username === "@sum_recruit")).toBe(true);
  });

  it("lists a turn request with the number of rolls asked for", async () => {
    await fetch(`${SM_URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: "@sum_player", admin: "@admin", deliverBy: "bot" }),
    });
    const player = (await adminStateOf()).players.find((p: any) => p.name === "@sum_player");

    const sock = io(SM_URL, {
      transports: ["websocket"],
      auth: { token: signToken(player.id, "player") },
      reconnection: false,
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.on("error", () => {});
    sock.emit("player:request_turn", 3);
    await wait(500);
    sock.close();

    const body = await summary();
    const entry = body.turnRequests.find((t: any) => t.id === player.id);
    expect(entry, "запрос хода не попал в сводку").toBeTruthy();
    expect(entry.requested).toBe(3);
    expect(entry.alias).toBeTruthy();
    // Админу нужен и настоящий хендл, чтобы написать человеку.
    expect(entry.name).toBe("@sum_player");
  }, 25_000);

  it("drops the request from the summary once it is approved", async () => {
    const player = (await adminStateOf()).players.find((p: any) => p.name === "@sum_player");

    await fetch(`${SM_URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        playerId: player.id,
        admin: "@admin",
        confirmBonusUse: true,
        turns: 3,
      }),
    });
    await wait(300);

    const body = await summary();
    expect(body.turnRequests.find((t: any) => t.id === player.id)).toBeUndefined();
    // Зато видно, что ходы выданы и ещё не потрачены.
    const open = body.approvedTurns.find((t: any) => t.id === player.id);
    expect(open.left).toBe(3);
  }, 25_000);

  it("lists an unredeemed prize the admin still has to hand over", async () => {
    /*
     * Приз выпадает случайно, поэтому катим пачку и ждём. Именно эта строка
     * сводки отвечает на вопрос «кому я ещё не отдал приз».
     */
    const player = (await adminStateOf()).players.find((p: any) => p.name === "@sum_player");

    for (let attempt = 0; attempt < 4; attempt++) {
      await fetch(`${SM_URL}/api/admin/bot-approve-turn`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          playerId: player.id,
          admin: "@admin",
          confirmBonusUse: true,
          turns: 10,
        }),
      });
      await wait(250);

      const sock = io(SM_URL, {
        transports: ["websocket"],
        auth: { token: signToken(player.id, "player") },
        reconnection: false,
      });
      await new Promise<void>((r) => sock.on("connect", () => r()));
      sock.on("error", () => {});

      let left = 10;
      for (let guard = 0; guard < 20 && left > 0; guard++) {
        sock.emit("roll:request");
        await wait(400);
        const now = (await adminStateOf()).players.find((p: any) => p.id === player.id);
        left = now.turnsApproved ?? 0;
        if (now.activeBonus) break;
      }
      sock.close();

      const body = await summary();
      const prize = body.unredeemedPrizes.find((p: any) => p.id === player.id);
      if (prize) {
        expect(prize.prize).toBeTruthy();
        expect(prize.alias).toBeTruthy();
        return;
      }
    }
    throw new Error("за четыре пачки приз ни разу не выпал");
  }, 120_000);

  it("warns that an unredeemed prize blocks the approval", async () => {
    // У игрока сейчас есть приз. Новый запрос хода должен нести пометку.
    const player = (await adminStateOf()).players.find((p: any) => p.name === "@sum_player");
    expect(player.activeBonus, "тест бессмыслен без приза").toBeTruthy();

    const sock = io(SM_URL, {
      transports: ["websocket"],
      auth: { token: signToken(player.id, "player") },
      reconnection: false,
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.on("error", () => {});
    sock.emit("player:request_turn", 1);
    await wait(500);
    sock.close();

    const body = await summary();
    const entry = body.turnRequests.find((t: any) => t.id === player.id);
    expect(entry.blockingBonus).toBeTruthy();
  }, 25_000);
});

describe("player aliases hide real handles", () => {
  const AL_PORT = PORT + 191;
  const TG4_PORT = PORT + 192;
  const AL_URL = `http://127.0.0.1:${AL_PORT}`;
  const ADMIN_HANDLE = "@alias_boss";
  const ADMIN_CHAT = 8001;

  const sent: Array<{ chat_id: string | number; text: string }> = [];
  let alServer: ChildProcess;
  let tgStub: http.Server;
  let alDir: string;

  beforeAll(async () => {
    alDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-alias-"));

    tgStub = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.endsWith("/sendMessage")) {
          try {
            sent.push(JSON.parse(body));
          } catch {
            /* не наш вызов */
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: sent.length + 400, chat: { id: ADMIN_CHAT } },
          })
        );
      });
    });
    await new Promise<void>((r) => tgStub.listen(TG4_PORT, "127.0.0.1", r));

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    alServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(AL_PORT),
        DATA_DIR: alDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: AL_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: ADMIN_HANDLE,
        TELEGRAM_API_ROOT: `http://127.0.0.1:${TG4_PORT}`,
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${AL_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }

    await fetch(`${AL_URL}/api/internal/telegram-user`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: ADMIN_HANDLE, chatId: ADMIN_CHAT }),
    });

    // Двое игроков: проверяем, что первый не видит хендл второго.
    for (const handle of ["@secret_alice", "@secret_bob"]) {
      await fetch(`${AL_URL}/api/admin/bot-approve-registration`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ username: handle, admin: "@admin", deliverBy: "bot" }),
      });
    }
  }, 40_000);

  afterAll(async () => {
    alServer?.kill("SIGTERM");
    await wait(400);
    alServer?.kill("SIGKILL");
    await new Promise<void>((r) => tgStub.close(() => r()));
    if (alDir) fs.rmSync(alDir, { recursive: true, force: true });
  });

  const publicState = async () => fetch(`${AL_URL}/api/state`).then((r) => r.json());

  async function socketState(id: string, role: "player" | "admin" = "player") {
    const s = io(AL_URL, {
      transports: ["websocket"],
      auth: { token: signToken(id, role) },
      reconnection: false,
      timeout: 4000,
    });
    const snapshot = await new Promise<any>((resolve, reject) => {
      s.on("state:update", (st: any) => resolve(st));
      s.on("connect_error", reject);
      setTimeout(() => reject(new Error("состояние не пришло")), 5000);
    });
    s.on("error", () => {});
    return { socket: s, snapshot };
  }

  it("gives every registered player an alias", async () => {
    const state = await publicState();
    const players = state.players.filter((p: any) => p.role === "player");
    expect(players.length).toBeGreaterThanOrEqual(2);
    for (const p of players) {
      expect(p.alias, "игрок без псевдонима засветит хендл").toBeTruthy();
      expect(p.alias).not.toContain("@");
    }
  });

  it("gives different players different aliases", async () => {
    const state = await publicState();
    const aliases = state.players.filter((p: any) => p.role === "player").map((p: any) => p.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("never exposes a real handle over the public API", async () => {
    const body = JSON.stringify(await publicState());
    expect(body).not.toContain("secret_alice");
    expect(body).not.toContain("secret_bob");
  });

  it("never sends another player's handle over the socket", async () => {
    /*
     * Главная проверка. Именно здесь была дыра: первый снимок состояния
     * уходил сырым, в обход фильтра, и игрок получал хендлы всех остальных
     * ещё до первого хода.
     */
    const state = await publicState();
    const alice = state.players.find((p: any) => p.alias && p.role === "player");

    const { socket, snapshot } = await socketState(alice.id);
    const body = JSON.stringify(snapshot);
    socket.close();

    expect(body).not.toContain("secret_alice");
    expect(body).not.toContain("secret_bob");
    // Псевдонимы при этом на месте — иначе играть не с кем.
    expect(snapshot.players.every((p: any) => Boolean(p.alias) || p.role === "admin")).toBe(true);
  }, 20_000);

  it("still shows real handles to the administrator", async () => {
    // Админу хендлы нужны: он по ним пишет игрокам и ищет их в боте.
    const { socket, snapshot } = await socketState("admin", "admin");
    const body = JSON.stringify(snapshot);
    socket.close();

    expect(body).toContain("secret_alice");
    expect(body).toContain("secret_bob");
  }, 20_000);

  it("writes the alias into the game log, not the handle", async () => {
    /*
     * Журнал читают все участники. Проверяем не только регистрацию, но и
     * запись о броске: первая версия теста смотрела пустой журнал и
     * пропускала возврат хендла в строку «выбросил N».
     */
    const state = await publicState();
    const alice = state.players.find((p: any) => p.role === "player");

    await fetch(`${AL_URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        playerId: alice.id,
        admin: "@admin",
        confirmBonusUse: true,
        turns: 1,
      }),
    });
    await wait(250);

    const sock = io(AL_URL, {
      transports: ["websocket"],
      auth: { token: signToken(alice.id, "player") },
      reconnection: false,
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.on("error", () => {});
    sock.emit("roll:request");
    await wait(700);
    sock.close();

    const after = await publicState();
    const logs = JSON.stringify(after.logs);
    expect(logs).not.toContain("secret_alice");
    expect(logs).not.toContain("secret_bob");
    // Запись о броске действительно появилась — иначе проверять нечего.
    expect(after.logs.some((l: any) => /выбросил/.test(l.message))).toBe(true);
    expect(after.logs.some((l: any) => l.message.includes(alice.alias))).toBe(true);
  }, 25_000);

  it("uses the alias as the chat sender name", async () => {
    const state = await publicState();
    const alice = state.players.find((p: any) => p.role === "player");

    const sock = io(AL_URL, {
      transports: ["websocket"],
      auth: { token: signToken(alice.id, "player") },
      reconnection: false,
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.on("error", () => {});
    sock.emit("chat:send", { text: "всем привет" });
    await wait(600);
    sock.close();

    const after = await publicState();
    const last = after.chatMessages.at(-1);
    expect(last.senderName).not.toContain("@");
    expect(last.senderName).toBe(alice.alias);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Обращение администратора к конкретному игроку.
// ---------------------------------------------------------------------------

describe("admin can reach one player directly", () => {
  const DM_PORT = PORT + 211;
  const TG5_PORT = PORT + 212;
  const DM_URL = `http://127.0.0.1:${DM_PORT}`;
  const ADMIN_HANDLE = "@dm_boss";
  const ADMIN_CHAT = 8501;
  const ALICE_CHAT = 8502;
  const BOB_CHAT = 8503;

  let sent: Array<{ chat_id: string | number; text: string }> = [];
  let dmServer: ChildProcess;
  let tgStub: http.Server;
  let dmDir: string;
  let alice: any;
  let bob: any;

  const toChat = (chat: number) => sent.filter((m) => String(m.chat_id) === String(chat));

  beforeAll(async () => {
    dmDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-dm-"));

    tgStub = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.endsWith("/sendMessage")) {
          try {
            sent.push(JSON.parse(body));
          } catch {
            /* не наш вызов */
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: sent.length + 600, chat: { id: ADMIN_CHAT } },
          })
        );
      });
    });
    await new Promise<void>((r) => tgStub.listen(TG5_PORT, "127.0.0.1", r));

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    dmServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(DM_PORT),
        DATA_DIR: dmDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: DM_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: ADMIN_HANDLE,
        TELEGRAM_API_ROOT: `http://127.0.0.1:${TG5_PORT}`,
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${DM_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }

    for (const [handle, chat] of [
      [ADMIN_HANDLE, ADMIN_CHAT],
      ["@dm_alice", ALICE_CHAT],
      ["@dm_bob", BOB_CHAT],
    ] as Array<[string, number]>) {
      await fetch(`${DM_URL}/api/internal/telegram-user`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ username: handle, chatId: chat }),
      });
    }

    for (const handle of ["@dm_alice", "@dm_bob"]) {
      await fetch(`${DM_URL}/api/admin/bot-approve-registration`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ username: handle, admin: "@admin", deliverBy: "bot" }),
      });
    }

    const state = await fetch(`${DM_URL}/api/state`).then((r) => r.json());
    alice = state.players.find((p: any) => p.id && p.alias && p.name === "@dm_alice");
    bob = state.players.find((p: any) => p.name === "@dm_bob");
    // Публичное состояние прячет хендлы, поэтому ищем через админский вид.
    if (!alice || !bob) {
      const all = state.players.filter((p: any) => p.role === "player");
      alice = all[0];
      bob = all[1];
    }
  }, 40_000);

  afterAll(async () => {
    dmServer?.kill("SIGTERM");
    await wait(400);
    dmServer?.kill("SIGKILL");
    await new Promise<void>((r) => tgStub.close(() => r()));
    if (dmDir) fs.rmSync(dmDir, { recursive: true, force: true });
  });

  it("delivers a /msg to the player found by alias", async () => {
    sent = [];
    const res = await fetch(`${DM_URL}/api/admin/bot-message-player`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ target: alice.alias, text: "Ваш приз ждёт", admin: "@boss" }),
    });
    expect(res.status).toBe(200);
    await wait(400);

    const delivered = sent.find((m) => /Ваш приз ждёт/.test(m.text));
    expect(delivered, "сообщение не дошло").toBeTruthy();
    expect(delivered!.text).toContain("Сообщение от администратора");
  }, 20_000);

  it("finds the player by the real handle too", async () => {
    sent = [];
    const res = await fetch(`${DM_URL}/api/admin/bot-message-player`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ target: "@dm_bob", text: "проверка связи" }),
    });
    expect(res.status).toBe(200);
  }, 20_000);

  it("says so when the player does not exist", async () => {
    const res = await fetch(`${DM_URL}/api/admin/bot-message-player`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ target: "Микки Маус", text: "привет" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/не найден/i);
  });

  it("refuses without the internal token", async () => {
    const res = await fetch(`${DM_URL}/api/admin/bot-message-player`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "кто угодно", text: "привет" }),
    });
    expect(res.status).toBe(403);
  });

  it("forwards an admin chat message to the player it names", async () => {
    /*
     * Админ пишет в игровой чат «Бэтмен, зайдите» — названный игрок получает
     * это в Telegram. Остальные — нет.
     */
    sent = [];
    const admin = io(DM_URL, {
      transports: ["websocket"],
      auth: { token: signToken("admin", "admin") },
      reconnection: false,
    });
    await new Promise<void>((r) => admin.on("connect", () => r()));
    admin.on("error", () => {});
    admin.emit("chat:send", { text: `${alice.alias}, зайдите за призом` });
    await wait(700);
    admin.close();

    const delivered = sent.filter((m) => /зайдите за призом/.test(m.text));
    expect(delivered.length).toBe(1);
    expect(String(delivered[0].chat_id)).toBe(String(ALICE_CHAT));
    // Бобу ничего не ушло.
    expect(toChat(BOB_CHAT).filter((m) => /зайдите/.test(m.text))).toEqual([]);
  }, 20_000);

  it("does not let a player message others through the chat", async () => {
    /*
     * Обращение работает ТОЛЬКО у администратора: иначе любой участник
     * рассылал бы другим сообщения в личку через игровой чат.
     */
    sent = [];
    const sock = io(DM_URL, {
      transports: ["websocket"],
      auth: { token: signToken(alice.id, "player") },
      reconnection: false,
    });
    await new Promise<void>((r) => sock.on("connect", () => r()));
    sock.on("error", () => {});
    sock.emit("chat:send", { text: `${bob.alias}, отдай приз` });
    await wait(700);
    sock.close();

    expect(toChat(BOB_CHAT)).toEqual([]);
  }, 20_000);
});

describe("players are never told about each other", () => {
  const PV_PORT = PORT + 171;
  const TG3_PORT = PORT + 172;
  const PV_URL = `http://127.0.0.1:${PV_PORT}`;
  const ADMIN_HANDLE = "@privacy_boss";
  const ADMIN_CHAT = 7001;
  const GROUP_CHAT = -100999;

  let sent: Array<{ chat_id: string | number; text: string }> = [];
  let pvServer: ChildProcess;
  let tgStub: http.Server;
  let pvDir: string;

  /** Всё, что ушло в общую группу. Должно остаться пустым. */
  const toGroup = () => sent.filter((m) => String(m.chat_id) === String(GROUP_CHAT));
  /** Сообщения администратору. */
  const toAdmin = () => sent.filter((m) => String(m.chat_id) === String(ADMIN_CHAT));

  beforeAll(async () => {
    pvDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-privacy-"));

    tgStub = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.endsWith("/sendMessage")) {
          try {
            sent.push(JSON.parse(body));
          } catch {
            /* не наш вызов */
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: sent.length + 300, chat: { id: ADMIN_CHAT } },
          })
        );
      });
    });
    await new Promise<void>((r) => tgStub.listen(TG3_PORT, "127.0.0.1", r));

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    pvServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(PV_PORT),
        DATA_DIR: pvDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: PV_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: ADMIN_HANDLE,
        // Группа НАСТРОЕНА. Именно поэтому тест что-то доказывает: если бы
        // её не было, сообщения не ушли бы туда просто из-за пустой настройки.
        TELEGRAM_GROUP_CHAT_ID: String(GROUP_CHAT),
        TELEGRAM_API_ROOT: `http://127.0.0.1:${TG3_PORT}`,
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${PV_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }

    await fetch(`${PV_URL}/api/internal/telegram-user`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: ADMIN_HANDLE, chatId: ADMIN_CHAT }),
    });
  }, 40_000);

  afterAll(async () => {
    pvServer?.kill("SIGTERM");
    await wait(400);
    pvServer?.kill("SIGKILL");
    await new Promise<void>((r) => tgStub.close(() => r()));
    if (pvDir) fs.rmSync(pvDir, { recursive: true, force: true });
  });

  const stateOf = async () => fetch(`${PV_URL}/api/state`).then((r) => r.json());
  // Поиск по настоящему хендлу возможен только в админском виде.
  const adminStateOf = async () =>
    fetch(`${PV_URL}/api/admin/state`, { headers: internalHeaders }).then((r) => r.json());
  const playerOf = async (id: string) => (await stateOf()).players.find((p: any) => p.id === id);

  async function newPlayer(handle: string) {
    await fetch(`${PV_URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: handle, admin: "@admin", deliverBy: "bot" }),
    });
    return (await adminStateOf()).players.find((p: any) => p.name === handle);
  }

  async function playerSocket(id: string) {
    const s = io(PV_URL, {
      transports: ["websocket"],
      auth: { token: signToken(id, "player") },
      reconnection: false,
      timeout: 4000,
    });
    await new Promise<void>((resolve, reject) => {
      s.on("connect", () => resolve());
      s.on("connect_error", reject);
    });
    s.on("error", () => {});
    return s;
  }

  it("does not announce a turn request to the group", async () => {
    const player = await newPlayer("@privacy_request");
    sent = [];

    const sock = await playerSocket(player.id);
    sock.emit("player:request_turn", 2);
    await wait(700);
    sock.close();

    expect(toGroup()).toEqual([]);
    // Администратор при этом узнал — иначе игру не в чем было бы одобрять.
    expect(toAdmin().some((m) => /ЗАПРОС ХОДА/.test(m.text))).toBe(true);
  }, 30_000);

  it("tells the admin the cell and the bonus warning that the group used to get", async () => {
    /*
     * Рассылку в группу я не просто удалил: в ней были клетка игрока и
     * предупреждение о неиспользованном бонусе. Эти данные перенесены в
     * сообщение администратору, иначе он потерял бы их вместе с утечкой.
     */
    const player = await newPlayer("@privacy_details");
    sent = [];

    const sock = await playerSocket(player.id);
    sock.emit("player:request_turn", 1);
    await wait(700);
    sock.close();

    const request = toAdmin().find((m) => /ЗАПРОС ХОДА/.test(m.text));
    expect(request).toBeTruthy();
    expect(request!.text).toMatch(/Клетка: \d+/);
  }, 30_000);

  it("does not announce a prize to the group", async () => {
    /*
     * Катим пачку, пока не выпадет приз: подвести к нему одним броском
     * нельзя, ни с одной клетки все шесть граней не ведут на призовую.
     */
    const player = await newPlayer("@privacy_prize");

    for (let attempt = 0; attempt < 4; attempt++) {
      await fetch(`${PV_URL}/api/admin/bot-approve-turn`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          playerId: player.id,
          admin: "@admin",
          confirmBonusUse: true,
          turns: 10,
        }),
      });
      await wait(250);
      sent = [];

      const sock = await playerSocket(player.id);
      let left = 10;
      for (let guard = 0; guard < 20 && left > 0; guard++) {
        sock.emit("roll:request");
        await wait(420);
        left = (await playerOf(player.id)).turnsApproved ?? 0;
      }
      await wait(600);
      sock.close();

      const now = await playerOf(player.id);
      if (now.activeBonus) {
        // Отдельное «получил награду» — только админу. В группу уходит лента ходов.
        expect(toGroup().some((m) => /получил награду/.test(m.text))).toBe(false);
        expect(toGroup().some((m) => /📜/.test(m.text) || /ХОД|СЕРИЯ ХОДОВ/.test(m.text))).toBe(
          true
        );
        expect(toAdmin().some((m) => /получил награду|ПОБЕДИТЕЛЬ/.test(m.text))).toBe(true);
        return;
      }
    }
    throw new Error("за четыре пачки приз ни разу не выпал");
  }, 120_000);

  it("posts move history to the closed group, not turn requests", async () => {
    expect(toGroup().some((m) => /ЗАПРОС ХОДА/.test(m.text))).toBe(false);
    expect(toGroup().some((m) => /📜/.test(m.text) || /ХОД|СЕРИЯ ХОДОВ/.test(m.text))).toBe(true);
  });

  it("sends group history through sendGroupMessage", async () => {
    const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "server.ts"), "utf-8");
    expect(src).toMatch(/sendGroupMessage\(/);
  });
});

describe("approval cannot be granted twice", () => {
  const AP_PORT = PORT + 151;
  const TG2_PORT = PORT + 152;
  const AP_URL = `http://127.0.0.1:${AP_PORT}`;
  const ADMIN_HANDLE = "@approve_boss";
  const ADMIN_CHAT = 5151;

  /** Всё, что сервер слал в Telegram, и все правки сообщений. */
  let sent: Array<{ chat_id: string | number; text: string; reply_markup?: unknown }> = [];
  let edits: Array<{ message_id: number; text?: string }> = [];

  let apServer: ChildProcess;
  let tgStub: http.Server;
  let apDir: string;

  beforeAll(async () => {
    apDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-approve-"));

    tgStub = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: any = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          /* не наш вызов */
        }
        if (req.url?.endsWith("/sendMessage")) sent.push(parsed);
        if (req.url?.endsWith("/editMessageText")) edits.push(parsed);
        if (req.url?.endsWith("/editMessageReplyMarkup")) edits.push(parsed);

        res.writeHead(200, { "Content-Type": "application/json" });
        // message_id обязателен: по нему сервер потом гасит кнопки.
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: sent.length + 900, chat: { id: ADMIN_CHAT } },
          })
        );
      });
    });
    await new Promise<void>((r) => tgStub.listen(TG2_PORT, "127.0.0.1", r));

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    apServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(AP_PORT),
        DATA_DIR: apDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: AP_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: ADMIN_HANDLE,
        TELEGRAM_API_ROOT: `http://127.0.0.1:${TG2_PORT}`,
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${AP_URL}/healthz`)).ok) break;
      } catch {
        /* ещё не поднялся */
      }
      await wait(250);
    }

    await fetch(`${AP_URL}/api/internal/telegram-user`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: ADMIN_HANDLE, chatId: ADMIN_CHAT }),
    });
  }, 40_000);

  afterAll(async () => {
    apServer?.kill("SIGTERM");
    await wait(400);
    apServer?.kill("SIGKILL");
    await new Promise<void>((r) => tgStub.close(() => r()));
    if (apDir) fs.rmSync(apDir, { recursive: true, force: true });
  });

  const stateOf = async () => fetch(`${AP_URL}/api/state`).then((r) => r.json());
  const adminStateOf = async () =>
    fetch(`${AP_URL}/api/admin/state`, { headers: internalHeaders }).then((r) => r.json());
  const playerOf = async (id: string) => (await stateOf()).players.find((p: any) => p.id === id);

  async function newPlayer(handle: string) {
    await fetch(`${AP_URL}/api/admin/bot-approve-registration`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ username: handle, admin: "@admin", deliverBy: "bot" }),
    });
    return (await adminStateOf()).players.find((p: any) => p.name === handle);
  }

  async function playerSocket(id: string) {
    const s = io(AP_URL, {
      transports: ["websocket"],
      auth: { token: signToken(id, "player") },
      reconnection: false,
      timeout: 4000,
    });
    await new Promise<void>((resolve, reject) => {
      s.on("connect", () => resolve());
      s.on("connect_error", reject);
    });
    s.on("error", () => {});
    return s;
  }

  /**
   * Нажатие кнопки под заявкой в Telegram.
   *
   * Ровно тот вызов, который делает бот: с requireRequest. Выдача по
   * инициативе админа (/turns, кнопки в админке) этот флаг не ставит.
   */
  const pressApproveButton = (playerId: string, turns?: number) =>
    fetch(`${AP_URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        playerId,
        admin: "@boss",
        confirmBonusUse: true,
        requireRequest: true,
        ...(turns === undefined ? {} : { turns }),
      }),
    });

  it("refuses a second press of the same button", async () => {
    /*
     * Сердце задачи. Игрок просит ход, админ жмёт кнопку — выдано. Жмёт
     * ещё раз (кнопка-то осталась) — сервер обязан отказать.
     */
    const player = await newPlayer("@double_press");
    const sock = await playerSocket(player.id);
    sock.emit("player:request_turn", 2);
    await wait(400);

    const first = await pressApproveButton(player.id, 2);
    expect(first.status).toBe(200);
    expect((await playerOf(player.id)).turnsApproved).toBe(2);

    const second = await pressApproveButton(player.id, 2);
    expect(second.status).toBe(410);
    expect((await second.json()).alreadyHandled).toBe(true);

    // Ходов по-прежнему два, а не четыре.
    expect((await playerOf(player.id)).turnsApproved).toBe(2);
    sock.close();
  }, 30_000);

  it("refuses the Telegram button after the turn was approved in the admin console", async () => {
    /*
     * Именно этот случай описал пользователь: разрешение выдано в игре, а
     * сообщение в боте осталось живым.
     */
    const player = await newPlayer("@approved_in_ui");
    const sock = await playerSocket(player.id);
    sock.emit("player:request_turn", 1);
    await wait(400);

    // Одобряем из админки, как это делает админ на экране.
    const admin = io(AP_URL, {
      transports: ["websocket"],
      auth: { token: signToken("admin", "admin") },
      reconnection: false,
    });
    await new Promise<void>((r) => admin.on("connect", () => r()));
    admin.on("error", () => {});
    admin.emit("admin:approve_player_turn", player.id, true, 3);
    await wait(500);
    admin.close();

    expect((await playerOf(player.id)).turnsApproved).toBe(3);

    // Теперь админ по привычке жмёт кнопку в Telegram.
    const press = await pressApproveButton(player.id, 3);
    expect(press.status).toBe(410);

    // Ходов не стало шесть.
    expect((await playerOf(player.id)).turnsApproved).toBe(3);
    sock.close();
  }, 30_000);

  it("clears the buttons on the Telegram message when the turn is approved elsewhere", async () => {
    // Кнопка не просто перестаёт работать — она исчезает.
    const player = await newPlayer("@buttons_cleared");
    const sock = await playerSocket(player.id);
    sent = [];
    edits = [];
    sock.emit("player:request_turn", 1);
    await wait(500);

    // Сообщение с кнопками ушло.
    const withButtons = sent.filter((m) => m.reply_markup);
    expect(withButtons.length).toBeGreaterThan(0);

    const admin = io(AP_URL, {
      transports: ["websocket"],
      auth: { token: signToken("admin", "admin") },
      reconnection: false,
    });
    await new Promise<void>((r) => admin.on("connect", () => r()));
    admin.on("error", () => {});
    admin.emit("admin:approve_player_turn", player.id, true, 1);
    await wait(600);
    admin.close();
    sock.close();

    // Сервер отредактировал сообщение — кнопок там больше нет.
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.some((e) => /ХОД ОДОБРЕН/.test(String(e.text ?? "")))).toBe(true);
  }, 30_000);

  it("closes the request when the admin rejects it from Telegram", async () => {
    /*
     * Кнопка «Отклонить» раньше только переписывала текст: заявка на сервере
     * оставалась открытой, и игрок ждал решения, которого уже не будет.
     */
    const player = await newPlayer("@rejected_in_bot");
    const sock = await playerSocket(player.id);
    sock.emit("player:request_turn", 2);
    await wait(400);
    expect((await playerOf(player.id)).turnRequested).toBe(true);

    const res = await fetch(`${AP_URL}/api/admin/bot-reject-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ playerId: player.id, admin: "@boss" }),
    });
    expect(res.status).toBe(200);

    const after = await playerOf(player.id);
    expect(after.turnRequested).toBeFalsy();
    expect(after.turnsApproved).toBe(0);
    sock.close();
  }, 30_000);

  it("refuses to reject an already handled request", async () => {
    const player = await newPlayer("@reject_twice");
    const sock = await playerSocket(player.id);
    sock.emit("player:request_turn", 1);
    await wait(400);

    const first = await fetch(`${AP_URL}/api/admin/bot-reject-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ playerId: player.id, admin: "@boss" }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${AP_URL}/api/admin/bot-reject-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ playerId: player.id, admin: "@boss" }),
    });
    expect(second.status).toBe(410);
    sock.close();
  }, 30_000);

  it("still lets /turns hand out a turn with no request at all", async () => {
    /*
     * Защита не должна мешать админу действовать по своей инициативе:
     * команда /turns передаёт force и работает без заявки.
     */
    const player = await newPlayer("@forced_grant");
    expect((await playerOf(player.id)).turnRequested).toBeFalsy();

    const res = await fetch(`${AP_URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      // /turns не передаёт requireRequest: админ выдаёт ход сам.
      body: JSON.stringify({
        playerId: player.id,
        admin: "@boss",
        confirmBonusUse: true,
        turns: 2,
      }),
    });
    expect(res.status).toBe(200);
    expect((await playerOf(player.id)).turnsApproved).toBe(2);
  }, 30_000);

  it("still lets the admin console grant a turn with no request", async () => {
    // Кнопка «ВЫДАТЬ» в админке тоже не требует заявки.
    const player = await newPlayer("@ui_grant");
    const admin = io(AP_URL, {
      transports: ["websocket"],
      auth: { token: signToken("admin", "admin") },
      reconnection: false,
    });
    await new Promise<void>((r) => admin.on("connect", () => r()));
    admin.on("error", () => {});
    admin.emit("admin:approve_player_turn", player.id, true, 4);
    await wait(500);
    admin.close();

    expect((await playerOf(player.id)).turnsApproved).toBe(4);
  }, 30_000);

  it("replaces the old request when the player asks again", async () => {
    /*
     * Две заявки подряд — два сообщения с кнопками. Старая кнопка должна
     * погаснуть, иначе админ выдаст ход дважды: по старой и по новой.
     */
    const player = await newPlayer("@asks_twice");
    const sock = await playerSocket(player.id);
    edits = [];

    sock.emit("player:request_turn", 1);
    await wait(500);
    sock.emit("player:request_turn", 3);
    await wait(600);
    sock.close();

    // Первое сообщение отредактировано — кнопок в нём не осталось.
    expect(edits.some((e) => /ЗАЯВКА ОБНОВЛЕНА/.test(String(e.text ?? "")))).toBe(true);
    expect((await playerOf(player.id)).turnsRequested).toBe(3);
  }, 30_000);
});

describe("upgrade from a pre-batch state file", () => {
  /*
   * Состояние, сохранённое прошлой версией, счётчика ходов не имеет.
   * Если читать его как «ноль ходов», после обновления каждый игрок с
   * действующим одобрением молча потеряет ход — а именно так выглядела бы
   * авария на боевом сервере в момент выкатки.
   */
  let upServer: ChildProcess;
  let upDir: string;
  const UP_PORT = PORT + 101;
  const UP_URL = `http://127.0.0.1:${UP_PORT}`;

  beforeAll(async () => {
    upDir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-upgrade-"));
    const until = Date.now() + 6 * 60 * 60 * 1000;

    fs.writeFileSync(
      path.join(upDir, "game-state-persistent.json"),
      JSON.stringify({
        schemaVersion: 2,
        players: [
          {
            id: "p_legacy_1",
            name: "@legacy_approved",
            role: "player",
            cell: 3,
            color: "#00ffaa",
            isOnline: false,
            lastRoll: null,
            skipNextTurn: false,
            turnApprovedUntil: until,
          },
          {
            id: "p_legacy_2",
            name: "@legacy_idle",
            role: "player",
            cell: 1,
            color: "#ff00aa",
            isOnline: false,
            lastRoll: null,
            skipNextTurn: false,
            turnApprovedUntil: null,
          },
        ],
        cells: [],
        currentPlayerId: "p_legacy_1",
        turnRequestUserId: null,
        turnStatus: "waiting_roll",
        chatMessages: [],
        logs: [],
        boardImage: null,
        calibrationMode: false,
        selectedCalibrationCellId: null,
      }),
      "utf-8"
    );

    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(ADMIN_PASSWORD, salt, 100000, 32, "sha256").toString("hex");

    upServer = spawn("node", ["dist/server.cjs"], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(UP_PORT),
        DATA_DIR: upDir,
        ADMIN_PASSWORD_HASH: `${salt}:${hash}`,
        ADMIN_LOGIN: "admin",
        SESSION_SECRET,
        INTERNAL_API_SECRET: INTERNAL_SECRET,
        WEB_APP_URL: UP_URL,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_ADMIN_USERNAME: "@e2e_admin",
        LOG_LEVEL: "silent",
      },
      stdio: "ignore",
    });

    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${UP_URL}/healthz`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await wait(250);
    }
    throw new Error("upgrade server did not start in time");
  }, 30_000);

  afterAll(async () => {
    upServer?.kill("SIGTERM");
    await wait(400);
    upServer?.kill("SIGKILL");
    if (upDir) fs.rmSync(upDir, { recursive: true, force: true });
  });

  it("keeps a live approval worth exactly one roll", async () => {
    const state = await fetch(`${UP_URL}/api/state`).then((r) => r.json());
    const p = state.players.find((x: any) => x.id === "p_legacy_1");
    expect(p.turnsApproved).toBe(1);
  });

  it("does not invent turns for a player who had none", async () => {
    const state = await fetch(`${UP_URL}/api/state`).then((r) => r.json());
    const p = state.players.find((x: any) => x.id === "p_legacy_2");
    expect(p.turnsApproved).toBe(0);
  });

  it("lets the upgraded player make their one roll and no more", async () => {
    const socketFor = (id: string) =>
      new Promise<Socket>((resolve, reject) => {
        const sock = io(UP_URL, {
          transports: ["websocket"],
          auth: { token: signToken(id, "player") },
          reconnection: false,
          timeout: 4000,
        });
        sock.on("connect", () => resolve(sock));
        sock.on("connect_error", reject);
      });

    const sock = await socketFor("p_legacy_1");
    const rolls: number[] = [];
    const errors: string[] = [];
    sock.on("roll:result", (d: { steps: number }) => rolls.push(d.steps));
    sock.on("error", (m: string) => errors.push(m));

    sock.emit("roll:request");
    await wait(600);
    sock.emit("roll:request");
    await wait(600);
    sock.close();

    expect(rolls.length).toBe(1);
    expect(errors.some((e) => /не ваш ход/i.test(e))).toBe(true);
  }, 25_000);
});

describe("результат хода сообщается игроку", () => {
  /*
   * Раньше игрок узнавал о броске только когда попадал на особую клетку:
   * event:trigger отправлялся из веток «есть эффект». Обычная клетка не
   * давала никакого ответа — фишка молча переезжала, и человек не понимал,
   * сработал ли его бросок вообще.
   *
   * Проверяем настоящими бросками, а не чтением кода: сколько раз бросили —
   * столько раз и пришёл результат.
   */
  /** Гарантированно получить игрока: тест не должен зависеть от соседей. */
  async function ensurePlayer(name: string): Promise<any> {
    const existing = (await getState()).players;
    if (existing.length > 0) return existing[0];
    const admin = await connect(signToken("admin_user", "admin"));
    admin.socket!.emit("admin:register_player", { name, color: "#00FFAA" });
    await wait(700);
    admin.socket!.close();
    return (await getState()).players[0];
  }

  it("присылает turn:outcome после КАЖДОГО броска, включая обычные клетки", async () => {
    const player = await ensurePlayer("@outcome_actor");
    expect(player).toBeTruthy();
    const { socket } = await connect(signToken(player.id, "player"));

    const outcomes: any[] = [];
    const rolls: number[] = [];
    socket!.on("turn:outcome", (d: any) => outcomes.push(d));
    socket!.on("roll:result", (d: { steps: number }) => rolls.push(d.steps));
    socket!.on("error", () => {});

    const ROLLS = 5;
    for (let i = 0; i < ROLLS; i++) {
      await fetch(`${URL}/api/admin/bot-approve-turn`, {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({ playerId: player.id, admin: "@admin", confirmBonusUse: true }),
      });
      socket!.emit("roll:request");
      await wait(400);
    }
    await wait(400);
    socket!.close();

    // Ключевое утверждение: результатов ровно столько же, сколько бросков.
    expect(rolls.length).toBeGreaterThan(0);
    expect(outcomes.length).toBe(rolls.length);

    for (const o of outcomes) {
      expect(typeof o.title).toBe("string");
      expect(o.title).toMatch(/^ВЫПАЛО [1-6]$/);
      // Пустого описания не бывает — молчание читается как сбой.
      expect(o.body.length).toBeGreaterThan(10);
      expect(["good", "bad", "neutral"]).toContain(o.tone);
      expect(typeof o.footer).toBe("string");
      expect(o.footer.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it("не отдаёт результат чужого хода", async () => {
    await ensurePlayer("@outcome_actor");
    if ((await getState()).players.length < 2) {
      // Второй игрок нужен для проверки адресности.
      const admin = await connect(signToken("admin_user", "admin"));
      admin.socket!.emit("admin:register_player", {
        name: "@outcome_spy",
        color: "#FF0000",
      });
      await wait(700);
      admin.socket!.close();
    }

    const fresh = await getState();
    expect(fresh.players.length).toBeGreaterThanOrEqual(2);
    const actor = fresh.players[0];
    const spy = fresh.players[1];

    const actorConn = await connect(signToken(actor.id, "player"));
    const spyConn = await connect(signToken(spy.id, "player"));

    const mine: any[] = [];
    const theirs: any[] = [];
    actorConn.socket!.on("turn:outcome", (d: any) => mine.push(d));
    spyConn.socket!.on("turn:outcome", (d: any) => theirs.push(d));
    actorConn.socket!.on("error", () => {});
    spyConn.socket!.on("error", () => {});

    await fetch(`${URL}/api/admin/bot-approve-turn`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ playerId: actor.id, admin: "@admin", confirmBonusUse: true }),
    });
    actorConn.socket!.emit("roll:request");
    await wait(800);

    actorConn.socket!.close();
    spyConn.socket!.close();

    expect(mine.length).toBe(1);
    // Соседний игрок не должен знать ни выпавшего числа, ни приза.
    expect(theirs.length).toBe(0);
  }, 30_000);
});

describe("destructive operations", () => {
  it("requires a typed confirmation before wiping every player", async () => {
    const admin = await connect(signToken("admin_user", "admin"));
    const before = (await getState()).players.length;
    expect(before).toBeGreaterThan(0);

    let error: string | null = null;
    admin.socket!.on("error", (m: string) => (error = m));
    admin.socket!.emit("admin:reset_game", { clearPlayers: true });
    await wait(700);

    expect(error).toContain("УДАЛИТЬ ВСЕХ");
    expect((await getState()).players.length).toBe(before);
    admin.socket!.close();
  });

  it("writes a snapshot before an accepted wipe", async () => {
    const admin = await connect(signToken("admin_user", "admin"));
    admin.socket!.emit("admin:reset_game", { clearPlayers: true, confirm: "УДАЛИТЬ ВСЕХ" });
    await wait(900);

    const snapshotDir = path.join(dataDir, "snapshots");
    expect(fs.existsSync(snapshotDir)).toBe(true);
    expect(fs.readdirSync(snapshotDir).some((f) => f.includes("before-reset"))).toBe(true);
    expect((await getState()).players.length).toBe(0);
    admin.socket!.close();
  });
});
