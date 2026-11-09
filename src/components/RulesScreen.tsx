import React from "react";
import { playSound, bindVideoSoundtrack } from "../utils/sounds";

interface RulesScreenProps {
  backgroundUrl?: string | null;
  onProceed: () => void;
}

export default function RulesScreen({ backgroundUrl, onProceed }: RulesScreenProps) {
  const [page, setPage] = React.useState<"video" | "text">("video");
  const pathOf = (u: string) => u.split("?")[0].toLowerCase();
  const customIsVideo =
    !!backgroundUrl &&
    (pathOf(backgroundUrl).endsWith(".mp4") ||
      pathOf(backgroundUrl).endsWith(".mov") ||
      backgroundUrl.startsWith("data:video"));
  const bg = customIsVideo ? backgroundUrl! : "/RulesHAP.mp4?v=13";
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  React.useEffect(() => bindVideoSoundtrack(videoRef.current), [bg]);

  const goBoard = () => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.BackButton) tg.BackButton.hide();
    playSound("success");
    onProceed();
  };

  React.useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.BackButton) {
      tg.BackButton.show();
      const handler = () => {
        if (page === "text") setPage("video");
        else goBoard();
      };
      tg.BackButton.onClick(handler);
      return () => {
        tg.BackButton.offClick(handler);
      };
    }
  }, [page]);

  return (
    <div
      id="rules_screen"
      className="relative h-[100dvh] w-full bg-[#0B1426] text-white overflow-hidden font-sans flex justify-center"
    >
      <div className="relative w-full h-full max-w-[500px] bg-[#0B1426] overflow-hidden">
        {page === "video" && (
          <>
            <video
              ref={videoRef}
              src={bg}
              autoPlay
              playsInline
              poster="/RulesHAP.png?v=13"
              className="absolute inset-0 w-full h-full object-cover z-0"
            />
            <div className="absolute bottom-[2%] left-0 right-0 z-50 flex justify-center pointer-events-none">
              <button
                type="button"
                onClick={() => {
                  playSound("click");
                  setPage("text");
                }}
                className="w-[50%] max-w-[200px] relative group cursor-pointer pointer-events-auto"
              >
                <div className="absolute -inset-1 bg-gradient-to-r from-[#D4A017] to-[#EAB308] rounded-full blur opacity-70" />
                <div className="relative bg-[#0d071b] border border-[#D4A017] rounded-full py-2 font-black text-xs tracking-[0.15em] uppercase text-center">
                  ДАЛЬШЕ
                </div>
              </button>
            </div>
          </>
        )}
        {page === "text" && (
          <div className="absolute inset-0 z-10 flex flex-col bg-[#060412]/95 px-4 pt-8 pb-24 overflow-y-auto">
            <h1 className="font-black text-[#00ffaa] tracking-widest text-sm mb-3">ПРАВИЛА ГОРОДА</h1>
            <div className="text-[13px] leading-relaxed text-white/85 space-y-3 font-sans">
              <p>
                Покупка в Hapstore открывает ход. Несколько товаров — пачка бросков подряд. Кубик
                считает сервер.
              </p>
              <p>
                Качай героя: контракты, фиксер, боссы на 16, 32, 48 и 63 дают опыт и статы. Клетка 64
                — Ядро и МЕГА-КРИСТАЛЛ.
              </p>
              <p>
                +1 ход с клетки или fever — часть игры, его можно тратить сразу.
              </p>
              <p>
                Призы магазина: скидки 1000 / 1500 / 2000 и кристаллы (малый, кристалл, мега). Внутри
                пачки остаётся самый ценный: кристаллы выше скидок, из скидок — большая сумма. Когда
                пачка кончилась, новый ход откроют после выдачи приза в магазине.
              </p>
              <p>
                Скидка Hapstore за покупки: 3 → 3%, 8 → 5%, 15 → 7%, 25 → 10%. Фиксер подскажет карту
                сектора и поставит хром-печать на проверку.
              </p>
            </div>
            <div className="absolute bottom-[2%] left-0 right-0 z-50 flex justify-center pointer-events-none">
              <button
                type="button"
                onClick={goBoard}
                className="w-[50%] max-w-[200px] relative group cursor-pointer pointer-events-auto"
              >
                <div className="absolute -inset-1 bg-gradient-to-r from-[#D4A017] to-[#EAB308] rounded-full blur opacity-70" />
                <div className="relative bg-[#0d071b] border border-[#D4A017] rounded-full py-2 font-black text-xs tracking-[0.15em] uppercase text-center">
                  ПОНЯТНО
                </div>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
