import React from "react";
import { motion } from "motion/react";
import { Player } from "../types";
import ChipImage from "./ChipImage";

interface PlayerTokenProps {
  player: Player;
  pIdx: number;
  isActionCell: boolean;
}

const PlayerToken = React.memo(({ player, pIdx, isActionCell }: PlayerTokenProps) => {
  // Фишки хранятся как SVG: PNG-версии в репозитории оказались повреждены,
  // а векторные к тому же принимают цвет игрока. Старые записи в базе
  // указывают на .png — переписываем расширение на лету, чтобы не требовать
  // миграции состояния.
  const chipSrc = (player.chipImage || "/chips/chip_1.svg").replace(/\.png$/i, ".svg");
  const neonColor = player.color || "#00ffaa";

  // Игрок вне сети остаётся на доске: его положение — часть партии. Но фишка
  // приглушается, чтобы было видно, кто сейчас за столом, а кто отошёл.
  const isOnline = player.isOnline !== false;

  return (
    <motion.div
      layoutId={`player_token_${player.id}`}
      layout
      className="relative w-7 h-7 md:w-9 md:h-9 flex items-center justify-center pointer-events-none group z-50 select-none"
      style={{ opacity: isOnline ? 1 : 0.55 }}
      animate={{
        // Покачивание — признак присутствия. Фишка вышедшего игрока замирает.
        y: isOnline ? [0, -5, 0] : 0,
        scale: isActionCell && isOnline ? [1, 1.25, 1] : [1, 1, 1],
      }}
      transition={{
        layout: { type: "spring", stiffness: 180, damping: 18 },
        y: { repeat: Infinity, duration: 2.2, delay: pIdx * 0.2, ease: "easeInOut" },
        scale: { repeat: Infinity, duration: 1.4, ease: "easeInOut" },
      }}
    >
      {/* Outer pulsing neon aura ring */}
      <motion.div
        className="absolute inset-[0px] rounded-full opacity-60"
        animate={{ rotate: 360, scale: [1, 1.05, 1] }}
        transition={{
          rotate: { repeat: Infinity, duration: 5, ease: "linear" },
          scale: { repeat: Infinity, duration: 2, ease: "easeInOut" },
        }}
        style={{
          border: `1px dashed ${neonColor}`,
          boxShadow: `0 0 3px ${neonColor}, inset 0 0 2px ${neonColor}`,
        }}
      />

      {/* Radial neon glow background disc */}
      <div
        className="absolute inset-1 rounded-full opacity-60 mix-blend-screen pointer-events-none"
        style={{
          background: `radial-gradient(circle at center, ${neonColor} 0%, transparent 40%)`,
          filter: `blur(0.5px)`,
        }}
      />

      {/* Модель фишки. Свечение внутри неё окрашивается в цвет игрока —
          через <img> это было невозможно: картинка не наследует CSS страницы,
          поэтому у всех фишек было одинаковое зелёно-голубое свечение. */}
      <ChipImage
        src={chipSrc}
        color={neonColor}
        label={`Фишка ${player.name}`}
        className="w-full h-full relative z-10 [&>svg]:w-full [&>svg]:h-full [&>svg]:object-contain"
        style={{
          filter: isOnline
            ? `drop-shadow(0 0 1px ${neonColor}) drop-shadow(0 0 2px ${neonColor})`
            : `grayscale(0.7) drop-shadow(0 0 1px ${neonColor})`,
        }}
      />

      {/* Player name label on hover */}
      <div
        className="absolute -top-3 left-1/2 -translate-x-1/2 px-1 py-0.2 bg-black/90 rounded border text-[8px] font-mono font-bold uppercase tracking-wider text-white whitespace-nowrap shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ borderColor: neonColor }}
      >
        {player.name}
        {!isOnline && <span className="ml-1 opacity-70">• не в сети</span>}
      </div>

      {/* Bottom cast shadow on the board */}
      <div
        className="absolute -bottom-2 w-5 h-1.5 md:w-6 md:h-2 bg-black/60 rounded-full blur-[2px] opacity-70"
        style={{ boxShadow: `0 0 10px ${neonColor}` }}
      />
    </motion.div>
  );
});

export default PlayerToken;
