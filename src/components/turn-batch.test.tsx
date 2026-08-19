// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import BoardView from "./BoardView";
import AdminConsole from "./AdminConsole";
import { GameState, Player, CellType } from "../types";

/**
 * Пакетное одобрение хода — со стороны экрана.
 *
 * Серверные тесты доказывают, что несколько бросков открываются одним
 * одобрением. Здесь проверяется вторая половина: игрок видит, сколько
 * бросков у него осталось, а администратор может выдать нужное количество —
 * и по заявке, и без неё.
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

function makePlayer(over: Partial<Player> = {}): Player {
  return {
    id: "p1",
    name: "Кибер",
    role: "player",
    cell: 5,
    color: "#00ffaa",
    isOnline: true,
    lastRoll: null,
    skipNextTurn: false,
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
    currentPlayerId: players[0]?.id ?? null,
    turnRequestUserId: null,
    turnStatus: "waiting_roll",
    chatMessages: [],
    logs: [],
    boardImage: null,
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

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("игрок видит остаток пачки", () => {
  const inTwelveHours = () => Date.now() + 12 * 60 * 60 * 1000;

  it("показывает, сколько бросков осталось", () => {
    const me = makePlayer({ turnApprovedUntil: inTwelveHours(), turnsApproved: 3 });
    const { container } = render(
      <BoardView {...boardProps} gameState={makeState([me])} userRole="player" userId="p1" />
    );
    expect(container.textContent).toContain("ОСТАЛОСЬ 3");
    expect(container.textContent).toContain("ХОДОВ: 3");
  });

  it("не пишет остаток, когда ход всего один", () => {
    // «ОСТАЛОСЬ 1» — шум: обычный ход выглядит как раньше.
    const me = makePlayer({ turnApprovedUntil: inTwelveHours(), turnsApproved: 1 });
    const { container } = render(
      <BoardView {...boardProps} gameState={makeState([me])} userRole="player" userId="p1" />
    );
    expect(container.textContent).not.toContain("ОСТАЛОСЬ");
    expect(container.textContent).toContain("ХОД ОДОБРЕН");
  });

  it("считает пачку исчерпанной, хотя 12 часов ещё не вышли", () => {
    /*
     * Ровно то, что ломалось бы при чтении одного лишь turnApprovedUntil:
     * счётчик на нуле, а кнопка предлагает бросать.
     */
    const me = makePlayer({ turnApprovedUntil: inTwelveHours(), turnsApproved: 0 });
    const { container } = render(
      <BoardView {...boardProps} gameState={makeState([me])} userRole="player" userId="p1" />
    );
    expect(container.textContent).toContain("ЗАПРОСИТЬ ХОД");
    expect(container.textContent).not.toContain("ХОД ОДОБРЕН");
  });

  it("запрашивает столько ходов, сколько выбрал игрок", () => {
    const onSendTurnRequest = vi.fn();
    const { getByText } = render(
      <BoardView
        {...boardProps}
        gameState={makeState([makePlayer()])}
        userRole="player"
        userId="p1"
        onSendTurnRequest={onSendTurnRequest}
      />
    );

    fireEvent.click(getByText("ЗАПРОСИТЬ ХОД"));
    fireEvent.click(getByText("3"));
    fireEvent.click(getByText("Отправить запрос"));

    expect(onSendTurnRequest).toHaveBeenCalledWith(3);
  });

  it("по умолчанию просит один ход", () => {
    const onSendTurnRequest = vi.fn();
    const { getByText } = render(
      <BoardView
        {...boardProps}
        gameState={makeState([makePlayer()])}
        userRole="player"
        userId="p1"
        onSendTurnRequest={onSendTurnRequest}
      />
    );

    fireEvent.click(getByText("ЗАПРОСИТЬ ХОД"));
    fireEvent.click(getByText("Отправить запрос"));

    expect(onSendTurnRequest).toHaveBeenCalledWith(1);
  });

  it("показывает, сколько ходов уже запрошено", () => {
    const me = makePlayer({ turnRequested: true, turnsRequested: 4 });
    const { container } = render(
      <BoardView {...boardProps} gameState={makeState([me])} userRole="player" userId="p1" />
    );
    expect(container.textContent).toContain("ЗАПРОШЕНО: 4");
  });
});

