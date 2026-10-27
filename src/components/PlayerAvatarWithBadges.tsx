import ChipImage from "./ChipImage";
import React, { useState } from "react";
import { Player, GameState } from "../types";
import { getPlayerAchievements, Achievement } from "../utils/achievements";

interface PlayerAvatarWithBadgesProps {
  player: Player;
  gameState: GameState;
  size?: "sm" | "md" | "lg";
  className?: string;
  showTooltipOnHover?: boolean;
}

export default function PlayerAvatarWithBadges({
  player,
  gameState,
  size = "md",
  className = "",
  showTooltipOnHover = true,
}: PlayerAvatarWithBadgesProps) {
  const [hoveredBadge, setHoveredBadge] = useState<Achievement | null>(null);
  const achievements = getPlayerAchievements(player, gameState);

  // Size mapping
  const sizeClasses = {
    sm: "w-8 h-8 text-xs",
    md: "w-10 h-10 text-sm",
    lg: "w-12 h-12 text-base",
  };

  const badgeIconSizeClasses = {
    sm: "w-3.5 h-3.5 text-[8px]",
    md: "w-4 h-4 text-[10px]",
    lg: "w-5 h-5 text-xs",
  };

  const isOnline = player.isOnline !== false;
  const topAchievement = achievements[0]; // Highest priority achievement

  // Extract initial if no avatar string
  const initial = player.name ? player.name.charAt(0).toUpperCase() : "?";

  return (
    <div className={`relative inline-flex items-center justify-center shrink-0 group ${className}`}>
      {/* Outer Hexagon / Circular Glowing Frame */}
      <div
        className={`relative ${sizeClasses[size]} rounded-xl flex items-center justify-center font-mono font-black border-2 transition-all duration-300 shadow-lg overflow-visible ${
          topAchievement ? topAchievement.avatarOverlayStyle || "" : "bg-black/90 text-white"
        }`}
        style={{
          borderColor: player.color || "#00FFAA",
          boxShadow: `0 0 12px ${player.color}40`,
        }}
      >
        {/* Avatar Content (Chip Image, Avatar or Initial) */}
        {player.chipImage ? (
          /* Фишка — свой SVG проекта: вставляется в разметку, чтобы принять
             цвет игрока. Загруженный аватар остаётся обычной картинкой. */
          <ChipImage
            src={player.chipImage.replace(/\.png$/i, ".svg")}
            color={player.color || "#00FFAA"}
            label={player.name}
            className="w-full h-full p-0.5 rounded-lg drop-shadow-[0_0_8px_currentColor] [&>svg]:w-full [&>svg]:h-full"
            style={{ color: player.color }}
          />
        ) : player.avatar ? (
          <img
            src={player.avatar}
            alt={player.name}
            className="w-full h-full object-contain p-0.5 rounded-lg drop-shadow-[0_0_8px_currentColor]"
            style={{ color: player.color }}
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.target as HTMLElement).style.display = "none";
            }}
          />
        ) : (
          <span
            className="drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]"
            style={{ color: player.color }}
          >
            {initial}
          </span>
        )}

        {/* Online/Offline status dot */}
        <span
          className={`absolute -bottom-0.5 -left-0.5 w-2.5 h-2.5 rounded-full border border-black shadow-md ${
            isOnline ? "bg-[#00ffaa] animate-pulse" : "bg-red-500/80"
          }`}
          style={isOnline ? { boxShadow: `0 0 6px ${player.color}` } : {}}
        />

        {/* Achievement Mini-Badge Overlay (Top-Right / Corners) */}
        {achievements.length > 0 && (
          <div className="absolute -top-1.5 -right-1.5 flex items-center -space-x-1 z-10 pointer-events-auto">
            {achievements.slice(0, 2).map((ach) => (
              <div
                key={ach.id}
                onMouseEnter={() => setHoveredBadge(ach)}
                onMouseLeave={() => setHoveredBadge(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  setHoveredBadge(hoveredBadge?.id === ach.id ? null : ach);
                }}
                className={`relative flex items-center justify-center ${badgeIconSizeClasses[size]} rounded-full border border-white/20 shadow-md backdrop-blur-md cursor-pointer transform hover:scale-125 transition-all duration-200 ${ach.badgeStyle}`}
                title={`${ach.name}: ${ach.description}`}
              >
                <span className="leading-none">{ach.icon}</span>
              </div>
            ))}
            {achievements.length > 2 && (
              <div className="flex items-center justify-center text-[7px] font-mono font-bold w-3.5 h-3.5 rounded-full bg-black/90 border border-cyan-400/80 text-cyan-300">
                +{achievements.length - 2}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Floating Tooltip for Hovered / Tapped Badge */}
      {showTooltipOnHover && hoveredBadge && (
        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-50 w-44 p-2 bg-black/95 border border-cyan-500/60 rounded-xl shadow-[0_0_20px_rgba(6,182,212,0.4)] pointer-events-none text-left font-sans">
          <div className="flex items-center gap-1.5 font-mono text-[10px] font-bold text-white mb-0.5">
            <span className="text-sm">{hoveredBadge.icon}</span>
            <span className="text-cyan-300 uppercase tracking-wide">{hoveredBadge.name}</span>
          </div>
          <div className="text-[9px] text-gray-300 leading-snug">{hoveredBadge.description}</div>
        </div>
      )}
    </div>
  );
}
