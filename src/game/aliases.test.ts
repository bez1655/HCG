import { describe, it, expect } from "vitest";
import { ALIAS_POOL, pickAlias, looksLikeHandle, publicName } from "./aliases";

/**
 * Псевдонимы закрывают Telegram-хендл игрока от остальных участников.
 *
 * Главное требование: настоящий аккаунт не должен попасть на экран другим
 * игрокам НИ ПРИ КАКИХ обстоятельствах — включая случай, когда герои
 * кончились или запись пришла из старого состояния без псевдонима.
 */
describe("список псевдонимов", () => {
  it("достаточно длинный для реальной партии", () => {
    expect(ALIAS_POOL.length).toBeGreaterThanOrEqual(100);
  });

  it("не содержит повторов", () => {
    const lower = ALIAS_POOL.map((a) => a.toLowerCase());
    expect(new Set(lower).size).toBe(ALIAS_POOL.length);
  });

  it("не содержит ничего похожего на Telegram-хендл", () => {
    expect(ALIAS_POOL.filter((a) => a.includes("@"))).toEqual([]);
  });

  it("собран из заявленных вселенных", () => {
    for (const hero of ["Железный Человек", "Бэтмен", "Йода", "Фродо", "Гарри Поттер"]) {
      expect(ALIAS_POOL).toContain(hero);
    }
  });
});

describe("выдача псевдонима", () => {
  it("выдаёт имя из списка", () => {
    expect(ALIAS_POOL).toContain(pickAlias([]));
  });

  it("никогда не повторяет уже занятое", () => {
    const taken: string[] = [];
    for (let i = 0; i < 60; i++) {
      const alias = pickAlias(taken);
      expect(taken.map((t) => t.toLowerCase())).not.toContain(alias.toLowerCase());
      taken.push(alias);
    }
  });

  it("не считает занятым имя в другом регистре", () => {
    const alias = pickAlias(["железный человек"]);
    expect(alias.toLowerCase()).not.toBe("железный человек");
  });

  it("продолжает выдавать имена, когда весь список исчерпан", () => {
    // Больше игроков, чем героев: имя обязано быть, и оно уникально.
    const taken = [...ALIAS_POOL];
    const extra = pickAlias(taken);
    expect(extra).toBeTruthy();
    expect(taken.map((t) => t.toLowerCase())).not.toContain(extra.toLowerCase());
  });

  it("не подставляет хендл, даже когда имена кончились", () => {
    // Главная гарантия: суффикс — номер, а не «@user».
    const taken = [...ALIAS_POOL];
    for (let i = 0; i < 5; i++) {
      const extra = pickAlias(taken);
      expect(extra).not.toContain("@");
      taken.push(extra);
    }
  });

  it("уважает переданный источник случайности", () => {
    // Тест должен уметь предсказать выбор, не подменяя Math.random.
    expect(pickAlias([], () => 0)).toBe(ALIAS_POOL[0]);
  });

  it("не спотыкается о мусор в списке занятых", () => {
    expect(ALIAS_POOL).toContain(pickAlias(["", "   ", undefined as unknown as string]));
  });
});

describe("публичное имя", () => {
  it("показывает псевдоним, когда он есть", () => {
    expect(publicName({ alias: "Бэтмен", name: "@real_user" })).toBe("Бэтмен");
  });

  it("никогда не показывает Telegram-хендл", () => {
    /*
     * Запись из состояния, сохранённого до появления псевдонимов. Показать
     * «@real_user» другим игрокам нельзя — лучше безликая заглушка.
     */
    expect(publicName({ name: "@real_user" })).toBe("Игрок");
  });

  it("оставляет обычное имя, если оно не хендл", () => {
    // Игрок, заведённый вручную под именем «Кибер», — это не утечка.
    expect(publicName({ name: "Кибер" })).toBe("Кибер");
  });

  it("не падает на пустой записи", () => {
    expect(publicName({})).toBe("Игрок");
  });

  it("узнаёт хендл", () => {
    expect(looksLikeHandle("@user")).toBe(true);
    expect(looksLikeHandle("  @user")).toBe(true);
    expect(looksLikeHandle("Бэтмен")).toBe(false);
    expect(looksLikeHandle(undefined)).toBe(false);
  });
});
