import { describe, it, expect } from "vitest";
import { applyTelegramHandle, findPlayerByTelegram, isCurrentLoginHandle } from "./telegramIdentity";
import type { Player } from "../types";

function p(partial: Partial<Player> & { id: string; name: string }): Player {
  return {
    role: "player",
    cell: 0,
    color: "#0",
    isOnline: false,
    lastRoll: null,
    skipNextTurn: false,
    ...partial,
  };
}

describe("telegram handle sync", () => {
  it("renames when telegram id matches and handle changed", () => {
    const a = p({ id: "1", name: "@old_name", telegramId: 99, telegramUsername: "old_name" });
    const r = applyTelegramHandle([a], a, "@new_name");
    expect(r.renamed).toBe(true);
    expect(a.name).toBe("@new_name");
    expect(a.telegramUsername).toBe("new_name");
  });

  it("does not steal another player's handle", () => {
    const a = p({ id: "1", name: "@old", telegramId: 1 });
    const b = p({ id: "2", name: "@taken", telegramId: 2 });
    const r = applyTelegramHandle([a, b], a, "@taken");
    expect(r.conflict).toBe(true);
    expect(a.name).toBe("@old");
    expect(a.telegramUsername).toBe("taken");
  });

  it("finds by numeric id first", () => {
    const a = p({ id: "1", name: "@old", telegramId: 42, telegramUsername: "old" });
    expect(findPlayerByTelegram([a], { telegramId: 42, handle: "@other" })?.id).toBe("1");
  });

  it("finds by a previous handle after rename", () => {
    const a = p({ id: "1", name: "@old", telegramId: 7, telegramUsername: "old" });
    applyTelegramHandle([a], a, "@fresh");
    expect(findPlayerByTelegram([a], { handle: "@old" })?.id).toBe("1");
    expect(a.previousHandles).toContain("@old");
  });

  it("treats a new @ on the same telegramId as the same player", () => {
    const a = p({ id: "1", name: "@old", telegramId: 77, telegramUsername: "old" });
    const found = findPlayerByTelegram([a], { telegramId: 77, handle: "@brand_new" });
    expect(found?.id).toBe("1");
    applyTelegramHandle([a], found!, "@brand_new");
    expect(a.name).toBe("@brand_new");
    expect(findPlayerByTelegram([a], { handle: "@old" })?.id).toBe("1");
    expect(isCurrentLoginHandle(a, "@brand_new")).toBe(true);
    expect(isCurrentLoginHandle(a, "@old")).toBe(false);
  });
});
