/**
 * Пул прокси с автоматическим переключением.
 *
 * Зачем это нужно: бесплатные публичные прокси живут часы. Порт продолжает
 * принимать соединения и после того, как прокси перестал доводить трафик до
 * Telegram, — снаружи это выглядит как «бот молчит». Один адрес в настройках
 * означает, что каждое такое падение требует ручного вмешательства.
 *
 * Про MTProto. Его сюда добавить нельзя, и это не упущение: MTProto проксирует
 * протокол клиентов Telegram, а бот обращается к api.telegram.org обычными
 * HTTPS-запросами. Разные протоколы — MTProto такой трафик не пропустит.
 * Официальная документация Bot API говорит об этом прямо. Поэтому адрес вида
 * `mtproto://` распознаётся и отклоняется с объяснением, а не приводит к
 * молчаливому зависанию.
 *
 * Поведение пула:
 *   • адреса пробуются по порядку, первый рабочий становится текущим;
 *   • отказ текущего переключает на следующий, а не роняет бота;
 *   • упавший адрес отправляется в карантин с растущей паузой,
 *     чтобы мёртвый прокси не пробовался в цикле;
 *   • первый в списке считается предпочтительным: если он ожил,
 *     пул возвращается к нему.
 */
import https from "node:https";
import httpMod from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export type ProxyKind = "direct" | "socks" | "http";

export interface ProxyEntry {
  /** Исходная строка из настроек. Может содержать пароль — не логировать. */
  url: string;
  /** Безопасное для логов представление: схема, хост, порт. */
  label: string;
  kind: ProxyKind;
  agent: https.Agent | undefined;
  /** Сколько раз подряд не сработал. */
  failures: number;
  /** До какого момента не пробовать (мс эпохи). */
  quarantineUntil: number;
  /** Время последнего успешного обращения. */
  lastOkAt: number;
}

/** Пауза карантина растёт с числом отказов: 30 с, 2 мин, 8 мин, максимум 30 мин. */
function quarantineMs(failures: number): number {
  const base = 30_000;
  const grown = base * Math.pow(4, Math.max(0, failures - 1));
  return Math.min(grown, 30 * 60_000);
}

/** Разобрать одну запись из настроек. Бросает с внятным текстом. */
export function parseProxyEntry(raw: string): ProxyEntry {
  const url = raw.trim();

  if (url === "" || url.toLowerCase() === "direct") {
    return {
      url: "direct",
      label: "прямое соединение",
      kind: "direct",
      agent: new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000 }),
      failures: 0,
      quarantineUntil: 0,
      lastOkAt: 0,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`не похоже на адрес: "${url}"`);
  }

  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  const label = `${scheme}://${parsed.hostname}:${parsed.port || "?"}`;

  // MTProto — самая частая ошибка в настройке. Объясняем, а не молчим.
  if (scheme === "mtproto" || scheme === "tg" || url.startsWith("tg://proxy")) {
    throw new Error(
      `MTProto-прокси (${label}) не работает с ботами.\n` +
        `   MTProto проксирует протокол клиентов Telegram, а бот обращается\n` +
        `   к api.telegram.org обычными HTTPS-запросами — это разные протоколы.\n` +
        `   Нужен SOCKS5 или HTTP: socks5://хост:порт`
    );
  }

  if (scheme.startsWith("socks")) {
    // socks5:// резолвит имя локально. Там, где Telegram заблокирован, его DNS
    // обычно тоже недоступен, и запрос падает ещё до обращения к прокси.
    // socks5h:// поручает резолв прокси — здесь это всегда правильный выбор.
    const upgraded = url.replace(/^socks5?:\/\//i, "socks5h://");
    return {
      url,
      label,
      kind: "socks",
      agent: new SocksProxyAgent(upgraded) as unknown as https.Agent,
      failures: 0,
      quarantineUntil: 0,
      lastOkAt: 0,
    };
  }

  if (scheme === "http" || scheme === "https") {
    return {
      url,
      label,
      kind: "http",
      agent: new HttpsProxyAgent(url) as unknown as https.Agent,
      failures: 0,
      quarantineUntil: 0,
      lastOkAt: 0,
    };
  }

  throw new Error(`неизвестная схема "${scheme}" в адресе ${label}`);
}

