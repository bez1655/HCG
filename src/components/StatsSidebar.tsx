import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { BarChart2, ChevronRight, ChevronLeft, MapPin, Repeat } from "lucide-react";
import { GameState } from "../types";
import PlayerAvatarWithBadges from "./PlayerAvatarWithBadges";
import ActiveTurnIndicator from "./ActiveTurnIndicator";
import { playSound } from "../utils/sounds";

interface StatsSidebarProps {
  gameState: GameState;
  userId: string;
  onSelectCell?: (cellId: number) => void;
}

export default function StatsSidebar({ gameState, onSelectCell }: StatsSidebarProps) {
  const [isOpen, setIsOpen] = useState(false);

  const totalBoardCells = gameState.cells?.length || 60;

  // Sort players by position descending
  const sortedPlayers = [...(gameState.players || [])]
    .filter((p) => p.role === "player")
    .sort((a, b) => b.cell - a.cell);

  const activeTurnPlayer = gameState.players?.find(
    (p) =>
      p.id === gameState.currentPlayerId ||
      (p.turnApprovedUntil && p.turnApprovedUntil > Date.now())
  );

  return (
    <>
      {/* 1. COLLAPSED TRIGGER TAB (Floating on Right Edge) */}
      {!isOpen && (
        <button
          type="button"
          onClick={() => {
            playSound("click");
            setIsOpen(true);
          }}
          className="fixed right-0 top-1/3 z-40 bg-black/85 backdrop-blur-md border-l-2 border-y border-[#00ffaa]/50 text-[#00ffaa] hover:bg-[#00ffaa]/15 hover:border-[#00ffaa] py-3 px-1.5 rounded-l-2xl shadow-[0_0_20px_rgba(0,255,170,0.25)] flex flex-col items-center gap-2 cursor-pointer transition-all duration-300 group"
          title="Открыть статистику игроков"
        >
          <ChevronLeft size={16} className="group-hover:-translate-x-0.5 transition-transform" />
          <BarChart2 size={16} className="animate-pulse" />
          <span className="[writing-mode:vertical-lr] font-mono text-[9px] font-black uppercase tracking-[0.2em] py-1 text-white/90 group-hover:text-[#00ffaa]">
            СТАТИСТИКА
          </span>
          {/* Active Turn Dot on Trigger */}
          {activeTurnPlayer && (
            <span
              className="w-2 h-2 rounded-full animate-ping"
              style={{ backgroundColor: activeTurnPlayer.color || "#00ffaa" }}
            />
          )}
        </button>
      )}

      {/* 2. EXPANDABLE SIDEBAR (Right Drawer) */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop for mobile */}
            <div
              className="fixed inset-0 bg-black/40 backdrop-blur-xs z-40 md:hidden"
              onClick={() => setIsOpen(false)}
            />

            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 240 }}
              className="fixed right-0 top-0 bottom-0 z-50 w-[300px] md:w-[320px] bg-black/95 backdrop-blur-xl border-l border-[#00ffaa]/30 p-4 md:p-5 flex flex-col gap-4 shadow-[0_0_40px_rgba(0,0,0,0.9)] select-none pointer-events-auto overflow-hidden"
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <div className="flex items-center gap-2">
                  <BarChart2 size={18} className="text-[#00ffaa]" />
                  <span className="font-mono text-xs font-black text-[#00ffaa] uppercase tracking-[0.15em]">
                    СТАТИСТИКА ИГРОКОВ
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    playSound("click");
                    setIsOpen(false);
                  }}
                  className="p-1 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition cursor-pointer"
                  title="Свернуть панель"
                >
                  <ChevronRight size={18} />
                </button>
              </div>

              {/* Match Summary Cards */}
              <div className="grid grid-cols-2 gap-2 text-mono text-[10px]">
                <div className="bg-white/5 border border-white/10 rounded-xl p-2 flex flex-col">
                  <span className="text-white/50 text-[9px]">ЛИДЕР ИГРЫ</span>
                  <span
                    className="font-black text-xs truncate mt-0.5"
                    style={{ color: sortedPlayers[0]?.color || "#00ffaa" }}
                  >
                    {sortedPlayers[0] ? `👑 ${sortedPlayers[0].name}` : "—"}
                  </span>
                </div>
                <div className="bg-white/5 border border-white/10 rounded-xl p-2 flex flex-col">
                  <span className="text-white/50 text-[9px]">АКТИВНЫЙ ХОД</span>
                  <span
                    className="font-black text-xs truncate mt-0.5 flex items-center gap-1"
                    style={{ color: activeTurnPlayer?.color || "#fff" }}
                  >
                    {activeTurnPlayer ? (
                      <>
                        <ActiveTurnIndicator
                          player={activeTurnPlayer}
                          gameState={gameState}
                          size="sm"
                        />
                        <span>{activeTurnPlayer.name}</span>
                      </>
                    ) : (
                      "Ожидание..."
                    )}
                  </span>
                </div>
              </div>

              {/* Players Stats List */}
              <div className="flex-1 overflow-y-auto space-y-3 scrollbar-none pr-1">
                {sortedPlayers.map((player, idx) => {
                  const currentCellObj = gameState.cells?.find((c) => c.id === player.cell);
                  const distanceTraveled = player.cell;
                  const lapCount = Math.floor(player.cell / totalBoardCells) + 1;
                  const isCurrentTurn =
                    gameState.currentPlayerId === player.id ||
                    !!(player.turnApprovedUntil && player.turnApprovedUntil > Date.now());

                  return (
                    <div
                      key={player.id}
                      onClick={() => {
                        playSound("click");
                        if (currentCellObj) onSelectCell?.(currentCellObj.id);
                      }}
                      className={`border p-3 rounded-2xl flex flex-col gap-2.5 cursor-pointer transition-all duration-200 hover:border-[#00ffaa]/60 ${
                        isCurrentTurn
                          ? "border-[#00ffaa] bg-[#00ffaa]/10 shadow-[0_0_15px_rgba(0,255,170,0.15)]"
                          : "border-white/10 bg-white/5 hover:bg-white/10"
                      }`}
                    >
                      {/* Player Header Row */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <PlayerAvatarWithBadges player={player} gameState={gameState} size="sm" />
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className="font-mono text-xs font-black truncate"
                              style={{ color: player.color }}
                            >
                              {player.name}
                            </span>
                            {/* Pulse Indicator next to player's name */}
                            <ActiveTurnIndicator
                              player={player}
                              gameState={gameState}
                              size="sm"
                              showTextLabel
                            />
                          </div>
                        </div>

                        {/* Rank Badge */}
                        <span className="shrink-0 font-mono text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/10 border border-white/20 text-white">
                          #{idx + 1}
                        </span>
                      </div>

                      {/* Stat Grid */}
                      <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-white/10 text-[10px] font-mono">
                        {/* 1. Distance Traveled */}
                        <div className="flex flex-col bg-black/40 p-1.5 rounded-lg border border-white/5">
                          <span className="text-white/50 text-[8px] uppercase tracking-wider flex items-center gap-1">
                            <MapPin size={10} className="text-[#00ffaa]" /> Дистанция
                          </span>
                          <span className="font-bold text-white mt-0.5">
                            {distanceTraveled} кл.{" "}
                            <span className="text-white/40 font-normal">
                              ({distanceTraveled * 100} м)
                            </span>
                          </span>
                        </div>

                        {/* 2. Current Lap Count */}
                        <div className="flex flex-col bg-black/40 p-1.5 rounded-lg border border-white/5">
                          <span className="text-white/50 text-[8px] uppercase tracking-wider flex items-center gap-1">
                            <Repeat size={10} className="text-purple-400" /> Круг
                          </span>
                          <span className="font-bold text-purple-300 mt-0.5">Круг #{lapCount}</span>
                        </div>
                      </div>

                      {/* Cell Position Details */}
                      <div className="flex items-center justify-between text-[9px] font-mono text-white/70 bg-black/30 px-2 py-1 rounded-lg">
                        <span className="truncate">
                          📍 {currentCellObj?.name || `Клетка #${player.cell}`}
                        </span>
                        {player.lastRoll !== null && (
                          <span className="shrink-0 font-bold text-[#00ffaa]">
                            🎲 {player.lastRoll}
                          </span>
                        )}
                      </div>

                      {/* Active Bonus if present */}
                      {player.activeBonus && (
                        <div className="flex items-center gap-1 text-[9px] font-mono font-bold text-yellow-300 bg-yellow-500/10 border border-yellow-500/30 px-2 py-1 rounded-lg">
                          <span>🎁</span>
                          <span className="truncate">
                            {player.activeBonus.extra || player.activeBonus.name}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Footer */}
              <div className="border-t border-white/10 pt-2 text-[9px] font-mono text-center text-white/40">
                Кликните по игроку, чтобы перейти к его клетке
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
