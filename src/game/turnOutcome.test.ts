import { describe, expect, it } from "vitest";
import { buildTurnOutcome, formatTurnOutcomeForTelegram, toneFor, cellIcon } from "./turnOutcome";
import { Cell, CellType } from "../types";

function cell(over: Partial<Cell>): Cell {
  return {
    id: 1,
    name: "Клетка 1",
    description: "Нейросетевой сегмент",
    type: CellType.NORMAL,
    value: 0,
    x: 0,
    y: 0,
    ...over,
  } as Cell;
}

describe("buildTurnOutcome — обычная клетка", () => {
  /*
   * Главный случай ради которого модуль и написан: раньше при попадании на
   * обычную клетку игроку не показывали НИЧЕГО. Пустой результат читается как
   * сбой, поэтому текст обязан быть непустым и содержать выпавшее число.
   */
  it("сообщает результат даже когда ничего не произошло", () => {
    const m = buildTurnOutcome({
      steps: 3,
      fromCell: 1,
      landedCell: 4,
      finalCell: 4,
      cell: cell({ id: 4, name: "Клетка 4", type: CellType.NORMAL }),
      turnsRemaining: 0,
    });

    expect(m.title).toBe("ВЫПАЛО 3");
    expect(m.body).not.toBe("");
    expect(m.body).toContain("с клетки 1 на 4");
    expect(m.tone).toBe("neutral");
  });

  it("прямо говорит, что приза нет", () => {
    const m = buildTurnOutcome({
      steps: 2,
      fromCell: 0,
      landedCell: 2,
      finalCell: 2,
      cell: cell({ id: 2, type: CellType.NORMAL }),
      turnsRemaining: 0,
    });
    expect(m.body).toContain("Приза нет");
  });

  it("подсказывает, что ходы кончились", () => {
    const m = buildTurnOutcome({
      steps: 1,
      fromCell: 0,
      landedCell: 1,
      finalCell: 1,
      cell: cell({ id: 1 }),
      turnsRemaining: 0,
    });
    expect(m.footer).toContain("Запросите новый");
  });

  it("подсказывает, что можно бросать снова", () => {
    const m = buildTurnOutcome({
      steps: 1,
      fromCell: 0,
      landedCell: 1,
      finalCell: 1,
      cell: cell({ id: 1 }),
      turnsRemaining: 3,
    });
    expect(m.footer).toContain("Осталось 3");
    expect(m.footer).toContain("можно бросать снова");
  });
});

describe("buildTurnOutcome — призовые клетки", () => {
  it("называет выданный приз", () => {
    const m = buildTurnOutcome({
      steps: 4,
      fromCell: 6,
      landedCell: 10,
      finalCell: 10,
      cell: cell({ id: 10, name: "МАЛЫЙ ЭНЕРГОКРИСТАЛЛ", type: CellType.FLASK, value: 2300 }),
      awardedBonus: {
        name: "МАЛЫЙ ЭНЕРГОКРИСТАЛЛ",
        extra: "МАЛЫЙ ЭНЕРГОКРИСТАЛЛ",
        description: "2300 кредитов",
        value: 2300,
        cellId: 10,
        receivedAt: Date.now(),
      },
      turnsRemaining: 0,
    });

    expect(m.tone).toBe("good");
    expect(m.body).toContain("МАЛЫЙ ЭНЕРГОКРИСТАЛЛ");
    expect(m.prize?.name).toBe("МАЛЫЙ ЭНЕРГОКРИСТАЛЛ");
  });

  it("предупреждает о замене приза — они не суммируются", () => {
    const prev = {
      name: "СТАРЫЙ",
      extra: "СТАРЫЙ",
      description: "",
      value: 1000,
      cellId: 4,
      receivedAt: 1,
    };
    const m = buildTurnOutcome({
      steps: 5,
      fromCell: 10,
      landedCell: 15,
      finalCell: 15,
      cell: cell({ id: 15, name: "ТЕНЕВАЯ ТРАНСЗАКЦИЯ", type: CellType.BITCOIN }),
      awardedBonus: { ...prev, name: "НОВЫЙ", extra: "НОВЫЙ" },
      replacedBonus: prev,
      turnsRemaining: 0,
    });
    expect(m.body).toContain("заменён");
  });
});

