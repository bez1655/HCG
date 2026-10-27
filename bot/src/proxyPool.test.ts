import { describe, it, expect } from "vitest";
import { parseProxyEntry, parseProxyList, ProxyPool, type ProxyEntry } from "./proxyPool";

describe("разбор адресов прокси", () => {
  it("принимает socks5, socks5h, http и https", () => {
    for (const url of [
      "socks5://h:1080",
      "socks5h://h:1080",
      "socks4://h:1080",
      "http://h:3128",
      "https://h:3128",
    ]) {
      expect(() => parseProxyEntry(url), url).not.toThrow();
    }
  });

  it("объясняет, почему MTProto не подходит, а не падает молча", () => {
    // Самая частая ошибка в настройке: MTProto проксирует протокол клиентов
    // Telegram, а бот ходит на api.telegram.org обычным HTTPS.
    for (const url of ["mtproto://h:443?secret=ee00", "tg://proxy?server=h&port=443"]) {
      expect(() => parseProxyEntry(url), url).toThrow(/MTProto/);
      expect(() => parseProxyEntry(url), url).toThrow(/не работает с ботами/);
    }
  });

  it("переводит socks5 в socks5h — резолв на стороне прокси", () => {
    // Там, где Telegram заблокирован, его DNS обычно тоже недоступен:
    // локальный резолв упал бы ещё до обращения к прокси.
    const e = parseProxyEntry("socks5://10.0.0.1:1080");
    expect(e.kind).toBe("socks");
    expect(e.agent).toBeTruthy();
  });

  it("не раскрывает пароль в подписи для логов", () => {
    const e = parseProxyEntry("socks5://user:s3cret@10.0.0.1:1080");
    expect(e.label).not.toContain("s3cret");
    expect(e.label).not.toContain("user");
    expect(e.label).toContain("10.0.0.1");
  });

  it("понимает прямое соединение", () => {
    expect(parseProxyEntry("direct").kind).toBe("direct");
    expect(parseProxyEntry("").kind).toBe("direct");
  });

  it("отклоняет мусор и неизвестные схемы", () => {
    expect(() => parseProxyEntry("не адрес")).toThrow(/не похоже на адрес/);
    expect(() => parseProxyEntry("ftp://h:21")).toThrow(/неизвестная схема/);
  });
});

