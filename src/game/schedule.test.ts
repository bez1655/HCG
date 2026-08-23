import { describe, it, expect } from "vitest";
import {
  isQuietHours,
  playersDueReminder,
  reminderText,
  buildDailyReport,
  shouldSendDailyReport,
  REMINDER_EVERY_MS,
} from "./schedule";

describe("тихие часы", () => {
  it("ночь 23–8 — тихо", () => {
    // 2026-08-20 23:30 UTC+3 = 20:30 UTC
    const night = Date.parse("2026-08-20T20:30:00Z");
    expect(isQuietHours(night, 23, 8, "Europe/Moscow")).toBe(true);
  });

  it("утро 10 — не тихо", () => {
    const day = Date.parse("2026-08-20T07:00:00Z"); // 10:00 Moscow
    expect(isQuietHours(day, 23, 8, "Europe/Moscow")).toBe(false);
  });
});

describe("напоминания о ходе", () => {
  const now = 1_800_000_000_000;

  it("берёт игрока с одобренными ходами, если давно не писали", () => {
    const due = playersDueReminder(
      [
        {
          id: "a",
          name: "@a",
          turnsApproved: 2,
          lastTurnReminderAt: now - REMINDER_EVERY_MS - 1,
        },
      ],
      now
    );
    expect(due.map((p) => p.id)).toEqual(["a"]);
  });

  it("не трогает, если писали меньше 5 часов назад", () => {
    const due = playersDueReminder(
      [{ id: "a", name: "@a", turnsApproved: 2, lastTurnReminderAt: now - 1000 }],
      now
    );
    expect(due).toEqual([]);
  });

  it("не трогает без ходов", () => {
    expect(playersDueReminder([{ id: "a", name: "@a", turnsApproved: 0 }], now)).toEqual([]);
  });

  it("текст напоминания называет число", () => {
    expect(reminderText(3)).toMatch(/3/);
    expect(reminderText(1)).toMatch(/ход/);
  });
});

describe("отчёт за день", () => {
  it("собирает сводку", () => {
    const text = buildDailyReport({
      playersTotal: 4,
      online: 1,
      awaitingTurn: 2,
      approvedTurns: 5,
      unredeemedPrizes: [{ name: "Бэтмен", prize: "кристалл" }],
      idleHidden: 1,
    });
    expect(text).toMatch(/Отчёт за день/);
    expect(text).toMatch(/Бэтмен/);
  });

  it("шлёт один раз в час отчёта", () => {
    const at21 = Date.parse("2026-08-20T18:05:00Z"); // 21:05 Moscow
    const first = shouldSendDailyReport(null, at21, 21, "Europe/Moscow");
    expect(first.send).toBe(true);
    const again = shouldSendDailyReport(first.dayKey, at21, 21, "Europe/Moscow");
    expect(again.send).toBe(false);
  });
});
