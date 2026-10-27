import React from "react";
import { CellType } from "../types";

export interface CellBurst {
  id: string;
  x: number; // Percent on board (0..100)
  y: number; // Percent on board (0..100)
  cellType: CellType;
  isSpecial: boolean;
  playerColor?: string;
  timestamp: number;
}

interface CellParticleEffectProps {
  bursts: CellBurst[];
}

interface ParticleConfig {
  id: number;
  dx: string;
  dy: string;
  scale: number;
  rot: string;
  color: string;
  size: number;
  delay: string;
  isGlyph?: boolean;
  glyphChar?: string;
}

// Generate deterministic particles for each burst based on burst ID
const getBurstParticles = (burst: CellBurst): ParticleConfig[] => {
  const isSpecial = burst.isSpecial;
  const count = isSpecial ? 16 : 10;
  const particles: ParticleConfig[] = [];

  /*
   * Значения по умолчанию обязательны.
   *
   * Здесь было `let baseColors: string[];` без присваивания, а сразу за ним —
   * baseColors.unshift(). Для игрока с заданным цветом это падало с
   * «Cannot read properties of undefined (reading 'unshift')» прямо во время
   * отрисовки. Ошибка внутри .map() по всплескам на доске снимала всё дерево
   * React: экран становился белым в APK и чёрным в Telegram, где под ним
   * оставался фон. Именно это и выглядело как «зависание после броска».
   *
   * Ветка default в switch тоже не задавала baseColors — обычная клетка
   * роняла бы игру так же.
   */
  let baseColors: string[] = ["#00ffaa", "#38bdf8", "#e879f9", "#f5c542"];
  let glyphs: string[] = ["✦", "•"];

  switch (burst.cellType) {
    case CellType.BONUS:
    case CellType.BITCOIN:
      baseColors = ["#f5c542", "#00ffaa", "#f0abfc", "#38bdf8"];
      glyphs = ["⚡", "⬢", "✦", "✨"];
      break;
    case CellType.SNAKE:
    case CellType.PENALTY:
    case CellType.ERROR:
      baseColors = ["#ff2a5f", "#ef4444", "#f97316", "#a855f7"];
      glyphs = ["☣", "⚠️", "⚡", "✖"];
      break;
    case CellType.FINISH:
      baseColors = ["#f5c542", "#fbbf24", "#38bdf8", "#e879f9"];
      glyphs = ["🏆", "👑", "✨", "✦"];
      break;
    case CellType.FLASK:
      baseColors = ["#c084fc", "#e879f9", "#38bdf8", "#00ffaa"];
      glyphs = ["⚗️", "🧪", "✨"];
      break;
    case CellType.START:
      baseColors = ["#e879f9", "#f0abfc", "#00ffff"];
      glyphs = ["✦", "🌀"];
      break;
    default:
      // Палитра уже задана значением по умолчанию выше.
      break;
  }

  // Цвет игрока — первым в палитре, но только после того, как она выбрана.
  if (burst.playerColor) {
    baseColors = [burst.playerColor, ...baseColors];
  }

  for (let i = 0; i < count; i++) {
    const angle = (i * (2 * Math.PI)) / count + (i % 2 === 0 ? 0.2 : -0.2);
    const distance = (isSpecial ? 38 : 24) + ((i * 7) % 18);
    const dx = `${Math.cos(angle) * distance}px`;
    const dy = `${Math.sin(angle) * distance}px`;
    const scale = 0.6 + ((i * 3) % 8) / 10;
    const rot = `${(i * 45) % 360}deg`;
    const color = baseColors[i % baseColors.length];
    const size = isSpecial ? (i % 3 === 0 ? 6 : 4) : 4;
    const delay = `${(i % 3) * 0.04}s`;

    const isGlyph = isSpecial && i < 3 && glyphs.length > 0;
    const glyphChar = isGlyph ? glyphs[i % glyphs.length] : undefined;

    particles.push({
      id: i,
      dx,
      dy,
      scale,
      rot,
      color,
      size,
      delay,
      isGlyph,
      glyphChar,
    });
  }

  return particles;
};