/**
 * Разобрать список из настроек.
 *
 * Разделители — запятая, точка с запятой и перевод строки: так список удобно
 * держать и в одну строку, и столбиком.
 */
export function parseProxyList(raw: string | undefined): {
  entries: ProxyEntry[];
  errors: string[];
} {
  const entries: ProxyEntry[] = [];
  const errors: string[] = [];

  if (!raw || raw.trim() === "") return { entries, errors };

  const parts = raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");

  const seen = new Set<string>();

  for (const part of parts) {
    try {
      const entry = parseProxyEntry(part);
      // Повтор в списке не ускоряет перебор, а только тратит время.
      if (seen.has(entry.label)) continue;
      seen.add(entry.label);
      entries.push(entry);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  return { entries, errors };
}

export interface ProbeResult {
  ok: boolean;
  /** Задержка в миллисекундах при успехе. */
  ms: number;
  /** true, когда Telegram ответил, но отверг токен: сеть в порядке. */
  unauthorized: boolean;
  detail: string;
}

/**
 * Проверить один адрес запросом getMe.
 *
 * Ответ 401 засчитывается как успех соединения: Telegram ответил, значит
 * маршрут работает, а проблема в токене. Считать это отказом прокси — значит
 * заставить пул перебирать заведомо рабочие адреса.
 */
export function probeProxy(
  entry: ProxyEntry,
  token: string,
  timeoutMs = 12_000,
  apiRoot = "https://api.telegram.org"
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();

    // Адрес API берётся из настроек, а не зашивается: иначе проверка ходила бы
    // на настоящий api.telegram.org даже когда бот работает через
    // самостоятельный Bot API server или локальный стенд — и её результат
    // не имел бы отношения к реальному маршруту бота.
    let base: URL;
    try {
      base = new URL(apiRoot);
    } catch {
      base = new URL("https://api.telegram.org");
    }
    const isHttps = base.protocol === "https:";
    const transport = isHttps ? https : httpMod;

    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path: `${base.pathname.replace(/\/$/, "")}/bot${token}/getMe`,
        method: "GET",
        // Агент рассчитан на https; для http-стенда он не нужен и мешает.
        agent: isHttps ? entry.agent : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          const ms = Date.now() - started;
          if (res.statusCode === 401) {
            resolve({ ok: true, ms, unauthorized: true, detail: "токен отвергнут" });
          } else if ((res.statusCode ?? 0) < 400) {
            resolve({ ok: true, ms, unauthorized: false, detail: "ok" });
          } else {
            resolve({
              ok: false,
              ms,
              unauthorized: false,
              detail: `HTTP ${res.statusCode}`,
            });
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error(`таймаут ${timeoutMs} мс`)));
    req.on("error", (err) =>
      resolve({ ok: false, ms: Date.now() - started, unauthorized: false, detail: err.message })
    );
    req.end();
  });
}

export class ProxyPool {
  private entries: ProxyEntry[];
  private currentIndex = -1;
  private readonly token: string;
  private readonly log: (msg: string) => void;

  private readonly apiRoot: string;

