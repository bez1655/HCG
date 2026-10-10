import React from "react";
import { playSound } from "../utils/sounds";

interface RulesScreenProps {
  backgroundUrl?: string | null;
  onProceed: () => void;
}

export default function RulesScreen({ backgroundUrl, onProceed }: RulesScreenProps) {
  const pathOf = (u: string) => u.split("?")[0].toLowerCase();
  const customIsVideo =
    !!backgroundUrl &&
    (pathOf(backgroundUrl).endsWith(".mp4") ||
      pathOf(backgroundUrl).endsWith(".mov") ||
      backgroundUrl.startsWith("data:video"));
  const bg = customIsVideo ? backgroundUrl! : "/RulesHAP.mp4?v=9";
  const isVideo = true;
  const videoRef = React.useRef<HTMLVideoElement | null>(null);

  React.useEffect(() => bindVideoSoundtrack(videoRef.current), [bg]);

  const handleProceed = () => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.BackButton) {
      tg.BackButton.hide();
    }
    playSound("success");
    onProceed();
  };

  React.useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.BackButton) {
      tg.BackButton.show();
      const handler = () => handleProceed();
      tg.BackButton.onClick(handler);
      return () => {
        tg.BackButton.offClick(handler);
      };
    }
  }, []);

  return (
    <div
      id="rules_screen"
      className="relative h-[100dvh] w-full bg-[#0B1426] text-white overflow-hidden font-sans flex justify-center"
    >
      <div className="relative w-full h-full max-w-[500px] bg-[#0B1426] overflow-hidden">
        {isVideo ? (
          <video
            ref={videoRef}
            src={bg}
            autoPlay
            loop
            playsInline
            poster="/RulesHAP.png?v=9"
            className="absolute inset-0 w-full h-full object-cover z-0"
          ></video>
        ) : (
          <img
            src={bg}
            alt="Rules Background"
            className="absolute inset-0 w-full h-full object-cover z-0"
          />
        )}
        <div className="absolute inset-0 z-0 pointer-events-none"></div>
        {/* Proceed Button */}
        <div className="absolute bottom-[2%] left-0 right-0 z-50 flex justify-center pointer-events-none">
          <button
            onClick={handleProceed}
            className="w-[50%] max-w-[200px] relative group cursor-pointer pointer-events-auto"
          >
            <div className="absolute -inset-1 bg-gradient-to-r from-[#D4A017] to-[#EAB308] rounded-full blur opacity-70 group-hover:opacity-100 transition duration-300"></div>
            <div className="relative bg-[#0d071b] border border-[#D4A017] rounded-full py-2 font-black text-xs md:text-sm tracking-[0.15em] uppercase text-white hover:text-[#EAB308] text-center transition duration-300 shadow-[0_0_10px_rgba(212,160,23,0.4)]">
              ПОНЯТНО
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
