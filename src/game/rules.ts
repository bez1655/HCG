/**
 * ============================================================================
 * GAME RULES — pure functions
 * ============================================================================
 *
 * Movement and prize logic used to live inline inside the socket handler in
 * server.ts, tangled with I/O, logging and broadcasting. That made the most
 * valuable part of the game impossible to unit-test.
 *
 * Everything here is deterministic and side-effect free: given a player and a
 * board it returns *what should happen*. The caller applies the result and
 * deals with persistence and notifications.
 */
import { Cell, CellType, Player, ActiveBonus } from "../types";

export const FINAL_CELL = 64;
export const GRAND_PRIZE_VALUE = 13800;

export interface MoveOutcome {
  /** Cell the player ends on after the roll and any cell effect. */
  finalCell: number;
  /** Cell reached by the dice alone, before the cell effect was applied. */
  landedCell: number;
  /** Human-readable description of the triggered effect ("" when none). */
  effectText: string;
  /** The player earned another roll (bonus cells worth "+1 ХОД"). */
  extraRoll: boolean;
  /** Prize awarded on this move, if any. */
  awardedBonus: ActiveBonus | null;
  /** The player reached the final cell. */
  finished: boolean;
  /** The cell the player landed on, when it exists on the board. */
  cell: Cell | undefined;
}

/** Russian pluralisation for "клетка" (1 клетку / 2 клетки / 5 клеток). */
export function pluralizeCells(count: number): string {
  const n = Math.abs(count) % 100;
  if (n >= 11 && n <= 14) return "клеток";
  const last = n % 10;
  if (last === 1) return "клетку";
  if (last >= 2 && last <= 4) return "клетки";
  return "клеток";
}

/**
 * Resolve a dice roll into a final board position and its consequences.
 *
 * @param player Current player state (not mutated).
 * @param steps  Dice value, 1..6.
 * @param cells  The board.
 */
export function resolveMove(
  player: Pick<Player, "cell" | "name">,
  steps: number,
  cells: Cell[]
): MoveOutcome {
  const landedCell = Math.min(FINAL_CELL, player.cell + steps);
  const cell = cells.find((c) => c.id === landedCell);

  let finalCell = landedCell;
  let effectText = "";
  let extraRoll = false;

  if (cell) {
    if (cell.type === CellType.BONUS) {
      if (cell.value > 0) {
        finalCell = Math.min(FINAL_CELL, landedCell + cell.value);
        effectText =
          `Активирован ускоритель! Прыжок вперед на +${cell.value} ` +
          `${pluralizeCells(cell.value)} (с клетки ${landedCell} на клетку ${finalCell}).`;
      } else if (cell.extra && cell.extra.includes("ХОД")) {
        extraRoll = true;
        effectText = "Получен дополнительный ход! Свободный бросок кубика.";
      } else {
        effectText = cell.description;
      }
    } else if (cell.type === CellType.PENALTY || cell.type === CellType.SNAKE) {
      if (cell.value < 0) {
        finalCell = Math.max(0, landedCell + cell.value);
        const absVal = Math.abs(cell.value);
        effectText =
          `Сработал откат системы! Смещение назад на ${absVal} ` +
          `${pluralizeCells(absVal)} (с клетки ${landedCell} на клетку ${finalCell}).`;
      } else {
        effectText = cell.description;
      }
    } else {
      effectText = cell.description;
    }
  }

  const finished = finalCell >= FINAL_CELL;

  let awardedBonus: ActiveBonus | null = null;
  if (finished) {
    awardedBonus = {
      name: "ГЛАВНЫЙ ПРИЗ",
      extra: "ФИНАЛ",
      description: "Главный приз за прохождение полного круга",
      value: GRAND_PRIZE_VALUE,
      cellId: FINAL_CELL,
      receivedAt: Date.now(),
    };
  } else if (cell && (cell.type === CellType.FLASK || cell.type === CellType.BITCOIN)) {
    awardedBonus = {
      name: cell.name,
      extra: cell.extra || "",
      description: cell.description,
      value: cell.value,
      cellId: cell.id,
      receivedAt: Date.now(),
    };
  }

  return { finalCell, landedCell, effectText, extraRoll, awardedBonus, finished, cell };
}

/**
 * Can this player roll right now?
 * Mirrors the prize-control rule: an unredeemed bonus blocks the next roll.
 */
export function canRoll(
  player: Pick<
    Player,
    "role" | "turnApprovedUntil" | "turnsApproved" | "activeBonus" | "skipNextTurn"
  >,
  now: number = Date.now()
): { allowed: boolean; reason?: "not-approved" | "unused-bonus" | "skip-turn" } {
  const isAdmin = player.role === "admin";
  if (isAdmin) return { allowed: true };

  if (turnsLeft(player, now) === 0) return { allowed: false, reason: "not-approved" };
  if (player.activeBonus) return { allowed: false, reason: "unused-bonus" };
  if (player.skipNextTurn) return { allowed: false, reason: "skip-turn" };

  return { allowed: true };
}

/**
 * Unspent rolls in the player's current approval.
 *
 * An approval opens a *batch*: a player who bought several items gets several
 * rolls at once and no longer waits for a separate approval after each one.
 * State written before batches existed carries no counter — there an open
 * window means exactly one roll, as it always did.
 */
export function turnsLeft(
  player: Pick<Player, "turnApprovedUntil" | "turnsApproved">,
  _now: number = Date.now()
): number {
  /*
   * Только счётчик: ограничения по времени в игре больше нет.
   *
   * Оплаченный бросок ждёт игрока сколько угодно — раньше он сгорал через
   * 12 часов, и купивший вечером терял ход к утру.
   *
   * Записи без счётчика (сохранены прошлой версией) читаем как один ход,
   * иначе при обновлении уже одобренный бросок молча пропал бы.
   */
  if (typeof player.turnsApproved === "number") return Math.max(0, player.turnsApproved);
  return player.turnApprovedUntil ? 1 : 0;
}

/** Russian pluralisation for "ход" (1 ход / 2 хода / 5 ходов). */
export function pluralizeTurns(count: number): string {
  const n = Math.abs(count) % 100;
  if (n >= 11 && n <= 14) return "ходов";
  const last = n % 10;
  if (last === 1) return "ход";
  if (last >= 2 && last <= 4) return "хода";
  return "ходов";
}

/** Milestone cells that trigger a celebratory toast. */
export const MILESTONES = [10, 20, 30, 40, 50, 60];

export function isMilestone(cellId: number): boolean {
  return MILESTONES.includes(cellId);
}
