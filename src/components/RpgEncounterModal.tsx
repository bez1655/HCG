import React from "react";
import { RpgEncounterSession } from "../types";
import { CLASS_LABEL } from "../game/encounters";

interface Props {
  session: RpgEncounterSession;
  className?: string;
  onChoose: (choiceId: string) => void;
  onClose: () => void;
}

export default function RpgEncounterModal({ session, onChoose, onClose }: Props) {
  const title =
    session.type === "boss"
      ? session.boss?.name || "Сторож"
      : session.type === "quest"
        ? session.quest?.title || "Накладная"
        : session.merchant?.name || "Фиксер";

  return (
    <div className="absolute inset-0 z-[80] flex items-end sm:items-center justify-center p-3 bg-black/70 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-sm bg-[#0a0814] border border-[#00ffaa]/40 rounded-2xl p-4 font-mono text-xs text-white shadow-[0_0_24px_rgba(0,255,170,0.2)]">
        <div className="text-[10px] tracking-widest text-[#00ffaa]/80 uppercase mb-1">
          Клетка {session.cellId} · {session.type}
        </div>
        <div className="text-base font-black text-[#00ffaa] mb-2">{title}</div>
        {!session.resolved && session.type === "boss" && session.boss && (
          <>
            <p className="text-white/80 mb-3 leading-relaxed">{session.boss.description}</p>
            <p className="text-white/50 mb-3">
              Одна проверка D20 + {session.boss.weakness.toUpperCase()} против сложности {session.boss.dc}.
              Награда — опыт и очки лояльности, не ход.
            </p>
            <button
              type="button"
              className="w-full min-h-[44px] rounded-xl bg-[#00ffaa]/20 border border-[#00ffaa] text-[#00ffaa] font-black"
              onClick={() => onChoose("fight")}
            >
              Проверка
            </button>
          </>
        )}
        {!session.resolved && session.type === "quest" && session.quest && (
          <>
            <p className="text-white/80 mb-3">{session.quest.description}</p>
            <div className="space-y-2">
              {session.quest.choices.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="w-full min-h-[44px] rounded-xl border border-white/20 text-left px-3 py-2 hover:border-[#00ffaa]"
                  onClick={() => onChoose(c.id)}
                >
                  {c.text}
                </button>
              ))}
            </div>
          </>
        )}
        {!session.resolved && session.type === "merchant" && (
          <>
            <p className="text-white/80 mb-3">{session.merchant?.welcomeText}</p>
            <div className="space-y-2">
              {(session.merchant?.choices || [{ id: "leave", text: "Уйти" }]).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="w-full min-h-[44px] rounded-xl border border-white/20 text-left px-3 py-2 hover:border-[#00ffaa]"
                  onClick={() => onChoose(c.id)}
                >
                  {c.text}
                </button>
              ))}
            </div>
          </>
        )}
        {session.resolved && (
          <>
            <p className="text-white/90 mb-3 leading-relaxed">{session.resultMessage}</p>
            {session.lastRoll != null && (
              <p className="text-[#f5c542] mb-3">Бросок сервера: {session.lastRoll}</p>
            )}
            <button
              type="button"
              className="w-full min-h-[44px] rounded-xl bg-[#00ffaa] text-black font-black"
              onClick={onClose}
            >
              Дальше
            </button>
          </>
        )}
        <p className="mt-3 text-[10px] text-white/35">
          Классы: {Object.values(CLASS_LABEL).join(" · ")}. Качай героя.
        </p>
      </div>
    </div>
  );
}
