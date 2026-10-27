import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePlainText, parseGeonode, isSaneHost, SOURCES } from "./sources.js";
import { ProxyStore, MAX_STRIKES, writeAtomic } from "./store.js";
import { toProxyUrl } from "./verify.js";
import { manualEntries } from "./index.js";

describe("parsing source responses", () => {
  it("pulls addresses out of a plain list", () => {
    expect(parsePlainText("1.2.3.4:1080\n5.6.7.8:9050\n")).toEqual([
      "1.2.3.4:1080",
      "5.6.7.8:9050",
    ]);
  });

  it("survives the banners and suffixes real sites add", () => {
    // Verbatim shape of spys.me: three header lines, then country/anonymity
    // flags after each address. A strict line parser returns zero here.
    const body = [
      "Proxy list (#400) updated at Wed, 05 Aug 26 01:58:10 +0300",
      "Support by donations:",
      "BTC bc1q0hxnu4gmn5ru8j7g29tv2dq2ng5g0zhanl6t4t",
      "IP address:Port CountryCode-Anonymity(Noa/Anm/Hia)-SSL_support(S)",
      "",
      "45.133.16.88:1080 CA-H + ",
      "94.102.124.87:1080 RU-H - ",
    ].join("\n");
    expect(parsePlainText(body)).toEqual(["45.133.16.88:1080", "94.102.124.87:1080"]);
  });

  it("reads the geonode JSON shape", () => {
    const body = JSON.stringify({
      data: [
        { ip: "91.226.172.214", port: "1080", protocols: ["socks5"] },
        { ip: "213.199.47.140", port: "4145", protocols: ["socks5"] },
      ],
    });
    expect(parseGeonode(body)).toEqual(["91.226.172.214:1080", "213.199.47.140:4145"]);
  });

  it("returns nothing instead of throwing when a source changes format", () => {
    // A source that starts answering HTML must degrade to zero results, not
    // crash the cycle and take every other source down with it.
    expect(parseGeonode("<html>502 Bad Gateway</html>")).toEqual([]);
    expect(parsePlainText("error code: 502")).toEqual([]);
  });

  it("rejects impossible ports", () => {
    expect(parsePlainText("1.2.3.4:99999")).toEqual([]);
  });
});

describe("host sanity", () => {
  it("keeps ordinary public addresses", () => {
    expect(isSaneHost("144.22.165.206")).toBe(true);
    expect(isSaneHost("8.8.8.8")).toBe(true);
  });

  it("rejects private, loopback and reserved ranges", () => {
    // These show up in public lists routinely. Probed from inside the
    // container they resolve to the container itself or to the Docker
    // network — a "working" proxy that points at our own services.
    for (const host of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
      "239.255.255.250",
    ]) {
      expect(isSaneHost(host), host).toBe(false);
    }
  });

  it("keeps 172.15 and 172.32, which are public", () => {
    // Off-by-one in the RFC1918 range check is easy and silently discards
    // usable proxies.
    expect(isSaneHost("172.15.0.1")).toBe(true);
    expect(isSaneHost("172.32.0.1")).toBe(true);
  });
});

describe("source catalogue", () => {
  it("has no duplicate names and every entry is https", () => {
    const names = SOURCES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SOURCES) expect(s.url.startsWith("https://"), s.name).toBe(true);
  });

  it("does not ship the sources that were verified dead", () => {
    // proxy-list.download answered 502 and mmpx12 answered 404 on 2026-08-05.
    // A source that never parses is indistinguishable from a broken harvester.
    const urls = SOURCES.map((s) => s.url).join(" ");
    expect(urls).not.toMatch(/proxy-list\.download/);
    expect(urls).not.toMatch(/mmpx12/);
  });
});

