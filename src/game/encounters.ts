/**
 * Tabletop events on the 64-cell walker.
 *
 * Board finish stays cell 64 (shop prize). Quarter bosses are 16/32/48/63.
 * Loyalty credits never buy turns or inventory items.
 */

import type {
  Player,
  CharacterClass,
  CharacterStats,
  LoyaltyRank,
  EncounterType,
  BossEncounter,
  QuestEncounter,
  MerchantEncounter,
  RpgEncounterSession,
} from "../types";
import { d20, type DiceFn } from "./rpgRng";
import { syncPurchaseLoyalty } from "./loyalty";
import { DROP_BOX_CELL_IDS } from "./rules";

export const BOSS_CELL_IDS = [16, 32, 48, 63] as const;
export const QUEST_CELL_IDS = [6, 20, 36, 50] as const;
export const MERCHANT_CELL_IDS = [10, 26, 44, 58] as const;
export const FINAL_CELL = 64;

export const CLASS_LABEL: Record<CharacterClass, string> = {
  picker: "Хром-джек",
  courier: "Гоуст-раннер",
  clerk: "Фиксер",
  analyst: "Нетраннер",
};

export { RANK_LABEL } from "./loyalty";

const CLASS_STATS: Record<CharacterClass, CharacterStats> = {
  picker: { str: 3, int: 1, lck: 2 },
  courier: { str: 2, int: 1, lck: 3 },
  clerk: { str: 1, int: 2, lck: 3 },
  analyst: { str: 1, int: 3, lck: 2 },
};

const CLASSES: CharacterClass[] = ["picker", "courier", "clerk", "analyst"];

export function isBossCell(cellId: number): boolean {
  return (BOSS_CELL_IDS as readonly number[]).includes(cellId);
}
export function isQuestCell(cellId: number): boolean {
  return (QUEST_CELL_IDS as readonly number[]).includes(cellId);
}
export function isMerchantCell(cellId: number): boolean {
  return (MERCHANT_CELL_IDS as readonly number[]).includes(cellId);
}

export function getEncounterType(cellId: number): EncounterType | null {
  if (cellId === FINAL_CELL) return null;
  if (isBossCell(cellId)) return "boss";
  if (isQuestCell(cellId)) return "quest";
  if (isMerchantCell(cellId)) return "merchant";
  return null;
}

export function loyaltyRankFrom(credits: number, laps: number): LoyaltyRank {
  void credits;
  void laps;
  return "intern";
}

function classFromId(id: string): CharacterClass {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n + id.charCodeAt(i)) % CLASSES.length;
  return CLASSES[n];
}

export function ensurePlayerRpg(player: Player): void {
  if (!player.characterClass) player.characterClass = classFromId(player.id || player.name || "p");
  if (!player.characterStats) player.characterStats = { ...CLASS_STATS[player.characterClass] };
  if (typeof player.characterLevel !== "number") player.characterLevel = 1;
  if (typeof player.characterExp !== "number") player.characterExp = 0;
  if (typeof player.loyaltyCredits !== "number") player.loyaltyCredits = 0;
  if (typeof player.purchaseCount !== "number") player.purchaseCount = 0;
  syncPurchaseLoyalty(player);
}

export function addExp(player: Player, exp: number, credits: number): void {
  ensurePlayerRpg(player);
  player.characterExp = (player.characterExp || 0) + Math.max(0, exp);
  player.loyaltyCredits = (player.loyaltyCredits || 0) + Math.max(0, credits);
  while ((player.characterExp || 0) >= player.characterLevel! * 200) {
    player.characterExp! -= player.characterLevel! * 200;
    player.characterLevel! += 1;
    player.characterStats = {
      str: player.characterStats!.str + 1,
      int: player.characterStats!.int + 1,
      lck: player.characterStats!.lck + 1,
    };
  }
  syncPurchaseLoyalty(player);
}

