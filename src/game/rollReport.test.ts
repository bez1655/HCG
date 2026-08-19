import { describe, it, expect } from "vitest";
import { formatRollReport, prizeLabel, RollRecord } from "./rollReport";
import { Cell, CellType } from "../types";

/**
 * Отчёт администратору о результатах бросков.
 *
 * Проверяется то, ради чего он существует: имя игрока, выпавшая грань,
 * переход между клетками и судьба приза — включая случай, когда приза нет.
 * Молчание вместо «призов нет» админ читает как сбой доставки.
 */
function cell(over: Partial<Cell> = {}): Cell {
  return {
    id: 5,
    name: "Клетка 5",
    description: "Обычный сектор",
    type: CellType.NORMAL,
    value: 0,
    x: 50,
    y: 50,
    ...over,
  };
}

function roll(over: Partial<RollRecord> = {}): RollRecord {
  return {
    steps: 3,
    fromCell: 2,
    landedCell: 5,
    finalCell: 5,
    cell: cell(),
    awardedBonus: null,
    ...over,
  };
}

describe("отчёт об одном броске", () => {
  it("называет игрока, грань кубика и переход между клетками", () => {
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [roll({ steps: 4, fromCell: 1, landedCell: 5, finalCell: 5 })],
      turnsRemaining: 0,
    });

    expect(text).toContain("Кибер");
    expect(text).toContain("4"); // грань
    expect(text).toContain("1 ➔");
    expect(text).toContain("5");
  });

  it("прямо пишет, что призов нет", () => {
    // Пустое место неотличимо от потерянного сообщения.
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [roll()],
      turnsRemaining: 0,
    });
    expect(text).toContain("Призов нет");
  });

  it("показывает выпавший приз и помечает его к выдаче", () => {
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [
        roll({
          finalCell: 15,
          landedCell: 15,
          cell: cell({ id: 15, name: "ТЕНЕВАЯ ТРАНСЗАКЦИЯ", type: CellType.BITCOIN }),
          awardedBonus: { name: "ТЕНЕВАЯ ТРАНСЗАКЦИЯ", extra: "1500 CR", receivedAt: 1 },
        }),
      ],
      turnsRemaining: 0,
    });

    expect(text).toContain("1500 CR");
    expect(text).toContain("К ВЫДАЧЕ");
    expect(text).not.toContain("Призов нет");
  });

  it("предупреждает, что новый приз заменил неиспользованный", () => {
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [
        roll({
          awardedBonus: { name: "ЭНЕРГОКРИСТАЛЛ", extra: "КРИСТАЛЛ", receivedAt: 2 },
          replacedBonus: { name: "КРИПТО-БОНУС", extra: "1000 CR", receivedAt: 1 },
        }),
      ],
      turnsRemaining: 0,
    });

    expect(text).toContain("не суммируются");
    expect(text).toContain("1000 CR");
  });

  it("показывает сдвиг вперёд, когда клетка отбросила фишку", () => {
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [
        roll({
          steps: 2,
          fromCell: 5,
          landedCell: 7,
          finalCell: 10,
          cell: cell({ id: 7, name: "КВАНТОВЫЙ ТЕЛЕПОРТ", type: CellType.BONUS, value: 3 }),
        }),
      ],
      turnsRemaining: 0,
    });

    // Важно видеть обе клетки: куда привёл кубик и куда отбросила клетка.
    expect(text).toContain("вперёд на 3 клетки");
    expect(text).toContain("7 ➔ 10");
  });

  it("показывает откат назад", () => {
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [
        roll({
          fromCell: 38,
          landedCell: 40,
          finalCell: 30,
          cell: cell({ id: 40, name: "КРИТИЧЕСКИЙ КРАШ", type: CellType.SNAKE, value: -10 }),
        }),
      ],
      turnsRemaining: 0,
    });

    expect(text).toContain("назад на 10 клеток");
    expect(text).toContain("40 ➔ 30");
  });

  it("объясняет, почему приза нет, когда фишка стоит на призовой клетке", () => {
    /*
     * Найдено живым прогоном: телепорт с клетки 7 закинул фишку на 10
     * («МАЛЫЙ ЭНЕРГОКРИСТАЛЛ»), приза при этом не полагается — его даёт
     * клетка, на которую привёл КУБИК. Без пояснения админ видит фишку на
     * призовой клетке и приписку «призов нет» и может выдать приз зря.
     */
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [
        roll({
          steps: 1,
          fromCell: 6,
          landedCell: 7,
          finalCell: 10,
          cell: cell({ id: 7, name: "КВАНТОВЫЙ ТЕЛЕПОРТ", type: CellType.BONUS, value: 3 }),
          destinationCell: cell({
            id: 10,
            name: "МАЛЫЙ ЭНЕРГОКРИСТАЛЛ",
            type: CellType.FLASK,
          }),
        }),
      ],
      turnsRemaining: 0,
    });

    expect(text).toContain("приз не начислен");
    expect(text).toContain("МАЛЫЙ ЭНЕРГОКРИСТАЛЛ");
    expect(text).toContain("Призов нет");
  });

  it("не выдумывает пояснение, когда фишка встала на обычную клетку", () => {
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [
        roll({
          landedCell: 12,
          finalCell: 9,
          cell: cell({ id: 12, name: "ОТКАТ НАВИГАЦИИ", type: CellType.PENALTY, value: -3 }),
          destinationCell: cell({ id: 9, name: "Клетка 9" }),
        }),
      ],
      turnsRemaining: 0,
    });
    expect(text).not.toContain("приз не начислен");
  });

  it("сообщает, что ходы кончились", () => {
    const text = formatRollReport({ playerName: "Кибер", rolls: [roll()], turnsRemaining: 0 });
    expect(text).toContain("нужно новое одобрение");
  });
});

