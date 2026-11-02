import React from "react";
import { Player } from "../types";
import ChipImage from "./ChipImage";

interface PlayerTokenProps {
  player: Player;
  pIdx: number;
  isActionCell: boolean;
  isMe?: boolean;
}

const PlayerToken = React.memo(({ player, isMe }: PlayerTokenProps) => {
  const chipSrc =
    (player.chipImage || "/chips/chip_1.svg").replace(/\.png$/i, ".svg") +
    ((player.chipImage || "").includes("?") ? "" : "?v=dm2");
  const isFever = !!player.feverMode;
  const neonColor = isFever ? "#FFD700" : player.color || "#00ffaa";
  const isOnline = player.isOnline !== false;

  return (
    <div
      className={`relative w-7 h-7 md:w-9 md:h-9 flex items-center justify-center pointer-events-none select-none ${
        isMe ? "z-50" : "z-40"
      }`}
      style={{ opacity: isOnline ? 1 : 0.55 }}
    >
      {/* Static glow only — no looping trail / pulse (keeps the video compositor free). */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          boxShadow: isMe
            ? `0 0 8px ${neonColor}`
            : `0 0 4px ${neonColor}`,
          border: `1px solid ${neonColor}`,
        }}
      />

      <ChipImage
        src={chipSrc}
        color={neonColor}
        label={`Фишка ${player.name}`}
        className="w-full h-full relative z-10 [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain"
      />

      {isFever && (
        <div className="absolute -top-5 left-1/2 -translate-x-1/2 px-1 py-0.5 bg-black/90 border border-yellow-400 rounded text-[7px] font-mono font-black text-yellow-300 whitespace-nowrap z-30">
          FEVER x2
        </div>
      )}

      {isMe && !isFever && (
        <div
          className="absolute -top-4 left-1/2 -translate-x-1/2 px-1 py-0.5 bg-black/90 border rounded text-[7px] font-mono font-black text-white whitespace-nowrap z-20"
          style={{ borderColor: neonColor }}
        >
          ВЫ
        </div>
      )}
    </div>
  );
});

export default PlayerToken;
