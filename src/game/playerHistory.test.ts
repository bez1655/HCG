import { describe, it, expect } from "vitest";
import {
  classifyLogMessage,
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
          toCell: 18,
          steps: 5,
          note: "",
        },
      ],
    });
    expect(text).toContain("0 ➔ 4");
    expect(text).toContain("4 ➔ 18");
    expect(text).toContain("Сейчас клетка: 18");
  });
});
