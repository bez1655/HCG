// @vitest-environment jsdom
/**
 * Проверка двух новых экранов настоящим монтированием в jsdom.
 *
 * Читать вёрстку глазами недостаточно: «крупный шрифт» и «подложка под
 * текстом» — требования, которые надо измерить, а не подтвердить кивком.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import HelpScreen from "./HelpScreen";
import TurnOutcomeCard, { TurnOutcome } from "./TurnOutcomeCard";
import { Cell } from "../types";
import realCells from "../game/data/cells.json";

const CELLS = realCells as unknown as Cell[];

vi.mock("../utils/sounds", () => ({
  playSound: vi.fn(),
  __esModule: true,
}));

beforeEach(() => cleanup());

describe("HelpScreen", () => {
  it("показывает разделы призов, ускорителей и штрафов", () => {
    render(<HelpScreen cells={CELLS} onClose={() => {}} />);
    expect(screen.getByText("ПРИЗОВЫЕ КЛЕТКИ")).toBeTruthy();
    expect(screen.getByText("УСКОРИТЕЛИ")).toBeTruthy();
    expect(screen.getByText("ШТРАФНЫЕ КЛЕТКИ")).toBeTruthy();
  });

  it("перечисляет настоящие клетки доски", () => {
    render(<HelpScreen cells={CELLS} onClose={() => {}} />);
    expect(screen.getByText("КВАНТОВЫЙ ТЕЛЕПОРТ")).toBeTruthy();
    expect(screen.getByText("КРИТИЧЕСКИЙ КРАШ")).toBeTruthy();
    expect(screen.getByText("КРИПТО-ДЖЕКПОТ")).toBeTruthy();
  });

  /*
   * Требование пользователя: «шрифт должен быть достаточно крупным и
   * комфортным для чтения». Проверяем измеримо — не меньше 15px в теле.
   */
  it("шрифт в карточках не мельче 15px", () => {
    const { container } = render(<HelpScreen cells={CELLS} onClose={() => {}} />);
    const name = screen.getByText("КВАНТОВЫЙ ТЕЛЕПОРТ") as HTMLElement;
    const size = parseFloat(name.style.fontSize);
    expect(size).toBeGreaterThanOrEqual(15);

    const heading = screen.getByText("ПРИЗОВЫЕ КЛЕТКИ") as HTMLElement;
    expect(parseFloat(heading.style.fontSize)).toBeGreaterThanOrEqual(18);
    expect(container).toBeTruthy();
  });

  /*
   * Требование: «добавить тёмную полупрозрачную тень под текст».
   * У каждой карточки должна быть тёмная подложка, иначе текст поплывёт
   * по пёстрому фону города.
   */
  it("под каждой карточкой тёмная полупрозрачная подложка", () => {
    render(<HelpScreen cells={CELLS} onClose={() => {}} />);
    const name = screen.getByText("КРИТИЧЕСКИЙ КРАШ");
    // Ищем ближайшего предка с тёмной подложкой — уровень вложенности
    // вёрстки может меняться, а требование «текст на подложке» — нет.
    let node: HTMLElement | null = name;
    let found = "";
    for (let i = 0; i < 5 && node; i++) {
      if (node.style?.background?.includes("rgba(0, 0, 0")) {
        found = node.style.background;
        break;
      }
      node = node.parentElement;
    }
    expect(found).toContain("rgba(0, 0, 0, 0.62)");
  });

  it("фоновая картинка приглушена и не мешает читать", () => {
    const { container } = render(<HelpScreen cells={CELLS} onClose={() => {}} />);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(parseFloat(img.style.opacity)).toBeLessThanOrEqual(0.6);
  });

  it("показывает сводку по количеству клеток", () => {
    render(<HelpScreen cells={CELLS} onClose={() => {}} />);
    expect(screen.getByText("призов")).toBeTruthy();
    expect(screen.getByText("ловушек")).toBeTruthy();
  });

  it("закрывается кнопкой ПОНЯТНО", () => {
    const onClose = vi.fn();
    render(<HelpScreen cells={CELLS} onClose={onClose} />);
    fireEvent.click(screen.getByText("ПОНЯТНО"));
    expect(onClose).toHaveBeenCalled();
  });

  it("закрывается по Escape", () => {
    const onClose = vi.fn();
    render(<HelpScreen cells={CELLS} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("не падает на пустом списке клеток", () => {
    expect(() => render(<HelpScreen cells={[]} onClose={() => {}} />)).not.toThrow();
  });
});

describe("TurnOutcomeCard", () => {
  const neutral: TurnOutcome = {
    title: "ВЫПАЛО 3",
    body: "Вы прошли 3 клетки: с клетки 1 на 4. Приза нет — клетка обычная.",
    cellName: "Клетка 4",
    cellType: "normal",
    icon: "▫️",
    tone: "neutral",
    footer: "Ходы закончились. Запросите новый у администратора.",
    prize: null,
  };

  it("ничего не рисует, пока результата нет", () => {
    const { container } = render(<TurnOutcomeCard outcome={null} onClose={() => {}} />);
    expect(container.querySelector('[data-testid="turn-outcome"]')).toBeNull();
  });

  /*
   * Тот самый случай, ради которого всё делалось: обычная клетка. Раньше
   * игрок не видел ничего — теперь обязан увидеть выпавшее число.
   */
  it("показывает результат на обычной клетке", () => {
    render(<TurnOutcomeCard outcome={neutral} onClose={() => {}} />);
    expect(screen.getByText("ВЫПАЛО 3")).toBeTruthy();
    expect(screen.getByText(/Приза нет/)).toBeTruthy();
  });

  it("выпавшее число — самый крупный текст карточки", () => {
    render(<TurnOutcomeCard outcome={neutral} onClose={() => {}} />);
    const title = screen.getByText("ВЫПАЛО 3") as HTMLElement;
    expect(parseFloat(title.style.fontSize)).toBeGreaterThanOrEqual(40);
  });

  it("текст результата лежит на тёмной подложке", () => {
    render(<TurnOutcomeCard outcome={neutral} onClose={() => {}} />);
    const body = screen.getByText(/Приза нет/);
    const box = body.parentElement as HTMLElement;
    expect(box.style.background).toContain("rgba(0, 0, 0, 0.55)");
  });

  it("подсказывает остаток бросков", () => {
    render(
      <TurnOutcomeCard
        outcome={{ ...neutral, footer: "Осталось 2 хода — можно бросать снова." }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/Осталось 2/)).toBeTruthy();
  });

  it("показывает приз отдельным блоком", () => {
    render(
      <TurnOutcomeCard
        outcome={{
          ...neutral,
          tone: "good",
          prize: { name: "ЭНЕРГОКРИСТАЛЛ", description: "4600 кредитов" },
        }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/ЭНЕРГОКРИСТАЛЛ/)).toBeTruthy();
    expect(screen.getByText("4600 кредитов")).toBeTruthy();
  });

  it("плохой результат окрашен иначе, чем хороший", () => {
    const { container: bad } = render(
      <TurnOutcomeCard outcome={{ ...neutral, tone: "bad" }} onClose={() => {}} />
    );
    const badCard = bad.querySelector('[data-testid="turn-outcome"] > div') as HTMLElement;
    const badBorder = badCard.style.border;
    cleanup();

    const { container: good } = render(
      <TurnOutcomeCard outcome={{ ...neutral, tone: "good" }} onClose={() => {}} />
    );
    const goodCard = good.querySelector('[data-testid="turn-outcome"] > div') as HTMLElement;
    expect(goodCard.style.border).not.toBe(badBorder);
  });

  it("закрывается кнопкой", () => {
    const onClose = vi.fn();
    render(<TurnOutcomeCard outcome={neutral} onClose={onClose} />);
    fireEvent.click(screen.getByText("ПОНЯТНО"));
    expect(onClose).toHaveBeenCalled();
  });

  it("клик по карточке не закрывает её случайно", () => {
    const onClose = vi.fn();
    render(<TurnOutcomeCard outcome={neutral} onClose={onClose} />);
    fireEvent.click(screen.getByText("ВЫПАЛО 3"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
