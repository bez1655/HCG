/**
 * ============================================================================
 * ПРИСУТСТВИЕ ИГРОКА НА ДОСКЕ — pure functions
 * ============================================================================
 *
 * Игроки накапливаются: сыграл однажды, ушёл — а фишка осталась на поле
 * навсегда. Через несколько месяцев на стартовых клетках толпа, и живых
 * участников среди них не различить.
 *
 * Фишка того, кто давно не появлялся, скрывается. Позиция при этом
 * СОХРАНЯЕТСЯ: человек вернулся — фишка снова на своём месте, ничего не
 * потеряно. Это не удаление игрока, а только видимость.
 *
 * «Был в игре» — любое из двух: зашёл в приложение или сделал ход. Первое
 * важно, потому что человек мог просто смотреть за партией; второе — потому
 * что играть можно и не открывая доску подолгу.
 */

/** Сколько часов бездействия скрывают фишку по умолчанию. */
export const DEFAULT_HIDE_AFTER_HOURS = 24;

/** Разрешённые границы настройки: от часа до года. 0 — никогда не прятать. */
export const MIN_HIDE_AFTER_HOURS = 1;
export const MAX_HIDE_AFTER_HOURS = 8760;

/** Минимум, который нужен, чтобы решить судьбу фишки. */
export interface PresenceInfo {
  role?: "admin" | "player";
  /** Когда игрок в последний раз заходил или ходил. */
  lastSeenAt?: number;
  /** Игрок сейчас в сети. */
  isOnline?: boolean;
  /** Незакрытая пачка одобренных ходов. */
  turnsApproved?: number;
  /** Игрок просит ход прямо сейчас. */
  turnRequested?: boolean;
  /** Неиспользованный приз. */
  activeBonus?: unknown;
}

/**
 * Привести настройку к разумному значению.
 *
 * 0 и всё, что не число, означают «не прятать никогда»: администратор должен
 * иметь возможность выключить правило целиком, не убирая его из кода.
 */
export function normaliseHideAfterHours(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.max(n, MIN_HIDE_AFTER_HOURS), MAX_HIDE_AFTER_HOURS);
}

/**
 * Показывать ли фишку этого игрока на доске.
 *
 * @param hideAfterHours 0 — показывать всех, как раньше.
 */
export function isTokenVisible(
  player: PresenceInfo,
  hideAfterHours: number,
  now: number = Date.now()
): boolean {
  // Правило выключено — доска ведёт себя как прежде.
  if (normaliseHideAfterHours(hideAfterHours) === 0) return true;

  // Администратор фишкой на поле не является; решение о нём принимает
  // вызывающий код, здесь просто не мешаем.
  if (player.role === "admin") return true;

  /*
   * Тот, кто сейчас в игре или чей ход в работе, виден всегда — независимо
   * от времени. Иначе фишка могла бы исчезнуть у человека, который прямо
   * сейчас ждёт одобрения или держит невыданный приз, и админ потерял бы
   * его из виду именно тогда, когда он нужен.
   */
  if (player.isOnline) return true;
  if ((player.turnsApproved ?? 0) > 0) return true;
  if (player.turnRequested) return true;
  if (player.activeBonus) return true;

  /*
   * Отметки нет вовсе — состояние сохранено до появления этого поля.
   * Показываем: молча спрятать фишку игрока, о котором ничего не известно,
   * хуже, чем лишняя фишка на доске.
   */
  if (typeof player.lastSeenAt !== "number") return true;

  return now - player.lastSeenAt < hideAfterHours * 60 * 60 * 1000;
}

/** Сколько часов прошло с последнего появления. null — если неизвестно. */
export function hoursSinceSeen(player: PresenceInfo, now: number = Date.now()): number | null {
  if (typeof player.lastSeenAt !== "number") return null;
  return Math.max(0, Math.floor((now - player.lastSeenAt) / (60 * 60 * 1000)));
}

/** Разделить игроков на видимых и скрытых — для доски и для админки. */
export function splitByPresence<T extends PresenceInfo>(
  players: T[],
  hideAfterHours: number,
  now: number = Date.now()
): { visible: T[]; hidden: T[] } {
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const p of players) {
    (isTokenVisible(p, hideAfterHours, now) ? visible : hidden).push(p);
  }
  return { visible, hidden };
}
