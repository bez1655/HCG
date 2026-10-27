// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import CellParticleEffect from "./CellParticleEffect";
import { CellType } from "../types";

/**
 * The crash that froze the game after every roll.
 *
 * Reported from a live device via the new error boundary:
 *
 *   TypeError: Cannot read properties of undefined (reading 'unshift')
 *     at Db … at Array.map … at Ub
 *
 * getBurstParticles declared `let baseColors: string[]` and called
 * `baseColors.unshift(burst.playerColor)` before assigning it. Any player
 * with a colour — that is, every player — crashed the render. Because it
 * happened inside a .map() over the board's particle bursts, React unmounted
 * the whole tree: white in the APK, black in Telegram where the page
 * background showed through. It looked like a hang; it was an exception.
 *
 * The default branch of the switch never assigned baseColors either, so an
 * ordinary cell would have crashed the same way.
 */
const burst = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  cellId: 12,
  x: 40,
  y: 60,
  cellType: CellType.NORMAL,
  ...over,
});

describe("particle bursts never crash the board", () => {
  it("renders for a player who has a colour", () => {
    // The exact reported case: playerColor set, unshift on an undefined array.
    const { container } = render(
      <CellParticleEffect bursts={[burst({ playerColor: "#059669" }) as never]} />
    );
    expect(container.querySelectorAll("div").length).toBeGreaterThan(0);
  });

  it("renders for a plain cell, which hits the switch default", () => {
    render(<CellParticleEffect bursts={[burst() as never]} />);
  });

  it("renders every cell type", () => {
    for (const type of Object.values(CellType)) {
      const { unmount } = render(
        <CellParticleEffect bursts={[burst({ cellType: type, playerColor: "#ff0088" }) as never]} />
      );
      unmount();
    }
  });

  it("renders a special burst", () => {
    render(
      <CellParticleEffect
        bursts={[burst({ isSpecial: true, playerColor: "#38bdf8" }) as never]}
      />
    );
  });

  it("renders several bursts at once, as a real roll produces", () => {
    // The stack showed the failure inside Array.map — more than one burst is
    // the normal case, not an edge case.
    render(
      <CellParticleEffect
        bursts={[
          burst({ id: "a", playerColor: "#059669" }),
          burst({ id: "b", cellType: CellType.BONUS, isSpecial: true, playerColor: "#f5c542" }),
          burst({ id: "c", cellType: CellType.SNAKE }),
        ] as never}
      />
    );
  });

  it("survives a burst with no colour at all", () => {
    render(<CellParticleEffect bursts={[burst({ playerColor: undefined }) as never]} />);
  });

  it("puts the player's colour first when there is one", () => {
    // Cosmetic, but it is the reason the unshift existed: the burst should
    // read as belonging to that player.
    const { container } = render(
      <CellParticleEffect bursts={[burst({ playerColor: "rgb(9, 200, 100)" }) as never]} />
    );
    const html = container.innerHTML;
    expect(html).toContain("rgb(9, 200, 100)");
  });
});
