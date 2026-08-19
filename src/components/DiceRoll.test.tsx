// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, cleanup, act } from "@testing-library/react";
import DiceRoll from "./DiceRoll";

/**
 * The rewritten roll overlay.
 *
 * The component it replaces froze the game outright — black screen in
 * Telegram, white in the APK, recoverable only by restarting. The cause was
 * a 6 KB <style> block rebuilt from template literals on every render, with
 * a 70 ms timer forcing 31 renders per roll. These tests pin down both the
 * behaviour and the thing that made it fail.
 */
vi.mock("../utils/sounds", () => ({ playSound: vi.fn() }));

const SOURCE = fs.readFileSync(path.join(__dirname, "DiceRoll.tsx"), "utf-8");

beforeEach(() => {
  vi.useFakeTimers();
  document.getElementById("hcg-dice-roll-styles")?.remove();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("DiceRoll renders and finishes", () => {
  it("shows every face the server can send", () => {
    for (const face of [1, 2, 3, 4, 5, 6]) {
      const { unmount } = render(<DiceRoll result={face} onDone={() => {}} />);
      unmount();
    }
  });

  it("falls back to a valid face for impossible input", () => {
    // A malformed result must not blank the screen — there is no error
    // boundary above this component, so a throw here takes the whole app.
    for (const bad of [0, 7, -1, NaN, 1.5] as number[]) {
      const onDone = vi.fn();
      const { unmount } = render(<DiceRoll result={bad} onDone={onDone} />);
      act(() => vi.advanceTimersByTime(4000));
      expect(onDone).toHaveBeenCalledWith(1);
      unmount();
    }
  });

  it("reports the result exactly once", () => {
    const onDone = vi.fn();
    render(<DiceRoll result={4} onDone={onDone} />);

    expect(onDone).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(3500));

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(4);
  });

  it("does not fire twice even if time keeps running", () => {
    const onDone = vi.fn();
    render(<DiceRoll result={2} onDone={onDone} />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("still reports when unmounted mid-roll", () => {
    // Otherwise the parent waits forever for a callback that can never come,
    // and isRolling stays true with no overlay on screen.
    const onDone = vi.fn();
    const { unmount } = render(<DiceRoll result={5} onDone={onDone} />);
    act(() => vi.advanceTimersByTime(200));
    unmount();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("switches from spinning to landed", () => {
    const { container } = render(<DiceRoll result={3} onDone={() => {}} />);
    expect(container.querySelector(".hcg-dice-img.is-spinning")).toBeTruthy();

    act(() => vi.advanceTimersByTime(1900));
    expect(container.querySelector(".hcg-dice-img.is-landed")).toBeTruthy();
    expect(container.textContent).toContain("3");
  });

  it("survives a sound subsystem that throws", () => {
    // Audio is blocked on plenty of phones; it must never take the roll down.
    // The component wraps playSound in try/catch for exactly this.
    expect(SOURCE).toMatch(/try \{\s*playSound/);
    expect(SOURCE).toMatch(/catch \{/);
  });
});

describe("the overlay cannot stall the browser", () => {
  it("injects its stylesheet once, not per render", () => {
    // This is the defect that froze the game: a stylesheet rebuilt inside
    // render, re-parsed dozens of times per roll.
    render(<DiceRoll result={1} onDone={() => {}} />);
    act(() => vi.advanceTimersByTime(3500));
    cleanup();
    render(<DiceRoll result={6} onDone={() => {}} />);

    expect(document.querySelectorAll("#hcg-dice-roll-styles")).toHaveLength(1);
  });

  it("renders no <style> element of its own", () => {
    const { container } = render(<DiceRoll result={3} onDone={() => {}} />);
    expect(container.querySelector("style")).toBeNull();
  });

  it("keeps the keyframes free of interpolation", () => {
    // Unique @keyframes names per roll meant the browser could never reuse a
    // parsed stylesheet. The CSS is now a constant.
    const css = SOURCE.slice(SOURCE.indexOf("const CSS = `"), SOURCE.indexOf("`;", SOURCE.indexOf("const CSS = `")));
    expect(css).not.toMatch(/@keyframes [\w-]*\$\{/);
    expect(css).not.toMatch(/\$\{(face|result|diceId|targetNumber)/);
  });

  it("re-renders at most twice for a whole roll", () => {
    // The old component ran a 70 ms telemetry timer — 31 renders per roll,
    // each rebuilding 6 KB of CSS. Nothing here re-renders on a timer except
    // the single spinning -> landed transition.
    let renders = 0;
    function Counted({ result }: { result: number }) {
      renders += 1;
      return <DiceRoll result={result} onDone={() => {}} />;
    }
    render(<Counted result={4} />);
    act(() => vi.advanceTimersByTime(3500));
    expect(renders).toBe(1);
  });

  it("does not blur the backdrop", () => {
    // backdrop-filter over the board's two looping videos is what stalled
    // the compositor in the first place. Check the stylesheet, not the
    // comments that explain why it is absent.
    const css = SOURCE.slice(
      SOURCE.indexOf("const CSS = `"),
      SOURCE.indexOf("`;", SOURCE.indexOf("const CSS = `"))
    );
    // Убираем CSS-комментарии: в одном из них слово упомянуто намеренно,
    // чтобы объяснить, почему свойства здесь нет.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).not.toMatch(/backdrop-filter\s*:/);
  });

  it("respects a reduced-motion preference", () => {
    expect(SOURCE).toMatch(/prefers-reduced-motion/);
  });
});

describe("the parent cannot get stuck", () => {
  const board = fs.readFileSync(path.join(__dirname, "BoardView.tsx"), "utf-8");

  it("mounts a fresh component per roll", () => {
    expect(board).toMatch(/key=\{rollSessionRef\.current\}/);
    expect(board).toMatch(/rollSessionRef\.current \+= 1/);
  });

  it("keeps an independent timeout as a backstop", () => {
    const bail = board.slice(board.indexOf("Аварийный выход"));
    expect(bail).toMatch(/setIsRolling\(false\)/);
    expect(bail).toMatch(/8000/);
  });

  it("no longer references the deleted component", () => {
    expect(board).not.toMatch(/Dice3D/);
    expect(fs.existsSync(path.join(__dirname, "Dice3D.tsx"))).toBe(false);
  });
});

/**
 * Ни один полноэкранный слой над доской не размывает фон.
 *
 * Под доской постоянно играют два зацикленных видео. backdrop-filter
 * заставляет браузер переcomposить всё, что под слоем, на каждом кадре —
 * на телефоне этого достаточно, чтобы отрисовка встала совсем.
 *
 * Именно так и выглядел зарегистрированный симптом: сервер принимал бросок
 * («roll:request received» в журнале), отвечал результатом, а игра замирала
 * чёрным экраном. Оверлей самого кубика я вычистил раньше — но следом за
 * броском всплывает карточка события с bg-black/80 + backdrop-blur-md,
 * и она вешала игру ровно так же.
 */
describe("полноэкранные слои не размывают доску", () => {
  const files = ["PopupCard.tsx", "BoardView.tsx", "StatsSidebar.tsx", "DiceRoll.tsx"];

  for (const file of files) {
    it(`${file}: нет backdrop-blur на слое во весь экран`, () => {
      const src = fs.readFileSync(path.join(__dirname, file), "utf-8");
      const offenders: string[] = [];

      for (const [i, line] of src.split("\n").entries()) {
        if (!/inset-0/.test(line)) continue;
        if (!/backdrop-blur(?!-none)/.test(line)) continue;
        offenders.push(`${file}:${i + 1}`);
      }

      expect(
        offenders,
        `backdrop-filter поверх играющего видео останавливает отрисовку ` +
          `на телефоне: ${offenders.join(", ")}`
      ).toEqual([]);
    });
  }

  it("затемнение осталось: слои по-прежнему читаются как модальные", () => {
    // Размытие убрано не «за компанию» — вместо него плотнее заливка,
    // иначе карточка потерялась бы на пёстром фоне доски.
    const popup = fs.readFileSync(path.join(__dirname, "PopupCard.tsx"), "utf-8");
    expect(popup).toMatch(/bg-black\/(8[0-9]|9[0-9])/);
  });
});
