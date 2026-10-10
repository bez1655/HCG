/**
 * Journal of turn *requests* vs *grants*.
 *
 * The live game log says "asked for a turn" / "approved N" but does not keep
 * a per-player ledger. This module is that ledger, and can rebuild a prefix
 * from existing log lines.
 */
import type { GameLog, Player } from "../types";

export type TurnJournalKind = "request" | "grant" | "reject";

export interface TurnJournalEntry {
  at: number;
  timeLabel: string;
  kind: TurnJournalKind;
  playerId: string;
  name: string;
  alias: string | null;
  requested: number | null;
  granted: number | null;
  note: string;
}

export interface TurnAskRow {
  at: number;
  timeLabel: string;
  playerId: string;
  name: string;
  alias: string | null;
  requested: number;
  granted: number | null;
  status: "pending" | "granted" | "rejected" | "unknown";
}

const REQ_RE = /Игрок\s+(.+?)\s+запросил(?:\s+(\d+)\s+ход)?/i;
const GRANT_RE = /Игроку\s+(.+?)\s+одобрено\s+(\d+)/i;
const REJECT_RE = /Запрос хода для игрока\s+(.+?)\s+отклонен/i;

export function parseTurnLogLine(
  message: string
): { kind: TurnJournalKind; who: string; n: number | null } | null {
  const grant = message.match(GRANT_RE);
  if (grant) return { kind: "grant", who: grant[1].trim(), n: Number(grant[2]) };
  const rej = message.match(REJECT_RE);
  if (rej) return { kind: "reject", who: rej[1].trim(), n: null };
  const req = message.match(REQ_RE);
  if (req) return { kind: "request", who: req[1].trim(), n: req[2] ? Number(req[2]) : 1 };
  return null;
}

function matchPlayer(players: Player[], who: string): Player | undefined {
  const needle = who.trim().toLowerCase().replace(/^@/, "");
  return players.find(
    (p) =>
      (p.alias || "").toLowerCase() === who.trim().toLowerCase() ||
      p.name.toLowerCase().replace(/^@/, "") === needle ||
      (p.telegramUsername || "").toLowerCase() === needle
  );
}

function stampOf(log: GameLog): { at: number; timeLabel: string } {
  const t = log.timestamp || "";
  const ru = t.match(
    /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (ru) {
    const [, dd, mm, yyyy, hh = "0", min = "0", ss = "0"] = ru;
    const at = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(min),
      Number(ss)
    ).getTime();
    if (Number.isFinite(at)) return { at, timeLabel: t };
  }
  return { at: 0, timeLabel: t || "дата неизвестна" };
}

export function entriesFromLogs(logs: GameLog[], players: Player[]): TurnJournalEntry[] {
  const out: TurnJournalEntry[] = [];
  const chronological = [...logs].reverse();
  for (const log of chronological) {
    const parsed = parseTurnLogLine(log.message || "");
    if (!parsed) continue;
    const player = matchPlayer(players, parsed.who);
    const { at, timeLabel } = stampOf(log);
    out.push({
      at,
      timeLabel,
      kind: parsed.kind,
      playerId: player?.id || "",
      name: player?.name || parsed.who,
      alias: player?.alias ?? null,
      requested: parsed.kind === "request" ? parsed.n : null,
      granted: parsed.kind === "grant" ? parsed.n : null,
      note: parsed.kind,
    });
  }
  return out;
}

/** Pair each request with the next grant/reject for the same player. */
export function pairAsks(entries: TurnJournalEntry[]): TurnAskRow[] {
  const open = new Map<string, TurnAskRow[]>();
  const done: TurnAskRow[] = [];
  const keyOf = (e: TurnJournalEntry) => e.playerId || e.name.toLowerCase();

  for (const e of entries) {
    const key = keyOf(e);
    if (e.kind === "request") {
      const row: TurnAskRow = {
        at: e.at,
        timeLabel: e.timeLabel,
        playerId: e.playerId,
        name: e.name,
        alias: e.alias,
        requested: e.requested && e.requested > 0 ? e.requested : 1,
        granted: null,
        status: "pending",
      };
      const q = open.get(key) || [];
      q.push(row);
      open.set(key, q);
      continue;
    }
    const q = open.get(key);
    const row = q && q.length ? q.shift() : undefined;
    if (row) {
      if (e.kind === "grant") {
        row.granted = e.granted;
        row.status = "granted";
      } else {
        row.granted = 0;
        row.status = "rejected";
      }
      done.push(row);
    } else if (e.kind === "grant") {
      done.push({
        at: e.at,
        timeLabel: e.timeLabel,
        playerId: e.playerId,
        name: e.name,
        alias: e.alias,
        requested: e.granted ?? 1,
        granted: e.granted,
        status: "unknown",
      });
    }
  }
  for (const q of open.values()) done.push(...q);
  done.sort((a, b) => {
    if (a.at && b.at) return a.at - b.at;
    if (a.at) return 1;
    if (b.at) return -1;
    return 0;
  });
  return done;
}

export function fingerprint(row: TurnAskRow): string {
  return `${row.playerId}|${row.at}|${row.requested}|${row.granted}|${row.status}|${row.timeLabel}`;
}

export function mergeAskRows(existing: TurnAskRow[], incoming: TurnAskRow[]): TurnAskRow[] {
  const seen = new Set(existing.map(fingerprint));
  const out = [...existing];
  for (const row of incoming) {
    const fp = fingerprint(row);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(row);
  }
  out.sort((a, b) => {
    if (a.at && b.at) return a.at - b.at;
    if (a.at) return 1;
    if (b.at) return -1;
    return 0;
  });
  return out;
}

function who(row: TurnAskRow): string {
  return row.alias ? `${row.alias} (${row.name})` : row.name;
}

function statusRu(row: TurnAskRow): string {
  if (row.status === "granted") return `выдано ${row.granted ?? "?"}`;
  if (row.status === "rejected") return "отказ";
  if (row.status === "pending") return "ждёт";
  return `выдано ${row.granted ?? "?"} (заявка в журнале не найдена)`;
}

export function formatTurnJournalText(rows: TurnAskRow[]): string {
  const lines = [`Журнал запросов хода`, `Записей: ${rows.length}`, ""];
  if (rows.length === 0) {
    lines.push("Пока пусто.");
    return lines.join("\n");
  }
  rows.forEach((row, i) => {
    const when = row.at > 1e11
      ? new Date(row.at).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : row.timeLabel || "дата неизвестна";
    lines.push(
      `${i + 1}. [${when}] ${who(row)} — просил ${row.requested}, ${statusRu(row)}`
    );
  });
  return lines.join("\n");
}

export function formatTurnJournalHtml(rows: TurnAskRow[]): string {
  const shown = rows.slice(-40);
  const head =
    `📒 <b>Журнал запросов хода</b>\n` +
    `Записей: <b>${rows.length}</b>` +
    (rows.length > 40 ? `\n<i>В сообщении последние 40.</i>` : "");
  if (rows.length === 0) return head + "\n\nПока пусто.";
  const body = shown.map((row, i) => {
    const idx = rows.length - shown.length + i + 1;
    const when =
      row.at > 1e11
        ? new Date(row.at).toLocaleString("ru-RU", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : row.timeLabel || "дата неизвестна";
    const w = row.alias
      ? `${esc(row.alias)} (${esc(row.name)})`
      : esc(row.name);
    return `${idx}. [${esc(when)}] ${w} — просил <b>${row.requested}</b>, ${esc(statusRu(row))}`;
  });
  return `${head}\n\n${body.join("\n")}`;
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
