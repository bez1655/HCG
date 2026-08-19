import { GameState, Player } from "../types";

export interface Achievement {
  id: string;
  name: string;
  icon: string;
  description: string;
  badgeStyle: string;
  avatarOverlayStyle?: string;
  priority: number;
}

export function getPlayerAchievements(player: Player, gameState: GameState): Achievement[] {
  const achievements: Achievement[] = [];

  if (!gameState || !gameState.players) return achievements;

  const maxCell =
    gameState.cells && gameState.cells.length > 0
      ? Math.max(...gameState.cells.map((c) => c.id))
      : 60;

  // Active playing players sorted by cell position (highest to lowest)
  const sortedPlayers = [...gameState.players]
    .filter((p) => p.role === "player")
    .sort((a, b) => b.cell - a.cell);

  const playerRankIndex = sortedPlayers.findIndex((p) => p.id === player.id);

  // 1. Top Ranks (Leader crown)
  if (playerRankIndex === 0 && player.cell > 0) {
    achievements.push({
      id: "top_rank",
      name: "Top Ranks",
      icon: "👑",
      description: "1-е место в текущем забеге!",
      badgeStyle:
        "bg-yellow-500/25 text-yellow-300 border-yellow-400/80 shadow-[0_0_12px_rgba(234,179,8,0.5)]",
      avatarOverlayStyle: "border-yellow-400 text-yellow-300 bg-yellow-950/80",
      priority: 1,
    });
  } else if (playerRankIndex === 1 && player.cell > 0) {
    achievements.push({
      id: "runner_up",
      name: "Претендент",
      icon: "🥈",
      description: "2-е место в забеге",
      badgeStyle:
        "bg-slate-400/25 text-slate-200 border-slate-300/80 shadow-[0_0_8px_rgba(203,213,225,0.4)]",
      avatarOverlayStyle: "border-slate-300 text-slate-200 bg-slate-900/80",
      priority: 2,
    });
  } else if (playerRankIndex === 2 && player.cell > 0) {
    achievements.push({
      id: "bronze_rank",
      name: "В Тройке",
      icon: "🥉",
      description: "3-е место в забеге",
      badgeStyle:
        "bg-amber-700/25 text-amber-300 border-amber-500/80 shadow-[0_0_8px_rgba(217,119,6,0.4)]",
      avatarOverlayStyle: "border-amber-500 text-amber-300 bg-amber-950/80",
      priority: 3,
    });
  }

  // 2. Legend / Finisher
  if (player.cell >= maxCell) {
    achievements.push({
      id: "legend",
      name: "Легенда",
      icon: "🏆",
      description: "Достиг финальной клетки!",
      badgeStyle:
        "bg-gradient-to-r from-yellow-500/30 via-amber-400/30 to-yellow-500/30 text-yellow-200 border-yellow-300/90 shadow-[0_0_15px_rgba(250,204,21,0.6)] animate-pulse",
      avatarOverlayStyle: "border-yellow-300 text-yellow-200 bg-black/90",
      priority: 0,
    });
  }

  // 3. Veteran (Reached cell 25 or at least 40% of the board)
  if (player.cell >= 25 || (maxCell > 0 && player.cell >= maxCell * 0.4)) {
    achievements.push({
      id: "veteran",
      name: "Veteran",
      icon: "🎖️",
      description: "Опытный игрок: преодолел более 25 клеток!",
      badgeStyle:
        "bg-cyan-500/25 text-cyan-300 border-cyan-400/80 shadow-[0_0_10px_rgba(6,182,212,0.4)]",
      avatarOverlayStyle: "border-cyan-400 text-cyan-300 bg-cyan-950/80",
      priority: 4,
    });
  }

  // 4. Lucky Roller (Last roll was 6)
  if (player.lastRoll === 6) {
    achievements.push({
      id: "lucky_roller",
      name: "Lucky Roller",
      icon: "🎲",
      description: "Счастливчик: Выбросил максимум (6) на кубике!",
      badgeStyle:
        "bg-emerald-500/25 text-emerald-300 border-emerald-400/80 shadow-[0_0_10px_rgba(52,211,153,0.4)]",
      avatarOverlayStyle: "border-emerald-400 text-emerald-300 bg-emerald-950/80",
      priority: 5,
    });
  }

  // 5. Bonus Master (Active bonus in Life Table)
  if (player.activeBonus) {
    achievements.push({
      id: "bonus_master",
      name: "Призер",
      icon: "🎁",
      description: `Держатель призового бонуса: "${player.activeBonus.extra || player.activeBonus.name}"`,
      badgeStyle:
        "bg-fuchsia-500/25 text-fuchsia-300 border-fuchsia-400/80 shadow-[0_0_10px_rgba(217,70,239,0.4)] animate-pulse",
      avatarOverlayStyle: "border-fuchsia-400 text-fuchsia-300 bg-fuchsia-950/80",
      priority: 6,
    });
  }

  // 6. Game Master / Admin
  if (player.role === "admin") {
    achievements.push({
      id: "admin_badge",
      name: "GameMaster",
      icon: "🛡️",
      description: "Хранитель правил и администратор игры",
      badgeStyle:
        "bg-red-500/25 text-red-300 border-red-500/80 shadow-[0_0_10px_rgba(239,68,68,0.4)]",
      avatarOverlayStyle: "border-red-500 text-red-300 bg-red-950/80",
      priority: 7,
    });
  }

  return achievements.sort((a, b) => a.priority - b.priority);
}
