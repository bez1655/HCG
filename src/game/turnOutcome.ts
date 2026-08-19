/**
 * ============================================================================
 * РЕЗУЛЬТАТ ХОДА ДЛЯ ИГРОКА — pure functions
 * ============================================================================
 *
 * Раньше игрок узнавал о своём броске только когда попадал на особую клетку:
 * `event:trigger` отправлялся внутри ветки «есть эффект». Попал на обычную —
 * фишка молча переехала, и всё. Человек, который ждал своей очереди и наконец
 * бросил кубик, оставался без ответа на единственный вопрос: «что мне выпало?»
 *
 * Молчание читается как сбой, а не как «ничего не произошло». Поэтому теперь
 * результат приходит ВСЕГДА — и на экран, и в бот, одинаковый по смыслу.
 *
 * Модуль намеренно без побочных эффектов: собрать текст и проверить его можно
 * без сервера, сокетов и Telegram.
 */
import { ActiveBonus, Cell, CellType } from "../types";
import { pluralizeCells, pluralizeTurns } from "./rules";

/** Что произошло за один бросок — ровно то, что нужно показать игроку. */
export interface TurnOutcomeInput {
  /** Грань кубика, 1..6. */
  steps: number;
  /** Клетка, с которой пошли. */
  fromCell: number;
  /** Клетка, куда привёл кубик, до эффекта. */
  landedCell: number;
  /** Клетка, где встали после эффекта. */
  finalCell: number;
  /** Клетка, на которую привёл кубик. */
  cell?: Cell;
  /** Приз, выданный этим броском. */
  awardedBonus?: ActiveBonus | null;
  /** Приз, который заменили (призы не суммируются). */
  replacedBonus?: ActiveBonus | null;
  /** Клетка дала дополнительный бросок. */
  extraRoll?: boolean;
  /** Игрок дошёл до финиша. */
  finished?: boolean;
  /** Сколько бросков осталось в пачке. */
  turnsRemaining: number;
}

/** Готовый результат: одинаковый смысл для экрана и для бота. */
export interface TurnOutcomeMessage {
  /** Заголовок карточки: «ВЫПАЛО 4». */
  title: string;
  /** Что случилось на клетке, человеческим языком. */
  body: string;
  /** Название клетки, куда встали. */
  cellName: string;
  /** Тип клетки — от него зависит цвет карточки. */
  cellType: CellType;
  /** Значок клетки. */
  icon: string;
  /**
   * Тональность: хорошо / плохо / нейтрально.
   * Определяет цвет рамки и подпись, а не только украшение.
   */
  tone: "good" | "bad" | "neutral";
  /** Приписка про остаток бросков. */
  footer: string;
  /** Приз, если он был выдан этим броском. */
  prize?: { name: string; description: string } | null;
}

/** Значок клетки: тип видно с одного взгляда, без чтения текста. */
export function cellIcon(type?: CellType): string {
  switch (type) {
    case CellType.BITCOIN:
      return "₿";
    case CellType.FLASK:
      return "🧪";
    case CellType.BONUS:
      return "⚡";
    case CellType.PENALTY:
      return "⚠️";
    case CellType.SNAKE:
      return "🐍";
    case CellType.FINISH:
      return "🏁";
    case CellType.START:
      return "🚩";
    default:
      return "▫️";
  }
}

/** Хорошо это для игрока или плохо. */
export function toneFor(type: CellType | undefined, awarded: boolean): "good" | "bad" | "neutral" {
  if (awarded) return "good";
  switch (type) {
    case CellType.BITCOIN:
    case CellType.FLASK:
    case CellType.BONUS:
    case CellType.FINISH:
      return "good";
    case CellType.PENALTY:
    case CellType.SNAKE:
      return "bad";
    default:
      return "neutral";
  }
}

/**
 * Собрать результат хода.
 *
 * Главное правило: пустого body не бывает. Обычная клетка — тоже результат,
 * и о нём надо сказать прямо, а не промолчать.
 */
