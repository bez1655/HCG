import { describe, it, expect } from "vitest";
import {
  classifyLogMessage,
  expandHistoryLines,
  findPlayerByTarget,
  formatPlayerHistoryText,
  logMentionsPlayer,
  mergeMoves,
  movesFromLogs,
} from "./playerHistory";

const player = { id: "p1", name: "@hapalka228", alias: "Бэтмен" };

describe("player movement history", () => {
  it("parses a roll line", () => {
    const m = classifyLogMessage("🎲 Бэтмен выбросил 4 и переместился на клетку 18.");
    expect(m?.kind).toBe("roll");
    expect(m?.steps).toBe(4);
    expect(m?.toCell).toBe(18);
  });

  it("parses an admin cell edit", () => {
    const m = classifyLogMessage("🛠️ Админ изменил параметры Бэтмен: Клетка: 12 ➔ 20.");
    expect(m?.kind).toBe("admin");
    expect(m?.fromCell).toBe(12);
    expect(m?.toCell).toBe(20);
  });

  it("does not attribute another player's roll", () => {
    expect(logMentionsPlayer("🎲 Росомаха выбросил 2 и переместился на клетку 5.", player)).toBe(
      false
    );
    expect(logMentionsPlayer("🎲 Бэтмен выбросил 2 и переместился на клетку 5.", player)).toBe(
      true
    );
    expect(logMentionsPlayer("ход @hapalka228", player)).toBe(true);
  });

  it("builds a chronological extract from logs", () => {
    const moves = movesFromLogs(
      [
        {
          id: "1",
          message: "🎲 Бэтмен выбросил 3 и переместился на клетку 3.",
          timestamp: "12:01:00",
          type: "roll",
        },
        {
          id: "2",
          message: "🎲 Росомаха выбросил 6 и переместился на клетку 6.",
          timestamp: "12:02:00",
          type: "roll",
        },
        {
          id: "3",
          message: "🛠️ Админ изменил параметры Бэтмен: Клетка: 3 ➔ 10.",
          timestamp: "12:03:00",
          type: "admin",
        },
      ],
      player
    );
    expect(moves).toHaveLength(2);
    expect(moves[0].toCell).toBe(3);
    expect(moves[1].kind).toBe("admin");
  });

  it("deduplicates the same event from disk and the live log", () => {
    const a = movesFromLogs(
      [
        {
          id: "1",
          message: "🎲 Бэтмен выбросил 1 и переместился на клетку 1.",
          timestamp: "10:00:00",
          type: "roll",
        },
      ],
      player
    );
    const merged = mergeMoves(a, a);
    expect(merged).toHaveLength(1);
  });

  it("finds a player by handle, alias or id", () => {
    const roster = [
      { ...player, role: "player" as const, cell: 7, color: "#0", isOnline: false, lastRoll: null, skipNextTurn: false },
    ];
    expect(findPlayerByTarget(roster, "hapalka228")?.id).toBe("p1");
    expect(findPlayerByTarget(roster, "@hapalka228")?.id).toBe("p1");
    expect(findPlayerByTarget(roster, "Бэтмен")?.id).toBe("p1");
    expect(findPlayerByTarget(roster, "никто")).toBeUndefined();
  });

  it("prints every recorded cell change in the extract", () => {
    const text = formatPlayerHistoryText({
      playerId: "p1",
      name: "@hapalka228",
      alias: "Бэтмен",
      cell: 18,
      moves: [
        {
          at: 1,
          timeLabel: "12:00",
          kind: "roll",
          fromCell: 0,
          toCell: 4,
          steps: 4,
          note: "",
        },
        {
          at: 2,
          timeLabel: "12:01",
          kind: "roll",
          fromCell: 4,
          toCell: 9,
          steps: 5,
          note: "",
        },
      ],
    });
    expect(text).toContain("0 → 1");
    expect(text).toContain("3 → 4");
    expect(text).toContain("кубик 4");
    expect(text).toContain("4 → 5");
    expect(text).toContain("Сейчас клетка: 18");
  });

  it("does not invent a reverse jump when fromCell was inferred wrongly", () => {
    const cells = [
      { id: 4, name: "КРИПТО-БОНУС", type: "bitcoin" as const, x: 0, y: 0, description: "", value: 1000 },
      { id: 10, name: "МАЛЫЙ", type: "flask" as const, x: 0, y: 0, description: "", value: 2300, extra: "МАЛЫЙ" },
      { id: 12, name: "ОТКАТ", type: "penalty" as const, x: 0, y: 0, description: "", value: -3, extra: "-3 КЛ." },
    ];
    const bogus = expandHistoryLines(
      [
        {
          at: 1,
          timeLabel: "",
          kind: "roll",
          fromCell: 9,
          toCell: 4,
          steps: 4,
          note: "1000 CR",
        },
      ],
      cells as any
    );
    const jumps = bogus.filter((l) => l.fromCell !== l.toCell).map((l) => `${l.fromCell}→${l.toCell}`);
    expect(jumps).toEqual(["0→1", "1→2", "2→3", "3→4"]);

    const penalty = expandHistoryLines(
      [
        {
          at: 2,
          timeLabel: "",
          kind: "roll",
          fromCell: 6,
          toCell: 9,
          steps: 6,
          note: "Сработал откат системы! Смещение назад на 3 клетки (с клетки 12 на клетку 9).",
        },
      ],
      cells as any
    );
    expect(penalty.map((l) => `${l.fromCell}→${l.toCell}`).join(" ")).toContain("11→12");
    expect(penalty.map((l) => `${l.fromCell}→${l.toCell}`)).toContain("12→9");

    const mismatch = expandHistoryLines(
      [
        {
          at: 3,
          timeLabel: "",
          kind: "roll",
          fromCell: 11,
          toCell: 10,
          steps: 1,
          note: "",
        },
      ],
      cells as any
    );
    expect(mismatch.map((l) => `${l.fromCell}→${l.toCell}`)).toEqual(["9→10"]);
  });

  it("drops a log duplicate of a jsonl roll", () => {
    const jsonl = [
      {
        at: 1_700_000_000_000,
        timeLabel: "25.08.2026, 10:24",
        kind: "roll" as const,
        fromCell: 4,
        toCell: 6,
        steps: 2,
        note: "",
      },
    ];
    const fromLog = [
      {
        at: 0,
        timeLabel: "10:24:29 AM",
        kind: "roll" as const,
        fromCell: 9,
        toCell: 6,
        steps: 2,
        note: "",
      },
    ];
    expect(mergeMoves(jsonl, fromLog)).toHaveLength(1);
  });

  it("does not re-date a clock-only log as today", () => {
    const jsonl = [
      {
        at: 1_775_000_000_000,
        timeLabel: "25.08.2026, 10:24",
        kind: "roll" as const,
        fromCell: 4,
        toCell: 6,
        steps: 2,
        note: "",
      },
    ];
    const ghost = [
      {
        at: 0,
        timeLabel: "10:24:29 AM",
        kind: "roll" as const,
        fromCell: 4,
        toCell: 6,
        steps: 2,
        note: "",
      },
      {
        at: 0,
        timeLabel: "7:11:33 PM",
        kind: "roll" as const,
        fromCell: null,
        toCell: 4,
        steps: 4,
        note: "1000 CR",
      },
    ];
    const merged = mergeMoves(jsonl, ghost);
    expect(merged.filter((m) => m.steps === 2 && m.toCell === 6)).toHaveLength(1);
    const start = merged.find((m) => m.steps === 4 && m.toCell === 4);
    expect(start).toBeTruthy();
    expect(start!.at).toBeLessThan(1e11);
    expect(merged[0].toCell).toBe(4);
  });

  it("expands a roll into every cell and a separate prize line", () => {
    const lines = expandHistoryLines([
      {
        at: 1_700_000_000_000,
        timeLabel: "",
        kind: "roll",
        fromCell: 0,
        toCell: 4,
        steps: 4,
        note: "КРИПТО-БОНУС",
      },
    ]);
    expect(
      lines.filter((l) => l.fromCell !== l.toCell).map((l) => `${l.fromCell}→${l.toCell}`)
    ).toEqual(["0→1", "1→2", "2→3", "3→4"]);
    expect(lines.some((l) => l.why.startsWith("приз"))).toBe(true);
    expect(lines[0].when).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });
});
