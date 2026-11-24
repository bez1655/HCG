import React from "react";
import { motion } from "motion/react";
import { Cell, CellType, Player } from "../types";

const boss = [16, 32, 48, 63];
const contract = [6, 20, 36, 50];
const fixer = [10, 26, 44, 58];

interface CellComponentProps {
  cell: Cell;
  hasPlayersOnCell: Player[];
  isSelected: boolean;
  isDraggable: boolean;
  getCellColor: (type: CellType) => string;
  onClick: () => void;
  onDragEnd: (event: any, info: any) => void;
  calibrationMode: boolean;
  isDropBox?: boolean;
}

// Determine icon or symbol based on CellType
const _getCellIcon = (type: CellType) => {
  switch (type) {
    case CellType.START:
      return "✦";
    case CellType.FINISH:
      return "🏆";
    case CellType.BITCOIN:
      return "⬢"; // in-game credits
    case CellType.FLASK:
      return "⚗";
    case CellType.BONUS:
      return "⚡";
    case CellType.SNAKE:
    case CellType.PENALTY:
      return "☣";
    case CellType.ERROR:
      return "⚠";
    default:
      return "";
  }
};

// Determine neon text colors based on CellType when calibration mode is off
const getCellVisualClasses = (type: CellType) => {
  switch (type) {
    case CellType.SNAKE:
    case CellType.PENALTY:
      return "text-red-400/90 drop-shadow-[0_0_2px_rgba(0,0,0,0.9)]";
    case CellType.BONUS:
    case CellType.BITCOIN:
    case CellType.FLASK:
      return "text-[#00ffaa]/90 drop-shadow-[0_0_2px_rgba(0,0,0,0.9)]";
    case CellType.START:
      return "text-fuchsia-300/90 drop-shadow-[0_0_3px_rgba(0,0,0,0.9)] font-bold";
    case CellType.FINISH:
      return "text-yellow-300/90 drop-shadow-[0_0_3px_rgba(0,0,0,0.9)] font-bold";
    default:
      return "text-purple-300/80 drop-shadow-[0_0_2px_rgba(0,0,0,0.9)]";
  }
};

const CellComponent = React.memo(
  ({
    cell,
    hasPlayersOnCell,
    isSelected,
    isDraggable,
    getCellColor,
    onClick,
    onDragEnd,
    calibrationMode,
    isDropBox = false,
  }: CellComponentProps) => {
    const badge = isDropBox ? "Д" : boss.includes(cell.id) ? "Б" : contract.includes(cell.id) ? "К" : fixer.includes(cell.id) ? "Ф" : "";
    const value = cell.type === CellType.FINISH ? "13800" : cell.type === CellType.START ? "СТАРТ" : cell.type === CellType.FLASK || cell.type === CellType.BITCOIN ? String(cell.value) : cell.value > 0 ? `+${cell.value}` : cell.value < 0 ? String(cell.value) : cell.extra?.includes("ХОД") ? "+1Х" : "";
    return (
      <motion.div
        key={cell.id}
        className={`absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center group cell-component-container ${isDraggable ? "cursor-move" : "cursor-pointer"} ${calibrationMode ? "z-50" : "z-20"}`}
        style={{ left: `${cell.x}%`, top: `${cell.y}%` }}
        initial={false}
        onClick={onClick}
        drag={isDraggable ? true : false}
        dragMomentum={false}
        onDragEnd={onDragEnd}
      >
        {calibrationMode ? (
          <motion.div
            className={`w-6 h-6 md:w-8 md:h-8 rounded-full border-2 flex items-center justify-center font-mono text-[9px] md:text-xs font-black transition-all ${getCellColor(
              cell.type
            )} ${isSelected ? "scale-125 border-white ring-2 ring-white shadow-[0_0_15px_#FFFFFF]" : ""} ${isDraggable ? "ring-2 ring-yellow-400 border-dashed animate-pulse cursor-move" : ""}`}
            animate={
              hasPlayersOnCell.length > 0 &&
              cell.type !== CellType.NORMAL &&
              cell.type !== CellType.START &&
              cell.type !== CellType.FINISH
                ? {
                    scale: [1, 1.25, 1],
                    rotate: [0, 5, -5, 0],
                    filter: ["hue-rotate(0deg)", "hue-rotate(90deg)", "hue-rotate(0deg)"],
                  }
                : {}
            }
            transition={{ repeat: Infinity, duration: 0.5 }}
          >
            {cell.id}
          </motion.div>
        ) : (
          <motion.div
            className={`relative min-w-[22px] min-h-[22px] px-0.5 rounded-md border border-cyan-400/70 bg-[#071322] flex flex-col items-center justify-center font-black font-mono text-[10px] leading-none select-none ${getCellVisualClasses(
              cell.type
            )} ${isSelected ? "scale-125 text-white drop-shadow-[0_0_12px_#FFFFFF]" : ""}`}

          >
            <span>{cell.id}{badge && <span className="ml-0.5 text-yellow-300">{badge}</span>}</span>
            {value && <span className="text-[7px] leading-none mt-0.5 text-white">{value}</span>}
          </motion.div>
        )}

        {/* DropBox Crate Beacon Badge */}


        {/* Info Tooltip */}
        {(isSelected || (calibrationMode && cell.type !== CellType.NORMAL)) && (
          <div
            className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-[#0B1426]/90 border border-[#D4A017]/50 rounded text-[9px] text-[#D4A017] font-mono uppercase whitespace-nowrap shadow-lg ${isSelected ? "opacity-100 z-50 animate-cyber-pulse-cyan" : "opacity-0 group-hover:opacity-100 pointer-events-none"}`}
          >
            <div className="font-bold text-white text-glow-cyan">{cell.name}</div>
            {isSelected && (
              <div className="text-gray-400 mt-1 max-w-[120px] whitespace-normal text-[8px] leading-tight">
                {cell.description}
              </div>
            )}
          </div>
        )}

        {/* Visual neon selector ring on selected cell coordinate */}
        {isSelected && (
          <motion.div
            className="absolute w-8 h-8 rounded-full border-2 border-cyan-400 pointer-events-none"
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{
              scale: [0.7, 1.3, 0.7],
              opacity: [0.4, 1.0, 0.4],
              boxShadow: [
                "0 0 8px rgba(6,182,212,0.4), inset 0 0 8px rgba(6,182,212,0.4)",
                "0 0 20px rgba(6,182,212,0.8), inset 0 0 16px rgba(6,182,212,0.8)",
                "0 0 8px rgba(6,182,212,0.4), inset 0 0 8px rgba(6,182,212,0.4)",
              ],
            }}
            transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
          />
        )}

      </motion.div>
    );
  }
);

export default CellComponent;
