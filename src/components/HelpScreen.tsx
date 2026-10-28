/**
 * Экран СПРАВКА — что делает каждая особая клетка.
 *
 * Требования к читаемости определили всю вёрстку:
 *   • крупный шрифт (16–17px в теле, 20px в заголовках разделов);
 *   • тёмная полупрозрачная подложка под КАЖДЫМ блоком текста — фон города
 *     красивый, но пёстрый, и без подложки светлый текст на нём плывёт;
 *   • фон дополнительно приглушён затемняющим слоем поверх картинки;
 *   • цвет рамки кодирует смысл раздела: золото — приз, мята — ускорение,
 *     розовый — штраф.
 *
 * Данные приходят из cells.json через buildGuide(): справка не может
 * разойтись с игрой, потому что читает те же клетки, по которым ходят фишки.
 */
import React from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";
import { Cell } from "../types";
import { buildGuide, guideSummary } from "../game/cellGuide";
import { playSound } from "../utils/sounds";

interface Props {
  cells: Cell[];
  onClose: () => void;
}

export default function HelpScreen({ cells, onClose }: Props) {
  const sections = React.useMemo(() => buildGuide(cells), [cells]);
  const summary = React.useMemo(() => guideSummary(cells), [cells]);

  const close = React.useCallback(() => {
    playSound("click");
    onClose();
  }, [onClose]);

  // Кнопка «назад» в Telegram закрывает справку — иначе она свернёт всё
  // приложение, и игрок вылетит из игры вместо возврата к доске.
  React.useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg?.BackButton) {
      tg.BackButton.show();
      const handler = () => close();
      tg.BackButton.onClick(handler);
      return () => {
        tg.BackButton.offClick(handler);
        tg.BackButton.hide();
      };
    }
  }, [close]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[120] flex justify-center"
      data-testid="help-screen"
      role="dialog"
      aria-label="Справка по клеткам"
    >
      {/* Фон: картинка + затемнение. Второй слой обязателен — без него
          текст читается только на тёмных участках города. */}
      <div className="absolute inset-0" style={{ background: "#0B0914" }}>
        <img
          src="/help-bg.jpg"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover"
          style={{ opacity: 0.5 }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(11,9,20,0.92) 0%, rgba(11,9,20,0.78) 30%, rgba(11,9,20,0.86) 100%)",
          }}
        />
      </div>

      <div className="relative w-full max-w-[520px] h-full flex flex-col">
        {/* Шапка */}
        <div
          className="flex-shrink-0 px-5 pt-5 pb-3"
          style={{
            background: "linear-gradient(180deg, rgba(11,9,20,0.96) 60%, transparent 100%)",
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div
                className="font-black tracking-[0.18em]"
                style={{ fontSize: "11px", color: "#00FFAA" }}
              >
                HAPSTORE CYBER GAME
              </div>
              <h1
                className="font-black leading-tight"
                style={{
                  fontSize: "30px",
                  color: "#FFFFFF",
                  textShadow: "0 2px 12px rgba(0,0,0,0.95)",
                }}
              >
                СПРАВКА
              </h1>
            </div>
            <button
              onClick={close}
              aria-label="Закрыть справку"
              className="flex-shrink-0 mt-1 rounded-full p-2 transition-colors"
              style={{ background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.18)" }}
            >
              <X size={20} color="#FFFFFF" />
            </button>
          </div>

          {/* Сводка: сколько чего на доске */}
          <div className="flex gap-2 mt-3">
            {[
              { n: summary.prizes, label: "призов", color: "#F5C542" },
              { n: summary.boosts, label: "ускорений", color: "#00FFAA" },
              { n: summary.traps, label: "ловушек", color: "#FF6B9D" },
            ].map((s) => (
              <div
                key={s.label}
                className="flex-1 rounded-xl px-2 py-2 text-center"
                style={{
                  background: "rgba(0,0,0,0.6)",
                  border: `1px solid ${s.color}55`,
                }}
              >
                <div className="font-black leading-none" style={{ fontSize: "22px", color: s.color }}>
                  {s.n}
                </div>
                <div style={{ fontSize: "11px", color: "rgba(255,255,255,0.65)", marginTop: 2 }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Прокручиваемое содержимое */}
        <div className="flex-1 overflow-y-auto px-4 pb-6" style={{ WebkitOverflowScrolling: "touch" }}>
          {sections.map((section) => (
            <section key={section.key} className="mb-5">
              <h2
                className="font-black tracking-[0.12em] mb-2.5 px-1"
                style={{
                  fontSize: "20px",
                  color: section.color,
                  textShadow: "0 2px 10px rgba(0,0,0,0.95)",
                }}
              >
                {section.title}
              </h2>

              <div className="flex flex-col gap-2">
                {section.entries.map((entry) => (
                  <div
                    key={`${entry.name}-${entry.cells[0]}`}
                    className="rounded-2xl px-3.5 py-3 flex items-start gap-3"
                    style={{
                      /* Тёмная подложка — то, ради чего она и нужна:
                         текст не зависит от того, что под ним на картинке. */
                      background: "rgba(0,0,0,0.62)",
                      border: `1.5px solid ${section.color}44`,
                      backdropFilter: "blur(3px)",
                    }}
                  >
                    <span
                      className="flex-shrink-0"
                      style={{ fontSize: "26px", lineHeight: 1.1 }}
                      aria-hidden="true"
                    >
                      {entry.icon}
                    </span>

                    <div className="min-w-0 flex-1">
                      <div
                        className="font-bold leading-snug"
                        style={{
                          fontSize: "16.5px",
                          color: "#FFFFFF",
                          textShadow: "0 1px 4px rgba(0,0,0,0.9)",
                        }}
                      >
                        {entry.name}
                      </div>
                      <div
                        className="leading-snug mt-0.5"
                        style={{ fontSize: "15px", color: section.color }}
                      >
                        {entry.effect}
                      </div>
                      <div
                        className="mt-1.5"
                        style={{ fontSize: "13px", color: "rgba(255,255,255,0.62)" }}
                      >
                        {entry.cells.length === 1 ? "Клетка " : "Клетки "}
                        {entry.cells.join(", ")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          {/* Как это работает — короткие правила, которые чаще всего спрашивают */}
          <section className="mb-4">
            <h2
              className="font-black tracking-[0.12em] mb-2.5 px-1"
              style={{ fontSize: "20px", color: "#FFFFFF", textShadow: "0 2px 10px rgba(0,0,0,0.95)" }}
            >
              КАК ЭТО РАБОТАЕТ
            </h2>
            <div
              className="rounded-2xl px-4 py-3.5"
              style={{
                background: "rgba(0,0,0,0.62)",
                border: "1.5px solid rgba(255,255,255,0.18)",
                backdropFilter: "blur(3px)",
              }}
            >
              {[
                "Кубик бросает сервер — результат подкрутить нельзя.",
                "Призы не суммируются: новый заменяет неиспользованный.",
                "Приз выдаёт администратор — он видит каждый ваш ход.",
                "Пока приз не выдан, новые ходы не одобряются.",
                "Результат каждого броска приходит вам в бот.",
              ].map((line, i) => (
                <div
                  key={i}
                  className="flex gap-2.5 items-start"
                  style={{ marginBottom: i === 4 ? 0 : 9 }}
                >
                  <span style={{ color: "#00FFAA", fontSize: "16px", lineHeight: 1.45 }}>▸</span>
                  <span
                    style={{
                      fontSize: "15.5px",
                      lineHeight: 1.45,
                      color: "#EFEBFF",
                      textShadow: "0 1px 3px rgba(0,0,0,0.85)",
                    }}
                  >
                    {line}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Кнопка закрытия */}
        <div className="flex-shrink-0 px-4 pb-5 pt-2">
          <button
            onClick={close}
            className="w-full rounded-2xl py-4 font-black tracking-[0.15em]"
            style={{ fontSize: "16px", background: "#00FFAA", color: "#0B0914" }}
          >
            ПОНЯТНО
          </button>
        </div>
      </div>
    </motion.div>
  );
}
