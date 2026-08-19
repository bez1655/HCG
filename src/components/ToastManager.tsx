import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Socket } from "socket.io-client";
import { Trophy, Rocket, Zap, Star } from "lucide-react";
import { playSound } from "../utils/sounds";

export interface ToastData {
  id: string;
  title: string;
  message: string;
  icon: string;
  type: "milestone" | "lap" | "special";
}

export default function ToastManager({ socket }: { socket: Socket | null }) {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  useEffect(() => {
    if (!socket) return;

    const handleAchievement = (data: Omit<ToastData, "id">) => {
      const id = Date.now().toString() + Math.random().toString(36).substring(7);
      setToasts((prev) => [...prev, { ...data, id }]);

      // Play achievement sound
      playSound("level_up");

      // Auto dismiss after 4 seconds
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4000);
    };

    socket.on("toast:achievement", handleAchievement);
    return () => {
      socket.off("toast:achievement", handleAchievement);
    };
  }, [socket]);

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex flex-col gap-3 pointer-events-none">
      <AnimatePresence>
        {toasts.map((toast) => {
          const isLap = toast.type === "lap";
          const isSpecial = toast.type === "special";

          const borderColor = isLap
            ? "border-yellow-500/50"
            : isSpecial
              ? "border-cyan-500/50"
              : "border-fuchsia-500/50";
          const shadowColor = isLap
            ? "shadow-[0_0_20px_rgba(234,179,8,0.4)]"
            : isSpecial
              ? "shadow-[0_0_20px_rgba(6,182,212,0.4)]"
              : "shadow-[0_0_20px_rgba(217,70,239,0.4)]";
          const iconBg = isLap
            ? "bg-yellow-950/50 border-yellow-500/30"
            : isSpecial
              ? "bg-cyan-950/50 border-cyan-500/30"
              : "bg-fuchsia-950/50 border-fuchsia-500/30";
          const titleColor = isLap
            ? "text-yellow-400"
            : isSpecial
              ? "text-cyan-400"
              : "text-fuchsia-400";

          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: -50, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8, y: -20 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className={`pointer-events-auto flex items-center gap-3 bg-gray-900/90 border ${borderColor} ${shadowColor} backdrop-blur-md px-5 py-3 rounded-xl min-w-[320px] max-w-[400px]`}
            >
              <div
                className={`flex-shrink-0 w-12 h-12 flex items-center justify-center rounded-full border ${iconBg} text-2xl`}
              >
                {toast.icon === "🏆" ? (
                  <Trophy className="w-6 h-6 text-yellow-400" />
                ) : toast.icon === "🚀" ? (
                  <Rocket className="w-6 h-6 text-fuchsia-400" />
                ) : toast.icon === "⚡" ? (
                  <Zap className="w-6 h-6 text-cyan-400" />
                ) : toast.icon === "⭐" ? (
                  <Star className="w-6 h-6 text-yellow-400" />
                ) : (
                  toast.icon
                )}
              </div>
              <div className="flex flex-col">
                <span className={`${titleColor} font-bold text-xs tracking-wider uppercase`}>
                  {toast.title}
                </span>
                <span className="text-gray-100 text-sm font-medium">{toast.message}</span>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
