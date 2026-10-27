import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LeaseHolder, leaseUrl, type LeasedProxy } from "./leaseClient";

/**
 * Consumer side of the lease.
 *
 * The behaviour under test is the one the operator asked for outright: never
 * linger on a proxy that stopped answering. Five verified addresses are in
 * hand and fifteen more sit in the harvester's reserve, so a failing address
 * is dropped on the spot and the next one takes over — no retry, no
 * quarantine, no waiting.
 */
const proxy = (address: string, latencyMs = 100): LeasedProxy => ({
  address,
  protocol: "socks5",
  latencyMs,
  issuedAt: new Date().toISOString(),
});

function writeLease(dir: string, who: string, proxies: LeasedProxy[], generation = 1): void {
  fs.writeFileSync(
    path.join(dir, `lease-${who}.json`),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), generation, proxies }),
    "utf-8"
  );
}

function readAck(dir: string, who: string): { dead: string[]; holding: string[]; want: number } {
  return JSON.parse(fs.readFileSync(path.join(dir, `lease-${who}.ack.json`), "utf-8"));
}

describe("держатель аренды", () => {
  let dir: string;
  let lease: LeaseHolder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-lease-"));
    lease = new LeaseHolder(dir, "bot", 5, () => {});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("молчит, пока сборщик ничего не выдал", () => {
    // Обычное состояние до первого цикла сборщика, не ошибка.
    expect(lease.refresh()).toBe(false);
    expect(lease.size).toBe(0);
    expect(lease.current).toBeNull();
  });

  it("забирает выданные адреса", () => {
    writeLease(dir, "bot", [proxy("1.1.1.1:1080"), proxy("2.2.2.2:1080")]);
    expect(lease.refresh()).toBe(true);
    expect(lease.size).toBe(2);
    expect(lease.current?.address).toBe("1.1.1.1:1080");
  });

  it("не перечитывает неизменившийся файл", () => {
    // Пересборка агентов на каждом опросе рвала бы живые keep-alive сокеты.
    writeLease(dir, "bot", [proxy("1.1.1.1:1080")]);
    expect(lease.refresh()).toBe(true);
    expect(lease.refresh()).toBe(false);
  });

  it("сразу переходит на следующий при отказе", () => {
    writeLease(dir, "bot", [proxy("1.1.1.1:1080"), proxy("2.2.2.2:1080")]);
    lease.refresh();

    const next = lease.dropCurrent("таймаут");
    expect(next?.address).toBe("2.2.2.2:1080");
    expect(lease.size).toBe(1);
  });

  it("сообщает сборщику о мёртвом адресе немедленно", () => {
    writeLease(dir, "bot", [proxy("1.1.1.1:1080"), proxy("2.2.2.2:1080")]);
    lease.refresh();
    lease.dropCurrent("ECONNREFUSED");

    // Ждать следующего опроса нельзя: сборщик действует по этому файлу,
    // и задержка здесь — это молчание бота для пользователя.
    const ack = readAck(dir, "bot");
    expect(ack.dead).toContain("1.1.1.1:1080");
    expect(ack.holding).toEqual(["2.2.2.2:1080"]);
    expect(ack.want).toBe(4);
  });

  it("возвращает null, когда аренда исчерпана", () => {
    writeLease(dir, "bot", [proxy("1.1.1.1:1080")]);
    lease.refresh();
    expect(lease.dropCurrent("мертв")).toBeNull();
    expect(readAck(dir, "bot").want).toBe(5);
  });

  it("не принимает обратно адрес, о смерти которого уже сообщил", () => {
    // Сборщик мог записать файл до того, как прочитал наше подтверждение.
    writeLease(dir, "bot", [proxy("1.1.1.1:1080"), proxy("2.2.2.2:1080")]);
    lease.refresh();
    lease.dropCurrent("мертв");

    writeLease(dir, "bot", [proxy("1.1.1.1:1080"), proxy("2.2.2.2:1080")], 2);
    lease.refresh();
    expect(lease.list().map((p) => p.address)).toEqual(["2.2.2.2:1080"]);
  });

  it("остаётся на рабочем адресе при обновлении аренды", () => {
    // Переключение без причины рвёт живое соединение.
    writeLease(dir, "bot", [proxy("1.1.1.1:1080"), proxy("2.2.2.2:1080")]);
    lease.refresh();
    lease.rotate();
    expect(lease.current?.address).toBe("2.2.2.2:1080");

    writeLease(dir, "bot", [proxy("3.3.3.3:1080"), proxy("2.2.2.2:1080")], 2);
    lease.refresh();
    expect(lease.current?.address).toBe("2.2.2.2:1080");
  });

  it("выбрасывает адрес по имени, где бы он ни стоял", () => {
    writeLease(dir, "bot", [proxy("1.1.1.1:1080"), proxy("2.2.2.2:1080"), proxy("3.3.3.3:1080")]);
    lease.refresh();
    lease.dropCurrentByAddress("2.2.2.2:1080", "таймаут");
    expect(lease.list().map((p) => p.address)).toEqual(["1.1.1.1:1080", "3.3.3.3:1080"]);
  });

  it("переживает испорченный файл аренды", () => {
    fs.writeFileSync(path.join(dir, "lease-bot.json"), "{сломано", "utf-8");
    expect(lease.refresh()).toBe(false);
    expect(lease.size).toBe(0);
  });

  it("строит адреса в том виде, который понимает пул", () => {
    expect(leaseUrl(proxy("1.2.3.4:1080"))).toBe("socks5://1.2.3.4:1080");
    expect(leaseUrl({ ...proxy("1.2.3.4:8080"), protocol: "http" })).toBe("http://1.2.3.4:8080");
  });
});

