import { describe, expect, it } from "vitest";
import { buildGuide, describeEffect, guideSummary } from "./cellGuide";
import { Cell, CellType } from "../types";
import realCells from "./data/cells.json";

const CELLS = realCells as unknown as Cell[];

function cell(over: Partial<Cell>): Cell {
  return {
    id: 1,
    name: "Клетка",
    description: "",
    type: CellType.NORMAL,
    value: 0,
    x: 0,
    y: 0,
    ...over,
  } as Cell;
}

describe("describeEffect", () => {
  it("называет сумму награды", () => {
    expect(describeEffect(cell({ type: CellType.BITCOIN, value: 1500 }))).toContain("1500");
  });

  it("правильно склоняет клетки", () => {
    expect(describeEffect(cell({ type: CellType.BONUS, value: 1 }))).toContain("1 клетку");
    expect(describeEffect(cell({ type: CellType.BONUS, value: 3 }))).toContain("3 клетки");
    expect(describeEffect(cell({ type: CellType.SNAKE, value: -10 }))).toContain("10 клеток");
  });

  it("бонус без значения — это дополнительный бросок", () => {
    expect(describeEffect(cell({ type: CellType.BONUS, value: 0 }))).toContain("Дополнительный бросок");
  });

  it("откат описывается как движение назад", () => {
    expect(describeEffect(cell({ type: CellType.PENALTY, value: -3 }))).toContain("назад на 3");
  });
});

describe("buildGuide на настоящих данных доски", () => {
  const guide = buildGuide(CELLS);

  it("есть все четыре раздела", () => {
    expect(guide.map((s) => s.key)).toEqual(["prize", "move", "penalty", "special"]);
  });

  it("обычные клетки в справку не попадают", () => {
    const names = guide.flatMap((s) => s.entries.map((e) => e.name));
    expect(names.some((n) => /^Клетка \d+$/.test(n))).toBe(false);
  });

  /*
   * Клетка 7 даёт +4, а не +3: её правили отдельно, чтобы телепорт не вёл
   * на призовую клетку 10. Справка обязана показывать действующее значение,
   * иначе она врёт игроку — ровно то, ради чего данные берутся из cells.json.
   */
  it("клетка 7 показывает +4, как в игре", () => {
    const teleport = guide
      .flatMap((s) => s.entries)
      .find((e) => e.cells.includes(7));
    expect(teleport?.effect).toContain("4");
    expect(teleport?.effect).not.toContain("+3");
  });

  it("клетка 52 показывает откат на 4", () => {
    const trap = guide.flatMap((s) => s.entries).find((e) => e.cells.includes(52));
    expect(trap?.effect).toContain("4");
  });

  it("одинаковые клетки объединены в одну строку", () => {
    // Три отката на -3 (12, 23, 31) должны стать одной записью.
    const penalties = guide.find((s) => s.key === "penalty")!;
    const backThree = penalties.entries.filter((e) => e.effect.includes("назад на 3"));
    const totalCells = backThree.reduce((n, e) => n + e.cells.length, 0);
    expect(totalCells).toBeGreaterThanOrEqual(3);
  });

  it("у каждой записи есть номера клеток и значок", () => {
    for (const s of guide) {
      for (const e of s.entries) {
        expect(e.cells.length).toBeGreaterThan(0);
        expect(e.icon).not.toBe("");
        expect(e.effect).not.toBe("");
      }
    }
  });

  it("номера внутри записи отсортированы", () => {
    for (const s of guide) {
      for (const e of s.entries) {
        expect(e.cells).toEqual([...e.cells].sort((a, b) => a - b));
      }
    }
  });

  it("змейки попали в штрафной раздел", () => {
    const penalties = guide.find((s) => s.key === "penalty")!;
    const ids = penalties.entries.flatMap((e) => e.cells);
    expect(ids).toContain(40);
    expect(ids).toContain(61);
  });

  it("финиш в разделе старт/финиш", () => {
    const special = guide.find((s) => s.key === "special")!;
    expect(special.entries.flatMap((e) => e.cells)).toContain(64);
  });
});

describe("guideSummary", () => {
  it("считает клетки настоящей доски", () => {
    const s = guideSummary(CELLS);
    expect(s.total).toBe(65);
    expect(s.prizes).toBe(10); // 6 bitcoin + 4 flask
    expect(s.boosts).toBe(5);
    expect(s.traps).toBe(6); // 4 penalty + 2 snake
  });
});
