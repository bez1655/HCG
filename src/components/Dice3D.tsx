import React, { useState, useEffect } from "react";
import { playSound } from "../utils/sounds";

interface Dice3DProps {
  /** Authoritative dice value decided by the server. */
  result: number;
  /** Called once the landing animation has finished. */
  onResult: (result: number) => void;
}

export default function Dice3D({ result, onResult }: Dice3DProps) {
  const diceId = React.useId().replace(/:/g, "");
  const [isSpinning, setIsSpinning] = useState(true);
  // The face to land on is dictated by the server, never generated locally.
  const [targetNumber] = useState<number>(result);
  const [telemetryNumber, setTelemetryNumber] = useState<number>(1);
  const [landed, setLanded] = useState(false);
  const [triggerGlitch, setTriggerGlitch] = useState(false);

  // Determine target number on mount
  useEffect(() => {
    const rolled = targetNumber;

    // Initial roll sound
    playSound("roll");

    // Tactile sound effects during the spin phase
    const soundTimers: NodeJS.Timeout[] = [];

    // Pro-grade game sound cues synchronized with each physical bounce and tumble
    const soundEvents = [
      { delay: 150, sound: "click" }, // Initial whoosh
      { delay: 550, sound: "roll" }, // FIRST HEAVY BOUNCE!
      { delay: 750, sound: "click" }, // Mid-air tumble
      { delay: 1000, sound: "click" }, // Mid-air tumble
      { delay: 1430, sound: "roll" }, // SECOND BOUNCE IMPACT!
      { delay: 1700, sound: "click" }, // Smaller tumble
      { delay: 1980, sound: "click" }, // Final slide and settle contact
      { delay: 2200, sound: "success" }, // CROWN/SETTLED FANFARE!
    ];

    soundEvents.forEach((evt) => {
      const timer = setTimeout(() => {
        playSound(evt.sound as any);
      }, evt.delay);
      soundTimers.push(timer);
    });

    // Fast-changing numbers in HUD telemetry
    const telemetryInterval = setInterval(() => {
      setTelemetryNumber((prev) => {
        let n = Math.floor(Math.random() * 6) + 1;
        while (n === prev) {
          n = Math.floor(Math.random() * 6) + 1;
        }
        return n;
      });
    }, 70);

    // Stop wild spinning and settle on the target face
    const settleTimer = setTimeout(() => {
      clearInterval(telemetryInterval);
      setIsSpinning(false);
      setTelemetryNumber(rolled);
      setLanded(true);
      setTriggerGlitch(true);

      // Auto-turn off glitch after a short duration
      setTimeout(() => setTriggerGlitch(false), 450);
    }, 2200);

    // Wait after settling so the player can appreciate the 3D result before closing
    const finishTimer = setTimeout(() => {
      onResult(rolled);
    }, 4000);

    return () => {
      clearInterval(telemetryInterval);
      soundTimers.forEach(clearTimeout);
      clearTimeout(settleTimer);
      clearTimeout(finishTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // CSS 3D Rotations to show the corresponding face to the camera

  const getAnglesForNumber = (num: number) => {
    switch (num) {
      case 1:
        return { rx: 720, ry: 720, rz: 0 };
      case 6:
        return { rx: 720, ry: 900, rz: 0 };
      case 3:
        return { rx: 720, ry: 630, rz: 0 };
      case 4:
        return { rx: 720, ry: 810, rz: 0 };
      case 2:
        return { rx: 630, ry: 720, rz: 0 };
      case 5:
        return { rx: 810, ry: 720, rz: 0 };
      default:
        return { rx: 0, ry: 0, rz: 0 };
    }
  };

  const _getRotationForNumber = (num: number) => {
    const { rx, ry, rz } = getAnglesForNumber(num);
    return `translateX(0px) translateY(0px) translateZ(0px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(1)`;
  };

  // Render the dots on each face
  const _renderDots = (number: number, color: string) => {
    const dotClass = "w-3 h-3 md:w-4 md:h-4 rounded-full transition-all duration-300";
    const shadowStyle = {
      backgroundColor: color,
      boxShadow: `0 0 12px ${color}, 0 0 24px ${color}, 0 0 35px ${color}`,
    };

    switch (number) {
      case 1:
        return (
          <div className="flex items-center justify-center w-full h-full">
            <div className={`${dotClass} w-6 h-6 md:w-7 md:h-7`} style={shadowStyle} />
          </div>
        );
      case 2:
        return (
          <div className="flex justify-between w-full h-full p-4 flex-col items-stretch">
            <div className="flex justify-start">
              <div className={dotClass} style={shadowStyle} />
            </div>
            <div className="flex justify-end">
              <div className={dotClass} style={shadowStyle} />
            </div>
          </div>
        );
      case 3:
        return (
          <div className="flex justify-between w-full h-full p-4 flex-col items-stretch">
            <div className="flex justify-start">
              <div className={dotClass} style={shadowStyle} />
            </div>
            <div className="flex justify-center">
              <div className={dotClass} style={shadowStyle} />
            </div>
            <div className="flex justify-end">
              <div className={dotClass} style={shadowStyle} />
            </div>
          </div>
        );
      case 4:
        return (
          <div className="flex flex-col justify-between h-full w-full p-4">
            <div className="flex justify-between">
              <div className={dotClass} style={shadowStyle} />
              <div className={dotClass} style={shadowStyle} />
            </div>
            <div className="flex justify-between">
              <div className={dotClass} style={shadowStyle} />
              <div className={dotClass} style={shadowStyle} />
            </div>
          </div>
        );
      case 5:
        return (
          <div className="flex flex-col justify-between h-full w-full p-4 relative">
            <div className="flex justify-between">
              <div className={dotClass} style={shadowStyle} />
              <div className={dotClass} style={shadowStyle} />
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className={dotClass} style={shadowStyle} />
            </div>
            <div className="flex justify-between">
              <div className={dotClass} style={shadowStyle} />
              <div className={dotClass} style={shadowStyle} />
            </div>
          </div>
        );
      case 6:
        return (
          <div className="flex flex-col justify-between h-full w-full p-4">
            <div className="flex justify-between">
              <div className={dotClass} style={shadowStyle} />
              <div className={dotClass} style={shadowStyle} />
            </div>
            <div className="flex justify-between">
              <div className={dotClass} style={shadowStyle} />
              <div className={dotClass} style={shadowStyle} />
            </div>
            <div className="flex justify-between">
              <div className={dotClass} style={shadowStyle} />
              <div className={dotClass} style={shadowStyle} />
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  const facesData = [
    {
      num: 1,
      color: "#00FFFF",
      label: "SYS_CORE",
      borderClass: "border-cyan-400 shadow-[0_0_20px_rgba(6,182,212,0.5)]",
      textClass: "text-cyan-300",
    },
    {
      num: 2,
      color: "#FF00FF",
      label: "LINK_UP",
      borderClass: "border-fuchsia-400 shadow-[0_0_20px_rgba(217,70,239,0.5)]",
      textClass: "text-fuchsia-300",
    },
    {
      num: 3,
      color: "#EAB308",
      label: "IMPULSE",
      borderClass: "border-yellow-400 shadow-[0_0_20px_rgba(234,179,8,0.5)]",
      textClass: "text-yellow-300",
    },
    {
      num: 4,
      color: "#10B981",
      label: "NODE_4",
      borderClass: "border-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.5)]",
      textClass: "text-emerald-300",
    },
    {
      num: 5,
      color: "#F97316",
      label: "CHARGE",
      borderClass: "border-orange-400 shadow-[0_0_20px_rgba(249,115,22,0.5)]",
      textClass: "text-orange-300",
    },
    {
      num: 6,
      color: "#FFFFFF",
      label: "MAX_OUT",
      borderClass: "border-white shadow-[0_0_20px_rgba(255,255,255,0.6)]",
      textClass: "text-white",
    },
  ];

  const themeColor = facesData.find((f) => f.num === targetNumber)?.color || "#D4A017";
  const { rx, ry, rz } = getAnglesForNumber(targetNumber);

  return (
    <div
      className={`fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/25 backdrop-blur-[1px] overflow-hidden font-sans ${triggerGlitch ? "animate-impact-shake" : ""}`}
    >
      {/* Dynamic CSS Stylesheet for 3D Custom Perspective & Animations */}
      <style>{`
        .perspective-1000 {
          perspective: 1200px;
        }
        .transform-style-3d {
          transform-style: preserve-3d;
        }
        .backface-hidden {
          backface-visibility: hidden;
        }

        .face-style-1 { transform: rotateY(0deg) translateZ(64px); }
        .face-style-2 { transform: rotateX(90deg) translateZ(64px); }
        .face-style-3 { transform: rotateY(90deg) translateZ(64px); }
        .face-style-4 { transform: rotateY(-90deg) translateZ(64px); }
        .face-style-5 { transform: rotateX(-90deg) translateZ(64px); }
        .face-style-6 { transform: rotateY(180deg) translateZ(64px); }

        @media (min-width: 768px) {
          .face-style-1 { transform: rotateY(0deg) translateZ(80px); }
          .face-style-2 { transform: rotateX(90deg) translateZ(80px); }
          .face-style-3 { transform: rotateY(90deg) translateZ(80px); }
          .face-style-4 { transform: rotateY(-90deg) translateZ(80px); }
          .face-style-5 { transform: rotateX(-90deg) translateZ(80px); }
          .face-style-6 { transform: rotateY(180deg) translateZ(80px); }
        }

        @keyframes real-roll-${targetNumber}-${diceId} {
          0% {
            transform: translateX(-300px) translateY(-650px) translateZ(0px) rotateX(${rx - 1440}deg) rotateY(${ry - 1800}deg) rotateZ(${rz - 1080}deg) scale(0.4);
          }
          25% {
            transform: translateX(-160px) translateY(0px) translateZ(0px) rotateX(${rx - 720}deg) rotateY(${ry - 1080}deg) rotateZ(${rz - 540}deg) scale(1.12);
          }
          45% {
            transform: translateX(-70px) translateY(-140px) translateZ(0px) rotateX(${rx - 360}deg) rotateY(${ry - 720}deg) rotateZ(${rz - 360}deg) scale(0.92);
          }
          65% {
            transform: translateX(-10px) translateY(0px) translateZ(0px) rotateX(${rx - 180}deg) rotateY(${ry - 360}deg) rotateZ(${rz - 180}deg) scale(1.05);
          }
          80% {
            transform: translateX(15px) translateY(-40px) translateZ(0px) rotateX(${rx - 90}deg) rotateY(${ry - 180}deg) rotateZ(${rz - 90}deg) scale(0.97);
          }
          90% {
            transform: translateX(5px) translateY(0px) translateZ(0px) rotateX(${rx - 25}deg) rotateY(${ry - 40}deg) rotateZ(${rz - 25}deg) scale(1.01);
          }
          95% {
            transform: translateX(1px) translateY(-10px) translateZ(0px) rotateX(${rx + 8}deg) rotateY(${ry - 10}deg) rotateZ(${rz + 4}deg) scale(0.99);
          }
          100% {
            transform: translateX(0px) translateY(0px) translateZ(0px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) scale(1);
          }
        }

        @keyframes shadow-roll-${targetNumber}-${diceId} {
          0% {
            transform: translateX(-300px) scale(0.15);
            opacity: 0.05;
            filter: blur(24px);
          }
          25% {
            transform: translateX(-160px) scale(1.25);
            opacity: 0.9;
            filter: blur(4px);
          }
          45% {
            transform: translateX(-70px) scale(0.6);
            opacity: 0.35;
            filter: blur(14px);
          }
          65% {
            transform: translateX(-10px) scale(1.1);
            opacity: 0.8;
            filter: blur(5px);
          }
          80% {
            transform: translateX(15px) scale(0.8);
            opacity: 0.45;
            filter: blur(9px);
          }
          90% {
            transform: translateX(5px) scale(1.02);
            opacity: 0.85;
            filter: blur(6px);
          }
          95% {
            transform: translateX(1px) scale(0.97);
            opacity: 0.75;
            filter: blur(7px);
          }
          100% {
            transform: translateX(0px) scale(1.0);
            opacity: 0.85;
            filter: blur(8px);
          }
        }

        @keyframes portal-roll-${targetNumber}-${diceId} {
          0% {
            transform: translateX(0px) rotateX(60deg) scale(0.3);
            opacity: 0;
          }
          65% {
            transform: translateX(0px) rotateX(60deg) scale(0.8);
            opacity: 0.3;
          }
          90% {
            transform: translateX(0px) rotateX(60deg) scale(1);
            opacity: 1;
          }
          100% {
            transform: translateX(0px) rotateX(60deg) scale(1);
            opacity: 1;
          }
        }

        @keyframes scanlines {
          0% { background-position: 0 0; }
          100% { background-position: 0 100%; }
        }

        @keyframes impact-shake {
          0%, 100% { transform: translate(0, 0) rotate(0deg); }
          15% { transform: translate(-8px, 6px) rotate(-1.5deg); }
          30% { transform: translate(8px, -6px) rotate(1.5deg); }
          45% { transform: translate(-6px, -4px) rotate(-1deg); }
          60% { transform: translate(6px, 4px) rotate(1deg); }
          75% { transform: translate(-3px, 2px) rotate(-0.5deg); }
          90% { transform: translate(3px, -2px) rotate(0.5deg); }
        }

        @keyframes hologram-glitch {
          0% { clip-path: inset(40% 0 61% 0); transform: skew(0.3deg); }
          20% { clip-path: inset(92% 0 1% 0); transform: skew(-0.5deg); }
          40% { clip-path: inset(15% 0 80% 0); transform: skew(0.8deg); }
          60% { clip-path: inset(80% 0 5% 0); transform: skew(-0.2deg); }
          80% { clip-path: inset(3% 0 92% 0); transform: skew(0.5deg); }
          100% { clip-path: inset(40% 0 61% 0); transform: skew(0deg); }
        }

        @keyframes radial-pulse {
          0% { transform: scale(0.8); opacity: 0.8; }
          100% { transform: scale(2.2); opacity: 0; }
        }

        .animate-real-roll-${diceId} {
          animation: real-roll-${targetNumber}-${diceId} 2.2s cubic-bezier(0.25, 1, 0.5, 1) forwards;
        }

        .animate-shadow-roll-${diceId} {
          animation: shadow-roll-${targetNumber}-${diceId} 2.2s cubic-bezier(0.25, 1, 0.5, 1) forwards;
        }

        .animate-portal-roll-${diceId} {
          animation: portal-roll-${targetNumber}-${diceId} 2.2s cubic-bezier(0.25, 1, 0.5, 1) forwards;
        }

        .animate-impact-shake {
          animation: impact-shake 0.35s cubic-bezier(.36,.07,.19,.97) both;
        }

        .scanlines-overlay {
          background: linear-gradient(
            rgba(18, 16, 16, 0) 50%, 
            rgba(0, 0, 0, 0.3) 50%
          );
          background-size: 100% 4px;
          animation: scanlines 12s linear infinite;
        }
      `}</style>

      {/* Cyber Background Grid & Effects */}
      <div className="absolute inset-0 pointer-events-none scanlines-overlay z-0 opacity-20"></div>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(6,11,22,0.4)_0%,rgba(4,7,12,0.75)_100%)] z-0"></div>

      {/* Cybernetic Matrix Data Streams Backdrop */}
      <div className="absolute inset-0 z-0 overflow-hidden opacity-10 flex justify-around select-none pointer-events-none">
        {[...Array(12)].map((_, i) => (
          <div
            key={i}
            className="text-[9px] font-mono text-[#00FFFF] flex flex-col gap-1.5 animate-[translateY_8s_linear_infinite]"
            style={{
              animationDelay: `${i * 0.6}s`,
              animationDuration: `${5 + Math.random() * 6}s`,
              transform: `translateY(${-100 + Math.random() * 50}px)`,
            }}
          >
            {
              [
                "0101",
                "HAP_SYS",
                "STATUS_OK",
                "VOLT_HIGH",
                "QUANTUM_UP",
                "CORE_INIT",
                "NET_ACTIVE",
                "99.8%",
                "SYS_LINK",
              ][Math.floor(Math.random() * 9)]
            }
            <span className="font-sans font-black text-xs">{Math.floor(Math.random() * 99)}</span>
            {"101011"}
          </div>
        ))}
      </div>

      {/* Glitch flash overlay on landing */}
      {triggerGlitch && (
        <div className="absolute inset-0 bg-cyan-500/15 mix-blend-color-dodge z-40 pointer-events-none flex items-center justify-center">
          <div className="w-full h-1/3 bg-[#FF00FF]/25 blur-md transform -skew-y-12 animate-[pulse_0.1s_infinite]" />
        </div>
      )}

      {/* Decorative neon portal platform behind the shadow */}
      <div
        className={`absolute top-[62%] w-52 h-14 md:w-68 md:h-18 rounded-full border-2 bg-gradient-to-b from-[#D4A017]/10 to-transparent flex items-center justify-center blur-[1px] z-10 transition-all duration-700 ${
          isSpinning ? `animate-portal-roll-${diceId}` : ""
        }`}
        style={{
          transform: "rotateX(60deg)",
          borderColor: landed ? `${themeColor}60` : "rgba(212, 160, 23, 0.25)",
          boxShadow: landed
            ? `0 0 45px ${themeColor}30, inset 0 0 25px ${themeColor}20`
            : "0 0 20px rgba(212, 160, 23, 0.1)",
        }}
      >
        <div
          className="w-[88%] h-[88%] rounded-full border border-dashed animate-[spin_20s_linear_infinite]"
          style={{ borderColor: landed ? `${themeColor}40` : "rgba(212, 160, 23, 0.3)" }}
        />
      </div>

      {/* Bounce-scaling shadow under the 3D Cube */}
      <div
        className={`absolute top-[62%] w-26 h-7 md:w-34 md:h-9 rounded-full bg-black/90 z-10 ${
          isSpinning ? `animate-shadow-roll-${diceId}` : ""
        }`}
        style={{
          transform: "scale(1.25)",
          opacity: 0.85,
          filter: "blur(12px)",
          backgroundColor: landed ? themeColor : "black",
          boxShadow: landed ? `0 0 35px ${themeColor}, 0 0 70px ${themeColor}` : undefined,
        }}
      />

      {/* --- HUD Header --- */}
      <div className="relative z-20 text-center mb-10 select-none px-4">
        <div className="text-[10px] md:text-xs font-mono text-[#D4A017]/70 tracking-[0.3em] uppercase mb-2">
          Hapstore Cybernetic Terminal
        </div>

        <div className="relative inline-block">
          <h2
            className="text-[#00FFFF] font-sans font-black text-3xl md:text-4xl tracking-widest uppercase drop-shadow-[0_0_15px_rgba(0,255,255,0.5)] transition-all duration-500"
            style={landed ? { color: themeColor, textShadow: `0 0 25px ${themeColor}` } : undefined}
          >
            {landed ? "ИМПУЛЬС СТАБИЛИЗИРОВАН" : "ГЕНЕРАЦИЯ ИМПУЛЬСА"}
          </h2>
          {triggerGlitch && (
            <h2 className="absolute inset-0 text-fuchsia-500 font-sans font-black text-3xl md:text-4xl tracking-widest uppercase opacity-70 animate-[hologram-glitch_0.3s_infinite] pointer-events-none">
              ИМПУЛЬС СТАБИЛИЗИРОВАН
            </h2>
          )}
        </div>

        <p className="text-gray-400 font-mono text-[9px] md:text-[10px] uppercase mt-2 tracking-[0.18em] flex items-center justify-center gap-2">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${landed ? "bg-[#00FFFF] shadow-[0_0_8px_#00FFFF]" : "bg-emerald-500 animate-pulse"}`}
          ></span>
          {landed
            ? `ПЕРЕМЕЩЕНИЕ НА КЛЕТОК: ${targetNumber} // КВАНТОВЫЙ КОД ОДОБРЕН`
            : "СВЯЗЬ С СЕРВЕРОМ: OK // ИДЕТ БРОСОК КУБИКА"}
        </p>
      </div>

      {/* --- 2D DICE STAGE --- */}
      <div className="relative w-64 h-64 md:w-80 md:h-80 flex items-center justify-center z-20 select-none">
        {/* Shockwave expanding circle when landed */}
        {landed && (
          <div
            className="absolute w-44 h-44 md:w-56 md:h-56 rounded-full border-2 opacity-0 animate-[radial-pulse_1.1s_cubic-bezier(0.1,0.8,0.3,1)_1_forwards]"
            style={{
              borderColor: themeColor,
              boxShadow: `inset 0 0 20px ${themeColor}`,
            }}
          />
        )}

        <div
          className={`w-40 h-40 md:w-56 md:h-56 relative flex items-center justify-center ${isSpinning ? `animate-real-roll-${diceId}` : ``}`}
          style={{
            transition: !isSpinning ? "transform 1.2s cubic-bezier(0.19, 1, 0.22, 1)" : undefined,
          }}
        >
          <img
            src="/Dice.png?v=4"
            alt="Dice"
            className="w-full h-full object-contain filter drop-shadow-[0_0_25px_rgba(255,0,128,0.4)]"
            style={{
              filter: landed
                ? `drop-shadow(0 0 35px ${themeColor})`
                : `drop-shadow(0 0 15px rgba(255,255,255,0.2))`,
            }}
          />
          {/* Overlay the number on top of the image in a glowing cyberpunk style when landed */}
          {landed && (
            <div className="absolute inset-0 flex items-center justify-center mix-blend-screen pointer-events-none">
              <span
                className="text-[90px] md:text-[110px] leading-none font-sans font-black"
                style={{
                  color: themeColor,
                  textShadow: `0 0 20px ${themeColor}, 0 0 40px ${themeColor}, 0 0 80px ${themeColor}`,
                  WebkitTextStroke: "1px white",
                }}
              >
                {targetNumber}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* --- BOTTOM HUD CONTROLS & INFO --- */}
      <div className="relative z-20 mt-10 w-full max-w-xs px-4">
        <div className="border border-[#D4A017]/25 bg-[#0B1426]/75 backdrop-blur-md rounded-2xl p-4 text-center font-mono shadow-[0_0_20px_rgba(11,20,38,0.7)]">
          <div className="text-[8px] text-gray-400 uppercase tracking-widest mb-1.5 flex justify-between">
            <span>ЧАСТОТА: 120 ГЦ</span>
            <span className="animate-pulse text-[#00FFFF]">СЕТЬ: ОДОБРЕНО</span>
          </div>

          <div className="h-px bg-gradient-to-r from-transparent via-[#D4A017]/45 to-transparent my-2" />

          <div className="flex items-center justify-between text-[11px] font-bold mt-1">
            <span className="text-gray-300">КВАНТОВЫЙ РЕЗУЛЬТАТ:</span>
            <span
              className="text-2xl font-black font-sans tracking-wider transition-colors duration-500"
              style={{ color: themeColor, textShadow: `0 0 15px ${themeColor}` }}
            >
              {isSpinning ? telemetryNumber : targetNumber}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
