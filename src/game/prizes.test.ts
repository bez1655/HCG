import { describe, it, expect } from "vitest";
import { keepBetterPrize, isBlockingShopPrize, prizeScore } from "./prizes";
import type { ActiveBonus } from "../types";

function b(extra: string, value: number, name = extra): ActiveBonus {
  return { name, extra, value, receivedAt: 1 };
}

describe("prize ranking", () => {
  it("keeps mega over crystal and cash", () => {
    const mega = b("МЕГА-КРИСТАЛЛ", 13800);
    const crystal = b("КРИСТАЛЛ", 4600, "ЭНЕРГОКРИСТАЛЛ");
    const cash = b("2000 CR", 2000);
    expect(keepBetterPrize(crystal, mega).active.extra).toBe("МЕГА-КРИСТАЛЛ");
    expect(keepBetterPrize(mega, cash).replaced).toBe(false);
  });

  it("crystal beats any discount even if fever-doubled", () => {
    const crystal = b("КРИСТАЛЛ", 4600, "ЭНЕРГОКРИСТАЛЛ");
    const fat = b("2000 CR", 4000);
    expect(keepBetterPrize(fat, crystal).active.extra).toBe("КРИСТАЛЛ");
  });

  it("small crystal beats 2000 cash", () => {
    const small = b("МАЛЫЙ", 2300, "МАЛЫЙ ЭНЕРГОКРИСТАЛЛ");
    expect(keepBetterPrize(b("2000 CR", 2000), small).active.extra).toBe("МАЛЫЙ");
  });

  it("among discounts keeps the larger sum", () => {
    const r = keepBetterPrize(b("1000 CR", 1000), b("2000 CR", 2000));
    expect(r.active.value).toBe(2000);
    expect(r.replaced).toBe(true);
  });

  it("blocks crystals and cash, not a lap key", () => {
    expect(isBlockingShopPrize(b("МЕГА-КРИСТАЛЛ", 13800))).toBe(true);
    expect(isBlockingShopPrize(b("1500 CR", 1500))).toBe(true);
    expect(isBlockingShopPrize(b("КРУГ 1", 0, "Ключ ядра"))).toBe(false);
  });

  it("scores mega highest", () => {
    expect(prizeScore(b("МЕГА-КРИСТАЛЛ", 13800))).toBeGreaterThan(prizeScore(b("КРИСТАЛЛ", 4600)));
  });
});