export function createBossEncounter(cellId: number, level: number): BossEncounter {
  const lvl = Math.max(1, level);
  const dc = 10 + lvl;
  switch (cellId) {
    case 16:
      return {
        id: "boss_16",
        name: "ICE-дрон периметра",
        district: "Квартал 1 — Неоновые трущобы",
        description: "Хромированный страж ворот. Ломается силой: вырвать кабель из патрона.",
        weakness: "str",
        dc,
        rewardExp: 80,
        rewardCredits: 40,
      };
    case 32:
      return {
        id: "boss_32",
        name: "Турель корпорации",
        district: "Квартал 2 — Стеклянный хаб",
        description: "Автоогонь по тепловому следу. Слабое место — интеллект: глушилка в прошивку.",
        weakness: "int",
        dc: dc + 1,
        rewardExp: 110,
        rewardCredits: 60,
      };
    case 48:
      return {
        id: "boss_48",
        name: "Тень переулка",
        district: "Квартал 3 — Нижний ярус",
        description: "Слишком быстро для камер. Слабое место — удача: один шаг не туда.",
        weakness: "lck",
        dc: dc + 1,
        rewardExp: 140,
        rewardCredits: 80,
      };
    default:
      return {
        id: "boss_63",
        name: "Страж Ядра",
        district: "Квартал 4 — Шпиль",
        description: "Последний файрвол перед клеткой 64. Главный приз — сразу за ним.",
        weakness: "int",
        dc: dc + 2,
        rewardExp: 180,
        rewardCredits: 100,
      };
  }
}

export function createQuestEncounter(cellId: number): QuestEncounter {
  const common = (id: string, title: string, description: string): QuestEncounter => ({
    id,
    title,
    description,
    choices: [
      {
        id: "careful",
        text: "Взломать узел (интеллект)",
        stat: "int",
        dc: 11,
        successText: "Протокол пал. В логах тебя нет. Опыт капает в имплант.",
        failText: "Айс царапнул сознание. Живой, но уровень не вырос.",
        successExp: 40,
        successCredits: 15,
      },
      {
        id: "bold",
        text: "Рвануть напролом (удача)",
        stat: "lck",
        dc: 12,
        successText: "Камеры моргнули. Ты уже на другой стороне улицы.",
        failText: "Неон вспыхнул. Пришлось залечь. Бой будет в другой раз.",
        successExp: 50,
        successCredits: 10,
      },
    ],
  });
  if (cellId === 20) {
    return common("quest_20", "Чёрный канал", "В переулке открылся джек. Кто первый — тот качает героя.");
  }
  if (cellId === 36) {
    return common("quest_36", "Код шпиля", "Лифт корпорации просит жест. Один верный — и опыт твой.");
  }
  if (cellId === 50) {
    return common("quest_50", "Ночной рейд", "Крыша. Дождь. Нужен пароль сектора.");
  }
  return common("quest_6", "Первый джек-ин", "Город впускает только тех, кто уже купил ход. Дальше — прокачка.");
}

function nextAhead(from: number, ids: readonly number[]): number | null {
  const sorted = [...ids].filter((id) => id !== 64).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted.find((id) => id > from) ?? sorted[0];
}

function cellsUntil(from: number, target: number): number {
  if (target > from) return target - from;
  return 64 - from + target;
}

export function merchantIntel(fromCell: number): string {
  const boss = nextAhead(fromCell, BOSS_CELL_IDS);
  const quest = nextAhead(fromCell, QUEST_CELL_IDS);
  const drop = nextAhead(fromCell, DROP_BOX_CELL_IDS);
  const parts: string[] = [];
  if (boss != null) {
    parts.push(`босс квартала — клетка ${boss} (через ${cellsUntil(fromCell, boss)})`);
  }
  if (drop != null) {
    parts.push(`дроп-кейс — клетка ${drop} (через ${cellsUntil(fromCell, drop)})`);
  }
  if (quest != null) {
    parts.push(`контракт — клетка ${quest} (через ${cellsUntil(fromCell, quest)})`);
  }
  parts.push("ядро и главный приз — клетка 64");
  return "Фиксер шепчет в комлинк: " + parts.join("; ") + ".";
}

