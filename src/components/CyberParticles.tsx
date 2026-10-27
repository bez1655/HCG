import React, { useEffect, useRef } from "react";

interface Particle {
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  color: string;
  alpha: number;
  maxAlpha: number;
  fadeSpeed: number;
  swaySpeed: number;
  swayOffset: number;
}

const NEON_COLORS = [
  "#00FFFF", // Cyan
  "#FF00FF", // Fuchsia / Magenta
  "#00FFAA", // Neon Green
  "#3B82F6", // Electric Blue
  "#F5C542", // Cyber Gold
  "#A855F7", // Neon Purple
];

export default function CyberParticles() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = canvas.parentElement?.clientWidth || window.innerWidth);
    let height = (canvas.height = canvas.parentElement?.clientHeight || window.innerHeight);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.parentElement?.clientWidth || window.innerWidth;
      height = canvas.height = canvas.parentElement?.clientHeight || window.innerHeight;
    };

    window.addEventListener("resize", handleResize);

    // Particle pool size
    const particleCount = Math.min(80, Math.floor((width * height) / 15000));
    const particles: Particle[] = [];

    const createParticle = (isInitial = false): Particle => {
      const maxAlpha = 0.2 + Math.random() * 0.6;
      return {
        x: Math.random() * width,
        y: isInitial ? Math.random() * height : height + 10,
        size: 1 + Math.random() * 2.5,
        speedX: (Math.random() - 0.5) * 0.3,
        speedY: -0.2 - Math.random() * 0.6, // Rise upwards like embers
        color: NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)],
        alpha: isInitial ? Math.random() * maxAlpha : 0,
        maxAlpha,
        fadeSpeed: 0.003 + Math.random() * 0.008,
        swaySpeed: 0.005 + Math.random() * 0.015,
        swayOffset: Math.random() * Math.PI * 2,
      };
    };

    for (let i = 0; i < particleCount; i++) {
      particles.push(createParticle(true));
    }

    let time = 0;

    const render = () => {
      time += 0.016;
      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];

        // Horizontal sway
        p.x += p.speedX + Math.sin(time * p.swaySpeed + p.swayOffset) * 0.4;
        p.y += p.speedY;

        // Fade in / out logic
        if (p.y > height * 0.8) {
          if (p.alpha < p.maxAlpha) {
            p.alpha = Math.min(p.maxAlpha, p.alpha + p.fadeSpeed * 2);
          }
        } else if (p.y < height * 0.2) {
          p.alpha -= p.fadeSpeed * 1.5;
        }

        // Reset particle if out of bounds or invisible
        if (p.y < -10 || p.alpha <= 0 || p.x < -20 || p.x > width + 20) {
          particles[i] = createParticle(false);
          continue;
        }

        // Render ember particle with glow
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.shadowColor = p.color;
        ctx.shadowBlur = p.size * 3;
        ctx.fillStyle = p.color;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-[1]" />
  );
}
