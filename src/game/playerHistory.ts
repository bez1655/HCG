/**
 * Per-player movement history.
 *
 * The live game log is capped at 300 lines and then archived without an
 * index, so reconstructing one player's path from it is lossy. Every move
 * is also appended to player-moves.jsonl — that file is the source of
 * truth for an extract.
 *
 * Display expands a roll into every cell-to-cell step (dice walk, then
 * any extra jump from the cell effect) so the admin can see where the
 * chip went and why.
 */
import type { Cell, GameLog, Player } from "../types";

export type MoveKind = "roll" | "admin" | "restart" | "skip" | "prize" | "other";

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

/** One line the admin actually reads. */
export interface HistoryLine {
  at: number;
  when: string;
  fromCell: number | null;
  toCell: number | null;
  why: string;
}

const ROLL_RE = /выбросил\s+(\d+)\s+и переместился на клетку\s+(\d+)/i;
const ADMIN_RE = /Клетка:\s*(\d+)\s*➔\s*(\d+)/;
const RESTART_RE = /начал новый круг с клетки\s+(\d+)/i;
const SKIP_RE = /пропустил ход/i;
const PRIZE_RE = /получил призовой бонус:\s*"([^"]+)"/i;
const WIN_RE = /получил приз:\s*(.+?)(?:!|$)/i;

