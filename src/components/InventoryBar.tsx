import React from "react";
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

  const slot = (
    id: "shield" | "loaded_dice" | "magnet",
    count: number,
    label: string,
    color: string,
    Icon: typeof Shield
  ) => (
    <button
      type="button"
      disabled={disabled || count === 0}
      onClick={() => {
        if (count === 0) return;
        hapticSelection();
        onToggleItem(id);
      }}
      className={`px-2 py-1 rounded-lg border flex items-center gap-1 text-left ${
        activeItem === id ? "bg-black/70" : "bg-black/80"
      } ${disabled || count === 0 ? "opacity-40" : ""}`}
      style={{
        borderColor: activeItem === id ? color : `${color}55`,
      }}
      title={label}
    >
      <Icon size={14} color={color} />
      <span className="font-mono text-[9px] font-bold uppercase" style={{ color }}>
        {label} ×{count}
      </span>
    </button>
  );

  return (
    <div className="flex items-center gap-1.5 select-none pointer-events-auto">
      {slot("shield", shieldCount, "Щит", "#00ffaa", Shield)}
      {slot("loaded_dice", diceCount, "Куб", "#ffb84d", Sparkles)}
      {slot("magnet", magnetCount, "Магнит", "#00f0ff", Magnet)}
    </div>
  );
}
