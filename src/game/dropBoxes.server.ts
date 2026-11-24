import { randomInt, randomUUID } from "node:crypto";
import type { DropBoxOption } from "../types";

/** Server-only: every case awards a shop coupon; no code exists until selection. */
export function generateDropBoxOptions(): DropBoxOption[] {
  return Array.from({ length: 3 }, () => {
    const discount = randomInt(0, 2) === 0 ? 10 : 15;
    return { title: `Скидка ${discount}% в Hapstore`, description: `Купон на скидку ${discount}% при покупке в магазине!`, type: "promo" as const };
  });
}

export function issueDropCoupon(option: DropBoxOption): DropBoxOption {
  return { ...option, promoCode: `HAP-${randomUUID().replace(/-/g, "").toUpperCase()}` };
}