describe("отчёт о пачке бросков", () => {
  const series: RollRecord[] = [
    roll({ steps: 3, fromCell: 0, landedCell: 3, finalCell: 3 }),
    roll({
      steps: 2,
      fromCell: 3,
      landedCell: 5,
      finalCell: 5,
    }),
    roll({
      steps: 5,
      fromCell: 5,
      landedCell: 10,
      finalCell: 10,
      cell: cell({ id: 10, name: "МАЛЫЙ ЭНЕРГОКРИСТАЛЛ", type: CellType.FLASK }),
      awardedBonus: { name: "МАЛЫЙ ЭНЕРГОКРИСТАЛЛ", extra: "МАЛЫЙ", receivedAt: 3 },
    }),
  ];

  it("описывает каждый бросок серии, а не только последний", () => {
    const text = formatRollReport({ playerName: "Кибер", rolls: series, turnsRemaining: 0 });

    // Все три грани и все переходы на месте.
    expect(text).toContain("0 ➔");
    expect(text).toContain("3 ➔");
    expect(text).toContain("5 ➔");
    for (const line of ["1.", "2.", "3."]) expect(text).toContain(line);
  });

  it("показывает общий путь от начала к концу серии", () => {
    const text = formatRollReport({ playerName: "Кибер", rolls: series, turnsRemaining: 0 });
    expect(text).toContain("Бросков:");
    expect(text).toContain("0 ➔ <b>10</b>");
  });

  it("не теряет приз, выпавший в середине серии", () => {
    const mid = [series[2], series[0], series[1]];
    const text = formatRollReport({ playerName: "Кибер", rolls: mid, turnsRemaining: 0 });
    expect(text).toContain("МАЛЫЙ");
    expect(text).toContain("К ВЫДАЧЕ");
  });

  it("при нескольких призах за серию отдаёт последний и объясняет почему", () => {
    // Правило игры: призы не суммируются, каждый новый заменяет предыдущий.
    const twoPrizes: RollRecord[] = [
      roll({ awardedBonus: { name: "КРИПТО-БОНУС", extra: "1000 CR", receivedAt: 1 } }),
      roll({ awardedBonus: { name: "ЭНЕРГОКРИСТАЛЛ", extra: "КРИСТАЛЛ", receivedAt: 2 } }),
    ];
    const text = formatRollReport({ playerName: "Кибер", rolls: twoPrizes, turnsRemaining: 0 });

    expect(text).toContain("К ВЫДАЧЕ: ЭНЕРГОКРИСТАЛЛ (КРИСТАЛЛ)");
    expect(text).toContain("не суммируются");
    expect(text).toContain("выпало 2");
  });

  it("сообщает остаток пачки, когда броски ещё есть", () => {
    const text = formatRollReport({ playerName: "Кибер", rolls: series, turnsRemaining: 2 });
    expect(text).toContain("Осталось 2 хода");
  });

  it("отмечает дополнительный бросок и финиш", () => {
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [
        roll({
          cell: cell({ id: 21, name: "СИСТЕМНЫЙ БУСТ", type: CellType.BONUS }),
          extraRoll: true,
        }),
        roll({ finalCell: 64, finished: true }),
      ],
      turnsRemaining: 0,
    });

    expect(text).toContain("дополнительный бросок");
    expect(text).toContain("круг пройден");
  });

  it("ничего не выдаёт, когда бросков не было", () => {
    expect(formatRollReport({ playerName: "Кибер", rolls: [], turnsRemaining: 0 })).toBe("");
  });
});

describe("устойчивость текста", () => {
  it("экранирует имя игрока, чтобы Telegram не отверг сообщение", () => {
    // Ник с угловой скобкой ломал бы parse_mode=HTML, и отчёт не дошёл бы.
    const text = formatRollReport({
      playerName: "<b>взлом</b>",
      rolls: [roll()],
      turnsRemaining: 0,
    });
    expect(text).toContain("&lt;b&gt;взлом&lt;/b&gt;");
    expect(text).not.toContain("<b>взлом</b>");
  });

  it("экранирует название клетки", () => {
    const text = formatRollReport({
      playerName: "Кибер",
      rolls: [roll({ cell: cell({ name: "Клетка <5>" }) })],
      turnsRemaining: 0,
    });
    expect(text).toContain("Клетка &lt;5&gt;");
  });

  it("собирает имя приза из названия и подписи", () => {
    expect(prizeLabel({ name: "КРИПТО-БОНУС", extra: "1000 CR", receivedAt: 1 })).toBe(
      "КРИПТО-БОНУС (1000 CR)"
    );
    expect(prizeLabel({ name: "ЭНЕРГОКРИСТАЛЛ", extra: "", receivedAt: 1 })).toBe("ЭНЕРГОКРИСТАЛЛ");
    expect(prizeLabel({ name: "ПРИЗ", extra: "ПРИЗ", receivedAt: 1 })).toBe("ПРИЗ");
  });
});