describe("buildTurnOutcome — перемещения", () => {
  it("объясняет телепорт вперёд", () => {
    const m = buildTurnOutcome({
      steps: 3,
      fromCell: 4,
      landedCell: 7,
      finalCell: 11,
      cell: cell({ id: 7, name: "КВАНТОВЫЙ ТЕЛЕПОРТ", type: CellType.BONUS, value: 4 }),
      turnsRemaining: 0,
    });
    expect(m.body).toContain("вперёд на 4");
    expect(m.body).toContain("теперь клетка 11");
    expect(m.tone).toBe("good");
  });

  it("объясняет откат назад", () => {
    const m = buildTurnOutcome({
      steps: 2,
      fromCell: 39,
      landedCell: 40,
      finalCell: 30,
      cell: cell({ id: 40, name: "КРИТИЧЕСКИЙ КРАШ", type: CellType.SNAKE, value: -10 }),
      turnsRemaining: 0,
    });
    expect(m.body).toContain("назад на 10");
    expect(m.body).toContain("теперь клетка 30");
    expect(m.tone).toBe("bad");
  });

  it("сообщает о дополнительном броске", () => {
    const m = buildTurnOutcome({
      steps: 1,
      fromCell: 20,
      landedCell: 21,
      finalCell: 21,
      cell: cell({ id: 21, name: "СИСТЕМНЫЙ БУСТ", type: CellType.BONUS, value: 0 }),
      extraRoll: true,
      turnsRemaining: 1,
    });
    expect(m.body).toContain("дополнительный бросок");
  });

  it("сообщает о победе", () => {
    const m = buildTurnOutcome({
      steps: 2,
      fromCell: 62,
      landedCell: 64,
      finalCell: 64,
      cell: cell({ id: 64, name: "ЯДРО СИСТЕМЫ", type: CellType.FINISH }),
      finished: true,
      turnsRemaining: 0,
    });
    expect(m.body).toContain("ЯДРА СИСТЕМЫ");
    expect(m.footer).toContain("Круг пройден");
  });
});

describe("toneFor / cellIcon", () => {
  it("штрафные клетки — плохо", () => {
    expect(toneFor(CellType.PENALTY, false)).toBe("bad");
    expect(toneFor(CellType.SNAKE, false)).toBe("bad");
  });
  it("призовые — хорошо", () => {
    expect(toneFor(CellType.FLASK, false)).toBe("good");
    expect(toneFor(CellType.BITCOIN, false)).toBe("good");
  });
  it("обычная — нейтрально", () => {
    expect(toneFor(CellType.NORMAL, false)).toBe("neutral");
  });
  it("выданный приз перебивает тип клетки", () => {
    expect(toneFor(CellType.NORMAL, true)).toBe("good");
  });
  it("у каждого типа свой значок", () => {
    expect(cellIcon(CellType.SNAKE)).toBe("🐍");
    expect(cellIcon(CellType.BITCOIN)).toBe("₿");
    expect(cellIcon(undefined)).toBe("▫️");
  });
});

describe("formatTurnOutcomeForTelegram", () => {
  it("включает число, клетку и остаток", () => {
    const m = buildTurnOutcome({
      steps: 6,
      fromCell: 0,
      landedCell: 6,
      finalCell: 6,
      cell: cell({ id: 6, name: "Клетка 6" }),
      turnsRemaining: 2,
    });
    const text = formatTurnOutcomeForTelegram(m);
    expect(text).toContain("РЕЗУЛЬТАТ ХОДА");
    expect(text).toContain("<b>6</b>");
    expect(text).toContain("Клетка 6");
    expect(text).toContain("Осталось 2");
  });

  it("экранирует HTML в названии клетки", () => {
    const m = buildTurnOutcome({
      steps: 1,
      fromCell: 0,
      landedCell: 1,
      finalCell: 1,
      cell: cell({ id: 1, name: "<script>alert(1)</script>" }),
      turnsRemaining: 0,
    });
    const text = formatTurnOutcomeForTelegram(m);
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("показывает приз отдельным блоком", () => {
    const m = buildTurnOutcome({
      steps: 4,
      fromCell: 45,
      landedCell: 49,
      finalCell: 49,
      cell: cell({ id: 49, name: "КРИПТО-ДЖЕКПОТ", type: CellType.BITCOIN }),
      awardedBonus: {
        name: "КРИПТО-ДЖЕКПОТ",
        extra: "2000 кредитов",
        description: "Награда +2000 кредитов.",
        value: 2000,
        cellId: 49,
        receivedAt: Date.now(),
      },
      turnsRemaining: 0,
    });
    const text = formatTurnOutcomeForTelegram(m);
    expect(text).toContain("🎁");
    expect(text).toContain("2000 кредитов");
  });
});
