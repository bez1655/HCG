import React, { useState } from "react";
import { Player, GameState } from "../types";
import { getPlayerAchievements, Achievement } from "../utils/achievements";

interface PlayerAchievementBadgesProps {
  player: Player;
  gameState: GameState;
  className?: string;
  compact?: boolean;
}

export default function PlayerAchievementBadges({
  player,
  gameState,
  className = "",
  compact = false,
}: PlayerAchievementBadgesProps) {
  const [activeTooltip, setActiveTooltip] = useState<Achievement | null>(null);
  const achievements = getPlayerAchievements(player, gameState);

  if (!achievements || achievements.length === 0) return null;

  return (
    <div className={`relative flex flex-wrap items-center gap-1 ${className}`}>
      {achievements.map((ach) => (
        <div key={ach.id} className="relative group">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setActiveTooltip(activeTooltip?.id === ach.id ? null : ach);
            }}
            onMouseEnter={() => setActiveTooltip(ach)}
            onMouseLeave={() => setActiveTooltip(null)}
            className={`inline-flex items-center gap-1 rounded-md border font-mono font-bold uppercase tracking-wider transition-all duration-200 cursor-pointer hover:scale-105 active:scale-95 ${
              compact ? "px-1.5 py-0.5 text-[8px]" : "px-2 py-0.5 text-[9px]"
            } ${ach.badgeStyle}`}
          >
            <span className="text-[10px] leading-none">{ach.icon}</span>
            <span>{ach.name}</span>
          </button>

          {/* Interactive Achievement Tooltip */}
          {activeTooltip?.id === ach.id && (
            <div className="absolute bottom-full mb-1.5 left-0 z-50 w-48 p-2 bg-black/95 border border-[#00ffaa]/60 rounded-xl shadow-[0_0_15px_rgba(0,255,170,0.3)] pointer-events-none font-sans text-left">
              <div className="flex items-center gap-1 font-mono text-[10px] font-bold text-[#00ffaa] mb-0.5">
                <span>{ach.icon}</span>
                <span>{ach.name}</span>
              </div>
              <div className="text-[9px] text-gray-200 leading-tight">{ach.description}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
