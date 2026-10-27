/**
 * ============================================================================
 * ОТЧЁТ О БРОСКАХ ДЛЯ АДМИНИСТРАТОРА — pure functions
 * ============================================================================
 *
 * Администратор выдаёт призы руками, поэтому обязан знать про каждый бросок:
 * кто бросал, что выпало, откуда куда пошла фишка и — главное — достался ли
 * приз. «Приза нет» здесь такой же результат, как и приз: молчание админ
 * читает как «сообщение потерялось», а не как «пусто».
 *
 * Одобрение хода теперь открывает ПАЧКУ бросков, и отдельное сообщение на
 * каждый превращало бы серию из десяти в десять уведомлений подряд. Поэтому
 * броски внутри пачки копятся и уходят одним письмом после последнего.
 *
 * Модуль намеренно без побочных эффектов: собрать текст и проверить его
 * можно без сервера, сети и Telegram.
 */
import { ActiveBonus, Cell, CellType } from "../types";
import { pluralizeCells, pluralizeTurns } from "./rules";

/** Один бросок в том виде, в каком он нужен отчёту. */
export interface RollRecord {
  /** Грань кубика, 1..6. */
  steps: number;
  /** Клетка, с которой игрок пошёл. */
  fromCell: number;
  /** Клетка, куда привёл сам кубик, до эффекта клетки. */
  landedCell: number;
  /** Клетка, где игрок остановился после эффекта. */
  finalCell: number;
  /** Клетка, на которую привёл кубик (для названия и типа). */
  cell?: Cell;
  /**
   * Клетка, где фишка встала после эффекта.
   *
   * Совпадает с cell, когда эффекта не было. Нужна, чтобы поймать случай
   * «стоит на призовой клетке, а приза нет».
   */
  destinationCell?: Cell;
  /** Приз, выданный этим броском, если был. */
  awardedBonus?: ActiveBonus | null;
  /** Приз, который заменили этим (призы не суммируются). */
  replacedBonus?: ActiveBonus | null;
  /** Клетка дала право на дополнительный бросок. */
  extraRoll?: boolean;
  /** Игрок дошёл до финиша. */
  finished?: boolean;
}

export interface RollReportInput {
  playerName: string;
  /** Броски в порядке совершения. */
  rolls: RollRecord[];
  /** Сколько бросков осталось в пачке после последнего. */
  turnsRemaining: number;
  /** Сколько бросков было одобрено, когда пачка открывалась. */
  turnsApproved?: number;
}