describe("копии модуля аренды не расходятся", () => {
  it("бот и сервер используют один и тот же код", () => {
    // Файл продублирован намеренно: контейнеры собираются из разных
    // контекстов, общего пакета нет, а импорт через границу ломает сборку
    // Docker. Расхождение копий вернуло бы знакомую беду — бот чинится,
    // сервер молча остаётся сломанным.
    const strip = (s: string) =>
      s
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
        .join("\n");

    const bot = fs.readFileSync(path.join(__dirname, "leaseClient.ts"), "utf-8");
    const server = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "telegram", "leaseClient.ts"),
      "utf-8"
    );
    expect(strip(server)).toBe(strip(bot));
  });
});

/**
 * Порядок запуска: аренда загружается ДО поиска маршрута, и поиск один.
 *
 * Симптом, с которого начали: вписанный руками в .env прокси подхватывался
 * сразу, а тот же адрес, выданный парсером, — нет. Причина была в гонке.
 * startHarvestWatch() синхронно вызывал reload(), тот при пустом пуле сам
 * звал ensureRoute(), и следом стартовал ensureRoute() из main. Два поиска
 * шли параллельно по одному пулу: оба проверяли один адрес и оба писали в
 * него результат, так что проигравший мог пометить рабочий прокси как
 * отказавший — прямо перед тем, как второй его выберет.
 *
 * Через .env этого не случалось: там маршрут находился до старта гонки.
 */
describe("порядок запуска бота", () => {
  const source = fs.readFileSync(path.join(__dirname, "index.ts"), "utf-8");

  it("стартовая загрузка аренды не запускает поиск маршрута", () => {
    const fn = source.slice(source.indexOf("function loadLeaseIntoPool"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(
      body,
      "loadLeaseIntoPool() должен только заполнять пул: поиск идёт из main"
    ).not.toMatch(/ensureRoute\(/);
  });

  it("при старте вызывается загрузчик, а не полный reload", () => {
    const fn = source.slice(source.indexOf("function startHarvestWatch"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/loadLeaseIntoPool\(\);/);
    // void reload() на старте — это и есть второй поиск.
    expect(body).not.toMatch(/^\s*void reload\(\);/m);
  });

  it("аренда попадает в пул до проверки маршрута", () => {
    // Иначе ensureRoute() увидит одно прямое соединение и уйдёт в отказ,
    // хотя рядом лежат пять проверенных адресов.
    const watch = source.indexOf("startHarvestWatch();");
    const ensure = source.indexOf("void ensureRoute()");
    expect(watch).toBeGreaterThan(-1);
    expect(ensure).toBeGreaterThan(-1);
    expect(watch).toBeLessThan(ensure);
  });

  it("периодическая перепроверка по-прежнему умеет искать маршрут", () => {
    // Загрузку отделили от поиска — но когда маршрут потерян, свежая
    // аренда обязана его поднять.
    const fn = source.slice(source.indexOf("function startHarvestWatch"));
    expect(fn.slice(0, 1200)).toMatch(/if \(!proxyPool\.current\) await ensureRoute\(\);/);
  });
});
