import React from "react";
import { motion, AnimatePresence } from "motion/react";

interface PopupCardProps {
  popup: {
    title: string;
    description: string;
    playerName: string;
    type: string;
    playerId?: string;
  } | null;
  onClose: () => void;
  onRestartLap?: (playerId: string) => void;
  userId?: string | null;
}

export default function PopupCard({ popup, onClose, onRestartLap }: PopupCardProps) {
  const isWin = popup?.type === "win" || popup?.type === "finish";

  // Trigger Telegram HapticFeedback when popup is shown
  React.useEffect(() => {
    if (popup) {
      const tg = (window as any).Telegram?.WebApp;
      if (tg && tg.HapticFeedback) {
        if (isWin) {
          tg.HapticFeedback.notificationOccurred("success");
        } else {
          tg.HapticFeedback.notificationOccurred("warning");
        }
      }
    }
  }, [popup, isWin]);

  // Generate lightweight particles for the win celebration
  const particles = React.useMemo(() => {
    if (!isWin) return [];
    return Array.from({ length: 20 }).map((_, i) => ({
      id: i,
      x: (Math.random() - 0.5) * 360,
      y: (Math.random() - 0.5) * 360,
      size: Math.random() * 6 + 4,
      color: Math.random() > 0.5 ? "#00FFFF" : "#EAB308",
      delay: Math.random() * 0.8,
      duration: Math.random() * 1.5 + 1.5,
    }));
  }, [isWin]);

  return (
    <AnimatePresence>
      {popup && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4"
          onClick={onClose}
        >
          {/* Confetti / Particle container */}
          {isWin && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden flex items-center justify-center">
              {particles.map((p) => (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, scale: 0, x: 0, y: 100 }}
                  animate={{
                    opacity: [0, 1, 1, 0],
                    scale: [0.5, 1.2, 0.8, 0],
                    x: p.x,
                    y: p.y - 120,
                  }}
                  transition={{
                    duration: p.duration,
                    delay: p.delay,
                    repeat: Infinity,
                    ease: "easeOut",
                  }}
                  className="absolute rounded-full blur-[1px]"
                  style={{
                    width: p.size,
                    height: p.size,
                    backgroundColor: p.color,
                    boxShadow: `0 0 12px ${p.color}`,
                  }}
                />
              ))}
            </div>
          )}

          <motion.div
            initial={{ scale: 0.8, y: 50, rotateX: 45 }}
            animate={{ scale: 1, y: 0, rotateX: 0 }}
            exit={{ scale: 0.8, y: 50, opacity: 0 }}
            transition={{ type: "spring", damping: 15 }}
            className={`relative w-full max-h-[90dvh] overflow-y-auto scrollbar-none rounded-2xl p-5 sm:p-8 border-2 transition-all duration-500 ${
              isWin
                ? "max-w-md bg-[#070B19]/95 border-[#00FFFF] shadow-[0_0_50px_rgba(0,255,255,0.4)]"
                : "max-w-sm bg-[#0B1426] border-[#D4A017] shadow-[0_0_30px_rgba(212,160,23,0.3)]"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Cyberpunk top border accents */}
            <div
              className={`absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r ${
                isWin
                  ? "from-transparent via-[#00FFFF] to-transparent animate-pulse"
                  : "from-transparent via-[#D4A017] to-transparent"
              }`}
            />

            {/* Glowing background shapes */}
            {isWin ? (
              <>
                <div className="absolute -right-16 -top-16 w-32 h-32 bg-[#00FFFF]/10 blur-3xl rounded-full" />
                <div className="absolute -left-16 -bottom-16 w-32 h-32 bg-[#FF00FF]/10 blur-3xl rounded-full" />
              </>
            ) : (
              <div className="absolute -left-10 top-10 w-20 h-40 bg-[#EAB308]/10 blur-2xl rotate-45" />
            )}

            {/* Content header */}
            <div className="flex items-center gap-3 mb-2">
              <span
                className={`text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded border ${
                  isWin
                    ? "text-[#00FFFF] border-[#00FFFF]/30 bg-[#00FFFF]/10"
                    : "text-[#D4A017] border-[#D4A017]/30 bg-[#D4A017]/10"
                }`}
              >
                {isWin ? "Системный Триумф" : "Книга Судеб"}
              </span>
              <span className="text-gray-400 font-mono text-xs">• {popup.playerName}</span>
            </div>

            {/* Title */}
            <h2
              className={`text-2xl font-black mb-4 uppercase tracking-tight leading-tight ${
                isWin
                  ? "text-transparent bg-clip-text bg-gradient-to-r from-[#00FFFF] via-white to-[#FF00FF] drop-shadow-[0_2px_10px_rgba(0,255,255,0.3)]"
                  : "text-white"
              }`}
            >
              {popup.title}
            </h2>

            {/* Illustration Icon */}
            {isWin && (
              <div className="my-5 flex justify-center">
                <motion.div
                  animate={{
                    scale: [1, 1.08, 1],
                    rotateY: [0, 180, 360],
                  }}
                  transition={{
                    duration: 6,
                    repeat: Infinity,
                    ease: "easeInOut",
                  }}
                  className="w-20 h-20 bg-gradient-to-br from-[#00FFFF] to-[#FF00FF] rounded-full p-0.5 shadow-[0_0_20px_rgba(0,255,255,0.5)] flex items-center justify-center"
                >
                  <div className="w-full h-full bg-[#070B19] rounded-full flex items-center justify-center font-mono text-4xl">
                    🏆
                  </div>
                </motion.div>
              </div>
            )}

            {/* Description */}
            <p className="text-gray-300 font-sans text-sm mb-4 leading-relaxed text-center sm:text-left">
              {popup.description}
            </p>

            {/* Prize Control Rule Note */}
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3 mb-6 text-[11px] text-yellow-200/90 leading-snug font-sans">
              ⚠️ <b>Система контроля призов:</b> Призовые суммы и бонусы НЕ суммируются. Для
              выполнения следующего броска вы должны сначала использовать полученный бонус в Таблице
              Жизни и получить подтверждение от администратора.
            </div>

            {/* Dynamic Buttons */}
            <div className="flex flex-col gap-3">
              {isWin && onRestartLap && popup.playerId && (
                <button
                  onClick={() => {
                    const tg = (window as any).Telegram?.WebApp;
                    if (tg && tg.HapticFeedback) {
                      tg.HapticFeedback.impactOccurred("heavy");
                    }
                    onRestartLap(popup.playerId!);
                    onClose();
                  }}
                  className="w-full py-3.5 bg-gradient-to-r from-[#00FFFF] to-[#00BCBC] hover:from-[#00BCBC] hover:to-[#008F8F] text-[#070B19] font-black uppercase tracking-widest rounded-xl shadow-[0_0_25px_rgba(0,255,255,0.5)] active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2"
                >
                  <span>🔄</span> Начать заново круг
                </button>
              )}

              <button
                onClick={() => {
                  const tg = (window as any).Telegram?.WebApp;
                  if (tg && tg.HapticFeedback) {
                    tg.HapticFeedback.impactOccurred("medium");
                  }
                  onClose();
                }}
                className={`w-full py-3.5 font-bold uppercase tracking-widest rounded-xl transition-all duration-200 active:scale-[0.98] ${
                  isWin
                    ? "bg-white/10 hover:bg-white/20 border border-white/20 text-white"
                    : "bg-gradient-to-r from-[#FF00FF]/20 to-[#FF00FF]/15 border border-[#FF00FF] text-[#FF00FF] hover:bg-[#FF00FF]/30 shadow-[0_0_15px_rgba(255,0,255,0.2)]"
                }`}
              >
                {isWin ? "Просто смотреть" : "Продолжить"}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
