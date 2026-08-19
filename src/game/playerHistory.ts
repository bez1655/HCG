/**
 * Per-player movement history.
 *
 * The live game log is capped at 300 lines and then archived without an
 * index, so reconstructing one player's path from it is lossy. Every move
 * is also appended to player-moves.jsonl — that file is the source of
 * truth for an extract.
 *
 * Older events that only exist in the capped log / archive are still
 * folded in, so a first extract after this ships is not empty.
 */
import type { GameLog, Player } from "../types";

export type MoveKind = "roll" | "admin" | "restart" | "skip" | "other";

export interface PlayerMove {
  at: number;
  timeLabel: string;
  kind: MoveKind;
  fromCell: number | null;
  toCell: number | null;
  steps: number | null;
  note: string;
}

export interface PlayerHistory {
  playerId: string;
  name: string;
  alias: string | null;
  cell: number;
  moves: PlayerMove[];
}

const ROLL_RE = /выбросил\s+(\d+)\s+и переместился на клетку\s+(\d+)/i;
const ADMIN_RE = /Клетка:\s*(\d+)\s*➔\s*(\d+)/;
const RESTART_RE = /начал новый круг с клетки\s+(\d+)/i;
const SKIP_RE = /пропустил ход/i;

export function classifyLogMessage(message: string): Omit<PlayerMove, "at" | "timeLabel"> | null {
  const roll = message.match(ROLL_RE);
  if (roll) {
    const toCell = Number(roll[2]);
    const steps = Number(roll[1]);
    return {
      kind: "roll",
      fromCell: null,
      toCell,
      steps,
      note: message,
    };
  }

  const admin = message.match(ADMIN_RE);
  if (admin) {
    return {
      kind: "admin",
      fromCell: Number(admin[1]),
      toCell: Number(admin[2]),
      steps: null,
      note: message,
    };
  }

  const restart = message.match(RESTART_RE);
  if (restart) {
    return {
      kind: "restart",
      fromCell: Number(restart[1]),
      toCell: 0,
      steps: null,
      note: message,
    };
  }

  if (SKIP_RE.test(message)) {
    return {
      kind: "skip",
      fromCell: null,
      toCell: null,
      steps: null,
      note: message,
    };
  }

  return {
    kind: "other",
    fromCell: null,
    toCell: null,
    steps: null,
    note: message,
  };
}

export function logMentionsPlayer(message: string, player: Pick<Player, "id" | "name" | "alias">): boolean {
  if (!message) return false;
  if (player.alias && message.includes(player.alias)) return true;
  if (player.name && message.includes(player.name)) return true;
  return false;
}

export function movesFromLogs(
  logs: GameLog[],
  player: Pick<Player, "id" | "name" | "alias">
): PlayerMove[] {
  const out: PlayerMove[] = [];
  for (const log of logs) {
    if (!logMentionsPlayer(log.message || "", player)) continue;
    const classified = classifyLogMessage(log.message || "");
    if (!classified) continue;
    if (classified.kind === "other" && !/ход|клетк|брос|приз|круг|бонус/i.test(classified.note)) {
      continue;
    }
    out.push({
      at: parseLooseTime(log.timestamp),
      timeLabel: log.timestamp || "",
      ...classified,
    });
  }
  return out;
}

function parseLooseTime(stamp?: string): number {
  if (!stamp) return 0;
  const asNum = Number(stamp);
  if (Number.isFinite(asNum) && asNum > 1e11) return asNum;
  return 0;
}

export function mergeMoves(...lists: PlayerMove[][]): PlayerMove[] {
  const seen = new Set<string>();
  const all: PlayerMove[] = [];
  for (const list of lists) {
    for (const m of list) {
      const key = `${m.kind}|${m.fromCell}|${m.toCell}|${m.steps}|${m.note}|${m.timeLabel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(m);
    }
  }
  all.sort((a, b) => {
    if (a.at && b.at && a.at !== b.at) return a.at - b.at;
    return 0;
  });
  return all;
}

export function formatPlayerHistoryText(history: PlayerHistory): string {
  const who = history.alias ? `${history.alias} (${history.name})` : history.name;
  const lines = [
    `📜 История: ${who}`,
    `Сейчас клетка: ${history.cell}`,
    `Записей: ${history.moves.length}`,
    "",
  ];

  if (history.moves.length === 0) {
    lines.push("Перемещений в журнале нет.");
    return lines.join("\n");
  }

  let n = 1;
  for (const m of history.moves) {
    const when = m.timeLabel || "—";
    if (m.kind === "roll") {
      const from = m.fromCell != null ? `${m.fromCell} ➔ ` : "";
      lines.push(`${n}. [${when}] кубик ${m.steps ?? "?"} · ${from}${m.toCell ?? "?"}`);
    } else if (m.kind === "admin") {
      lines.push(`${n}. [${when}] админ · ${m.fromCell} ➔ ${m.toCell}`);
    } else if (m.kind === "restart") {
      lines.push(`${n}. [${when}] новый круг · клетка 0`);
    } else if (m.kind === "skip") {
      lines.push(`${n}. [${when}] пропуск хода`);
    } else {
      lines.push(`${n}. [${when}] ${m.note}`);
    }
    n += 1;
  }

  return lines.join("\n");
}

export function formatPlayerHistoryHtml(history: PlayerHistory): string {
  const who = history.alias
    ? `${escapeHtml(history.alias)} (${escapeHtml(history.name)})`
    : escapeHtml(history.name);
  const head =
    `📜 <b>История игрока</b>\n` +
    `${who}\n` +
    `Сейчас клетка: <b>${history.cell}</b>\n` +
    `Записей: <b>${history.moves.length}</b>`;

  if (history.moves.length === 0) {
    return head + "\n\nПеремещений в журнале нет.";
  }

  const rows = history.moves.slice(-40).map((m, i, arr) => {
    const idx = history.moves.length - arr.length + i + 1;
    const when = escapeHtml(m.timeLabel || "—");
    if (m.kind === "roll") {
      const from = m.fromCell != null ? `${m.fromCell} ➔ ` : "";
      return `${idx}. [${when}] 🎲 ${m.steps ?? "?"} · ${from}<b>${m.toCell ?? "?"}</b>`;
    }
    if (m.kind === "admin") {
      return `${idx}. [${when}] 🛠️ ${m.fromCell} ➔ <b>${m.toCell}</b>`;
    }
    if (m.kind === "restart") return `${idx}. [${when}] 🔄 новый круг`;
    if (m.kind === "skip") return `${idx}. [${when}] ⏳ пропуск`;
    return `${idx}. [${when}] ${escapeHtml(m.note).slice(0, 160)}`;
  });

  const clipped =
    history.moves.length > 40
      ? `\n<i>В сообщении последние 40. Полный список — в файле.</i>`
      : "";

  return `${head}\n\n${rows.join("\n")}${clipped}`;
}

function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function findPlayerByTarget(
  players: Player[],
  target: string
): Player | undefined {
  const needle = target.trim().toLowerCase().replace(/^@/, "");
  if (!needle) return undefined;
  return players.find(
    (p) =>
      p.id === target ||
      p.id.toLowerCase() === needle ||
      p.name.toLowerCase().replace(/^@/, "") === needle ||
      (p.alias ?? "").toLowerCase() === target.trim().toLowerCase() ||
      (p.telegramUsername ?? "").toLowerCase() === needle
  );
}
