import { describe, it, expect } from "vitest";
import { Cell, CellType, Player } from "../types";
import {
  resolveMove,
  canRoll,
  pluralizeCells,
  pluralizeTurns,
  turnsLeft,
  isMilestone,
  FINAL_CELL,
} from "./rules";

/** Minimal board: plain cells plus the specific ones each test needs. */
function makeBoard(overrides: Partial<Record<number, Partial<Cell>>> = {}): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i <= FINAL_CELL; i++) {
    cells.push({
      id: i,
      name: `Клетка ${i}`,
      description: `Сегмент ${i}`,
      type: CellType.NORMAL,
      value: 0,
      x: 50,
      y: 50,
      ...(overrides[i] ?? {}),
    });
  }
  return cells;
}

const player = (cell: number): Pick<Player, "cell" | "name"> => ({ cell, name: "@tester" });

describe("resolveMove — basic movement", () => {
  it("advances by the dice value on a plain cell", () => {
    const r = resolveMove(player(10), 4, makeBoard());
    expect(r.landedCell).toBe(14);
    expect(r.finalCell).toBe(14);
    expect(r.extraRoll).toBe(false);
    expect(r.awardedBonus).toBeNull();
  });

  it("never moves past the final cell", () => {
    const r = resolveMove(player(62), 6, makeBoard());
    expect(r.finalCell).toBe(FINAL_CELL);
    expect(r.finished).toBe(true);
  });
});

describe("resolveMove — bonus cells", () => {
  it("applies a forward jump", () => {
    const board = makeBoard({ 7: { type: CellType.BONUS, value: 3, extra: "+3 КЛ." } });
    const r = resolveMove(player(4), 3, board);
    expect(r.landedCell).toBe(7);
    expect(r.finalCell).toBe(10);
    expect(r.effectText).toContain("+3");
  });

  it("grants an extra roll instead of moving", () => {
    const board = makeBoard({ 21: { type: CellType.BONUS, value: 0, extra: "+1 ХОД" } });
    const r = resolveMove(player(20), 1, board);
    expect(r.extraRoll).toBe(true);
    expect(r.finalCell).toBe(21);
  });

  it("clamps a forward jump to the final cell", () => {
    const board = makeBoard({ 63: { type: CellType.BONUS, value: 10, extra: "+10 КЛ." } });
    const r = resolveMove(player(62), 1, board);
    expect(r.finalCell).toBe(FINAL_CELL);
    expect(r.finished).toBe(true);
  });
});

describe("resolveMove — penalties", () => {
  it("moves the player backwards", () => {
    const board = makeBoard({ 12: { type: CellType.PENALTY, value: -3, extra: "-3 КЛ." } });
    const r = resolveMove(player(10), 2, board);
    expect(r.landedCell).toBe(12);
    expect(r.finalCell).toBe(9);
  });

  it("handles the heavy -10 snake", () => {
    const board = makeBoard({ 40: { type: CellType.SNAKE, value: -10, extra: "-10 КЛ." } });
    const r = resolveMove(player(38), 2, board);
    expect(r.finalCell).toBe(30);
  });

  it("never moves below the start cell", () => {
    const board = makeBoard({ 2: { type: CellType.SNAKE, value: -10 } });
    const r = resolveMove(player(0), 2, board);
    expect(r.finalCell).toBe(0);
  });
});

describe("resolveMove — prizes", () => {
  it("awards a prize on a FLASK cell", () => {
    const board = makeBoard({
      10: { type: CellType.FLASK, value: 2300, extra: "МАЛЫЙ", name: "ПРИЗ" },
    });
    const r = resolveMove(player(8), 2, board);
    expect(r.awardedBonus).not.toBeNull();
    expect(r.awardedBonus!.value).toBe(2300);
    expect(r.awardedBonus!.cellId).toBe(10);
  });

  it("awards a prize on a BITCOIN cell", () => {
    const board = makeBoard({ 15: { type: CellType.BITCOIN, value: 1500, extra: "1500" } });
    const r = resolveMove(player(14), 1, board);
    expect(r.awardedBonus?.value).toBe(1500);
  });

  it("awards the grand prize on the final cell", () => {
    const r = resolveMove(player(60), 4, makeBoard());
    expect(r.finished).toBe(true);
    expect(r.awardedBonus).not.toBeNull();
    expect(r.awardedBonus!.cellId).toBe(FINAL_CELL);
  });

  it("does not award a prize on a plain cell", () => {
    expect(resolveMove(player(1), 1, makeBoard()).awardedBonus).toBeNull();
  });
});

