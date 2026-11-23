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
    <div className="flex flex-col items-start gap-1.5 select-none pointer-events-auto">
      {/* Header title as seen on screenshot */}
      <div className="w-[78px] text-center px-2 py-0.5 bg-[#050c18]/90 border border-[#00f0ff]/70 rounded-lg shadow-[0_0_10px_rgba(0,240,255,0.4)]">
        <span className="font-mono text-[9px] font-black tracking-[0.2em] text-[#00f0ff] uppercase drop-shadow-[0_0_8px_rgba(0,240,255,0.8)]">
          ИНВЕНТАРЬ
        </span>
      </div>

      {/* 3 vertical cyber slots with icon on top and 2-line centered label */}
      <div className="flex flex-col gap-2 w-[78px]">
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
              className={`relative min-h-[74px] w-full p-1.5 flex flex-col items-center justify-center text-center rounded-2xl transition-all duration-200 cursor-pointer ${
                isActive
                  ? "bg-gradient-to-b from-[#08223f]/95 to-[#051122]/95 border-2 border-[#00f0ff] shadow-[0_0_20px_rgba(0,240,255,0.8)] scale-[1.03]"
                  : "bg-gradient-to-b from-[#061426]/90 to-[#020712]/95 border border-[#00f0ff]/50 hover:border-[#00f0ff] shadow-[0_0_12px_rgba(0,240,255,0.25)]"
              } ${!isUsable ? "opacity-60 cursor-not-allowed hover:border-[#00f0ff]/30" : "active:scale-95"}`}
            >
              {/* Photorealistic 3D Icon */}
              <div className="relative w-[34px] h-[34px] shrink-0 flex items-center justify-center my-0.5">
                <img
                  src={item.iconSrc}
                  alt={item.line1}
                  className="w-full h-full object-contain filter drop-shadow-[0_0_8px_rgba(0,240,255,0.7)]"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = "/Dice.png?v=16";
                  }}
                />
              </div>

              {/* Text label in 2 lines centered */}
              <div className="flex flex-col items-center justify-center min-w-0 leading-tight mt-0.5">
                <span className="font-mono text-[8px] font-bold text-white tracking-tight truncate max-w-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                  {item.line1}
                </span>
                <span className="font-mono text-[8px] font-bold text-white/90 tracking-tight truncate max-w-full drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                  {item.line2}
                </span>
              </div>

              {/* Count badge in corner */}
              {item.count > 0 && (
                <div className="absolute top-1 right-1 px-1 py-0.2 bg-black/80 rounded border border-white/20">
                  <span
                    className="font-mono text-[8px] font-black"
                    style={{ color: item.color }}
                  >
                    ×{item.count}
                  </span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
