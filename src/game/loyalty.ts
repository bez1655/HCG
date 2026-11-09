/**
 * Shop discount in real Hapstore, tied to approved purchases (1 item = 1 turn).
 * Scale from the TEST brief: 0 / 3 / 5 / 7 / 10 percent.
 */

import type { LoyaltyRank, Player } from "../types";

export const RANK_LABEL: Record<LoyaltyRank, string> = {
  intern: "Стрит",
  operative: "Раннер",
  veteran: "Соло",
  master: "Эйс",
  legend: "Легенда сектора",
};

/** Rank from lifetime purchase count (approved turns). */
export function loyaltyRankFromPurchases(purchases: number): LoyaltyRank {
  const n = Math.max(0, Math.floor(purchases));
  if (n >= 25) return "legend";
  if (n >= 15) return "master";
  if (n >= 8) return "veteran";
  if (n >= 3) return "operative";
  return "intern";
}

export function getLoyaltyDiscountPercent(purchases: number): number {
  switch (loyaltyRankFromPurchases(purchases)) {
    case "legend":
      return 10;
    case "master":
      return 7;
    case "veteran":
      return 5;
    case "operative":
      return 3;
    default:
      return 0;
  }
}

export function loyaltyPerkLine(purchases: number): string {
  const d = getLoyaltyDiscountPercent(purchases);
  const n = Math.max(0, Math.floor(purchases));
  if (d === 0) return `Покупок: ${n}. Скидка 0% (с 3-й покупки — 3%).`;
  return `Покупок: ${n}. Постоянная скидка ${d}% в Hapstore.`;
}

export function syncPurchaseLoyalty(player: Player): void {
  const n = Math.max(0, player.purchaseCount || 0);
  player.purchaseCount = n;
  player.loyaltyRank = loyaltyRankFromPurchases(n);
}

export const DISCOUNT_TABLE_TEXT =
  "0–2 покупки — 0% · 3 — 3% · 8 — 5% · 15 — 7% · 25 — 10%";
