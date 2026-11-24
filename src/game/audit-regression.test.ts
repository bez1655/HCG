import { describe, expect, it } from "vitest";
import board from "./data/cells.json";
import { resolveMove } from "./rules";
import { generateDropBoxOptions, issueDropCoupon } from "./dropBoxes.server";
import { playerForViewer } from "./publicPlayer.server";
import { keepBetterPrize } from "./prizes";
import { Cell, Player } from "../types";

const cells = board as Cell[];
const move = (from: number, steps: number, feverActive = false) => resolveMove({ cell: from, name: "Сайфер" }, steps, cells, { feverActive });

describe("audit regressions", () => {
  it("keeps the drop on 12 accessible after rollback", () => {
    const outcome = move(10, 2);
    expect(outcome.finalCell).toBe(9);
    expect(outcome.isDropBox).toBe(true);
  });
  it("doubles only cash discounts and leaves crystal values unchanged", () => {
    expect(move(3, 1, true).awardedBonus?.value).toBe(2000);
    expect(move(3, 1, true).awardedBonus?.extra).toBe("СКИДКА 2000");
    expect(move(9, 1, true).awardedBonus?.value).toBe(2300);
    expect(move(24, 1, true).awardedBonus?.value).toBe(4600);
    expect(move(63, 1, true).awardedBonus?.value).toBe(13800);
    expect(keepBetterPrize(move(48, 1, true).awardedBonus, move(9, 1).awardedBonus!).active.value).toBe(2300);
  });
  it("only issues a coupon after a case is chosen", () => {
    const options = generateDropBoxOptions();
    expect(options).toHaveLength(3);
    expect(options.every((o) => o.type === "promo" && !o.promoCode)).toBe(true);
    expect(issueDropCoupon(options[0]).promoCode).toMatch(/^HAP-/);
    expect(issueDropCoupon(options[0]).promoCode).not.toBe(issueDropCoupon(options[0]).promoCode);
  });
  it("hides private state and real IDs from other viewers", () => {
    const p = { id: "private-id", name: "@private", alias: "Сайфер", role: "player", cell: 12, color: "#fff", isOnline: true, lastRoll: 2, skipNextTurn: false, telegramId: 123, activeBonus: { name: "КРИСТАЛЛ", receivedAt: 1 }, prizeLog: [], pendingDropBox: { cellId: 12, options: generateDropBoxOptions() } } as Player;
    const other = playerForViewer(p, "other");
    expect(other.id).not.toBe(p.id);
    expect(other.name).toBe("Сайфер");
    expect(other.activeBonus).toBeUndefined();
    expect(other.prizeLog).toBeUndefined();
    expect(other.pendingDropBox).toBeUndefined();
    expect(other.telegramId).toBeUndefined();
    expect(playerForViewer(p, p.id).activeBonus).toEqual(p.activeBonus);
    expect(playerForViewer(p, p.id).pendingDropBox?.options).toEqual([]);
  });
  it("keeps all 65 board positions distinct", () => {
    expect(cells.map((c) => c.id)).toEqual(Array.from({ length: 65 }, (_, n) => n));
    expect(new Set(cells.map((c) => `${c.x},${c.y}`)).size).toBe(65);
  });
});
