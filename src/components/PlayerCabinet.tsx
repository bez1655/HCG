import React, { useState } from "react";
import { X, Gift, Award } from "lucide-react";
import { GameState, Player, PrizeRecord } from "../types";
import { getPlayerAchievements } from "../utils/achievements";
import PlayerAchievementBadges from "./PlayerAchievementBadges";

interface PlayerCabinetProps {
  me: Player | undefined;
  gameState: GameState;
  prizes: PrizeRecord[];
  onClose: () => void;
}

export default function PlayerCabinet({ me, gameState, prizes, onClose }: PlayerCabinetProps) {
  const [tab, setTab] = useState<"prizes" | "badges">("prizes");
  const achievements = me ? getPlayerAchievements(me, gameState) : [];
  const rows = [...prizes].reverse();

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center p-4 bg-black/80 pointer-events-auto">
      <div className="relative w-full max-w-sm bg-black/95 border-2 border-[#00ffaa]/40 rounded-2xl p-4 font-mono text-xs text-white">
        <div className="flex justify-between items-center border-b border-white/10 pb-2 mb-3">
          <span className="text-[#00ffaa] font-black tracking-widest uppercase">Мой кабинет</span>
          <button type="button" onClick={onClose} className="text-white/60 hover:text-white">
            <X size={16} />
          </button>
        </div>
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            onClick={() => setTab("prizes")}
            className={`flex-1 py-1.5 rounded-lg border ${tab === "prizes" ? "border-[#00ffaa] text-[#00ffaa]" : "border-white/15 text-white/50"}`}
          >
            <Gift size={12} className="inline mr-1" />
            Призы
          </button>
          <button
            type="button"
            onClick={() => setTab("badges")}
            className={`flex-1 py-1.5 rounded-lg border ${tab === "badges" ? "border-[#00ffaa] text-[#00ffaa]" : "border-white/15 text-white/50"}`}
          >
            <Award size={12} className="inline mr-1" />
            Награды
          </button>
        </div>

        {tab === "prizes" ? (
          <div className="max-h-[50vh] overflow-y-auto space-y-2">
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
        ) : (
          <div className="space-y-3">
            {me && <PlayerAchievementBadges player={me} gameState={gameState} />}
            {achievements.length === 0 && (
              <div className="text-white/40 text-center py-6">Наград пока нет — ходите по доске</div>
            )}
            <ul className="space-y-2 max-h-[45vh] overflow-y-auto">
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
      </div>
    </div>
  );
}
