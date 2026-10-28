// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import BoardView from "./BoardView";
import AdminConsole from "./AdminConsole";
import { GameState, Player, CellType } from "../types";

/**
 * Скрытие фишек давно не заходивших игроков — со стороны экрана.
 *
 * Серверные тесты проверяют правило, здесь — что доска ему подчиняется:
 * лишняя фишка исчезла, нужная осталась, и по возвращении игрока она
 * появляется снова.
 */
vi.mock("../utils/sounds", () => ({
  playSound: vi.fn(),
  getSoundVolume: () => 0,
  setSoundVolume: vi.fn(),
  getSoundEnabled: () => false,
  setSoundEnabled: vi.fn(),
  getMusicVolume: () => 0,
  setMusicVolume: vi.fn(),
  getMusicEnabled: () => false,
  setMusicEnabled: vi.fn(),
}));

const HOUR = 60 * 60 * 1000;
const agoHours = (h: number) => Date.now() - h * HOUR;

function makePlayer(over: Partial<Player> = {}): Player {
  return {
    id: "p1",
    name: "@real",
    alias: "Бэтмен",
    role: "player",
    cell: 5,
    color: "#00ffaa",
    isOnline: false,
    lastRoll: null,
    skipNextTurn: false,
    chipImage: "/chips/chip_1.svg",
    ...over,
  };
}

function makeState(players: Player[], over: Partial<GameState> = {}): GameState {
  return {
    players,
    cells: [
      {
        id: 5,
        name: "Сектор 5",
        description: "",
        type: CellType.NORMAL,
        value: 0,
        x: 50,
        y: 50,
      },
    ],
    currentPlayerId: null,
    turnRequestUserId: null,
    turnStatus: "idle",
    chatMessages: [],
    logs: [],
    boardImage: null,
    hideTokensAfterHours: 24,
    calibrationMode: false,
    selectedCalibrationCellId: null,
    ...over,
  };
}

const boardProps = {
  onRoll: vi.fn(),
  pendingRoll: null,
  onRollAnimationDone: vi.fn(),
  onSendMessage: vi.fn(),
  onLogout: vi.fn(),
  openAdminPanel: vi.fn(),
  onCalibrateCell: vi.fn(),
  openRules: vi.fn(),
};

const adminProps = {
  onUpdatePlayer: vi.fn(),
  onRegisterPlayer: vi.fn(),
  onDeletePlayer: vi.fn(),
  onResetGame: vi.fn(),
  onSetBoardImage: vi.fn(),
  onToggleCalibration: vi.fn(),
  onClose: vi.fn(),
};

/**
 * Сколько РАЗНЫХ игроков показано на доске.
 *
 * Две тонкости, на которых спотыкалась первая версия теста:
 *
 * 1. Фишки — встроенные SVG, тега `img` на доске нет вовсе, поэтому поиск
 *    по `img[src*="/chips/"]` находил ноль всегда.
 * 2. Один игрок рисуется ДВУМЯ слоями: внутри клетки и отдельным слоем
 *    «шагающих» фишек. Считать элементы нельзя — получится вдвое больше,
 *    поэтому пересчитываем по id игроков, чьи фишки нашлись.
 */
function shownPlayers(container: HTMLElement, players: Player[]): Set<string> {
  const html = container.innerHTML;
  const shown = new Set<string>();
  for (const p of players) {
    // Цвет и модель фишки уникальны для игрока в этих тестах, но надёжнее
    // всего — подпись с его именем, которую рисует PlayerToken.
    if (html.includes(`>${p.name}<`) || html.includes(`Фишка ${p.name}`)) shown.add(p.id);
  }
  return shown;
}

