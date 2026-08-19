import React from "react";
import { Player, GameState } from "../types";
import { turnsLeft } from "../game/rules";

interface ActiveTurnIndicatorProps {
  player: Player;
  gameState: GameState;
  size?: "sm" | "md" | "lg";
  className?: string;
  showTextLabel?: boolean;
}

export default function ActiveTurnIndicator({
  player,
  gameState,
  size = "md",
  className = "",
  showTextLabel = false,
}: ActiveTurnIndicatorProps) {
  const isCurrentTurn = gameState.currentPlayerId === player.id;
  const hasApprovedTurn = turnsLeft(player) > 0;
  const isActive = isCurrentTurn || hasApprovedTurn;

  if (!isActive) return null;

  const dotSize = size === "sm" ? "w-2 h-2" : size === "lg" ? "w-3 h-3" : "w-2.5 h-2.5";
  const color = player.color || "#00ffaa";

  return (
    <span
      className={`inline-flex items-center gap-1 shrink-0 select-none ${className}`}
      title={`Сейчас ход игрока ${player.name}`}
    >
      <span className="relative flex items-center justify-center shrink-0 w-3 h-3">
        <span
          className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-80 ${dotSize}`}
          style={{ backgroundColor: color }}
        />
        <span
          className={`relative inline-flex rounded-full ${dotSize} border border-white/80 shadow-[0_0_10px_currentColor]`}
          style={{ backgroundColor: color, color }}
        />
      </span>
      {showTextLabel && (
        <span
          className="text-[9px] font-mono font-black uppercase tracking-wider animate-pulse drop-shadow-[0_0_6px_rgba(0,255,170,0.5)]"
          style={{ color }}
        >
          ХОД
        </span>
      )}
    </span>
  );
}
