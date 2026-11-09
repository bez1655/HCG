import { describe, it, expect } from "vitest";
import type { Player } from "../types";
import {
  BOSS_CELL_IDS,
  FINAL_CELL,
  getEncounterType,
  beginEncounter,
  resolveEncounterChoice,
  ensurePlayerRpg,
  addExp,
} from "./encounters";
import { sequenceDice } from "./rpgRng";

function stubPlayer(cell: number): Player {
  return {
    id: "p1",
    name: "@test",
    role: "player",
    cell,
    color: "#0f0",
    isOnline: true,
    lastRoll: null,
    skipNextTurn: false,
  };
}

describe("board vs RPG cells", () => {
  it("does not put a boss on the shop finish", () => {
    expect(BOSS_CELL_IDS).not.toContain(FINAL_CELL);
    expect(getEncounterType(64)).toBeNull();
    expect(getEncounterType(63)).toBe("boss");
  });

  it("starts a boss session on 63", () => {
    const p = stubPlayer(63);
    const s = beginEncounter(p, 63);
    expect(s?.type).toBe("boss");
    expect(s?.boss?.id).toBe("boss_63");
  });

  it("skips encounter while a drop box is open", () => {
    const p = stubPlayer(16);
    p.pendingDropBox = { cellId: 12, options: [] };
    expect(beginEncounter(p, 16)).toBeNull();
  });
});

describe("economy", () => {
  it("loyalty credits never grant inventory", () => {
    const p = stubPlayer(1);
    ensurePlayerRpg(p);
    addExp(p, 500, 5000);
    expect(p.loyaltyCredits).toBe(5000);
    expect(p.inventory).toBeUndefined();
    expect(p.turnsApproved || 0).toBe(0);
  });
});

describe("floor clerk", () => {
  it("intel does not grant turns or items", () => {
    const p = stubPlayer(10);
    p.pendingEncounter = beginEncounter(p, 10);
    const out = resolveEncounterChoice(p, "intel", sequenceDice([1]));
    expect(out.resolved).toBe(true);
    expect(out.resultMessage).toMatch(/босс|дроп|контракт/i);
    expect(p.turnsApproved || 0).toBe(0);
    expect(p.inventory).toBeUndefined();
  });

  it("stamp helps the next check once", () => {
    const p = stubPlayer(10);
    p.pendingEncounter = beginEncounter(p, 10);
    resolveEncounterChoice(p, "stamp", sequenceDice([1]));
    expect(p.pendingCheckBonus).toBe(1);
    p.cell = 16;
    p.pendingEncounter = beginEncounter(p, 16);
    resolveEncounterChoice(p, "fight", sequenceDice([1]));
    expect(p.pendingCheckBonus || 0).toBe(0);
  });

  it("pardon clears skipNextTurn", () => {
    const p = stubPlayer(10);
    p.skipNextTurn = true;
    p.pendingEncounter = beginEncounter(p, 10);
    resolveEncounterChoice(p, "pardon", sequenceDice([1]));
    expect(p.skipNextTurn).toBe(false);
  });
});

describe("combat uses injected D20", () => {
  it("win when roll is high", () => {
    const p = stubPlayer(16);
    p.pendingEncounter = beginEncounter(p, 16);
    const out = resolveEncounterChoice(p, "fight", sequenceDice([20]));
    expect(out.resolved).toBe(true);
    expect(out.lastRoll).toBe(20);
    expect(p.characterExp || 0).toBeGreaterThan(0);
  });

  it("loss when roll is 1", () => {
    const p = stubPlayer(16);
    const before = 0;
    p.pendingEncounter = beginEncounter(p, 16);
    const out = resolveEncounterChoice(p, "fight", sequenceDice([1]));
    expect(out.resolved).toBe(true);
    expect(p.characterExp || 0).toBe(before);
  });
});