export function buildTurnOutcome(input: TurnOutcomeInput): TurnOutcomeMessage {
  const {
    steps,
    fromCell,
    landedCell,
    finalCell,
    cell,
    awardedBonus,
    replacedBonus,
    extraRoll,
    finished,
    turnsRemaining,
  } = input;

  const type = cell?.type ?? CellType.NORMAL;
  const tone = toneFor(type, !!awardedBonus);

  // Куда в итоге встали — название берём у клетки назначения, если эффект
  // сдвинул фишку дальше.
  const cellName = cell?.name || `Клетка ${finalCell}`;

  const parts: string[] = [];

  // 1. Само перемещение. Говорим всегда — это и есть «результат хода».
  parts.push(`Вы прошли ${steps} ${pluralizeCells(steps)}: с клетки ${fromCell} на ${landedCell}.`);

  // 2. Эффект клетки, если он сдвинул фишку.
  if (finalCell !== landedCell) {
    const diff = finalCell - landedCell;
    if (diff > 0) {
      parts.push(`Ускоритель отбросил вас вперёд на ${diff} ${pluralizeCells(diff)} — теперь клетка ${finalCell}.`);
    } else {
      const back = Math.abs(diff);
      parts.push(`Откат системы отбросил назад на ${back} ${pluralizeCells(back)} — теперь клетка ${finalCell}.`);
    }
  }

  // 3. Приз или его отсутствие. «Приза нет» — такой же результат.
  if (finished) {
    parts.push("Вы дошли до ЯДРА СИСТЕМЫ и забрали главный приз!");
  } else if (awardedBonus) {
    parts.push(`Награда: ${awardedBonus.extra || awardedBonus.name}.`);
    if (replacedBonus) {
      parts.push("Предыдущий неиспользованный приз заменён — призы не суммируются.");
    }
  } else if (extraRoll) {
    parts.push("Клетка дала дополнительный бросок.");
  } else if (tone === "bad") {
    parts.push("Приза на этой клетке нет.");
  } else {
    parts.push("Приза нет — клетка обычная.");
  }

  // 4. Остаток пачки: игрок должен знать, может ли бросать снова.
  let footer: string;
  if (finished) {
    footer = "Круг пройден.";
  } else if (turnsRemaining > 0) {
    footer = `Осталось ${turnsRemaining} ${pluralizeTurns(turnsRemaining)} — можно бросать снова.`;
  } else {
    footer = "Ходы закончились. Запросите новый у администратора.";
  }

  return {
    title: `ВЫПАЛО ${steps}`,
    body: parts.join(" "),
    cellName,
    cellType: type,
    icon: cellIcon(type),
    tone,
    footer,
    prize: awardedBonus
      ? {
          name: awardedBonus.extra || awardedBonus.name,
          description: awardedBonus.description || "",
        }
      : null,
  };
}

/**
 * Тот же результат в виде сообщения Telegram.
 *
 * Дублирование намеренное: игрок мог закрыть окно приложения сразу после
 * броска, и тогда сообщение в боте — единственный след того, что произошло.
 */
export function formatTurnOutcomeForTelegram(m: TurnOutcomeMessage): string {
  const head =
    m.tone === "good" ? "🎲 <b>РЕЗУЛЬТАТ ХОДА</b>" : m.tone === "bad" ? "🎲 <b>РЕЗУЛЬТАТ ХОДА</b>" : "🎲 <b>РЕЗУЛЬТАТ ХОДА</b>";

  const lines = [
    head,
    "",
    `Кубик: <b>${m.title.replace("ВЫПАЛО ", "")}</b>`,
    `Клетка: ${m.icon} <b>${escapeTg(m.cellName)}</b>`,
    "",
    escapeTg(m.body),
  ];

  if (m.prize) {
    lines.push("", `🎁 <b>${escapeTg(m.prize.name)}</b>`);
    if (m.prize.description) lines.push(`<i>${escapeTg(m.prize.description)}</i>`);
  }

  lines.push("", `<i>${escapeTg(m.footer)}</i>`);
  return lines.join("\n");
}

/** Экранирование для parse_mode=HTML. */
function escapeTg(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