describe("администратор выдаёт несколько ходов", () => {
  it("одобряет ровно то количество, которое просил игрок", () => {
    const onApprovePlayerTurn = vi.fn();
    const p = makePlayer({ turnRequested: true, turnsRequested: 3 });
    const { getByTitle } = render(
      <AdminConsole
        {...adminProps}
        gameState={makeState([p])}
        onApprovePlayerTurn={onApprovePlayerTurn}
      />
    );

    fireEvent.click(getByTitle("Одобрить 3 хода — без ограничения по времени"));
    expect(onApprovePlayerTurn).toHaveBeenCalledWith("p1", false, 3);
  });

  it("позволяет изменить количество перед одобрением", () => {
    const onApprovePlayerTurn = vi.fn();
    const p = makePlayer({ turnRequested: true, turnsRequested: 1 });
    const { getByTitle, getAllByLabelText } = render(
      <AdminConsole
        {...adminProps}
        gameState={makeState([p])}
        onApprovePlayerTurn={onApprovePlayerTurn}
      />
    );

    fireEvent.click(getAllByLabelText("Больше ходов")[0]);
    fireEvent.click(getAllByLabelText("Больше ходов")[0]);
    fireEvent.click(getByTitle("Одобрить 3 хода — без ограничения по времени"));

    expect(onApprovePlayerTurn).toHaveBeenCalledWith("p1", false, 3);
  });

  it("выдаёт ходы без всякой заявки от игрока", () => {
    // Второй способ из задачи: администратор открывает броски сам.
    const onApprovePlayerTurn = vi.fn();
    const p = makePlayer(); // ход не запрошен
    const { getByTitle, getAllByLabelText } = render(
      <AdminConsole
        {...adminProps}
        gameState={makeState([p])}
        onApprovePlayerTurn={onApprovePlayerTurn}
      />
    );

    fireEvent.click(getAllByLabelText("Больше ходов")[0]);
    fireEvent.click(getByTitle("Выдать 2 хода без запроса"));

    expect(onApprovePlayerTurn).toHaveBeenCalledWith("p1", false, 2);
  });

  it("не даёт опустить количество ниже одного", () => {
    const onApprovePlayerTurn = vi.fn();
    const p = makePlayer();
    const { getByTitle, getAllByLabelText } = render(
      <AdminConsole
        {...adminProps}
        gameState={makeState([p])}
        onApprovePlayerTurn={onApprovePlayerTurn}
      />
    );

    fireEvent.click(getAllByLabelText("Меньше ходов")[0]);
    fireEvent.click(getAllByLabelText("Меньше ходов")[0]);
    fireEvent.click(getByTitle("Выдать 1 ход без запроса"));

    expect(onApprovePlayerTurn).toHaveBeenCalledWith("p1", false, 1);
  });

  it("не срезает пачку, когда админ жмёт «Задать» не глядя", () => {
    /*
     * У игрока четыре невыбранных хода. Шаг-пикер по умолчанию показывал
     * «1», и кнопка «Задать» молча урезала бы остаток до одного броска —
     * ровно та потеря, которую эта задача должна была устранить.
     */
    const onApprovePlayerTurn = vi.fn();
    const p = makePlayer({
      turnApprovedUntil: Date.now() + 12 * 60 * 60 * 1000,
      turnsApproved: 4,
    });
    const { getByText } = render(
      <AdminConsole
        {...adminProps}
        gameState={makeState([p])}
        onApprovePlayerTurn={onApprovePlayerTurn}
      />
    );

    fireEvent.click(getByText("Задать"));
    // Второй аргумент — подтверждение бонуса; у игрока приза нет.
    expect(onApprovePlayerTurn).toHaveBeenCalledWith("p1", false, 4);
  });

  it("показывает остаток пачки в колонке доступа", () => {
    const p = makePlayer({
      turnApprovedUntil: Date.now() + 12 * 60 * 60 * 1000,
      turnsApproved: 4,
    });
    const { container } = render(<AdminConsole {...adminProps} gameState={makeState([p])} />);
    expect(container.textContent).toContain("Одобрено: 4 хода");
  });
});
