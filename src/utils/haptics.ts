/**
 * Telegram Haptic Feedback & Mobile Vibration Helper.
 *
 * Provides tactile feedback for mobile players in Telegram Mini App,
 * Android APK (Capacitor) and mobile browsers.
 *
 * Operates independently from sound settings so players who muted audio
 * still experience tactile feedback.
 */

type ImpactStyle = "light" | "medium" | "heavy" | "rigid" | "soft";
type NotificationType = "success" | "warning" | "error";

interface TelegramHaptic {
  impactOccurred: (style: ImpactStyle) => void;
  notificationOccurred: (type: NotificationType) => void;
  selectionChanged: () => void;
}

function getTelegramHaptic(): TelegramHaptic | null {
  if (typeof window === "undefined") return null;
  const tg = (window as unknown as { Telegram?: { WebApp?: { HapticFeedback?: TelegramHaptic } } })?.Telegram?.WebApp;
  return tg?.HapticFeedback ?? null;
}

/** Fallback vibration using navigator.vibrate when not inside Telegram */
function fallbackVibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    /* vibration not permitted or supported on device */
  }
}

/**
 * Triggers an impact haptic pulse (physical collision, button click, dice hit).
 */
export function hapticImpact(style: ImpactStyle = "medium"): void {
  const tgHaptic = getTelegramHaptic();
  if (tgHaptic) {
    try {
      tgHaptic.impactOccurred(style);
      return;
    } catch {
      /* ignore */
    }
  }

  // Fallback patterns (ms)
  switch (style) {
    case "light":
    case "soft":
      fallbackVibrate(12);
      break;
    case "medium":
      fallbackVibrate(24);
      break;
    case "heavy":
    case "rigid":
      fallbackVibrate(40);
      break;
  }
}

/**
 * Triggers a notification haptic sequence (success, warning, error).
 */
export function hapticNotification(type: NotificationType): void {
  const tgHaptic = getTelegramHaptic();
  if (tgHaptic) {
    try {
      tgHaptic.notificationOccurred(type);
      return;
    } catch {
      /* ignore */
    }
  }

  // Fallback patterns (ms)
  switch (type) {
    case "success":
      fallbackVibrate([20, 40, 35]);
      break;
    case "warning":
      fallbackVibrate([30, 40, 30]);
      break;
    case "error":
      fallbackVibrate([45, 40, 45, 40, 45]);
      break;
  }
}

/**
 * Triggers a subtle selection click (changing tabs, selecting turn counts).
 */
export function hapticSelection(): void {
  const tgHaptic = getTelegramHaptic();
  if (tgHaptic) {
    try {
      tgHaptic.selectionChanged();
      return;
    } catch {
      /* ignore */
    }
  }

  fallbackVibrate(8);
}
