import React from "react";
import { GameState, Player } from "../types";
import { turnsLeft, pluralizeTurns } from "../game/rules";

interface PlayerStatusBadgeProps {
  player: Player;
  gameState: GameState;
  visualCells?: Record<string, number>;
  className?: string;
}

export function getPlayerStatuses(
  player: Player,
  gameState: GameState,
  visualCells?: Record<string, number>
) {
  const maxCell =
    gameState.cells && gameState.cells.length > 0
      ? Math.max(...gameState.cells.map((c) => c.id))
      : 60;

  const isMoving =
    visualCells && visualCells[player.id] !== undefined && visualCells[player.id] !== player.cell;
  const isCurrentTurn =
    gameState.currentPlayerId === player.id && gameState.turnStatus === "waiting_roll";
  const isTurnRequested = player.turnRequested || gameState.turnRequestUserId === player.id;
  // Одобрение открывает пачку бросков: значение имеет остаток, а не окно.
  const approvedTurns = turnsLeft(player);
  const hasApprovedTurn = approvedTurns > 0;
  const isFinished = player.cell >= maxCell;
  const isOffline = player.isOnline === false;

  const statuses: {
    id: string;
    label: string;
    icon?: string;
    badgeStyle: string;
  }[] = [];

  // Priority status determination
  if (isOffline) {
    statuses.push({
      id: "offline",
      label: "Офлайн",
      icon: "🔌",
      badgeStyle: "bg-neutral-800/90 text-neutral-400 border-neutral-700/60",
    });
  } else if (isMoving) {
    statuses.push({
      id: "moving",
      label: "Движение",
      icon: "⚡",
      badgeStyle:
        "bg-cyan-500/20 text-cyan-300 border-cyan-400/60 shadow-[0_0_8px_rgba(6,182,212,0.3)] animate-pulse",
    });
  } else if (isFinished) {
    statuses.push({
      id: "finished",
      label: "Финиш круг",
      icon: "🏆",
      badgeStyle:
        "bg-yellow-500/25 text-yellow-300 border-yellow-400/70 shadow-[0_0_10px_rgba(234,179,8,0.35)]",
    });
  } else if (isCurrentTurn) {
    statuses.push({
      id: "current_turn",
      label: "Бросок",
      icon: "🎲",
      badgeStyle:
        "bg-emerald-500/25 text-emerald-300 border-emerald-400/70 shadow-[0_0_8px_rgba(52,211,153,0.35)] animate-pulse",
    });
  } else if (isTurnRequested) {
    statuses.push({
      id: "awaiting_turn",
      label:
        player.turnsRequested && player.turnsRequested > 1
          ? `Запрос: ${player.turnsRequested} ${pluralizeTurns(player.turnsRequested)}`
          : "Запрос хода",
      icon: "⏳",
      badgeStyle: "bg-amber-500/20 text-amber-300 border-amber-400/50",
    });
  } else if (hasApprovedTurn) {
    statuses.push({
      id: "approved",
      label: approvedTurns > 1 ? `Ходов: ${approvedTurns}` : "Ход доступен",
      icon: "✅",
      badgeStyle: "bg-green-500/20 text-green-300 border-green-500/50",
    });
  } else if (player.skipNextTurn) {
    statuses.push({
      id: "penalty",
      label: "Пропуск хода",
      icon: "🛑",
      badgeStyle: "bg-red-500/20 text-red-400 border-red-500/50",
    });
  } else {
    statuses.push({
      id: "awaiting",
      label: "В ожидании",
      icon: "💤",
      badgeStyle: "bg-white/5 text-gray-400 border-white/10",
    });
  }

  // Active Bonus badge
  if (player.activeBonus) {
    statuses.push({
      id: "bonus",
      label: player.activeBonus.extra || player.activeBonus.name || "Бонус",
      icon: "🎁",
      badgeStyle: "bg-yellow-400/20 text-yellow-300 border-yellow-400/50",
    });
  }

  return statuses;
}

export default function PlayerStatusBadge({
  player,
  gameState,
  visualCells,
  className = "",
}: PlayerStatusBadgeProps) {
  const statuses = getPlayerStatuses(player, gameState, visualCells);

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {statuses.map((s) => (
        <span
          key={s.id}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[8px] font-mono font-bold border tracking-wider uppercase transition-all ${s.badgeStyle}`}
        >
          {s.icon && <span className="text-[9px] leading-none">{s.icon}</span>}
          <span>{s.label}</span>
        </span>
      ))}
    </div>
  );
}
