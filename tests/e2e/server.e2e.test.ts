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

    const state = await getState();
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
    const p = (await getState()).players.find((x: any) => x.name === HANDLE);
    expect(p.telegramId).toBeUndefined();
    expect(p.telegramUsername).toBeUndefined();
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

    const state = await getState();
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
