import { describe, it, expect } from "vitest";
import cells from "./data/cells.json";
import { resolveMove, FINAL_CELL } from "./rules";
import { Cell, CellType } from "../types";

/**
 * Проверки самого игрового поля, а не логики движения.
 *
 * cells.json — данные, которые правятся руками, и до сих пор их не проверял
 * никто. Так и появилась нестыковка: ускоритель на клетке 7 давал ровно +3 и
 * ставил фишку на клетку 10 с призом, которого игрок не получал. Приз даёт
 * та клетка, на которую привёл КУБИК, а не та, куда потом отбросил эффект.
 *
 * Снаружи это выглядит обманом: фишка стоит на «ЭНЕРГОКРИСТАЛЛЕ», а приза
 * нет. Такие клетки теперь запрещены тестом.
 */
const BOARD = cells as Cell[];
const byId = new Map(BOARD.map((c) => [c.id, c]));

const PRIZE_TYPES: string[] = [CellType.FLASK, CellType.BITCOIN];
const SHIFT_TYPES: string[] = [CellType.BONUS, CellType.PENALTY, CellType.SNAKE];

/** Клетка, куда эффект уводит с данной. */
function destinationOf(cell: Cell): number {
  const value = cell.value ?? 0;
  if (!SHIFT_TYPES.includes(cell.type) || value === 0) return cell.id;
  return Math.max(0, Math.min(FINAL_CELL, cell.id + value));
}

describe("игровое поле: целостность", () => {
  it("содержит 65 клеток с уникальными номерами", () => {
    expect(BOARD).toHaveLength(65);
    expect(new Set(BOARD.map((c) => c.id)).size).toBe(65);
  });

  it("нумерует клетки подряд от 0 до 64", () => {
    for (let i = 0; i <= FINAL_CELL; i++) {
      expect(byId.has(i), `клетки ${i} нет на поле`).toBe(true);
    }
  });

  it("держит координаты в пределах доски", () => {
    for (const c of BOARD) {
      expect(c.x, `клетка ${c.id}: x вне доски`).toBeGreaterThanOrEqual(0);
      expect(c.x, `клетка ${c.id}: x вне доски`).toBeLessThanOrEqual(100);
      expect(c.y, `клетка ${c.id}: y вне доски`).toBeGreaterThanOrEqual(0);
      expect(c.y, `клетка ${c.id}: y вне доски`).toBeLessThanOrEqual(100);
    }
  });
});

describe("игровое поле: клетки со сдвигом", () => {
  it("ни одна не приводит на призовую клетку", () => {
    /*
     * Главная проверка этого файла.
     *
     * Фишка, вставшая на призовую клетку из-за ускорителя или отката, приза
     * не получает — и игрок считает, что его обманули. Такой клетке нужен
     * другой шаг: либо на клетку раньше, либо на клетку позже.
     */
    const collisions = BOARD.filter((c) => {
      const dest = destinationOf(c);
      return dest !== c.id && PRIZE_TYPES.includes(byId.get(dest)?.type ?? "");
    }).map((c) => {
      const dest = destinationOf(c);
      return `клетка ${c.id} «${c.name}» (${c.extra}) ведёт на ${dest} «${byId.get(dest)?.name}»`;
    });

    expect(
      collisions,
      "фишка встанет на призовую клетку, но приза не получит — игрок сочтёт это обманом:\n" +
        collisions.join("\n")
    ).toEqual([]);
  });

  it("не выбрасывает фишку за пределы поля", () => {
    for (const c of BOARD) {
      const dest = destinationOf(c);
      expect(dest, `клетка ${c.id} уводит за поле`).toBeGreaterThanOrEqual(0);
      expect(dest, `клетка ${c.id} уводит за поле`).toBeLessThanOrEqual(FINAL_CELL);
    }
  });

  it("не зацикливает фишку саму на себя", () => {
    // Клетка, ведущая на такую же клетку со сдвигом, гоняла бы фишку по кругу.
    for (const c of BOARD) {
      const dest = destinationOf(c);
      if (dest === c.id) continue;
      const target = byId.get(dest);
      const targetShift = SHIFT_TYPES.includes(target?.type ?? "") ? (target?.value ?? 0) : 0;
      expect(targetShift, `клетка ${c.id} ведёт на клетку ${dest}, которая двигает дальше`).toBe(0);
    }
  });

  it("описывает сдвиг в подписи тем же числом, что и в значении", () => {
    // «+3 КЛ.» при value 4 — расхождение, которое игрок видит на доске.
    for (const c of BOARD) {
      if (!SHIFT_TYPES.includes(c.type)) continue;
      const value = c.value ?? 0;
      if (value === 0) continue;
      const digits = (c.extra || "").match(/\d+/);
      if (!digits) continue;
      expect(
        Number(digits[0]),
        `клетка ${c.id}: подпись «${c.extra}» не совпадает с ${value}`
      ).toBe(Math.abs(value));
    }
  });
});

describe("клетка 7 — КВАНТОВЫЙ ТЕЛЕПОРТ", () => {
  it("переносит на клетку 11, а не на призовую 10", () => {
    // Ровно то, о чём просил пользователь: на 10 лежит энергокристалл.
    const cell7 = byId.get(7)!;
    expect(cell7.value).toBe(4);
    expect(destinationOf(cell7)).toBe(11);
    expect(byId.get(11)!.type).toBe(CellType.NORMAL);
  });

  it("довозит игрока до 11 при настоящем броске", () => {
    // Проверка через реальные правила, а не только по данным.
    const outcome = resolveMove({ cell: 4, name: "Игрок" }, 3, BOARD);
    expect(outcome.landedCell).toBe(7);
    expect(outcome.finalCell).toBe(11);
    expect(outcome.awardedBonus).toBeNull();
  });

  it("оставляет приз на клетке 10 доступным при прямом попадании", () => {
    // Приз никуда не делся — его по-прежнему можно взять, дойдя кубиком.
    const outcome = resolveMove({ cell: 6, name: "Игрок" }, 4, BOARD);
    expect(outcome.landedCell).toBe(10);
    expect(outcome.awardedBonus).not.toBeNull();
  });
});

describe("клетка 52 — ЭМИ-ЛОВУШКА", () => {
  it("отбрасывает на обычную 48, а не на призовую 49", () => {
    const cell52 = byId.get(52)!;
    expect(cell52.value).toBe(-4);
    expect(destinationOf(cell52)).toBe(48);
    expect(byId.get(48)!.type).toBe(CellType.NORMAL);
  });

  it("довозит игрока до 48 при настоящем броске", () => {
    const outcome = resolveMove({ cell: 50, name: "Игрок" }, 2, BOARD);
    expect(outcome.landedCell).toBe(52);
    expect(outcome.finalCell).toBe(48);
    expect(outcome.awardedBonus).toBeNull();
  });
});
