/**
 * Всплывающий результат хода.
 *
 * Показывается ПОСЛЕ КАЖДОГО броска, а не только на призовой клетке. Раньше
 * игрок, попавший на обычную клетку, не видел ничего: фишка переезжала молча.
 * Человек не мог отличить «ничего не выпало» от «игра сломалась».
 *
 * Оформление подчинено читаемости: крупный шрифт, тёмная подложка под текстом,
 * цвет рамки говорит о результате раньше, чем прочитан текст.
 */
import React from "react";
import { motion, AnimatePresence } from "motion/react";

export interface TurnOutcome {
  title: string;
  body: string;
  cellName: string;
  cellType: string;
  icon: string;
  tone: "good" | "bad" | "neutral";
  footer: string;
  prize?: { name: string; description: string } | null;
  playerId?: string;
}

interface Props {
  outcome: TurnOutcome | null;
  onClose: () => void;
}

/** Палитра по тональности: цвет читается раньше текста. */
const TONE = {
  good: {
    accent: "#00FFAA",
    glow: "rgba(0,255,170,0.35)",
    label: "УДАЧНЫЙ ХОД",
  },
  bad: {
    accent: "#FF6B9D",
    glow: "rgba(255,107,157,0.35)",
    label: "НЕУДАЧА",
  },
  neutral: {
    accent: "#C77DFF",
    glow: "rgba(199,125,255,0.30)",
    label: "ХОД СДЕЛАН",
  },
} as const;

export default function TurnOutcomeCard({ outcome, onClose }: Props) {
  // Отклик телефона: приятный при удаче, предупреждающий при откате.
  React.useEffect(() => {
    if (!outcome) return;
    const tg = (window as any).Telegram?.WebApp;
    if (tg?.HapticFeedback) {
      if (outcome.tone === "good") tg.HapticFeedback.notificationOccurred("success");
      else if (outcome.tone === "bad") tg.HapticFeedback.notificationOccurred("error");
      else tg.HapticFeedback.impactOccurred("light");
    }
  }, [outcome]);

  // Закрытие по Escape — на случай игры с клавиатуры.
  React.useEffect(() => {
    if (!outcome) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [outcome, onClose]);

  const tone = outcome ? TONE[outcome.tone] ?? TONE.neutral : TONE.neutral;

  return (
    <AnimatePresence>
      {outcome && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[110] flex items-center justify-center p-4"
          style={{ background: "rgba(4,2,10,0.88)" }}
          onClick={onClose}
          data-testid="turn-outcome"
          role="dialog"
          aria-live="assertive"
          aria-label="Результат хода"
        >
          <motion.div
            initial={{ scale: 0.9, y: 24, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.95, y: 12, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 26 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-[380px] rounded-3xl overflow-hidden"
            style={{
              background: "linear-gradient(160deg, #14102B 0%, #0B0914 100%)",
              border: `2px solid ${tone.accent}`,
              boxShadow: `0 0 40px ${tone.glow}, inset 0 0 60px rgba(0,0,0,0.6)`,
            }}
          >
            {/* Шапка: выпавшее число — самое крупное на карточке */}
            <div
              className="px-5 pt-5 pb-4 text-center"
              style={{ background: `linear-gradient(180deg, ${tone.glow} 0%, transparent 100%)` }}
            >
              <div
                className="text-[11px] font-black tracking-[0.25em] mb-2"
                style={{ color: tone.accent }}
              >
                {tone.label}
              </div>
              <div
                className="font-black leading-none"
                style={{
                  fontSize: "52px",
                  color: "#FFFFFF",
                  textShadow: `0 0 24px ${tone.glow}, 0 2px 8px rgba(0,0,0,0.9)`,
                }}
              >
                {outcome.title}
              </div>
            </div>

            {/* Клетка, куда встали */}
            <div className="px-5 pb-3 flex items-center justify-center gap-2.5">
              <span style={{ fontSize: "26px", lineHeight: 1 }}>{outcome.icon}</span>
              <span
                className="font-bold text-center"
                style={{ fontSize: "17px", color: tone.accent, letterSpacing: "0.02em" }}
              >
                {outcome.cellName}
              </span>
            </div>

            {/*
             * Тёмная подложка под текстом.
             *
             * Фон карточки — градиент со свечением, и на нём светлый текст
             * теряет контраст. Подложка возвращает его, не убирая оформление.
             */}
            <div className="px-4 pb-3">
              <div
                className="rounded-2xl px-4 py-3.5"
                style={{
                  background: "rgba(0,0,0,0.55)",
                  border: "1px solid rgba(255,255,255,0.10)",
                }}
              >
                <p
                  className="text-center"
                  style={{
                    fontSize: "16px",
                    lineHeight: 1.55,
                    color: "#F0EDFF",
                    textShadow: "0 1px 3px rgba(0,0,0,0.8)",
                  }}
                >
                  {outcome.body}
                </p>
              </div>
            </div>

            {/* Приз — отдельным блоком, его не должно быть видно «между строк» */}
            {outcome.prize && (
              <div className="px-4 pb-3">
                <div
                  className="rounded-2xl px-4 py-3 text-center"
                  style={{
                    background: "rgba(245,197,66,0.12)",
                    border: "1.5px solid rgba(245,197,66,0.55)",
                  }}
                >
                  <div
                    className="font-black mb-0.5"
                    style={{ fontSize: "18px", color: "#F5C542", textShadow: "0 1px 4px rgba(0,0,0,0.9)" }}
                  >
                    🎁 {outcome.prize.name}
                  </div>
                  {outcome.prize.description && (
                    <div style={{ fontSize: "13px", color: "#FFE9A8", lineHeight: 1.4 }}>
                      {outcome.prize.description}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Остаток бросков */}
            <div className="px-5 pb-4">
              <div
                className="text-center"
                style={{
                  fontSize: "13.5px",
                  color: "rgba(255,255,255,0.72)",
                  textShadow: "0 1px 3px rgba(0,0,0,0.9)",
                }}
              >
                {outcome.footer}
              </div>
            </div>

            <button
              onClick={onClose}
              className="w-full py-4 font-black tracking-[0.15em] transition-colors"
              style={{
                fontSize: "15px",
                color: "#0B0914",
                background: tone.accent,
              }}
            >
              ПОНЯТНО
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