describe("proxy URL formatting", () => {
  it("emits the schemes the bot and server parse", () => {
    expect(toProxyUrl({ address: "1.2.3.4:1080", protocol: "socks5", source: "x" })).toBe(
      "socks5://1.2.3.4:1080"
    );
    expect(toProxyUrl({ address: "1.2.3.4:8080", protocol: "http", source: "x" })).toBe(
      "http://1.2.3.4:8080"
    );
  });
});

describe("manual entries from TELEGRAM_PROXY", () => {
  it("reads a comma-separated list", () => {
    expect(manualEntries("socks5://1.2.3.4:1080,http://5.6.7.8:3128")).toEqual([
      { address: "1.2.3.4:1080", protocol: "socks5" },
      { address: "5.6.7.8:3128", protocol: "http" },
    ]);
  });

  it("skips MTProto and junk without throwing", () => {
    expect(manualEntries("tg://proxy?server=a&port=443,мусор,socks5://1.2.3.4:1080")).toEqual([
      { address: "1.2.3.4:1080", protocol: "socks5" },
    ]);
  });

  it("handles an empty value", () => {
    expect(manualEntries("")).toEqual([]);
  });
});

describe("the store", () => {
  let dir: string;
  let store: ProxyStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcg-harvest-"));
    store = new ProxyStore(path.join(dir, "proxies.json"), 5);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts empty when there is no file", async () => {
    expect(await store.load()).toEqual({ loaded: 0 });
  });

  it("starts empty and warns when the file is corrupt", async () => {
    await fs.writeFile(path.join(dir, "proxies.json"), "{not json", "utf-8");
    const result = await store.load();
    expect(result.loaded).toBe(0);
    expect(result.warning).toBeTruthy();
  });

  it("deletes an address only after repeated failures", () => {
    store.recordSuccess("1.2.3.4:1080", "socks5", "test", 100);
    for (let i = 1; i < MAX_STRIKES; i++) {
      expect(store.recordFailure("1.2.3.4:1080")).toBe(false);
    }
    // Free proxies flap; deleting on the first timeout would empty a list
    // that is actually fine.
    expect(store.recordFailure("1.2.3.4:1080")).toBe(true);
    expect(store.size).toBe(0);
  });

  it("resets the strike count after a success", () => {
    store.recordSuccess("1.2.3.4:1080", "socks5", "test", 100);
    store.recordFailure("1.2.3.4:1080");
    store.recordSuccess("1.2.3.4:1080", "socks5", "test", 90);
    store.recordFailure("1.2.3.4:1080");
    expect(store.size).toBe(1);
  });

  it("never deletes a pinned manual address", () => {
    store.pinManual("9.9.9.9:1080", "socks5");
    for (let i = 0; i < MAX_STRIKES * 3; i++) store.recordFailure("9.9.9.9:1080");
    // The operator chose this one — a paid proxy or their own VPS must not be
    // evicted by the scraper's bookkeeping.
    expect(store.size).toBe(1);
  });

  it("ranks by latency alone, with no privilege for manual entries", () => {
    // Manual entries used to be forced to the front, so one address in .env
    // captured every request while faster verified proxies waited behind it.
    // Position is earned by responding quickly, nothing else.
    store.recordSuccess("1.1.1.1:1080", "socks5", "a", 500);
    store.recordSuccess("2.2.2.2:1080", "socks5", "b", 100);
    store.pinManual("9.9.9.9:1080", "socks5");
    store.recordSuccess("9.9.9.9:1080", "socks5", "manual", 900);

    expect(store.ranked().map((r) => r.address)).toEqual([
      "2.2.2.2:1080",
      "1.1.1.1:1080",
      "9.9.9.9:1080",
    ]);
  });

  it("trims to the cap but never deletes a pinned entry", () => {
    // Pinned addresses lost their place at the FRONT of the list, but they
    // are still never evicted: the operator put them there deliberately, and
    // silently dropping one would be surprising.
    const small = new ProxyStore(path.join(dir, "s.json"), 2);
    small.pinManual("9.9.9.9:1080", "socks5");
    small.recordSuccess("9.9.9.9:1080", "socks5", "manual", 900);
    for (let i = 1; i <= 5; i++) small.recordSuccess(`1.1.1.${i}:1080`, "socks5", "s", i * 10);

    small.trim();
    const kept = small.ranked().map((r) => r.address);
    expect(kept).toContain("9.9.9.9:1080");
    // The fastest scraped proxy outranks it now.
    expect(kept[0]).toBe("1.1.1.1:1080");
  });

  it("writes a txt list the bot can parse, newest state first", async () => {
    store.recordSuccess("1.1.1.1:1080", "socks5", "a", 500);
    store.recordSuccess("2.2.2.2:8080", "http", "b", 100);
    await store.save();

    const txt = await fs.readFile(path.join(dir, "proxies.txt"), "utf-8");
    expect(txt.trim().split("\n")).toEqual(["http://2.2.2.2:8080", "socks5://1.1.1.1:1080"]);
  });

  it("keeps unverified pinned addresses out of the txt list", async () => {
    // Writing an unchecked address into the consumed list would have the bot
    // spend its startup probing something we never confirmed.
    store.pinManual("9.9.9.9:1080", "socks5");
    await store.save();
    expect((await fs.readFile(path.join(dir, "proxies.txt"), "utf-8")).trim()).toBe("");
  });

  it("survives a save/load round trip", async () => {
    store.recordSuccess("1.1.1.1:1080", "socks5", "a", 123);
    store.recordFailure("1.1.1.1:1080");
    await store.save();

    const reloaded = new ProxyStore(path.join(dir, "proxies.json"), 5);
    expect((await reloaded.load()).loaded).toBe(1);
    // Strikes must persist: a restart that forgot them would keep a dead
    // address forever, since it never reaches three in a row.
    expect(reloaded.all()[0].strikes).toBe(1);
  });
});

