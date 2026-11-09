import { describe, it, expect } from "vitest";
import {
  getLoyaltyDiscountPercent,
  loyaltyRankFromPurchases,
} from "./loyalty";

describe("Hapstore purchase discount", () => {
  it("matches the agreed scale", () => {
    expect(getLoyaltyDiscountPercent(0)).toBe(0);
    expect(getLoyaltyDiscountPercent(2)).toBe(0);
    expect(getLoyaltyDiscountPercent(3)).toBe(3);
    expect(getLoyaltyDiscountPercent(7)).toBe(3);
    expect(getLoyaltyDiscountPercent(8)).toBe(5);
    expect(getLoyaltyDiscountPercent(14)).toBe(5);
    expect(getLoyaltyDiscountPercent(15)).toBe(7);
    expect(getLoyaltyDiscountPercent(24)).toBe(7);
    expect(getLoyaltyDiscountPercent(25)).toBe(10);
    expect(getLoyaltyDiscountPercent(100)).toBe(10);
  });

  it("maps ranks", () => {
    expect(loyaltyRankFromPurchases(0)).toBe("intern");
    expect(loyaltyRankFromPurchases(3)).toBe("operative");
    expect(loyaltyRankFromPurchases(8)).toBe("veteran");
    expect(loyaltyRankFromPurchases(15)).toBe("master");
    expect(loyaltyRankFromPurchases(25)).toBe("legend");
  });
});
