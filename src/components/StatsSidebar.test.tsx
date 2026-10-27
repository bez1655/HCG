// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Player statistics: compact, but not at the cost of information.
 *
 * The card used to stack four rows per player — a 2x1 stat grid, a cell row
 * and a bonus row — so a phone showed two players and six meant scrolling.
 * The risk in compacting is silently dropping a field, so these tests check
 * both halves: fewer stacked rows, and every value still rendered.
 */
const SOURCE = fs.readFileSync(path.join(__dirname, "StatsSidebar.tsx"), "utf-8");

describe("player stats stay compact", () => {
  it("keeps every statistic that was there before", () => {
    // Distance, lap, last roll, current cell and the bonus all still appear.
    for (const field of [
      "distanceTraveled",
      "lapCount",
      "player.lastRoll",
      "currentCellObj",
      "player.activeBonus",
    ]) {
      expect(SOURCE.includes(field), `${field} disappeared from the card`).toBe(true);
    }
  });

  it("puts the numbers on one line instead of a stacked grid", () => {
    // grid-cols-2 inside a player card is what made each entry three rows
    // tall. The summary cards at the top may still use it.
    const cardStart = SOURCE.indexOf("{sortedPlayers.map(");
    const card = SOURCE.slice(cardStart);
    expect(card).not.toMatch(/grid grid-cols-2/);
  });

  it("explains the numbers it shortened", () => {
    // "12" alone is meaningless; the tooltip carries what the label used to.
    expect(SOURCE).toMatch(/title=\{`Пройдено \$\{distanceTraveled\}/);
    expect(SOURCE).toMatch(/title=\{`Круг \$\{lapCount\}`\}/);
  });

  it("keeps the bonus on its own line", () => {
    // The administrator writes bonuses off by hand, so this one must stay
    // visible rather than collapse into a tooltip.
    expect(SOURCE).toMatch(/player\.activeBonus && \(/);
    expect(SOURCE).toMatch(/🎁/);
  });

  it("uses tighter spacing between cards", () => {
    expect(SOURCE).toMatch(/space-y-1\.5/);
    expect(SOURCE).not.toMatch(/space-y-3 scrollbar-none/);
  });

  it("still lets a click jump to the player's cell", () => {
    // The footer promises this; losing it while rearranging would be easy.
    expect(SOURCE).toMatch(/onSelectCell\?\.\(currentCellObj\.id\)/);
  });
});