  constructor(
    entries: ProxyEntry[],
    token: string,
    log: (msg: string) => void = console.log,
    apiRoot = "https://api.telegram.org"
  ) {
    this.entries = entries;
    this.token = token;
    this.log = log;
    this.apiRoot = apiRoot;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Текущий выбранный адрес, если он есть. */
  get current(): ProxyEntry | null {
    return this.currentIndex >= 0 ? this.entries[this.currentIndex] : null;
  }

  /** Агент для исходящих запросов. undefined — прямое соединение. */
  get agent(): https.Agent | undefined {
    return this.current?.agent;
  }

  /** Список для вывода в лог: без паролей. */
  describe(): string[] {
    const now = Date.now();
    return this.entries.map((e, i) => {
      const mark = i === this.currentIndex ? "▸" : " ";
      const state =
        e.quarantineUntil > now
          ? `в карантине ещё ${Math.ceil((e.quarantineUntil - now) / 1000)} с`
          : e.lastOkAt > 0
            ? "рабочий"
            : "не проверялся";
      return `${mark} ${e.label} — ${state}`;
    });
  }

  /**
   * Найти рабочий адрес и сделать его текущим.
   *
   * Порядок в списке — это приоритет: перебор всегда начинается сначала,
   * поэтому после восстановления первого адреса пул возвращается к нему.
   */
  async selectWorking(): Promise<ProxyEntry | null> {
    const now = Date.now();

    // Первый проход: только те, что не в карантине.
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.quarantineUntil > now) continue;

      const result = await probeProxy(entry, this.token, 12_000, this.apiRoot);
      if (result.ok) {
        entry.failures = 0;
        entry.quarantineUntil = 0;
        entry.lastOkAt = Date.now();
        this.currentIndex = i;
        this.log(`  ✓ ${entry.label} — отвечает за ${result.ms} мс`);
        return entry;
      }

      entry.failures += 1;
      entry.quarantineUntil = Date.now() + quarantineMs(entry.failures);
      this.log(`  ✗ ${entry.label} — ${result.detail}`);
    }

    // Второй проход: все в карантине, но выбора нет — пробуем всё подряд.
    // Лучше медленный прокси, чем неработающий бот.
    this.log("  Все адреса в карантине, пробую повторно...");
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const result = await probeProxy(entry, this.token, 12_000, this.apiRoot);
      if (result.ok) {
        entry.failures = 0;
        entry.quarantineUntil = 0;
        entry.lastOkAt = Date.now();
        this.currentIndex = i;
        this.log(`  ✓ ${entry.label} — заработал`);
        return entry;
      }
    }

    this.currentIndex = -1;
    return null;
  }

  /**
   * Сообщить, что текущий адрес отказал.
   * Возвращает новый рабочий адрес или null.
   */
  async reportFailure(reason: string): Promise<ProxyEntry | null> {
    const failed = this.current;
    if (failed) {
      failed.failures += 1;
      failed.quarantineUntil = Date.now() + quarantineMs(failed.failures);
      this.log(`  ! ${failed.label} отказал (${reason}) — переключаюсь`);
    }
    return this.selectWorking();
  }

  /**
   * Заменить список адресов, сохранив текущий рабочий.
   *
   * Нужно для списка, который обновляет контейнер-сборщик прокси. Наивная
   * замена массива сбросила бы выбранный маршрут и статистику отказов: бот
   * заново перебирал бы адреса каждые несколько минут, теряя рабочее
   * соединение ровно тогда, когда список стал лучше. Поэтому состояние
   * уже известных адресов переносится, а текущий остаётся текущим.
   *
   * Возвращает, что изменилось, — для лога.
   */
  replaceEntries(next: ProxyEntry[]): { added: number; removed: number; kept: number } {
    const previous = new Map(this.entries.map((e) => [e.label, e]));
    const currentLabel = this.current?.label;

    const merged: ProxyEntry[] = [];
    let added = 0;
    let kept = 0;

    for (const entry of next) {
      const old = previous.get(entry.label);
      if (old) {
        // Переносим наработанное: карантин и счётчик отказов заслужены.
        old.agent = old.agent ?? entry.agent;
        merged.push(old);
        previous.delete(entry.label);
        kept += 1;
      } else {
        merged.push(entry);
        added += 1;
      }
    }

    // Текущий рабочий адрес не выбрасываем, даже если он выпал из нового
    // списка: связь важнее свежести. Отпадёт сам при следующем отказе.
    let removed = previous.size;
    if (currentLabel && previous.has(currentLabel)) {
      const survivor = previous.get(currentLabel)!;
      merged.unshift(survivor);
      removed -= 1;
    }

    this.entries = merged;
    this.currentIndex = currentLabel ? merged.findIndex((e) => e.label === currentLabel) : -1;
    return { added, removed, kept };
  }

  /** Тестовый доступ к внутреннему списку. */
  _entries(): ProxyEntry[] {
    return this.entries;
  }
}
