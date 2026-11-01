import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Package, Sparkles, Zap, Gift, Shield, AlertTriangle } from "lucide-react";
import { DropBoxOption } from "../types";
import { playSound } from "../utils/sounds";
import { hapticImpact, hapticNotification } from "../utils/haptics";

interface DropBoxModalProps {
  cellId: number;
  onPick: (boxIndex: number) => void;
  result: {
    chosen: DropBoxOption;
    allOptions: DropBoxOption[];
  } | null;
  onClose: () => void;
}

export default function DropBoxModal({
  cellId,
  onPick,
  result,
  onClose,
}: DropBoxModalProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  const handleSelectBox = (index: number) => {
    if (selectedIndex !== null || result !== null) return;
    setSelectedIndex(index);
    playSound("laser");
    hapticImpact("heavy");
    onPick(index);
  };

  const getOptionIcon = (type: string) => {
    switch (type) {
      case "jump":
        return <Zap size={28} className="text-[#00ffaa] animate-bounce" />;
      case "promo":
        return <Gift size={28} className="text-[#f5c542] animate-bounce" />;
      case "item":
        return <Shield size={28} className="text-[#38bdf8] animate-bounce" />;
      default:
        return <AlertTriangle size={28} className="text-[#ff2a5f] animate-pulse" />;
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/90 pointer-events-auto select-none">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 15 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="relative w-full max-w-md bg-[#0a0715] border-2 border-[#00ffaa]/50 rounded-2xl p-6 shadow-[0_0_50px_rgba(0,255,170,0.25)] flex flex-col items-center text-center space-y-5"
      >
        {/* Header */}
        <div className="space-y-1">
          <div className="flex items-center justify-center gap-2 text-[#00ffaa] font-mono font-black text-sm tracking-widest uppercase">
            <Package size={18} className="text-[#00ffaa] animate-pulse" />
            <span>КИБЕР-ДРОП #КЛЕТКА {cellId}</span>
          </div>
          <p className="text-[12px] text-white/70 font-mono">
            {!result
              ? "Выберите один из трёх засекреченных контейнеров:"
              : "Контейнер взломан! Ваша награда:"}
          </p>
        </div>

        {/* 3 Crates Grid */}
        <div className="grid grid-cols-3 gap-3 w-full">
          {[0, 1, 2].map((idx) => {
            const isPicked = selectedIndex === idx;
            const isOther = selectedIndex !== null && !isPicked;
            const revealData = result?.chosen && isPicked ? result.chosen : null;

            return (
              <motion.button
                key={idx}
                type="button"
                whileHover={selectedIndex === null ? { scale: 1.05 } : {}}
                whileTap={selectedIndex === null ? { scale: 0.95 } : {}}
                disabled={selectedIndex !== null}
                onClick={() => handleSelectBox(idx)}
                className={`relative h-32 rounded-xl border flex flex-col items-center justify-center p-2 transition-all duration-300 cursor-pointer ${
                  isPicked
                    ? "bg-[#00ffaa]/20 border-[#00ffaa] shadow-[0_0_25px_rgba(0,255,170,0.5)]"
                    : isOther
                      ? "bg-black/40 border-white/10 opacity-30 cursor-not-allowed"
                      : "bg-[#140e26] border-[#00ffaa]/30 hover:border-[#00ffaa] hover:shadow-[0_0_15px_rgba(0,255,170,0.3)]"
                }`}
              >
                {!result ? (
                  <>
                    <Package
                      size={36}
                      className={`transition-colors ${
                        isPicked ? "text-[#00ffaa] animate-bounce" : "text-[#00ffaa]/70"
                      }`}
                    />
                    <span className="mt-2 font-mono font-black text-xs text-white/90">
                      КЕЙС #{idx + 1}
                    </span>
                    <span className="font-mono text-[9px] text-[#00ffaa]/80 tracking-wider">
                      {isPicked ? "ВЗЛОМ..." : "ОТКРЫТЬ"}
                    </span>
                  </>
                ) : isPicked && revealData ? (
                  <motion.div
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="flex flex-col items-center justify-center space-y-1"
                  >
                    {getOptionIcon(revealData.type)}
                    <span className="font-mono font-black text-[10px] text-[#00ffaa] leading-tight">
                      {revealData.title}
                    </span>
                  </motion.div>
                ) : (
                  <Package size={24} className="text-white/20" />
                )}
              </motion.button>
            );
          })}
        </div>

        {/* Revealed Outcome Card */}
        <AnimatePresence>
          {result?.chosen && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full bg-black/60 border border-[#00ffaa]/40 rounded-xl p-3.5 space-y-2 text-left"
            >
              <div className="flex items-center gap-2 text-[#00ffaa] font-mono font-bold text-xs uppercase">
                <Sparkles size={16} />
                <span>{result.chosen.title}</span>
              </div>
              <p className="text-[11px] font-mono text-white/80 leading-relaxed">
                {result.chosen.description}
              </p>
              {result.chosen.promoCode && (
                <div className="bg-[#00ffaa]/10 border border-[#00ffaa]/30 rounded px-2.5 py-1 text-center font-mono font-black text-sm text-[#00ffaa] tracking-widest">
                  {result.chosen.promoCode}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Action Button */}
        {result ? (
          <button
            type="button"
            onClick={() => {
              playSound("success");
              hapticNotification("success");
              onClose();
            }}
            className="w-full py-3 bg-[#00ffaa] hover:bg-[#00ffaa]/80 text-black font-mono font-black text-xs uppercase tracking-widest rounded-xl transition cursor-pointer shadow-[0_0_20px_rgba(0,255,170,0.4)]"
          >
            Забрать и продолжить
          </button>
        ) : (
          <div className="font-mono text-[10px] text-white/40 tracking-wider">
            ⚡ НАЖМИТЕ НА ЛЮБОЙ КЕЙС, ЧТОБЫ УЗНАТЬ СОДЕРЖИМОЕ
          </div>
        )}
      </motion.div>
    </div>
  );
}