describe("canRoll — prize control", () => {
  const base = { role: "player" as const, skipNextTurn: false, activeBonus: null };

  it("blocks a player without an approved turn", () => {
    const r = canRoll({ ...base, turnApprovedUntil: null });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("not-approved");
  });

  it("does NOT take the turn away as time passes", () => {
    /*
     * Раньше одобрение сгорало через 12 часов, и купивший вечером терял
     * бросок к утру. Ограничения по времени больше нет: дата в прошлом
     * ничего не значит, право на бросок держит счётчик.
     */
    const r = canRoll({
      ...base,
      turnApprovedUntil: Date.now() - 365 * 24 * 60 * 60 * 1000,
      turnsApproved: 2,
    });
    expect(r.allowed).toBe(true);
  });

  it("blocks a player with no turns left", () => {
    const r = canRoll({ ...base, turnApprovedUntil: null, turnsApproved: 0 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("not-approved");
  });

  it("allows an approved player", () => {
    expect(canRoll({ ...base, turnApprovedUntil: Date.now() + 60_000 }).allowed).toBe(true);
  });

  it("blocks an approved player holding an unused bonus", () => {
    const r = canRoll({
      ...base,
      turnApprovedUntil: Date.now() + 60_000,
      activeBonus: { name: "ПРИЗ", receivedAt: Date.now() },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("unused-bonus");
  });

  it("blocks a player serving a skip penalty", () => {
    const r = canRoll({
      ...base,
      turnApprovedUntil: Date.now() + 60_000,
      skipNextTurn: true,
    });
    expect(r.reason).toBe("skip-turn");
  });

  it("lets an admin roll unconditionally", () => {
    const r = canRoll({
      role: "admin",
      turnApprovedUntil: null,
      activeBonus: { name: "ПРИЗ", receivedAt: Date.now() },
      skipNextTurn: true,
    });
    expect(r.allowed).toBe(true);
  });
});

describe("turnsLeft — batch approvals", () => {
  const future = () => Date.now() + 60_000;

  it("counts nothing when the batch is spent", () => {
    expect(turnsLeft({ turnApprovedUntil: null, turnsApproved: 0 })).toBe(0);
  });

  it("keeps the turns however old the approval is", () => {
    /*
     * Главное следствие снятия лимита: одобренный ход ждёт игрока сколько
     * угодно. Дата в прошлом на счётчик не влияет.
     */
    const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    expect(turnsLeft({ turnApprovedUntil: yearAgo, turnsApproved: 3 })).toBe(3);
  });

  it("reports the whole batch", () => {
    expect(turnsLeft({ turnApprovedUntil: future(), turnsApproved: 3 })).toBe(3);
  });

  it("reads a pre-batch approval as exactly one roll", () => {
    // Состояние, сохранённое до появления пачек, счётчика не имеет. Если бы
    // оно читалось как ноль, после обновления все одобренные ходы пропали бы.
    expect(turnsLeft({ turnApprovedUntil: future() })).toBe(1);
  });

  it("treats a spent batch as no turn at all", () => {
    expect(turnsLeft({ turnApprovedUntil: future(), turnsApproved: 0 })).toBe(0);
  });
});

describe("canRoll — batch approvals", () => {
  const base = { role: "player" as const, skipNextTurn: false, activeBonus: null };

  it("allows every roll of the batch", () => {
    const r = canRoll({ ...base, turnApprovedUntil: Date.now() + 60_000, turnsApproved: 3 });
    expect(r.allowed).toBe(true);
  });

  it("refuses once the batch is spent, even inside the 12-hour window", () => {
    const r = canRoll({ ...base, turnApprovedUntil: Date.now() + 60_000, turnsApproved: 0 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("not-approved");
  });
});

describe("pluralizeTurns", () => {
  it.each([
    [1, "ход"],
    [2, "хода"],
    [4, "хода"],
    [5, "ходов"],
    [11, "ходов"],
    [21, "ход"],
  ])("%i -> %s", (n, expected) => {
    expect(pluralizeTurns(n)).toBe(expected);
  });
});

describe("pluralizeCells", () => {
  it.each([
    [1, "клетку"],
    [2, "клетки"],
    [4, "клетки"],
    [5, "клеток"],
    [11, "клеток"],
    [14, "клеток"],
    [21, "клетку"],
    [22, "клетки"],
  ])("%i -> %s", (n, expected) => {
    expect(pluralizeCells(n)).toBe(expected);
  });
});

describe("isMilestone", () => {
  it("recognises milestone cells", () => {
    expect(isMilestone(10)).toBe(true);
    expect(isMilestone(60)).toBe(true);
  });
  it("ignores ordinary cells", () => {
    expect(isMilestone(11)).toBe(false);
    expect(isMilestone(0)).toBe(false);
  });
});