export function createMerchantEncounter(cellId: number, player?: Player): MerchantEncounter {
  const choices: MerchantEncounter["choices"] = [
    { id: "intel", text: "Карта сектора: босс, дроп, контракт" },
    {
      id: "stamp",
      text: player?.pendingCheckBonus
        ? "Хром-печать уже горит"
        : "Хром-печать: +1 к следующей проверке",
    },
  ];
  if (player?.skipNextTurn) {
    choices.push({ id: "pardon", text: "Сбить ICE с фишки (штраф хода)" });
  }
  choices.push({ id: "leave", text: "Слиться в толпу" });
  return {
    id: `merchant_${cellId}`,
    name: "Фиксер переулка",
    welcomeText:
      "Нужна карта квартала, печать на бой или снять зависание с фишки. Качай героя — город слушает сильных.",
    choices,
  };
}

export function beginEncounter(player: Player, cellId: number): RpgEncounterSession | null {
  ensurePlayerRpg(player);
  const type = getEncounterType(cellId);
  if (!type) return null;
  if (player.pendingDropBox) return null;
  const session: RpgEncounterSession = { cellId, type };
  if (type === "boss") session.boss = createBossEncounter(cellId, player.characterLevel || 1);
  if (type === "quest") session.quest = createQuestEncounter(cellId);
  if (type === "merchant") session.merchant = createMerchantEncounter(cellId, player);
  return session;
}

export function resolveEncounterChoice(
  player: Player,
  choiceId: string,
  roll: DiceFn
): RpgEncounterSession {
  ensurePlayerRpg(player);
  const session = player.pendingEncounter;
  if (!session || session.resolved) {
    return session || { cellId: player.cell, type: "merchant", resolved: true, resultMessage: "Нет события." };
  }

  if (session.type === "merchant") {
    const id = choiceId || "leave";
    if (id === "intel") {
      session.resultMessage = merchantIntel(player.cell);
    } else if (id === "stamp") {
      if (player.pendingCheckBonus) {
        session.resultMessage = "Печать уже горит. Береги её до контракта или босса.";
      } else {
        player.pendingCheckBonus = 1;
        session.resultMessage = "Хром-печать на импланте. Следующий D20 получит +1. Качай удар.";
      }
    } else if (id === "pardon") {
      if (player.skipNextTurn) {
        player.skipNextTurn = false;
        session.resultMessage = "ICE сбит. Следующий бросок снова твой.";
      } else {
        session.resultMessage = "Фишка чистая. Фиксер кивает и растворяется в неоне.";
      }
    } else {
      session.resultMessage = "Фиксер тает в дожде. Город ждёт твой следующий уровень.";
    }
    session.resolved = true;
    return session;
  }

  const dice = d20(roll);
  session.lastRoll = dice;
  const stats = player.characterStats!;
  const stamp = player.pendingCheckBonus ? 1 : 0;
  if (stamp) player.pendingCheckBonus = 0;

  if (session.type === "boss" && session.boss) {
    const bonus = stats[session.boss.weakness] + stamp;
    const total = dice + bonus;
    const ok = total >= session.boss.dc;
    if (ok) {
      addExp(player, session.boss.rewardExp, session.boss.rewardCredits);
      session.resultMessage = `D20=${dice} + ${session.boss.weakness.toUpperCase()} ${bonus} = ${total} vs ${session.boss.dc}. ${session.boss.name} пал. +${session.boss.rewardExp} XP — герой растёт.`;
    } else {
      session.resultMessage = `D20=${dice} + ${bonus} = ${total} < ${session.boss.dc}. Босс стоит. Качай статы — в следующий заход будет легче.`;
    }
    session.resolved = true;
    return session;
  }

  if (session.type === "quest" && session.quest) {
    const choice = session.quest.choices.find((c) => c.id === choiceId) || session.quest.choices[0];
    const bonus = stats[choice.stat] + stamp;
    const total = dice + bonus;
    const ok = total >= choice.dc;
    if (ok) {
      addExp(player, choice.successExp, choice.successCredits);
      session.resultMessage = `${choice.successText} (D20=${dice}+${bonus}=${total}). +${choice.successExp} опыта.`;
    } else {
      session.resultMessage = `${choice.failText} (D20=${dice}+${bonus}=${total}).`;
    }
    session.resolved = true;
    return session;
  }

  session.resolved = true;
  session.resultMessage = "Событие закрыто.";
  return session;
}