describe("разбор списка", () => {
  it("принимает запятую, точку с запятой и перевод строки", () => {
    const { entries } = parseProxyList("socks5://a:1080, socks5://b:1080; socks5://c:1080");
    expect(entries).toHaveLength(3);

    const multiline = parseProxyList("socks5://a:1080\nsocks5://b:1080");
    expect(multiline.entries).toHaveLength(2);
  });

  it("сохраняет порядок — он задаёт приоритет", () => {
    const { entries } = parseProxyList("socks5://first:1080,socks5://second:1080");
    expect(entries[0].label).toContain("first");
    expect(entries[1].label).toContain("second");
  });

  it("отбрасывает повторы", () => {
    const { entries } = parseProxyList("socks5://a:1080,socks5://a:1080");
    expect(entries).toHaveLength(1);
  });

  it("плохой адрес не отменяет остальные", () => {
    // Одна опечатка в списке из пяти не должна оставить бота без связи.
    const { entries, errors } = parseProxyList("socks5://ok:1080,мусор,socks5://ok2:1080");
    expect(entries).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it("возвращает пустой список, когда ничего не задано", () => {
    expect(parseProxyList(undefined).entries).toHaveLength(0);
    expect(parseProxyList("").entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Переключение. probeProxy подменяется, чтобы не ходить в сеть.
// ---------------------------------------------------------------------------

function fakeEntry(name: string): ProxyEntry {
  return {
    url: `socks5://${name}:1080`,
    label: `socks5://${name}:1080`,
    kind: "socks",
    agent: undefined,
    failures: 0,
    quarantineUntil: 0,
    lastOkAt: 0,
  };
}

/** Пул, у которого проверка отвечает по заранее заданной карте. */
class TestPool extends ProxyPool {
  constructor(
    entries: ProxyEntry[],
    private alive: Set<string>
  ) {
    super(entries, "token", () => {});
  }

  // Подменяем сетевую проверку на карту «живой / мёртвый».
  async selectWorking(): Promise<ProxyEntry | null> {
    const now = Date.now();
    const list = this._entries();

    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (pass === 0 && e.quarantineUntil > now) continue;

        if (this.alive.has(e.label)) {
          e.failures = 0;
          e.quarantineUntil = 0;
          e.lastOkAt = Date.now();
          (this as unknown as { currentIndex: number }).currentIndex = i;
          return e;
        }
        e.failures += 1;
        e.quarantineUntil = Date.now() + 30_000 * Math.pow(4, e.failures - 1);
      }
    }
    (this as unknown as { currentIndex: number }).currentIndex = -1;
    return null;
  }
}

describe("автопереключение", () => {
  it("берёт первый рабочий по порядку", async () => {
    const pool = new TestPool(
      [fakeEntry("a"), fakeEntry("b"), fakeEntry("c")],
      new Set(["socks5://b:1080", "socks5://c:1080"])
    );
    const chosen = await pool.selectWorking();
    expect(chosen?.label).toContain("b");
  });

  it("при отказе переключается на следующий", async () => {
    const alive = new Set(["socks5://a:1080", "socks5://b:1080"]);
    const pool = new TestPool([fakeEntry("a"), fakeEntry("b")], alive);

    expect((await pool.selectWorking())?.label).toContain("a");

    alive.delete("socks5://a:1080"); // первый умер
    const next = await pool.reportFailure("таймаут");
    expect(next?.label).toContain("b");
  });

  it("возвращается к первому, когда тот ожил", async () => {
    // Порядок в списке — это приоритет: предпочтительный адрес должен
    // подхватываться обратно, а не оставаться в резерве навсегда.
    const alive = new Set(["socks5://b:1080"]);
    const pool = new TestPool([fakeEntry("a"), fakeEntry("b")], alive);

    expect((await pool.selectWorking())?.label).toContain("b");

    alive.add("socks5://a:1080");
    for (const e of pool._entries()) e.quarantineUntil = 0; // карантин истёк
    expect((await pool.selectWorking())?.label).toContain("a");
  });

  it("возвращает null, когда не работает ничего", async () => {
    const pool = new TestPool([fakeEntry("a"), fakeEntry("b")], new Set());
    expect(await pool.selectWorking()).toBeNull();
    expect(pool.current).toBeNull();
  });

  it("карантин растёт с числом отказов", async () => {
    const pool = new TestPool([fakeEntry("a")], new Set());
    await pool.selectWorking();
    const first = pool._entries()[0].quarantineUntil;

    await pool.selectWorking();
    const second = pool._entries()[0].quarantineUntil;

    // Мёртвый адрес не должен опрашиваться в цикле без пауз.
    expect(second).toBeGreaterThan(first);
  });

  it("описание не раскрывает пароли", async () => {
    const { entries } = parseProxyList("socks5://u:p@h:1080");
    const pool = new ProxyPool(entries, "t", () => {});
    const text = pool.describe().join(" ");
    expect(text).not.toContain("p@");
    expect(text).not.toContain(":p");
  });
});

describe("замена списка на лету", () => {
  const make = (labels: string[]) => labels.map((l) => parseProxyEntry(l));

  it("сохраняет текущий рабочий адрес на его месте", () => {
    const pool = new ProxyPool(
      make(["socks5://a.test:1080", "socks5://b.test:1080"]),
      "t",
      () => {}
    );
    // Имитируем выбранный маршрут: второй адрес стал рабочим.
    (pool as unknown as { currentIndex: number }).currentIndex = 1;

    pool.replaceEntries(make(["socks5://b.test:1080", "socks5://c.test:1080"]));
    expect(pool.current?.label).toBe("socks5://b.test:1080");
  });

  it("не выбрасывает текущий адрес, даже если он выпал из нового списка", () => {
    // Связь важнее свежести: сборщик мог не успеть перепроверить адрес,
    // который прямо сейчас держит соединение.
    const pool = new ProxyPool(make(["socks5://a.test:1080"]), "t", () => {});
    (pool as unknown as { currentIndex: number }).currentIndex = 0;

    pool.replaceEntries(make(["socks5://z.test:1080"]));
    expect(pool._entries().map((e) => e.label)).toContain("socks5://a.test:1080");
    expect(pool.current?.label).toBe("socks5://a.test:1080");
  });

  it("переносит карантин уже известных адресов", () => {
    // Иначе обновление списка каждые несколько минут обнуляло бы наказание,
    // и мёртвый адрес пробовался бы бесконечно.
    const pool = new ProxyPool(make(["socks5://a.test:1080"]), "t", () => {});
    const entry = pool._entries()[0];
    entry.failures = 2;
    entry.quarantineUntil = Date.now() + 120_000;

    pool.replaceEntries(make(["socks5://a.test:1080", "socks5://b.test:1080"]));
    const after = pool._entries().find((e) => e.label === "socks5://a.test:1080")!;
    expect(after.failures).toBe(2);
    expect(after.quarantineUntil).toBeGreaterThan(Date.now());
  });

  it("сообщает, что изменилось", () => {
    const pool = new ProxyPool(
      make(["socks5://a.test:1080", "socks5://b.test:1080"]),
      "t",
      () => {}
    );
    const diff = pool.replaceEntries(make(["socks5://a.test:1080", "socks5://c.test:1080"]));
    expect(diff).toEqual({ added: 1, removed: 1, kept: 1 });
  });
});
