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
import { Cell, CellType, Player, ActiveBonus, DropBoxOption } from "../types";

export const FINAL_CELL = 64;
export const GRAND_PRIZE_VALUE = 13800;

/** Клетки, на которых активируется выбор из 3 кейсов Кибер-дропа */
export const DROP_BOX_CELL_IDS = [12, 28, 42, 53];

export function isDropBoxCell(cellId: number): boolean {
  return DROP_BOX_CELL_IDS.includes(cellId);
}

export interface MoveOutcome {
  /** Cell the player ends on after the roll and any cell effect. */
  finalCell: number;
  /** Cell reached by the dice alone, before the cell effect was applied. */
  landedCell: number;
  /** Human-readable description of the triggered effect ("" when none). */
  effectText: string;
  /** The player earned another roll (bonus cells worth "+1 ХОД" or fever mode). */
  extraRoll: boolean;
  /** Prize awarded on this move, if any. */
  awardedBonus: ActiveBonus | null;
  /** The player reached the final cell. */
  finished: boolean;
  /** The cell the player landed on, when it exists on the board. */
  cell: Cell | undefined;
  /** Whether a shield absorbed a penalty */
  shieldBlocked?: boolean;
  /** Whether the landed cell offers a drop box choice */
  isDropBox?: boolean;
  /** Whether neon magnet pulled the token to a prize cell */
  magnetPulled?: boolean;
  /** Whether fever mode bonus was applied on this move */
  feverReward?: boolean;
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
  cells: Cell[],
  options?: { shieldActive?: boolean; magnetActive?: boolean; feverActive?: boolean }
): MoveOutcome {
  const landedCell = Math.min(FINAL_CELL, player.cell + steps);
  let cell = cells.find((c) => c.id === landedCell);

  let finalCell = landedCell;
  let effectText = "";
  let extraRoll = false;
  let shieldBlocked = false;
  let magnetPulled = false;
  let feverReward = false;

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
      if (options?.shieldActive) {
        shieldBlocked = true;
        finalCell = landedCell;
        effectText = `🛡️ Сработал Файрвол-щит! Поглощён откат системы на клетке ${landedCell}. Фишка осталась на месте!`;
      } else if (cell.value < 0) {
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

  // 🧲 Неоновый магнит: если фишка остановилась всего в 1 шаге от призовой колбы или биткоина,
  // магнит автоматически дотягивает фишку на призовую клетку!
  if (options?.magnetActive && finalCell < FINAL_CELL) {
    const isPrize = (c?: Cell) => c && (c.type === CellType.FLASK || c.type === CellType.BITCOIN);
    if (!isPrize(cell)) {
      const prizeAhead = cells.find((c) => c.id === finalCell + 1 && isPrize(c));
      const prizeBehind = !prizeAhead ? cells.find((c) => c.id === finalCell - 1 && isPrize(c)) : null;
      const targetPrize = prizeAhead || prizeBehind;
      if (targetPrize) {
        finalCell = targetPrize.id;
        cell = targetPrize;
        magnetPulled = true;
        effectText = `🧲 Сработал «Неоновый магнит»! Фишка притянута на 1 шаг к призовой клетке ${targetPrize.id} («${targetPrize.name || "Приз"}»)!`;
      }
    }
  }

  const finished = finalCell >= FINAL_CELL;
  const isDropBox = isDropBoxCell(finalCell);

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

  // 🔥 Fever Mode (Кибер-серия): бесплатный экстра-бросок и удвоенная награда
  if (options?.feverActive) {
    extraRoll = true;
    feverReward = true;
    if (awardedBonus) {
      if (typeof awardedBonus.value === "number") {
        awardedBonus.value *= 2;
      }
      awardedBonus.description =
        (awardedBonus.description ? awardedBonus.description + " • " : "") +
        "🔥 УДВОЕНО В РЕЖИМЕ FEVER!";
    }
    effectText =
      (effectText ? effectText + " " : "") +
      "🔥 Включён FEVER MODE: начислен бесплатный экстра-бросок!";
  }

  return {
    finalCell,
    landedCell,
    effectText,
    extraRoll,
    awardedBonus,
    finished,
    cell,
    shieldBlocked,
    isDropBox,
    magnetPulled,
    feverReward,
  };
}

/**
 * Generate 3 diverse cyber-box choices for a drop box cell.
 */
export function generateDropBoxOptions(): DropBoxOption[] {
  // Option 1: Forward booster (+2 or +3)
  const jumpSteps = Math.random() < 0.5 ? 2 : 3;
  const opt1: DropBoxOption = {
    title: `Ускоритель +${jumpSteps}`,
    description: `Рывок вперёд на +${jumpSteps} ${pluralizeCells(jumpSteps)}!`,
    type: "jump",
    value: jumpSteps,
  };

  // Option 2: Store Discount Voucher
  const discount = Math.random() < 0.5 ? 10 : 15;
  const opt2: DropBoxOption = {
    title: `Скидка ${discount}% в Hapstore`,
    description: `Купон на скидку ${discount}% при покупке в магазине!`,
    type: "promo",
    promoCode: `HAP-${discount}-${Math.floor(1000 + Math.random() * 9000)}`,
  };

  // Option 3: Consumable Item or small glitch
  const rollThird = Math.random();
  let opt3: DropBoxOption;
  if (rollThird < 0.35) {
    opt3 = {
      title: "Щит «Файрвол»",
      description: "Защитный девайс добавлен в ваш инвентарь!",
      type: "item",
      item: "shield",
    };
  } else if (rollThird < 0.65) {
    opt3 = {
      title: "Заряженный кубик",
      description: "Чип гарантированного броска (5 или 6) добавлен в инвентарь!",
      type: "item",
      item: "loaded_dice",
    };
  } else if (rollThird < 0.88) {
    opt3 = {
      title: "Неоновый магнит",
      description: "Девайс притяжения к призовым клеткам добавлен в инвентарь!",
      type: "item",
      item: "magnet",
    };
  } else {
    opt3 = {
      title: "Глитч-вирус",
      description: "Небольшой сбой системы: откат назад на -1 клетку.",
      type: "penalty",
      value: -1,
    };
  }

  const options = [opt1, opt2, opt3];
  // Fisher-Yates shuffle
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return options;
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
