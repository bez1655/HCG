import React, { useState } from "react";
import { X, Gift, Award, Sparkles, Check } from "lucide-react";
import { GameState, Player, PrizeRecord } from "../types";
import { getPlayerAchievements } from "../utils/achievements";
import PlayerAchievementBadges from "./PlayerAchievementBadges";
import ChipImage from "./ChipImage";
import { CYBER_SKINS, CYBER_NEON_COLORS, getSkinBySrc } from "../game/skins";
import { playSound } from "../utils/sounds";
import { hapticNotification, hapticSelection } from "../utils/haptics";

interface PlayerCabinetProps {
  me: Player | undefined;
  gameState: GameState;
  prizes: PrizeRecord[];
  onClose: () => void;
  onUpdateSkin?: (chipImage: string, color: string) => void;
}

export default function PlayerCabinet({
  me,
  gameState,
  prizes,
  onClose,
  onUpdateSkin,
}: PlayerCabinetProps) {
  const [tab, setTab] = useState<"prizes" | "badges" | "skins">("prizes");
  const achievements = me ? getPlayerAchievements(me, gameState) : [];
  const rows = [...prizes].reverse();

  // Custom skin & color state
  const [selectedChip, setSelectedChip] = useState<string>(me?.chipImage || "/chips/chip_1.svg");
  const [selectedColor, setSelectedColor] = useState<string>(me?.color || "#00ffaa");
  const [isSaved, setIsSaved] = useState(false);

  const currentSkin = getSkinBySrc(selectedChip);

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center p-4 bg-black/80 pointer-events-auto">
      <div className="relative w-full max-w-sm bg-black/95 border-2 border-[#00ffaa]/40 rounded-2xl p-4 font-mono text-xs text-white shadow-[0_0_25px_rgba(0,255,170,0.25)]">
        {/* Header */}
        <div className="flex justify-between items-center border-b border-white/10 pb-2 mb-3">
          <span className="text-[#00ffaa] font-black tracking-widest uppercase">Мой кабинет</span>
          <button type="button" onClick={onClose} className="text-white/60 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex gap-1.5 mb-3">
          <button
            type="button"
            onClick={() => {
              playSound("click");
              hapticSelection();
              setTab("prizes");
            }}
            className={`flex-1 py-1.5 rounded-lg border text-center transition-all ${
              tab === "prizes"
                ? "border-[#00ffaa] text-[#00ffaa] bg-[#00ffaa]/10"
                : "border-white/15 text-white/50 hover:border-white/30"
            }`}
          >
            <Gift size={12} className="inline mr-1" />
            Призы
          </button>
          <button
            type="button"
            onClick={() => {
              playSound("click");
              hapticSelection();
              setTab("badges");
            }}
            className={`flex-1 py-1.5 rounded-lg border text-center transition-all ${
              tab === "badges"
                ? "border-[#00ffaa] text-[#00ffaa] bg-[#00ffaa]/10"
                : "border-white/15 text-white/50 hover:border-white/30"
            }`}
          >
            <Award size={12} className="inline mr-1" />
            Награды
          </button>
          <button
            type="button"
            onClick={() => {
              playSound("click");
              hapticSelection();
              setTab("skins");
            }}
            className={`flex-1 py-1.5 rounded-lg border text-center transition-all ${
              tab === "skins"
                ? "border-[#00ffaa] text-[#00ffaa] bg-[#00ffaa]/10"
                : "border-white/15 text-white/50 hover:border-white/30"
            }`}
          >
            <Sparkles size={12} className="inline mr-1" />
            Облик
          </button>
        </div>

        {/* Tab 1: Prizes */}
        {tab === "prizes" && (
          <div className="max-h-[50vh] overflow-y-auto space-y-2 pr-1">
            {me?.activeBonus && (
              <div className="border border-yellow-500/40 bg-yellow-500/10 rounded-lg p-2 text-yellow-200">
                Сейчас ждёт выдачи: <b>{me.activeBonus.extra || me.activeBonus.name}</b>
              </div>
            )}
            {rows.length === 0 && !me?.activeBonus && (
              <div className="text-white/40 text-center py-6">Призов пока нет</div>
            )}
            {rows.map((r, i) => (
              <div key={i} className="border border-white/10 rounded-lg p-2">
                <div className="font-bold text-[#00ffaa]">{r.extra || r.name}</div>
                <div className="text-[10px] text-white/50">
                  {new Date(r.at).toLocaleString("ru-RU")} · {r.redeemed ? "выдан в магазине" : "ещё не выдан"}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Tab 2: Badges & Achievements */}
        {tab === "badges" && (
          <div className="space-y-3">
            {me && <PlayerAchievementBadges player={me} gameState={gameState} />}
            {achievements.length === 0 && (
              <div className="text-white/40 text-center py-6">Наград пока нет — ходите по доске</div>
            )}
            <ul className="space-y-2 max-h-[45vh] overflow-y-auto pr-1">
              {achievements.map((a) => (
                <li key={a.id} className="border border-white/10 rounded-lg p-2">
                  <div>
                    {a.icon} <b>{a.name}</b>
                  </div>
                  <div className="text-[10px] text-white/60">{a.description}</div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Tab 3: Custom Cyber-Skins & Neon Aura */}
        {tab === "skins" && (
          <div className="space-y-3 max-h-[52vh] overflow-y-auto pr-1">
            {/* Live Interactive Token Preview */}
            <div className="flex flex-col items-center justify-center p-3 rounded-xl bg-black/60 border border-white/10 relative overflow-hidden">
              <div
                className="absolute w-24 h-24 rounded-full blur-xl opacity-35 pointer-events-none"
                style={{ backgroundColor: selectedColor }}
              />
              <div className="relative w-12 h-12 flex items-center justify-center mb-1">
                <div
                  className="absolute inset-0 rounded-full border border-dashed animate-spin pointer-events-none"
                  style={{ borderColor: selectedColor, animationDuration: "14s" }}
                />
                <div
                  className="w-10 h-10 relative z-10"
                  style={{ filter: `drop-shadow(0 0 6px ${selectedColor})` }}
                >
                  <ChipImage
                    src={selectedChip}
                    color={selectedColor}
                    label="Превью фишки"
                    className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
                  />
                </div>
              </div>
              <div className="text-center">
                <span className="font-bold text-xs tracking-wide text-white drop-shadow">
                  {currentSkin.icon} {currentSkin.name}
                </span>
                <p className="text-[9px] text-white/60 mt-0.5 max-w-[240px] leading-tight">
                  {currentSkin.description}
                </p>
              </div>
            </div>

            {/* Neon Aura Color Palette */}
            <div>
              <div className="text-[10px] text-white/70 uppercase tracking-wider mb-1.5 flex justify-between items-center">
                <span>Неоновое свечение</span>
                <span className="font-bold text-[9px]" style={{ color: selectedColor }}>
                  {CYBER_NEON_COLORS.find((c) => c.hex.toLowerCase() === selectedColor.toLowerCase())?.name ||
                    selectedColor}
                </span>
              </div>
              <div className="flex gap-2 justify-between">
                {CYBER_NEON_COLORS.map((col) => {
                  const isCurColor = selectedColor.toLowerCase() === col.hex.toLowerCase();
                  return (
                    <button
                      key={col.hex}
                      type="button"
                      onClick={() => {
                        setSelectedColor(col.hex);
                        playSound("click");
                        hapticSelection();
                      }}
                      className={`w-7 h-7 rounded-full flex items-center justify-center transition-all ${
                        isCurColor ? "scale-110 ring-2 ring-white shadow-lg" : "hover:scale-105 opacity-80"
                      }`}
                      style={{
                        backgroundColor: col.hex,
                        boxShadow: `0 0 10px ${col.glow}`,
                      }}
                      title={col.name}
                    >
                      {isCurColor && <Check size={12} className="text-black font-black" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Grid of 13 Cyber-Skins */}
            <div>
              <div className="text-[10px] text-white/70 uppercase tracking-wider mb-1.5">
                Модель фишки (13 скинов)
              </div>
              <div className="grid grid-cols-3 gap-1.5 max-h-[140px] overflow-y-auto pr-1">
                {CYBER_SKINS.map((skin) => {
                  const isSelected = selectedChip.split("?")[0].toLowerCase() === skin.src.toLowerCase();
                  return (
                    <button
                      key={skin.id}
                      type="button"
                      onClick={() => {
                        setSelectedChip(skin.src);
                        playSound("click");
                        hapticSelection();
                      }}
                      className={`p-1.5 rounded-lg border text-left transition-all flex flex-col items-center gap-1 ${
                        isSelected
                          ? "border-[#00ffaa] bg-[#00ffaa]/15 text-white shadow-[0_0_8px_rgba(0,255,170,0.4)]"
                          : "border-white/10 hover:border-white/30 text-white/70 bg-white/5"
                      }`}
                    >
                      <span className="text-base">{skin.icon}</span>
                      <span className="text-[8px] font-bold text-center leading-tight truncate w-full">
                        {skin.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Save Button */}
            <button
              type="button"
              onClick={() => {
                if (onUpdateSkin) {
                  onUpdateSkin(selectedChip, selectedColor);
                  playSound("click");
                  hapticNotification("success");
                  setIsSaved(true);
                  setTimeout(() => setIsSaved(false), 2000);
                }
              }}
              className="w-full py-2 rounded-xl bg-gradient-to-r from-[#00ffaa] to-[#00b377] text-black font-black uppercase tracking-wider text-xs shadow-[0_0_15px_rgba(0,255,170,0.5)] active:scale-95 transition-all flex items-center justify-center gap-1.5"
            >
              {isSaved ? (
                <>
                  <Check size={14} className="stroke-[3]" />
                  Облик сохранён!
                </>
              ) : (
                <>
                  <Sparkles size={14} />
                  Применить облик
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