describe("atomic writes", () => {
  it("leaves no partial file behind", async () => {
    // The bot polls this file. A plain writeFile truncates first and fills
    // after; a reader landing in that window sees an empty list. This exact
    // bug already truncated game state once.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcg-atomic-"));
    const file = path.join(dir, "nested", "out.txt");
    await writeAtomic(file, "hello");
    expect(await fs.readFile(file, "utf-8")).toBe("hello");

    const leftovers = (await fs.readdir(path.dirname(file))).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

/**
 * "Отвечает сейчас" против "когда-либо работал".
 *
 * Разница решает, пойдёт ли сборщик за новыми адресами, и она стоила
 * расхождения прямо в логе у пользователя: «Живых: 15 из 22» строкой выше
 * и «в списке 20 рабочих» строкой ниже. Считалось lastOk !== null, то есть
 * адрес числился живым ещё два цикла после смерти — пока копил промахи
 * 1 и 2. Список, отваливший целиком, продолжал выглядеть полным, сборщик
 * не трогал источники, и бот оставался без единого рабочего маршрута.
 */
describe("сколько адресов отвечает прямо сейчас", () => {
  let dir: string;
  let store: ProxyStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcg-alive-"));
    store = new ProxyStore(path.join(dir, "p.json"), 30);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("считает только ответивших на последней проверке", () => {
    for (let i = 1; i <= 5; i++) store.recordSuccess(`1.1.1.${i}:1080`, "socks5", "t", 100);
    expect(store.respondingNow()).toHaveLength(5);

    // Один промах — ещё не удаление, но и живым он уже не считается.
    store.recordFailure("1.1.1.1:1080");
    expect(store.respondingNow()).toHaveLength(4);
  });

  it("показывает ноль, когда не ответил никто", () => {
    // Худший случай и главный: раньше здесь возвращалось полное число,
    // и сборщик решал, что за новыми адресами идти незачем.
    for (let i = 1; i <= 22; i++) store.recordSuccess(`1.1.1.${i}:1080`, "socks5", "t", 100);
    for (const rec of store.all()) store.recordFailure(rec.address);
    for (const rec of store.all()) store.recordFailure(rec.address);

    expect(store.all().length).toBeGreaterThan(0); // ещё не удалены
    expect(store.respondingNow()).toHaveLength(0); // но и не живы
  });

  it("возвращает адрес в счёт после успешной проверки", () => {
    store.recordSuccess("1.1.1.1:1080", "socks5", "t", 100);
    store.recordFailure("1.1.1.1:1080");
    expect(store.respondingNow()).toHaveLength(0);

    store.recordSuccess("1.1.1.1:1080", "socks5", "t", 120);
    expect(store.respondingNow()).toHaveLength(1);
  });

  it("не засчитывает закреплённый адрес, который молчит", () => {
    // Закреплённые не удаляются никогда. Считать молчащий за живого —
    // значит навсегда удержать счётчик выше цели и запретить сборщику
    // пополнять список.
    store.pinManual("9.9.9.9:1080", "socks5");
    expect(store.respondingNow()).toHaveLength(0);

    store.recordSuccess("9.9.9.9:1080", "socks5", "manual", 200);
    expect(store.respondingNow()).toHaveLength(1);

    store.recordFailure("9.9.9.9:1080");
    expect(store.respondingNow()).toHaveLength(0);
  });
});

/**
 * Аренда: сборщик отдаёт адреса и вычёркивает их у себя.
 *
 * Требование владельца проекта: у бота и сервера всегда не меньше пяти
 * рабочих прокси, в запасе 15-20, выданные не проверяются повторно,
 * мёртвые удаляются автоматически.
 */
describe("выдача прокси в аренду", () => {
  let dir: string;
  let store: ProxyStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcg-issue-"));
    store = new ProxyStore(path.join(dir, "p.json"), 20);
    for (let i = 1; i <= 18; i++) {
      store.recordSuccess(`10.0.0.${i}:1080`, "socks5", "src", i * 10);
    }
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("выдаёт лучшие адреса и убирает их из резерва", () => {
    const granted = store.issue(5, "bot");
    expect(granted).toHaveLength(5);
    // Самые быстрые уходят первыми.
    expect(granted[0].address).toBe("10.0.0.1:1080");
    expect(store.reserve()).toHaveLength(13);
  });

  it("не выдаёт один адрес двум потребителям", () => {
    const toBot = store.issue(5, "bot").map((r) => r.address);
    const toServer = store.issue(5, "server").map((r) => r.address);
    expect(toBot.some((a) => toServer.includes(a))).toBe(false);
    expect(store.reserve()).toHaveLength(8);
  });

  it("не перепроверяет выданные адреса", () => {
    // Иначе два контейнера долбят один бесплатный прокси, и цикл тратится
    // на адреса, которые всё равно нельзя никому отдать.
    store.issue(5, "bot");
    const due = store.dueForRecheck().map((r) => r.address);
    expect(due).toHaveLength(13);
    expect(due).not.toContain("10.0.0.1:1080");
  });

  it("удаляет адрес навсегда, когда потребитель признал его мёртвым", () => {
    store.issue(5, "bot");
    expect(store.discard("10.0.0.1:1080")).toBe(true);
    expect(store.all().some((r) => r.address === "10.0.0.1:1080")).toBe(false);
  });

  it("забирает обратно адреса упавшего контейнера", () => {
    // Без этого перезапуск потребителя навсегда съедал бы часть резерва.
    store.issue(5, "bot");
    const returned = store.reclaim("bot", new Set(["10.0.0.1:1080"]));
    expect(returned).toBe(4);
    expect(store.issued()).toHaveLength(1);
  });

  it("возвращённые адреса требуют перепроверки перед новой выдачей", () => {
    // Что с ними стало, пока их держал потребитель, мы не знаем.
    store.issue(5, "bot");
    store.reclaim("bot", new Set());
    expect(store.reserve().some((r) => r.address === "10.0.0.1:1080")).toBe(false);
    expect(store.dueForRecheck().some((r) => r.address === "10.0.0.1:1080")).toBe(true);
  });

  it("не обрезает выданные адреса по лимиту резерва", () => {
    // Потребитель на них рассчитывает; удалить здесь — значит потерять след
    // адреса, который прямо сейчас в работе.
    const small = new ProxyStore(path.join(dir, "s.json"), 5);
    for (let i = 1; i <= 12; i++) small.recordSuccess(`10.1.0.${i}:1080`, "socks5", "s", i * 10);
    small.issue(5, "bot");
    small.trim();
    expect(small.issued()).toHaveLength(5);
    expect(small.reserve().length).toBeLessThanOrEqual(5);
  });

  it("держит в proxies.txt только резерв", async () => {
    // Выданное уходит в файлы аренды. Показывать его здесь же значило бы
    // намекать, что оно свободно.
    store.issue(5, "bot");
    await store.save();
    const txt = await fs.readFile(path.join(dir, "proxies.txt"), "utf-8");
    expect(txt.trim().split("\n")).toHaveLength(13);
    expect(txt).not.toContain("10.0.0.1:1080");
  });

  it("переживает перезапуск, помня кому что выдано", async () => {
    store.issue(5, "bot");
    await store.save();

    const reloaded = new ProxyStore(path.join(dir, "p.json"), 20);
    await reloaded.load();
    expect(reloaded.issued()).toHaveLength(5);
    expect(reloaded.reserve()).toHaveLength(13);
  });

  it("отдаёт сколько есть, если резерв меньше запрошенного", () => {
    const small = new ProxyStore(path.join(dir, "t.json"), 20);
    small.recordSuccess("10.2.0.1:1080", "socks5", "s", 50);
    expect(small.issue(5, "bot")).toHaveLength(1);
  });
});

/**
 * Проверка перед выдачей.
 *
 * Требование: «при запросе от бота и сервера запускает проверку этих 20,
 * выдаёт самые быстрые». Сохранённая задержка может быть десятиминутной
 * давности, а бесплатный прокси за это время успевает умереть — тогда
 * потребитель обнаружит смерть сам и сразу придёт за заменой, ровно за тем
 * лишним кругом, которого аренда и должна избегать.
 */
describe("выдача проверяет резерв заново", () => {
  // fs здесь — промис-версия (её использует остальной файл), поэтому читаем
  // синхронно через отдельный импорт.
  const source = readFileSync(path.join(__dirname, "index.ts"), "utf-8");

  it("перепроверяет кандидатов перед выдачей", () => {
    const fn = source.slice(source.indexOf("async function serveConsumer"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/verifyAll\(/);
    // Проверка должна идти ДО issue(), иначе она бессмысленна.
    expect(body.indexOf("verifyAll(")).toBeLessThan(body.indexOf("store.issue("));
  });

  it("обновляет задержку по свежему замеру", () => {
    // Список отдаётся отсортированным по скорости, и потребитель идёт по
    // нему сверху вниз: устаревшая цифра испортит порядок.
    const fn = source.slice(source.indexOf("async function serveConsumer"));
    expect(fn.slice(0, 3000)).toMatch(/store\.recordSuccess\(/);
  });

  it("удаляет умершего кандидата, а не выдаёт его", () => {
    const fn = source.slice(source.indexOf("async function serveConsumer"));
    expect(fn.slice(0, 3000)).toMatch(/store\.recordFailure\(/);
  });

  it("проверяет только голову резерва, а не весь список", () => {
    // Двадцать проверок на каждый запрос — это лишние секунды ожидания;
    // кандидаты на выдачу и так стоят в начале.
    const fn = source.slice(source.indexOf("async function serveConsumer"));
    expect(fn.slice(0, 3000)).toMatch(/slice\(0, Math\.min\(need \* 3, 12\)\)/);
  });
});
