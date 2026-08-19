import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PendingCredentialStore, normalise, CREDENTIAL_TTL_MS } from "./pendingCredentials";

/**
 * Passwords waiting for a hand-registered player to open the bot.
 *
 * The requirement, verbatim: the server hands the bot a login/password pair,
 * the bot keeps it until someone whose @username matches that login starts
 * the chat, delivers it, and deletes it immediately.
 *
 * Worth testing properly because both failure directions are bad — a
 * password that is never delivered locks the player out, and one that is
 * delivered twice sits in a chat log longer than it should.
 */
function writeServerFile(dir: string, items: unknown): void {
  fs.writeFileSync(path.join(dir, "pending-credentials.json"), JSON.stringify(items), "utf-8");
}

describe("отложенная выдача пароля", () => {
  let dir: string;
  let store: PendingCredentialStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-cred-"));
    store = new PendingCredentialStore(dir, () => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("пустое хранилище, когда сервер ничего не оставил", () => {
    expect(store.size).toBe(0);
    expect(store.claim("@someone")).toBeNull();
  });

  it("выдаёт пароль тому, чей username совпал", () => {
    store.put("@neon", "secret1");
    expect(store.claim("@neon")?.password).toBe("secret1");
  });

  it("удаляет запись сразу после выдачи", () => {
    // Требование пользователя дословно: «сразу же удаляет эту информацию
    // у себя». Иначе пароль повторялся бы при каждом /start.
    store.put("@neon", "secret1");
    store.claim("@neon");
    expect(store.claim("@neon")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("не отдаёт пароль другому пользователю", () => {
    store.put("@neon", "secret1");
    expect(store.claim("@someone-else")).toBeNull();
    // И пароль остаётся ждать своего адресата.
    expect(store.claim("@neon")?.password).toBe("secret1");
  });

  it("считает @Neon, neon и @neon одним человеком", () => {
    // Telegram отдаёт username без @ и в исходном регистре, а админ вводит
    // логин как ему удобно. Несовпадение здесь означало бы пароль, который
    // никогда не найдёт владельца.
    store.put("@Neon", "secret1");
    expect(store.claim("neon")?.password).toBe("secret1");
  });

  it("новая регистрация заменяет невыданный пароль", () => {
    // Сервер хранит хэш только последнего пароля: выдать предыдущий значит
    // дать игроку заведомо неработающие данные.
    store.put("@neon", "old");
    store.put("@neon", "new");
    expect(store.size).toBe(1);
    expect(store.claim("@neon")?.password).toBe("new");
  });

  it("переживает перезапуск контейнера", () => {
    // Ожидание не ограничено по времени: игрок может открыть бота завтра.
    store.put("@neon", "secret1");
    const reopened = new PendingCredentialStore(dir, () => {});
    expect(reopened.claim("@neon")?.password).toBe("secret1");
  });

  it("подхватывает то, что записал сервер", () => {
    // У бота нет HTTP-порта, поэтому сервер общается с ним через этот файл.
    writeServerFile(dir, [{ handle: "@fromserver", password: "s3rv3r", createdAt: Date.now() }]);
    const fresh = new PendingCredentialStore(dir, () => {});
    expect(fresh.claim("@fromserver")?.password).toBe("s3rv3r");
  });

  it("видит запись, появившуюся уже после запуска бота", () => {
    // Админ регистрирует игрока при работающем боте — самый обычный случай.
    expect(store.claim("@later")).toBeNull();
    writeServerFile(dir, [{ handle: "@later", password: "late", createdAt: Date.now() }]);
    expect(store.claim("@later")?.password).toBe("late");
  });

  it("не выдаёт просроченный пароль", () => {
    writeServerFile(dir, [
      { handle: "@stale", password: "old", createdAt: Date.now() - CREDENTIAL_TTL_MS - 1000 },
    ]);
    const fresh = new PendingCredentialStore(dir, () => {});
    expect(fresh.claim("@stale")).toBeNull();
  });

  it("переживает испорченный файл, не роняя бота", () => {
    fs.writeFileSync(path.join(dir, "pending-credentials.json"), "{сломано", "utf-8");
    const fresh = new PendingCredentialStore(dir, () => {});
    expect(fresh.size).toBe(0);
  });

  it("не показывает пароли в списке ожидающих", () => {
    // Список идёт в диагностику; паролям там не место.
    store.put("@neon", "secret1");
    expect(JSON.stringify(store.waiting())).not.toContain("secret1");
  });

  it("хранит файл с правами только для владельца", () => {
    // Пароли лежат в открытом виде до момента выдачи.
    store.put("@neon", "secret1");
    const mode = fs.statSync(path.join(dir, "pending-credentials.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("нормализация логина", () => {
  it("приводит к единому виду", () => {
    expect(normalise("Neon")).toBe("@neon");
    expect(normalise("@NEON")).toBe("@neon");
    expect(normalise("  @Neon  ")).toBe("@neon");
  });
});

/**
 * Обе стороны договорились об одном формате файла.
 *
 * Сервер пишет его вручную (у бота нет HTTP-порта), поэтому формат нигде не
 * разделён типом. Разойдись поля — пароль молча не дошёл бы до игрока, а
 * заметили бы это только по жалобе.
 */
describe("формат обмена с сервером", () => {
  const serverSource = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "server.ts"),
    "utf-8"
  );

  it("сервер пишет тот же файл, что читает бот", () => {
    expect(serverSource).toMatch(/pending-credentials\.json/);
  });

  it("поля совпадают с теми, что ждёт бот", () => {
    const fn = serverSource.slice(serverSource.indexOf("function queueCredentialsForBot"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    for (const field of ["handle", "password", "createdAt"]) {
      expect(body, `сервер не пишет поле ${field}`).toMatch(new RegExp(field));
    }
  });

  it("сервер тоже нормализует логин", () => {
    // Админ вводит «Neon», Telegram отдаёт «neon». Без приведения к общему
    // виду пароль остался бы ждать вечно.
    const fn = serverSource.slice(serverSource.indexOf("function queueCredentialsForBot"));
    expect(fn.slice(0, 1200)).toMatch(/normaliseHandle/);
  });

  it("сервер не затирает пары, которые бот ещё не забрал", () => {
    const fn = serverSource.slice(serverSource.indexOf("function queueCredentialsForBot"));
    expect(fn.slice(0, 1600)).toMatch(/readFileSync/);
  });

  it("ручная регистрация всегда выдаёт пароль", () => {
    // Раньше без пароля запись была пустой строкой, и игрок не мог войти
    // через браузер вовсе.
    expect(serverSource).toMatch(/reg\.password \|\| generatePassword\(\)/);
  });
});
