import React, { useState } from "react";
import { Package, Gift, Zap, Shield, AlertTriangle } from "lucide-react";
import { DropBoxOption } from "../types";
import { playSound } from "../utils/sounds";
import { hapticImpact, hapticNotification } from "../utils/haptics";

const NAMES = ["АЛЬФА", "БЕТА", "ГАММА"];

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

  const iconFor = (type: string) => {
    if (type === "jump") return <Zap size={22} className="text-[#00ffaa]" />;
    if (type === "promo") return <Gift size={22} className="text-[#f5c542]" />;
    if (type === "item") return <Shield size={22} className="text-[#38bdf8]" />;
    return <AlertTriangle size={22} className="text-[#ff6b9d]" />;
  };

  const chosen = result?.chosen;
  const all = result?.allOptions || [];

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 bg-black/85 pointer-events-auto select-none">
      <div className="relative w-full max-w-md bg-[#0a0715] border-2 border-[#f5c542]/60 rounded-2xl p-4 flex flex-col items-center text-center gap-3">
        <div className="font-mono font-black text-sm text-[#f5c542] tracking-widest">
          КИБЕР-ДРОП · КЛЕТКА {cellId}
        </div>
        <p className="text-[11px] text-white/80 font-mono">
          {!result ? "Выберите кейс: Альфа, Бета или Гамма" : "Содержимое всех трёх кейсов"}
        </p>

        <div className="grid grid-cols-3 gap-2 w-full">
          {[0, 1, 2].map((idx) => {
            const revealed = all[idx];
            const isPicked = (selectedIndex ?? -1) === idx;
            return (
              <button
                key={idx}
                type="button"
                disabled={selectedIndex !== null}
                onClick={() => handleSelectBox(idx)}
                className={`min-h-[7.5rem] rounded-xl border p-2 flex flex-col items-center justify-center gap-1 ${
                  isPicked
                    ? "border-[#f5c542] bg-[#f5c542]/15"
                    : "border-white/20 bg-black/50"
                }`}
              >
                <span className="font-mono text-[9px] text-white/70">{NAMES[idx]}</span>
                {!result ? (
                  <>
                    <Package size={28} className="text-[#f5c542]" />
                    <span className="font-mono text-[10px] text-white">ОТКРЫТЬ</span>
                  </>
                ) : revealed ? (
                  <>
                    {iconFor(revealed.type)}
                    <span className="font-mono text-[9px] text-white leading-tight">
                      {revealed.title}
                    </span>
                    {revealed.promoCode && (
                      <span className="font-mono text-[10px] font-black text-[#f5c542] break-all">
                        {revealed.promoCode}
                      </span>
                    )}
                    {isPicked && (
                      <span className="font-mono text-[8px] text-[#00ffaa]">ВАШ ВЫБОР</span>
                    )}
                  </>
                ) : (
                  <Package size={22} className="text-white/30" />
                )}
              </button>
            );
          })}
        </div>

        {chosen?.promoCode && (
          <div className="w-full border border-[#f5c542] rounded-xl p-3 bg-[#f5c542]/10">
            <div className="text-[10px] font-mono text-white/70 uppercase">Ваш купон в Hapstore</div>
            <div className="font-mono font-black text-lg text-[#f5c542] tracking-widest break-all">
              {chosen.promoCode}
            </div>
            <div className="text-[10px] text-white/80 mt-1">{chosen.title}</div>
            <div className="text-[10px] text-white/50">Сохранён в «Мои призы»</div>
          </div>
        )}

        {chosen && !chosen.promoCode && (
          <div className="w-full border border-white/20 rounded-xl p-2 text-[11px] font-mono text-white/80">
            {chosen.title}: {chosen.description}
          </div>
        )}

        {result ? (
          <button
            type="button"
            onClick={() => {
              playSound("success");
              hapticNotification("success");
              onClose();
            }}
            className="w-full py-3 bg-[#f5c542] text-black font-mono font-black text-xs uppercase rounded-xl"
          >
            Понятно
          </button>
        ) : (
          <div className="font-mono text-[10px] text-white/40">Нажмите на кейс</div>
        )}
      </div>
    </div>
  );
}
