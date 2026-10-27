import React from "react";
import { motion } from "motion/react";
import { Player } from "../types";
import ChipImage from "./ChipImage";

interface PlayerTokenProps {
  player: Player;
  pIdx: number;
  isActionCell: boolean;
  isMe?: boolean;
}

const PlayerToken = React.memo(({ player, pIdx, isActionCell, isMe }: PlayerTokenProps) => {
  // Фишки хранятся как SVG: PNG-версии в репозитории оказались повреждены,
  // а векторные к тому же принимают цвет игрока. Старые записи в базе
  // указывают на .png — переписываем расширение на лету, чтобы не требовать
  // миграции состояния.
  const chipSrc = (player.chipImage || "/chips/chip_1.svg").replace(/\.png$/i, ".svg") +
    ((player.chipImage || "").includes("?") ? "" : "?v=hw1");
  const isFever = !!player.feverMode;
  const neonColor = isFever ? "#FFD700" : player.color || "#00ffaa";

  // Игрок вне сети остаётся на доске: его положение — часть партии. Но фишка
  // приглушается, чтобы было видно, кто сейчас за столом, а кто отошёл.
  const isOnline = player.isOnline !== false;

  return (
    <motion.div
      layoutId={`player_token_${player.id}`}
      layout
      className={`relative w-7 h-7 md:w-9 md:h-9 flex items-center justify-center pointer-events-none group select-none ${
        isMe ? "z-50" : "z-40"
      }`}
      style={{ opacity: isOnline ? 1 : 0.55 }}
      animate={{
        // Покачивание — признак присутствия. Фишка вышедшего игрока замирает.
        y: isOnline ? [0, isMe ? -6 : -4, 0] : 0,
        scale: isActionCell && isOnline ? [1, 1.25, 1] : [1, 1, 1],
      }}
      transition={{
        layout: { type: "spring", stiffness: 180, damping: 18 },
        y: { repeat: Infinity, duration: isMe ? 1.8 : 2.2, delay: pIdx * 0.2, ease: "easeInOut" },
        scale: { repeat: Infinity, duration: 1.4, ease: "easeInOut" },
      }}
    >
      {/* 🔥 FEVER MODE: Golden energetic pulse and sparkling aura */}
      {isFever && (
        <>
          <motion.div
            className="absolute -inset-3 rounded-full pointer-events-none"
            animate={{
              scale: [1, 1.4, 1],
              opacity: [0.9, 0.2, 0.9],
              rotate: [0, 180, 360],
            }}
            transition={{ repeat: Infinity, duration: 1.1, ease: "linear" }}
            style={{
              border: "2px solid #FFD700",
              boxShadow: "0 0 18px #FFD700, 0 0 35px #FFA500, inset 0 0 10px #FFD700",
            }}
          />
          <motion.div
            className="absolute -inset-1.5 rounded-full pointer-events-none bg-gradient-to-tr from-amber-500/40 via-yellow-400/50 to-transparent"
            animate={{ scale: [1, 1.2, 1], opacity: [0.9, 0.5, 0.9] }}
            transition={{ repeat: Infinity, duration: 0.7, ease: "easeInOut" }}
          />
        </>
      )}

      {/* Dynamic neon motion trail ripple */}
      <motion.div
        className="absolute -inset-1 rounded-full pointer-events-none"
        animate={{ scale: [0.9, 1.45, 0.9], opacity: [0.6, 0, 0.6] }}
        transition={{ repeat: Infinity, duration: isMe ? 1.6 : 2.4, ease: "easeOut" }}
        style={{
          border: `1.5px solid ${neonColor}`,
          boxShadow: isFever ? `0 0 14px #FFD700` : `0 0 8px ${neonColor}`,
        }}
      />

      {/* Outer pulsing neon aura ring */}
      <motion.div
        className="absolute inset-[0px] rounded-full opacity-60"
        animate={{ rotate: 360, scale: [1, 1.08, 1] }}
        transition={{
          rotate: { repeat: Infinity, duration: 5, ease: "linear" },
          scale: { repeat: Infinity, duration: 2, ease: "easeInOut" },
        }}
        style={{
          border: `1px ${isMe ? "solid" : "dashed"} ${neonColor}`,
          boxShadow: isMe
            ? `0 0 8px ${neonColor}, inset 0 0 4px ${neonColor}`
            : `0 0 3px ${neonColor}, inset 0 0 2px ${neonColor}`,
        }}
      />

      {/* Radial neon glow background disc */}
      <div
        className="absolute inset-1 rounded-full opacity-65 mix-blend-screen pointer-events-none"
        style={{
          background: `radial-gradient(circle at center, ${neonColor} 0%, transparent ${isMe ? "60%" : "40%"})`,
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
            ? isMe
              ? `drop-shadow(0 0 3px ${neonColor}) drop-shadow(0 0 6px ${neonColor})`
              : `drop-shadow(0 0 1px ${neonColor}) drop-shadow(0 0 2px ${neonColor})`
            : `grayscale(0.7) drop-shadow(0 0 1px ${neonColor})`,
        }}
      />

      {/* 🔥 FEVER MODE Badge */}
      {isFever && (
        <motion.div
          className={`absolute ${isMe ? "-top-8" : "-top-5"} left-1/2 -translate-x-1/2 px-1.5 py-0.2 bg-black/95 border border-yellow-400 rounded text-[7px] font-mono font-black text-yellow-300 whitespace-nowrap shadow-[0_0_12px_rgba(255,215,0,0.9)] z-30 flex items-center gap-0.5`}
          animate={{ scale: [1, 1.15, 1], y: [0, -1.5, 0] }}
          transition={{ repeat: Infinity, duration: 0.8, ease: "easeInOut" }}
        >
          <span>🔥</span>
          <span>FEVER x2</span>
        </motion.div>
      )}

      {/* Distinctive "YOU / ВЫ" beacon badge for current player */}
      {isMe && (
        <motion.div
          className="absolute -top-4 left-1/2 -translate-x-1/2 px-1.5 py-0.2 bg-[#060412]/95 border rounded text-[7px] font-mono font-black text-white whitespace-nowrap shadow-[0_0_8px_rgba(0,255,170,0.8)] z-20 flex items-center gap-0.5"
          style={{ borderColor: neonColor }}
          animate={{ y: [0, -2, 0] }}
          transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
        >
          <span className="w-1.5 h-1.5 rounded-full animate-ping" style={{ backgroundColor: neonColor }} />
          <span>ВЫ</span>
        </motion.div>
      )}

      {/* Player name label on hover */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 px-1 py-0.2 bg-black/90 rounded border text-[8px] font-mono font-bold uppercase tracking-wider text-white whitespace-nowrap shadow-md opacity-0 group-hover:opacity-100 transition-opacity ${
          isMe ? "-top-7" : "-top-3"
        }`}
        style={{ borderColor: neonColor }}
      >
        {player.name}
        {!isOnline && <span className="ml-1 opacity-70">• не в сети</span>}
      </div>

      {/* Bottom cast shadow on the board */}
      <div
        className="absolute -bottom-2 w-5 h-1.5 md:w-6 md:h-2 bg-black/70 rounded-full blur-[2px] opacity-80"
        style={{ boxShadow: `0 0 ${isMe ? "14px" : "10px"} ${neonColor}` }}
      />
    </motion.div>
  );
});

export default PlayerToken;