/** Сколько игроков видно на доске. */
function tokenCount(container: HTMLElement, players: Player[] = []): number {
  return players.length > 0
    ? shownPlayers(container, players).size
    : container.querySelectorAll(".w-7.h-7").length;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("доска скрывает фишки неактивных", () => {
  it("рисует фишку игрока, который заходил недавно", () => {
    const { container } = render(
      <BoardView
        {...boardProps}
        gameState={makeState([makePlayer({ lastSeenAt: agoHours(2) })])}
        userRole="player"
        userId="p1"
      />
    );
    expect(tokenCount(container)).toBeGreaterThan(0);
  });

  it("убирает фишку того, кто пропал дольше суток", () => {
    const { container } = render(
      <BoardView
        {...boardProps}
        gameState={makeState([makePlayer({ lastSeenAt: agoHours(50) })])}
        userRole="player"
        userId="other"
      />
    );
    expect(tokenCount(container)).toBe(0);
  });

  it("возвращает фишку, когда игрок появился снова", () => {
    /*
     * Главное обещание: позиция сохраняется. Тот же игрок, та же клетка —
     * меняется только отметка присутствия.
     */
    const stale = makePlayer({ lastSeenAt: agoHours(50) });
    const { container, rerender } = render(
      <BoardView {...boardProps} gameState={makeState([stale])} userRole="player" userId="other" />
    );
    expect(tokenCount(container)).toBe(0);

    rerender(
      <BoardView
        {...boardProps}
        gameState={makeState([{ ...stale, lastSeenAt: Date.now() }])}
        userRole="player"
        userId="other"
      />
    );
    expect(tokenCount(container)).toBeGreaterThan(0);
  });

  it("не трогает того, у кого есть неиспользованные ходы", () => {
    // Ходы оплачены — терять такого игрока с доски нельзя.
    const { container } = render(
      <BoardView
        {...boardProps}
        gameState={makeState([
          makePlayer({
            lastSeenAt: agoHours(500),
            turnsApproved: 2,
            turnApprovedUntil: Date.now() + HOUR,
          }),
        ])}
        userRole="player"
        userId="other"
      />
    );
    expect(tokenCount(container)).toBeGreaterThan(0);
  });

  it("не трогает того, у кого невыданный приз", () => {
    const { container } = render(
      <BoardView
        {...boardProps}
        gameState={makeState([
          makePlayer({
            lastSeenAt: agoHours(500),
            activeBonus: { name: "ПРИЗ", extra: "1500 CR", receivedAt: 1 },
          }),
        ])}
        userRole="player"
        userId="other"
      />
    );
    expect(tokenCount(container)).toBeGreaterThan(0);
  });

  it("показывает всех, когда правило выключено", () => {
    const { container } = render(
      <BoardView
        {...boardProps}
        gameState={makeState([makePlayer({ lastSeenAt: agoHours(9999) })], {
          hideTokensAfterHours: 0,
        })}
        userRole="player"
        userId="other"
      />
    );
    expect(tokenCount(container)).toBeGreaterThan(0);
  });

  it("оставляет на доске только активных, когда неактивных много", () => {
    /*
     * Ровно та ситуация, из-за которой всё затевалось: десять брошенных
     * фишек и один живой игрок.
     */
    /*
     * Имена обязаны различаться: подпись фишки рисуется по player.name, и с
     * одинаковыми именами тест не смог бы отличить одного игрока от другого.
     */
    const players = [
      makePlayer({ id: "live", name: "@live", alias: "Тор", lastSeenAt: agoHours(1) }),
      ...Array.from({ length: 10 }, (_, i) =>
        makePlayer({
          id: `old${i}`,
          name: `@old${i}`,
          alias: `Герой ${i}`,
          lastSeenAt: agoHours(100 + i),
        })
      ),
    ];
    const { container } = render(
      <BoardView {...boardProps} gameState={makeState(players)} userRole="player" userId="live" />
    );
    // Один игрок вместо одиннадцати.
    expect(tokenCount(container, players)).toBe(1);
  });
});

describe("админка управляет порогом", () => {
  it("сообщает выбранное значение наверх", () => {
    const onSetTokenTimeout = vi.fn();
    const { getByText } = render(
      <AdminConsole
        {...adminProps}
        gameState={makeState([makePlayer()])}
        onSetTokenTimeout={onSetTokenTimeout}
      />
    );

    fireEvent.click(getByText("3 дня"));
    expect(onSetTokenTimeout).toHaveBeenCalledWith(72);
  });

  it("позволяет выключить правило совсем", () => {
    const onSetTokenTimeout = vi.fn();
    const { getByText } = render(
      <AdminConsole
        {...adminProps}
        gameState={makeState([makePlayer()])}
        onSetTokenTimeout={onSetTokenTimeout}
      />
    );

    fireEvent.click(getByText("Никогда"));
    expect(onSetTokenTimeout).toHaveBeenCalledWith(0);
  });

  it("показывает текущий порог", () => {
    const { container } = render(
      <AdminConsole
        {...adminProps}
        gameState={makeState([makePlayer()], { hideTokensAfterHours: 72 })}
      />
    );
    expect(container.textContent).toContain("72 ч");
  });

  it("пишет «не скрывать», когда правило выключено", () => {
    const { container } = render(
      <AdminConsole
        {...adminProps}
        gameState={makeState([makePlayer()], { hideTokensAfterHours: 0 })}
      />
    );
    expect(container.textContent).toContain("не скрывать");
  });

  it("считает, сколько игроков сейчас скрыто", () => {
    // Без этого числа непонятно, работает правило или нет.
    const players = [
      makePlayer({ id: "a", lastSeenAt: agoHours(1) }),
      makePlayer({ id: "b", lastSeenAt: agoHours(100) }),
      makePlayer({ id: "c", lastSeenAt: agoHours(200) }),
    ];
    const { container } = render(<AdminConsole {...adminProps} gameState={makeState(players)} />);
    expect(container.textContent).toContain("Сейчас скрыто: 2");
  });
});