export default function CellParticleEffect({ bursts }: CellParticleEffectProps) {
  if (!bursts || bursts.length === 0) return null;

  return (
    <div className="absolute inset-0 w-full h-full pointer-events-none z-40 overflow-hidden">
      {bursts.map((burst) => {
        const particles = getBurstParticles(burst);
        const isSpecial = burst.isSpecial;

        // Choose primary glow color based on cell type
        let mainGlowColor = burst.playerColor || "#00ffff";
        if (burst.cellType === CellType.BONUS || burst.cellType === CellType.BITCOIN) {
          mainGlowColor = "#f5c542";
        } else if (burst.cellType === CellType.SNAKE || burst.cellType === CellType.PENALTY) {
          mainGlowColor = "#ff2a5f";
        } else if (burst.cellType === CellType.FINISH) {
          mainGlowColor = "#fbbf24";
        } else if (burst.cellType === CellType.FLASK) {
          mainGlowColor = "#e879f9";
        }

        return (
          <div
            key={burst.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{
              left: `${burst.x}%`,
              top: `${burst.y}%`,
            }}
          >
            {/* 1. Flash Radial Glow */}
            <div
              className="absolute w-16 h-16 rounded-full animate-cell-flash"
              style={{
                background: `radial-gradient(circle, ${mainGlowColor}cc 0%, ${mainGlowColor}00 70%)`,
                filter: "blur(4px)",
              }}
            />

            {/* 2. Shockwave Expansion Ring 1 */}
            <div
              className="absolute w-12 h-12 rounded-full border border-solid animate-shockwave"
              style={{
                borderColor: mainGlowColor,
                boxShadow: `0 0 12px ${mainGlowColor}, inset 0 0 8px ${mainGlowColor}`,
              }}
            />

            {/* 3. Shockwave Expansion Ring 2 (for special cells) */}
            {isSpecial && (
              <div
                className="absolute w-16 h-16 rounded-full border border-dashed animate-shockwave-delayed"
                style={{
                  borderColor: mainGlowColor,
                  boxShadow: `0 0 16px ${mainGlowColor}`,
                }}
              />
            )}

            {/* 4. Floating Special Cell Symbol */}
            {isSpecial && (
              <div
                className="absolute text-lg font-black font-mono animate-float-glyph drop-shadow-[0_0_10px_rgba(255,255,255,0.9)]"
                style={{ color: mainGlowColor }}
              >
                {burst.cellType === CellType.BONUS
                  ? "⚡ BONUS!"
                  : burst.cellType === CellType.BITCOIN
                    ? "⬢ CREDITS!"
                    : burst.cellType === CellType.SNAKE
                      ? "🐍 SNAKE!"
                      : burst.cellType === CellType.PENALTY
                        ? "☣ PENALTY!"
                        : burst.cellType === CellType.FINISH
                          ? "🏆 FINISH!"
                          : burst.cellType === CellType.FLASK
                            ? "⚗️ FLASK!"
                            : "✦ STEP"}
              </div>
            )}

            {/* 5. Radiating Burst Particles */}
            {particles.map((p) => (
              <div
                key={p.id}
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-particle-burst"
                style={
                  {
                    "--dx": p.dx,
                    "--dy": p.dy,
                    "--scale": p.scale,
                    "--rot": p.rot,
                    animationDelay: p.delay,
                  } as React.CSSProperties
                }
              >
                {p.isGlyph ? (
                  <span
                    className="text-xs font-mono font-bold leading-none select-none drop-shadow-[0_0_6px_rgba(255,255,255,0.8)]"
                    style={{ color: p.color }}
                  >
                    {p.glyphChar}
                  </span>
                ) : (
                  <div
                    className="rounded-full shadow-md"
                    style={{
                      width: `${p.size}px`,
                      height: `${p.size}px`,
                      backgroundColor: p.color,
                      boxShadow: `0 0 8px ${p.color}, 0 0 12px ${p.color}`,
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
