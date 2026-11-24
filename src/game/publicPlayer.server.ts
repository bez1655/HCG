import { createHash } from "node:crypto";
import type { Player } from "../types";
import { publicName } from "./aliases";

export function publicPlayerKey(id: string): string {
  return "public_" + createHash("sha256").update(id).digest("hex").slice(0, 24);
}
export function visiblePlayerId(id: string | null, viewerId?: string): string | null {
  return id === null || id === viewerId ? id : publicPlayerKey(id);
}
export function playerForViewer(p: Player, viewerId?: string): Player {
  if (p.id === viewerId) {
    const own = { ...p, name: publicName(p) };
    delete own.telegramId;
    delete own.telegramUsername;
    delete own.previousHandles;
    delete own.pendingHorrorAlias;
    if (own.pendingDropBox) own.pendingDropBox = { cellId: own.pendingDropBox.cellId, options: [] };
    return own;
  }
  return {
    id: publicPlayerKey(p.id), name: p.alias || (p.role === "admin" ? "Администратор" : "Игрок"), alias: p.alias,
    role: p.role, cell: p.cell, color: p.color, isOnline: p.isOnline,
    lastRoll: p.lastRoll, skipNextTurn: false, lastSeenAt: p.lastSeenAt,
    avatar: p.avatar, chipImage: p.chipImage,
  };
}