/** Значок клетки: тип видно с одного взгляда, без чтения текста. */
function cellIcon(cell?: Cell): string {
  switch (cell?.type) {
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

/** Клетка, стоя на которой игрок мог бы ожидать приз. */
function isPrizeCell(cell?: Cell): boolean {
  return cell?.type === CellType.FLASK || cell?.type === CellType.BITCOIN;
}

/** Человеческое имя приза: у клеток приз описан в extra, а не в name. */
export function prizeLabel(bonus: ActiveBonus): string {
  const extra = (bonus.extra || "").trim();
  const name = (bonus.name || "").trim();
  if (extra && name && extra !== name) return `${name} (${extra})`;
  return extra || name || "БЕЗ НАЗВАНИЯ";
}

/**
 * Что случилось на клетке, одной строкой.
 *
 * Берём не effectText из правил: он написан для игрока («Активирован
 * ускоритель!»), а админу нужны числа — на сколько и куда сдвинуло.
 */
function movementNote(r: RollRecord): string {
  if (r.finalCell === r.landedCell) return "";

  const delta = r.finalCell - r.landedCell;
  const abs = Math.abs(delta);
  const direction = delta > 0 ? "вперёд" : "назад";
  return ` → ${direction} на ${abs} ${pluralizeCells(abs)} (клетка ${r.landedCell} ➔ ${r.finalCell})`;
}

/** Одна строка отчёта про один бросок. */
function rollLine(r: RollRecord, index: number, total: number): string {
  const number = total > 1 ? `<b>${index + 1}.</b> ` : "";
  const cellName = r.cell?.name ? ` — ${escape(r.cell.name)}` : "";

  const head =
    `${number}🎲 <b>${r.steps}</b>: клетка ${r.fromCell} ➔ ` +
    `<b>${r.finalCell}</b> ${cellIcon(r.cell)}${cellName}`;

  const parts = [head + escape(movementNote(r))];

  if (r.awardedBonus) {
    parts.push(`   🎁 <b>ПРИЗ: ${escape(prizeLabel(r.awardedBonus))}</b>`);
    if (r.replacedBonus) {
      parts.push(
        `   ⚠️ заменил неиспользованный «${escape(prizeLabel(r.replacedBonus))}» ` +
          `— призы не суммируются`
      );
    }
  }

  if (r.extraRoll) parts.push("   ⚡ дополнительный бросок сверх пачки");
  if (r.finished) parts.push("   🏁 круг пройден");

  /*
   * Фишка стоит на призовой клетке, но приза нет.
   *
   * Приз даёт клетка, на которую привёл КУБИК, а не та, куда потом отбросил
   * эффект. Молча это выглядит как ошибка отчёта: админ видит фишку на
   * «ЭНЕРГОКРИСТАЛЛЕ» и приписку «призов нет» — и может выдать приз зря.
   * Замечено на живом прогоне: телепорт с клетки 7 закинул игрока на 10.
   */
  if (!r.awardedBonus && r.finalCell !== r.landedCell && isPrizeCell(r.destinationCell)) {
    parts.push(
      `   ℹ️ фишка стоит на «${escape(r.destinationCell?.name ?? "")}», ` +
        `но приз не начислен: его даёт клетка, на которую привёл кубик`
    );
  }

  return parts.join("\n");
}

/** Мини-версия escapeHtml: модуль не должен тянуть за собой утилиты сервера. */
function escape(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Собрать сообщение администратору по завершённой пачке бросков.
 *
 * Возвращает готовый HTML для Telegram. Пустой список бросков даёт пустую
 * строку — вызывающему коду нечего отправлять.
 */
export function formatRollReport(input: RollReportInput): string {
  const { playerName, rolls, turnsRemaining } = input;
  if (rolls.length === 0) return "";

  const many = rolls.length > 1;
  const startCell = rolls[0].fromCell;
  const endCell = rolls[rolls.length - 1].finalCell;
  const prizes = rolls.map((r) => r.awardedBonus).filter((b): b is ActiveBonus => !!b);

  const title = many
    ? `🎲 <b>СЕРИЯ ХОДОВ: ${escape(playerName)}</b>`
    : `🎲 <b>ХОД: ${escape(playerName)}</b>`;

  const lines = [title, ""];

  if (many) {
    lines.push(`Бросков: <b>${rolls.length}</b> · путь: ${startCell} ➔ <b>${endCell}</b>`, "");
  }

  lines.push(...rolls.map((r, i) => rollLine(r, i, rolls.length)));
  lines.push("");

  /*
   * Итог по призам — то, ради чего отчёт и существует.
   *
   * Отсутствие приза печатается словами. Пустое место админ не отличит от
   * недоставленного сообщения, а решение «выдавать или нет» принимается
   * именно здесь.
   */
  if (prizes.length === 0) {
    lines.push("✅ <b>Призов нет</b> — выдавать нечего.");
  } else if (prizes.length === 1) {
    lines.push(`🎁 <b>К ВЫДАЧЕ: ${escape(prizeLabel(prizes[0]))}</b>`);
  } else {
    /*
     * Несколько призов за пачку — не значит «выдать все».
     *
     * Активным остаётся только последний: правило игры гласит, что призы не
     * суммируются, и каждый новый заменяет предыдущий. Админ должен видеть
     * и то, что выпадало, и то, что реально причитается.
     */
    const held = prizes[prizes.length - 1];
    lines.push(`🎁 <b>К ВЫДАЧЕ: ${escape(prizeLabel(held))}</b>`);
    lines.push(
      `   <i>за серию выпало ${prizes.length}, но призы не суммируются — ` +
        `остаётся последний</i>`
    );
  }

  lines.push(
    turnsRemaining > 0
      ? `⏳ Осталось ${turnsRemaining} ${pluralizeTurns(turnsRemaining)} без нового одобрения.`
      : "🔒 Ходы закончились — нужно новое одобрение."
  );

  return lines.join("\n");
}
