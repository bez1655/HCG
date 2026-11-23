import React from "react";
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
  const diceCount = inventory.filter((i) => i === "loaded_dice").length;
  const magnetCount = inventory.filter((i) => i === "magnet").length;
  const shieldCount = inventory.filter((i) => i === "shield").length;

  const items = [
    {
      id: "loaded_dice" as const,
      count: diceCount,
      line1: "Заряженный",
      line2: "кубик",
      color: "#ffb84d",
      iconSrc: "/assets/ui/icon_loaded_dice.png",
      glowColor: "rgba(255, 184, 77, 0.6)",
    },
    {
      id: "magnet" as const,
      count: magnetCount,
      line1: "Неоновый",
      line2: "магнит",
      color: "#00f0ff",
      iconSrc: "/assets/ui/icon_neon_magnet.png",
      glowColor: "rgba(0, 240, 255, 0.6)",
    },
    {
      id: "shield" as const,
      count: shieldCount,
      line1: "Щит",
      line2: "«Файрвол»",
      color: "#00ffaa",
      iconSrc: "/assets/ui/icon_firewall_shield.png",
      glowColor: "rgba(0, 255, 170, 0.6)",
    },
  ];

  return (
    <div className="flex flex-col items-start gap-1 select-none pointer-events-auto">
      {/* Header title as seen on screenshot */}
      <div className="flex items-center gap-1 px-1 py-0.5">
        <span className="font-mono text-[9px] font-black tracking-[0.24em] text-[#00f0ff] uppercase drop-shadow-[0_0_8px_rgba(0,240,255,0.7)]">
          ИНВЕНТАРЬ
        </span>
      </div>

      {/* 3 vertical cyber slots with chamfered corners */}
      <div className="flex flex-col gap-1.5 w-[118px]">
        {items.map((item) => {
          const isActive = activeItem === item.id;
          const isUsable = !disabled && item.count > 0;

          return (
            <button
              key={item.id}
              type="button"
              disabled={!isUsable}
              onClick={() => {
                if (!isUsable) return;
                hapticSelection();
                onToggleItem(item.id);
              }}
              title={`${item.line1} ${item.line2} (×${item.count})`}
              className={`relative min-h-[46px] w-full px-2 py-1.5 flex items-center gap-1.5 text-left transition-all duration-150 cursor-pointer ${
                isActive
                  ? "bg-[#06182a]/95 border border-[#00f0ff] shadow-[0_0_16px_rgba(0,240,255,0.7)] scale-[1.02]"
                  : "bg-[#050c18]/90 border border-[#00f0ff]/35 hover:border-[#00f0ff]/75 hover:bg-[#071324]/90 shadow-[0_0_10px_rgba(0,0,0,0.6)]"
              } ${!isUsable ? "opacity-40 cursor-not-allowed hover:border-[#00f0ff]/20" : "active:scale-95"}`}
              style={{
                clipPath: "polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px)",
              }}
            >
              {/* Photorealistic 3D Icon */}
              <div className="relative w-[28px] h-[28px] shrink-0 flex items-center justify-center">
                <img
                  src={item.iconSrc}
                  alt={item.line1}
                  className="w-full h-full object-contain filter drop-shadow-[0_0_6px_rgba(0,240,255,0.5)]"
                  onError={(e) => {
                    // Fallback with cache-busting tag
                    (e.target as HTMLImageElement).src = "/Dice.png?v=14";
                  }}
                />
              </div>

              {/* Text label in 2 lines */}
              <div className="flex flex-col min-w-0 leading-tight">
                <span className="font-mono text-[9px] font-bold text-white tracking-tight truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                  {item.line1}
                </span>
                <span className="font-mono text-[9px] font-bold text-white/90 tracking-tight truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
                  {item.line2}
                </span>
              </div>

              {/* Count badge */}
              <div className="ml-auto shrink-0 pl-0.5">
                <span
                  className="font-mono text-[9.5px] font-black"
                  style={{ color: item.count > 0 ? item.color : "rgba(255,255,255,0.4)" }}
                >
                  ×{item.count}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
