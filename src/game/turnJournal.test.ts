import { describe, it, expect } from "vitest";
import {
  parseTurnLogLine,
  entriesFromLogs,
  pairAsks,
  formatTurnJournalText,
} from "./turnJournal";
import type { GameLog, Player } from "../types";

function p(id: string, name: string, alias: string): Player {
  return {
    id,
    name,
    alias,
    role: "player",
    cell: 0,
    color: "#0",
    isOnline: false,
    lastRoll: null,
    skipNextTurn: false,
  };
}

describe("turn journal", () => {
  it("parses request without an explicit count as 1", () => {
    const x = parseTurnLogLine("⏳ Игрок Шторм запросил ход. Ожидание одобрения.");
    expect(x).toEqual({ kind: "request", who: "Шторм", n: 1 });
  });

  it("parses request with a count", () => {
    const x = parseTurnLogLine("⏳ Игрок Шторм запросил 3 хода. Ожидание одобрения.");
    expect(x?.n).toBe(3);
  });

  it("pairs request then grant for the same alias", () => {
    const players = [p("1", "@storm", "Шторм")];
    const logs: GameLog[] = [
      {
        id: "a",
        message: "👑 Игроку Шторм одобрено 3 хода (без ограничения по времени).",
        timestamp: "01.10.2026, 12:05",
        type: "admin",
      },
      {
        id: "b",
        message: "⏳ Игрок Шторм запросил 3 хода. Ожидание одобрения.",
        timestamp: "01.10.2026, 12:00",
        type: "system",
      },
    ];
    const rows = pairAsks(entriesFromLogs(logs, players));
    expect(rows).toHaveLength(1);
    expect(rows[0].requested).toBe(3);
    expect(rows[0].granted).toBe(3);
    expect(rows[0].status).toBe("granted");
    expect(formatTurnJournalText(rows)).toMatch(/просил 3/);
  });
});
