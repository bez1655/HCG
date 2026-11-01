// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hapticImpact, hapticNotification, hapticSelection } from "./haptics";

describe("haptics module", () => {
  const originalTelegram = (window as any).Telegram;
  const originalVibrate = navigator.vibrate;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    (window as any).Telegram = originalTelegram;
    Object.defineProperty(navigator, "vibrate", {
      value: originalVibrate,
      configurable: true,
      writable: true,
    });
  });

  it("calls Telegram.WebApp.HapticFeedback methods when inside Telegram", () => {
    const impactOccurred = vi.fn();
    const notificationOccurred = vi.fn();
    const selectionChanged = vi.fn();

    (window as any).Telegram = {
      WebApp: {
        HapticFeedback: {
          impactOccurred,
          notificationOccurred,
          selectionChanged,
        },
      },
    };

    hapticImpact("heavy");
    expect(impactOccurred).toHaveBeenCalledWith("heavy");

    hapticNotification("success");
    expect(notificationOccurred).toHaveBeenCalledWith("success");

    hapticSelection();
    expect(selectionChanged).toHaveBeenCalled();
  });

  it("falls back to navigator.vibrate when Telegram WebApp is not present", () => {
    delete (window as any).Telegram;
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", {
      value: vibrate,
      configurable: true,
      writable: true,
    });

    hapticImpact("medium");
    expect(vibrate).toHaveBeenCalledWith(24);

    hapticNotification("error");
    expect(vibrate).toHaveBeenCalledWith([45, 40, 45, 40, 45]);

    hapticSelection();
    expect(vibrate).toHaveBeenCalledWith(8);
  });

  it("does not throw when neither Telegram nor vibrate is available", () => {
    delete (window as any).Telegram;
    Object.defineProperty(navigator, "vibrate", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    expect(() => {
      hapticImpact("light");
      hapticNotification("warning");
      hapticSelection();
    }).not.toThrow();
  });
});
