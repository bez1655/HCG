import { describe, it, expect } from "vitest";
import {
  isTokenVisible,
  normaliseHideAfterHours,
  hoursSinceSeen,
  splitByPresence,
  DEFAULT_HIDE_AFTER_HOURS,
} from "./presence";

/**
 * Скрытие фишек давно не заходивших игроков.
 *
 * Цена ошибки в обе стороны: не спрятать — доска зарастает и живых игроков
 * не различить; спрятать лишнего — человек, который ждёт хода или держит
 * невыданный приз, пропадает у администратора из виду.
 */
const HOUR = 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
const agoHours = (h: number) => NOW - h * HOUR;

describe("настройка порога", () => {
  it("по умолчанию сутки", () => {
    expect(DEFAULT_HIDE_AFTER_HOURS).toBe(24);
  });

  it("ноль означает «не прятать никогда»", () => {
    expect(normaliseHideAfterHours(0)).toBe(0);
  });

  it("мусор трактуется как выключено, а не как ноль часов", () => {
    // Иначе опечатка в настройке спрятала бы разом все фишки.
    for (const bad of ["", "abc", null, undefined, NaN, -5]) {
      expect(normaliseHideAfterHours(bad)).toBe(0);
    }
  });

  it("не даёт задать абсурдно большой срок", () => {
    expect(normaliseHideAfterHours(999_999)).toBe(8760);
  });

  it("округляет дробное вниз", () => {
    expect(normaliseHideAfterHours(24.9)).toBe(24);
  });
});

describe("кого показываем", () => {
  const base = { role: "player" as const };

  it("того, кто заходил недавно", () => {
    expect(isTokenVisible({ ...base, lastSeenAt: agoHours(2) }, 24, NOW)).toBe(true);
  });

  it("прячем того, кто пропал дольше порога", () => {
    expect(isTokenVisible({ ...base, lastSeenAt: agoHours(30) }, 24, NOW)).toBe(false);
  });

  it("на самой границе ещё показываем", () => {
    // Ровно 24 часа — пограничный случай, который легко перепутать.
    expect(isTokenVisible({ ...base, lastSeenAt: agoHours(24) }, 24, NOW)).toBe(false);
    expect(isTokenVisible({ ...base, lastSeenAt: NOW - 24 * HOUR + 1000 }, 24, NOW)).toBe(true);
  });

  it("при выключенном правиле показываем всех", () => {
    expect(isTokenVisible({ ...base, lastSeenAt: agoHours(10_000) }, 0, NOW)).toBe(true);
  });
});

describe("кого нельзя прятать ни при каких условиях", () => {
  const stale = { role: "player" as const, lastSeenAt: agoHours(500) };

  it("того, кто сейчас в сети", () => {
    expect(isTokenVisible({ ...stale, isOnline: true }, 24, NOW)).toBe(true);
  });

  it("того, у кого есть неиспользованные ходы", () => {
    // Ходы оплачены: спрятать фишку — потерять человека из виду.
    expect(isTokenVisible({ ...stale, turnsApproved: 2 }, 24, NOW)).toBe(true);
  });

  it("того, кто прямо сейчас просит ход", () => {
    expect(isTokenVisible({ ...stale, turnRequested: true }, 24, NOW)).toBe(true);
  });

  it("того, у кого невыданный приз", () => {
    // Приз ещё не отдан — админ обязан видеть, кому он должен.
    expect(isTokenVisible({ ...stale, activeBonus: { name: "ПРИЗ" } }, 24, NOW)).toBe(true);
  });

  it("администратора", () => {
    expect(isTokenVisible({ role: "admin", lastSeenAt: agoHours(500) }, 24, NOW)).toBe(true);
  });

  it("того, о ком нет отметки времени", () => {
    /*
     * Состояние, сохранённое до появления этого поля. Спрятать игрока, о
     * котором ничего не известно, хуже, чем оставить лишнюю фишку.
     */
    expect(isTokenVisible({ role: "player" }, 24, NOW)).toBe(true);
  });
});

describe("сколько времени прошло", () => {
  it("считает часы", () => {
    expect(hoursSinceSeen({ lastSeenAt: agoHours(30) }, NOW)).toBe(30);
  });

  it("возвращает null, когда отметки нет", () => {
    expect(hoursSinceSeen({}, NOW)).toBeNull();
  });

  it("не уходит в минус при часах из будущего", () => {
    // Часы на сервере могли перевести назад.
    expect(hoursSinceSeen({ lastSeenAt: NOW + 5 * HOUR }, NOW)).toBe(0);
  });
});

describe("разделение для доски и админки", () => {
  it("делит игроков на видимых и скрытых", () => {
    const players = [
      { id: "a", role: "player" as const, lastSeenAt: agoHours(1) },
      { id: "b", role: "player" as const, lastSeenAt: agoHours(100) },
      { id: "c", role: "player" as const, lastSeenAt: agoHours(100), turnsApproved: 1 },
    ];
    const { visible, hidden } = splitByPresence(players, 24, NOW);
    expect(visible.map((p) => p.id)).toEqual(["a", "c"]);
    expect(hidden.map((p) => p.id)).toEqual(["b"]);
  });

  it("никого не теряет", () => {
    // Сумма частей обязана равняться целому: пропавший игрок исчез бы и из
    // админки, а его позиция должна сохраняться.
    const players = Array.from({ length: 7 }, (_, i) => ({
      id: String(i),
      role: "player" as const,
      lastSeenAt: agoHours(i * 10),
    }));
    const { visible, hidden } = splitByPresence(players, 24, NOW);
    expect(visible.length + hidden.length).toBe(players.length);
  });
});
