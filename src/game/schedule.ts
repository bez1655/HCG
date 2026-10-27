/**
 * Quiet hours, turn reminders, daily admin digest.
 *
 * Pure functions so the clock can be injected in tests. Moscow is the
 * shop's wall clock; override the zone only in tests.
 */

export const REMINDER_EVERY_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_QUIET_START = 23;
export const DEFAULT_QUIET_END = 8;
export const DEFAULT_REPORT_HOUR = 21;
export const DEFAULT_TZ = "Europe/Moscow";

export interface ReminderPlayer {
  id: string;
  name: string;
  alias?: string;
  role?: string;
  telegramId?: number;
  turnsApproved?: number;
  lastTurnReminderAt?: number;
  turnBatchStartedAt?: number;
}

export function hourInZone(now: number, timeZone: string = DEFAULT_TZ): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
}

/** Quiet window that may wrap midnight, e.g. 23 → 8. */
export function isQuietHours(
  now: number,
  startHour: number = DEFAULT_QUIET_START,
  endHour: number = DEFAULT_QUIET_END,
  timeZone: string = DEFAULT_TZ
): boolean {
  const h = hourInZone(now, timeZone);
  if (startHour === endHour) return false;
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour;
}

export function playersDueReminder(
  players: ReminderPlayer[],
  now: number,
  everyMs: number = REMINDER_EVERY_MS
): ReminderPlayer[] {
  return players.filter((p) => {
    if (p.role === "admin") return false;
    if ((p.turnsApproved ?? 0) <= 0) return false;
    const since = p.lastTurnReminderAt ?? p.turnBatchStartedAt ?? 0;
    if (!since) return true;
    return now - since >= everyMs;
  });
}

export function reminderText(turns: number): string {
  const n = Math.abs(turns) % 100;
  const last = n % 10;
  let word = "ходов";
  if (n < 11 || n > 14) {
    if (last === 1) word = "ход";
    else if (last >= 2 && last <= 4) word = "хода";
  }
  return (
    `⏰ Напоминание: у вас одобрено <b>${turns}</b> ${word}.\n` +
    `Откройте игру и бросьте кубик — ход не сгорает, но ждать жалко.`
  );
}

export function buildDailyReport(input: {
  playersTotal: number;
  online: number;
  awaitingTurn: number;
  approvedTurns: number;
  unredeemedPrizes: Array<{ name: string; prize: string }>;
  idleHidden: number;
}): string {
  const prizes =
    input.unredeemedPrizes.length === 0
      ? "нет"
      : input.unredeemedPrizes
          .slice(0, 12)
          .map((p) => `• ${p.name} — ${p.prize}`)
          .join("\n");
  return (
    `📋 <b>Отчёт за день</b>\n\n` +
    `👥 Игроков: <b>${input.playersTotal}</b> (в сети ${input.online})\n` +
    `🎲 Ждут одобрения хода: <b>${input.awaitingTurn}</b>\n` +
    `✅ Несыгранных одобренных ходов: <b>${input.approvedTurns}</b>\n` +
    `👻 Скрыто с доски (неактивны): <b>${input.idleHidden}</b>\n\n` +
    `🎁 Невыданные призы:\n${prizes}`
  );
}

export function shouldSendDailyReport(
  lastSentDayKey: string | null,
  now: number,
  reportHour: number = DEFAULT_REPORT_HOUR,
  timeZone: string = DEFAULT_TZ
): { send: boolean; dayKey: string } {
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
  const h = hourInZone(now, timeZone);
  if (h !== reportHour) return { send: false, dayKey };
  if (lastSentDayKey === dayKey) return { send: false, dayKey };
  return { send: true, dayKey };
}
