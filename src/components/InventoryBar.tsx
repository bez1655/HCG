import React from "react";
import { motion } from "motion/react";
import { Shield, Sparkles, Magnet } from "lucide-react";
import { hapticSelection } from "../utils/haptics";

interface InventoryBarProps {
  inventory?: string[];
  activeItem: "shield" | "loaded_dice" | "magnet" | null;
  onToggleItem: (item: "shield" | "loaded_dice" | "magnet") => void;
  disabled?: boolean;
}

export default function InventoryBar({
  inventory = [],
  activeItem,
  onToggleItem,
  disabled = false,
}: InventoryBarProps) {
  const shieldCount = inventory.filter((i) => i === "shield").length;
  const diceCount = inventory.filter((i) => i === "loaded_dice").length;
  const magnetCount = inventory.filter((i) => i === "magnet").length;

  if (shieldCount === 0 && diceCount === 0 && magnetCount === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 select-none pointer-events-auto">
      {/* 1. Shield Button */}
      {shieldCount > 0 && (
        <motion.button
          type="button"
          whileTap={{ scale: 0.95 }}
          disabled={disabled}
          onClick={() => {
            hapticSelection();
            onToggleItem("shield");
          }}
          className={`relative px-2.5 py-1.5 rounded-xl border flex items-center gap-1.5 transition-all duration-200 cursor-pointer text-left ${
            activeItem === "shield"
              ? "bg-[#00ffaa]/20 border-[#00ffaa] shadow-[0_0_12px_rgba(0,255,170,0.4)]"
              : "bg-black/80 border-[#00ffaa]/30 hover:border-[#00ffaa]/60 hover:bg-[#00ffaa]/10"
          } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
          title="Файрвол: поглощает ловушку и откат назад"
        >
          <div className="relative">
            <Shield
              size={14}
              className={activeItem === "shield" ? "text-[#00ffaa] animate-pulse" : "text-[#00ffaa]/80"}
            />
            {activeItem === "shield" && (
              <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-[#00ffaa] animate-ping" />
            )}
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1">
              <span className="font-mono font-black text-[9px] text-[#00ffaa] tracking-wider uppercase">
                ЩИТ
              </span>
              <span className="px-1 py-0.2 rounded-full bg-[#00ffaa]/20 border border-[#00ffaa]/40 font-mono text-[8px] font-bold text-[#00ffaa]">
                ×{shieldCount}
              </span>
            </div>
            <span className="font-mono text-[7px] text-white/60">
              {activeItem === "shield" ? "АКТИВИРОВАН" : "защита"}
            </span>
          </div>
        </motion.button>
      )}

      {/* 2. Loaded Dice Button */}
      {diceCount > 0 && (
        <motion.button
          type="button"
          whileTap={{ scale: 0.95 }}
          disabled={disabled}
          onClick={() => {
            hapticSelection();
            onToggleItem("loaded_dice");
          }}
          className={`relative px-2.5 py-1.5 rounded-xl border flex items-center gap-1.5 transition-all duration-200 cursor-pointer text-left ${
            activeItem === "loaded_dice"
              ? "bg-[#ffb84d]/20 border-[#ffb84d] shadow-[0_0_12px_rgba(255,184,77,0.4)]"
              : "bg-black/80 border-[#ffb84d]/30 hover:border-[#ffb84d]/60 hover:bg-[#ffb84d]/10"
          } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
          title="Заряженный кубик: гарантирует выпадение 5 или 6"
        >
          <div className="relative">
            <Sparkles
              size={14}
              className={activeItem === "loaded_dice" ? "text-[#ffb84d] animate-spin" : "text-[#ffb84d]/80"}
            />
            {activeItem === "loaded_dice" && (
              <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-[#ffb84d] animate-ping" />
            )}
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1">
              <span className="font-mono font-black text-[9px] text-[#ffb84d] tracking-wider uppercase">
                КУБ 5-6
              </span>
              <span className="px-1 py-0.2 rounded-full bg-[#ffb84d]/20 border border-[#ffb84d]/40 font-mono text-[8px] font-bold text-[#ffb84d]">
                ×{diceCount}
              </span>
            </div>
            <span className="font-mono text-[7px] text-white/60">
              {activeItem === "loaded_dice" ? "АКТИВИРОВАН" : "чип броска"}
            </span>
          </div>
        </motion.button>
      )}

      {/* 3. Neon Magnet Button */}
      {magnetCount > 0 && (
        <motion.button
          type="button"
          whileTap={{ scale: 0.95 }}
          disabled={disabled}
          onClick={() => {
            hapticSelection();
            onToggleItem("magnet");
          }}
          className={`relative px-2.5 py-1.5 rounded-xl border flex items-center gap-1.5 transition-all duration-200 cursor-pointer text-left ${
            activeItem === "magnet"
              ? "bg-[#00f0ff]/20 border-[#00f0ff] shadow-[0_0_12px_rgba(0,240,255,0.4)]"
              : "bg-black/80 border-[#00f0ff]/30 hover:border-[#00f0ff]/60 hover:bg-[#00f0ff]/10"
          } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
          title="Неоновый магнит: дотягивает на призовую клетку в 1 шаге"
        >
          <div className="relative">
            <Magnet
              size={14}
              className={activeItem === "magnet" ? "text-[#00f0ff] animate-bounce" : "text-[#00f0ff]/80"}
            />
            {activeItem === "magnet" && (
              <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-[#00f0ff] animate-ping" />
            )}
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1">
              <span className="font-mono font-black text-[9px] text-[#00f0ff] tracking-wider uppercase">
                МАГНИТ
              </span>
              <span className="px-1 py-0.2 rounded-full bg-[#00f0ff]/20 border border-[#00f0ff]/40 font-mono text-[8px] font-bold text-[#00f0ff]">
                ×{magnetCount}
              </span>
            </div>
            <span className="font-mono text-[7px] text-white/60">
              {activeItem === "magnet" ? "АКТИВИРОВАН" : "притяжение"}
            </span>
          </div>
        </motion.button>
      )}
    </div>
  );
}