export function classifyLogMessage(message: string): Omit<PlayerMove, "at" | "timeLabel"> | null {
  const roll = message.match(ROLL_RE);
  if (roll) {
    return {
      kind: "roll",
      fromCell: null,
      toCell: Number(roll[2]),
      steps: Number(roll[1]),
      note: "",
    };
  }

  const admin = message.match(ADMIN_RE);
  if (admin) {
    return {
      kind: "admin",
      fromCell: Number(admin[1]),
      toCell: Number(admin[2]),
      steps: null,
      note: "",
    };
  }

  const restart = message.match(RESTART_RE);
  if (restart) {
    return {
      kind: "restart",
      fromCell: Number(restart[1]),
      toCell: 0,
      steps: null,
      note: "",
    };
  }

  if (SKIP_RE.test(message)) {
    return {
      kind: "skip",
      fromCell: null,
      toCell: null,
      steps: null,
      note: "",
    };
  }

  const prize = message.match(PRIZE_RE) || message.match(WIN_RE);
  if (prize) {
    return {
      kind: "prize",
      fromCell: null,
      toCell: null,
      steps: null,
      note: prize[1].trim(),
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
      const key = `${m.kind}|${m.fromCell}|${m.toCell}|${m.steps}|${m.note}|${m.at || m.timeLabel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(m);
    }
  }
  all.sort((a, b) => {
    if (a.at && b.at && a.at !== b.at) return a.at - b.at;
    return 0;
  });
  return fillMissingFrom(all);
}

/** Infer a missing start cell from the previous known position. */
export function fillMissingFrom(moves: PlayerMove[]): PlayerMove[] {
  let cursor: number | null = 0;
  return moves.map((m) => {
    const next = { ...m };
    if (next.fromCell == null && next.toCell != null && next.kind === "roll" && cursor != null) {
      next.fromCell = cursor;
    }
    if (next.toCell != null) cursor = next.toCell;
    else if (next.kind === "restart") cursor = 0;
    return next;
  });
}

function cellTitle(id: number | null, cells?: Cell[]): string {
  if (id == null || !Number.isFinite(id)) return "?";
  const named = cells?.find((c) => c.id === id);
  if (named && named.name && !/^Клетка\s+\d+$/i.test(named.name)) {
    return `${id} «${named.name}»`;
  }
  return String(id);
}

function formatWhen(at: number, timeLabel: string): string {
  if (at > 1e11) {
    return new Date(at).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return timeLabel?.trim() || "дата неизвестна";
}

function reasonForJump(from: number, to: number, note: string, cells?: Cell[]): string {
  const clean = (note || "").replace(/\s+/g, " ").trim();
  if (clean) return clean.slice(0, 140);
  const landed = cells?.find((c) => c.id === from);
  if (landed?.extra) return `эффект клетки: ${landed.extra}`;
  if (landed?.name && !/^Клетка\s+\d+$/i.test(landed.name)) return `эффект: ${landed.name}`;
  const delta = to - from;
  if (delta > 0) return `сдвиг вперёд на ${delta}`;
  if (delta < 0) return `сдвиг назад на ${Math.abs(delta)}`;
  return "без сдвига";
}

/**
 * Turn stored events into one line per cell change (and prize awards).
 */
export function expandHistoryLines(moves: PlayerMove[], cells?: Cell[]): HistoryLine[] {
  const lines: HistoryLine[] = [];

  for (const m of moves) {
    const when = formatWhen(m.at, m.timeLabel);

    if (m.kind === "prize") {
      lines.push({
        at: m.at,
        when,
        fromCell: m.toCell,
        toCell: m.toCell,
        why: `приз: ${m.note || "награда"}`,
      });
      continue;
    }

    if (m.kind === "skip") {
      lines.push({ at: m.at, when, fromCell: m.fromCell, toCell: m.fromCell, why: "пропуск хода" });
      continue;
    }

    if (m.kind === "restart") {
      lines.push({
        at: m.at,
        when,
        fromCell: m.fromCell,
        toCell: 0,
        why: "новый круг — фишка на старт",
      });
      continue;
    }

    if (m.kind === "admin" && m.fromCell != null && m.toCell != null) {
      lines.push({
        at: m.at,
        when,
        fromCell: m.fromCell,
        toCell: m.toCell,
        why: "админ переставил фишку",
      });
      continue;
    }

    if (m.kind === "roll" && m.fromCell != null && m.toCell != null) {
      const steps = m.steps && m.steps > 0 ? m.steps : Math.max(1, Math.abs(m.toCell - m.fromCell));
      const walkedTo = Math.max(0, Math.min(64, m.fromCell + steps));

      if (walkedTo !== m.fromCell) {
        const dir = walkedTo >= m.fromCell ? 1 : -1;
        for (let c = m.fromCell; c !== walkedTo; ) {
          const nxt = c + dir;
          lines.push({
            at: m.at,
            when,
            fromCell: c,
            toCell: nxt,
            why: `кубик ${steps}`,
          });
          c = nxt;
        }
      }

      if (m.toCell !== walkedTo) {
        lines.push({
          at: m.at,
          when,
          fromCell: walkedTo,
          toCell: m.toCell,
          why: reasonForJump(walkedTo, m.toCell, m.note, cells),
        });
      }

      if (m.note && /приз|бонус|кристалл|кредит/i.test(m.note)) {
        lines.push({
          at: m.at,
          when,
          fromCell: m.toCell,
          toCell: m.toCell,
          why: `приз / бонус: ${m.note.slice(0, 140)}`,
        });
      }
      continue;
    }

    if (m.toCell != null) {
      lines.push({
        at: m.at,
        when,
        fromCell: m.fromCell,
        toCell: m.toCell,
        why: m.note || "перемещение",
      });
    }
  }

  return lines;
}

function lineText(line: HistoryLine, cells?: Cell[], html = false): string {
  const b = (s: string) => (html ? `<b>${s}</b>` : s);
  if (line.fromCell == null && line.toCell == null) {
    return `[${line.when}] ${line.why}`;
  }
  if (line.fromCell === line.toCell || line.fromCell == null) {
    return `[${line.when}] ${cellTitle(line.toCell, cells)} — ${line.why}`;
  }
  return (
    `[${line.when}] ${cellTitle(line.fromCell, cells)} → ${b(cellTitle(line.toCell, cells))}` +
    ` — ${line.why}`
  );
}

export function formatPlayerHistoryText(history: PlayerHistory, cells?: Cell[]): string {
  const who = history.alias ? `${history.alias} (${history.name})` : history.name;
  const lines = expandHistoryLines(history.moves, cells);
  const out = [
    `История: ${who}`,
    `Сейчас клетка: ${cellTitle(history.cell, cells)}`,
    `Переходов: ${lines.length}`,
    "",
  ];

  if (lines.length === 0) {
    out.push("Перемещений в журнале нет.");
    return out.join("\n");
  }

  lines.forEach((line, i) => {
    out.push(`${i + 1}. ${lineText(line, cells, false)}`);
  });
  return out.join("\n");
}

export function formatPlayerHistoryHtml(history: PlayerHistory, cells?: Cell[]): string {
  const who = history.alias
    ? `${escapeHtml(history.alias)} (${escapeHtml(history.name)})`
    : escapeHtml(history.name);
  const lines = expandHistoryLines(history.moves, cells);
  const head =
    `📜 <b>История игрока</b>\n` +
    `${who}\n` +
    `Сейчас: <b>${escapeHtml(cellTitle(history.cell, cells))}</b>\n` +
    `Переходов: <b>${lines.length}</b>`;

  if (lines.length === 0) {
    return head + "\n\nПеремещений в журнале нет.";
  }

  const shown = lines.slice(-50);
  const rows = shown.map((line, i) => {
    const idx = lines.length - shown.length + i + 1;
    return `${idx}. ${lineText(line, cells, true)}`;
  });

  const clipped =
    lines.length > 50 ? `\n<i>В сообщении последние 50. Полный список — в файле.</i>` : "";

  return `${head}\n\n${rows.join("\n")}${clipped}`;
}

function escapeHtml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function findPlayerByTarget(players: Player[], target: string): Player | undefined {
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
