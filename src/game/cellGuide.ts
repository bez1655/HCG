/**
 * ============================================================================
 * СПРАВКА ПО КЛЕТКАМ — pure functions
 * ============================================================================
 *
 * Группирует клетки доски в разделы для экрана справки.
 *
 * Данные берутся из cells.json, а не переписываются руками. Так справка не
 * может разойтись с игрой: если админ поменяет значение клетки, справка
 * покажет новое. Отдельный список пришлось бы править дважды, и второй раз
 * про него бы забыли — классический источник вранья в интерфейсе.
 */
import { Cell, CellType } from "../types";

export interface GuideEntry {
  /** Номера клеток этого вида, по возрастанию. */
  cells: number[];
  /** Название, как на доске. */
  name: string;
  /** Что делает, человеческим языком. */
  effect: string;
  /** Значок. */
  icon: string;
}

export interface GuideSection {
  key: "prize" | "move" | "penalty" | "special";
  title: string;
  /** Цвет раздела — из палитры игры. */
  color: string;
  entries: GuideEntry[];
}

/** Склонение слова «клетка». */
function cellsWord(n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return "клеток";
  if (b === 1) return "клетку";
  if (b >= 2 && b <= 4) return "клетки";
  return "клеток";
}

/**
 * Человеческое описание эффекта клетки.
 *
 * Формулировки короткие намеренно: справку читают между ходами, а не изучают.
 */
export function describeEffect(cell: Cell): string {
  switch (cell.type) {
    case CellType.BITCOIN:
      return `Награда: ${cell.value} кредитов`;
    case CellType.FLASK:
      return cell.value ? `Энергокристалл: ${cell.value} кредитов` : "Энергокристалл";
    case CellType.BONUS:
      if (cell.value > 0) return `Прыжок вперёд на ${cell.value} ${cellsWord(cell.value)}`;
      return "Дополнительный бросок кубика";
    case CellType.PENALTY: {
      const back = Math.abs(cell.value);
      return `Откат назад на ${back} ${cellsWord(back)}`;
    }
    case CellType.SNAKE: {
      const back = Math.abs(cell.value);
      return `Крупный откат назад на ${back} ${cellsWord(back)}`;
    }
    case CellType.FINISH:
      return "Главный приз — МЕГА-КРИСТАЛЛ";
    case CellType.START:
      return "Начало пути";
    default:
      return "Обычная клетка, ничего не происходит";
  }
}

const ICONS: Partial<Record<CellType, string>> = {
  [CellType.BITCOIN]: "₿",
  [CellType.FLASK]: "🧪",
  [CellType.BONUS]: "⚡",
  [CellType.PENALTY]: "⚠️",
  [CellType.SNAKE]: "🐍",
  [CellType.FINISH]: "🏁",
  [CellType.START]: "🚩",
};

/**
 * Объединить одинаковые клетки в одну строку.
 *
 * На доске шесть криптобонусов с разными суммами и четыре одинаковых отката.
 * Показывать десять строк там, где смыслов четыре, — значит утопить читателя
 * в повторах. Ключ группировки — название плюс эффект.
 */
function groupCells(cells: Cell[]): GuideEntry[] {
  const map = new Map<string, GuideEntry>();
  for (const cell of cells) {
    const effect = describeEffect(cell);
    const key = `${cell.name}|${effect}`;
    const existing = map.get(key);
    if (existing) {
      existing.cells.push(cell.id);
    } else {
      map.set(key, {
        cells: [cell.id],
        name: cell.name,
        effect,
        icon: ICONS[cell.type] || "▫️",
      });
    }
  }
  const out = [...map.values()];
  for (const e of out) e.cells.sort((a, b) => a - b);
  // По номеру первой клетки: порядок справки совпадает с порядком на доске.
  out.sort((a, b) => a.cells[0] - b.cells[0]);
  return out;
}

/** Разделы справки в порядке показа. */
export function buildGuide(cells: Cell[]): GuideSection[] {
  const by = (types: CellType[]) => cells.filter((c) => types.includes(c.type));

  const sections: GuideSection[] = [
    {
      key: "prize",
      title: "ПРИЗОВЫЕ КЛЕТКИ",
      color: "#F5C542",
      entries: groupCells(by([CellType.BITCOIN, CellType.FLASK])),
    },
    {
      key: "move",
      title: "УСКОРИТЕЛИ",
      color: "#00FFAA",
      entries: groupCells(by([CellType.BONUS])),
    },
    {
      key: "penalty",
      title: "ШТРАФНЫЕ КЛЕТКИ",
      color: "#FF6B9D",
      entries: groupCells(by([CellType.PENALTY, CellType.SNAKE])),
    },
    {
      key: "special",
      title: "СТАРТ И ФИНИШ",
      color: "#C77DFF",
      entries: groupCells(by([CellType.START, CellType.FINISH])),
    },
  ];

  return sections.filter((s) => s.entries.length > 0);
}

/** Короткая сводка: сколько каких клеток на доске. */
export function guideSummary(cells: Cell[]): { prizes: number; boosts: number; traps: number; total: number } {
  return {
    prizes: cells.filter((c) => c.type === CellType.BITCOIN || c.type === CellType.FLASK).length,
    boosts: cells.filter((c) => c.type === CellType.BONUS).length,
    traps: cells.filter((c) => c.type === CellType.PENALTY || c.type === CellType.SNAKE).length,
    total: cells.length,
  };
}
