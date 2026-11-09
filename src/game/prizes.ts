/**
 * Shop prizes: crystals outrank cash discounts; among discounts keep the larger sum.
 * Unredeemed blocking prize stops a NEW batch, not rolls already paid for.
 */

import type { ActiveBonus } from "../types";

function blob(b: ActiveBonus | null | undefined): string {
  return `${b?.name || ""} ${b?.extra || ""}`.toUpperCase();
}

/** Mega / crystal / small crystal / cash (1000–2000). */
export function crystalTier(bonus: ActiveBonus | null | undefined): number {
  const s = blob(bonus);
  if (!s.trim()) return 0;
  if (s.includes("МЕГА")) return 3;
  if (s.includes("МАЛЫЙ")) return 1;
  if (s.includes("КРИСТАЛЛ")) return 2;
  return 0;
}

export function isBlockingShopPrize(bonus: ActiveBonus | null | undefined): boolean {
  if (!bonus) return false;
  if (crystalTier(bonus) > 0) return true;
  const v = bonus.value;
  return typeof v === "number" && v >= 1000;
}

export function prizeScore(bonus: ActiveBonus | null | undefined): number {
  if (!bonus) return 0;
  const tier = crystalTier(bonus);
  const v = typeof bonus.value === "number" ? bonus.value : 0;
  return tier * 1_000_000 + v;
}

/** Returns the more valuable prize. Equal score → keep current (stable). */
export function keepBetterPrize(
  current: ActiveBonus | null | undefined,
  incoming: ActiveBonus
): { active: ActiveBonus; replaced: boolean } {
  if (!current) return { active: incoming, replaced: false };
  if (prizeScore(incoming) > prizeScore(current)) {
    return { active: incoming, replaced: true };
  }
  return { active: current, replaced: false };
}
