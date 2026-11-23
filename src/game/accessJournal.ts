/**
 * Access & Security Journal + Multi-Account Detection for HCG.
 *
 * Keeps an append-only audit trail in DATA_DIR/access-journal.jsonl:
 * - Records every visit to the game URL:
 *   - Verified Telegram users (via Mini App /api/telegram/auth with initData)
 *   - Unregistered visitors (opened Mini App from Telegram, but no player chip)
 *   - Guests (opened the site in a browser / direct link without Telegram)
 *   - Registration requests (/register from the bot)
 *   - Sockets & classic logins
 * - Extracts client IP reliably behind reverse proxies (Nginx / Caddy / Cloudflare).
 * - Identifies multi-account clusters: multiple Telegram accounts sharing the same IP,
 *   with special high-priority alerts when a registered player and an unapproved
 *   or uninvited applicant share an IP address!
 * - Supports historical log import from Nginx/Caddy access logs.
 */
import fs from "node:fs";
import path from "node:path";
import { createLogger, errorContext } from "../utils/logger";
import { normaliseHandle } from "../telegram/initData";
import type { Player } from "../types";
import type { RegistrationRequest } from "./registrations";

const log = createLogger("AccessJournal");

export type AccessStatus = "registered" | "pending" | "unregistered" | "guest";

export type AccessAction =
  | "telegram_auth"
  | "page_view"
  | "registration_request"
  | "socket_connect"
  | "login_attempt"
  | "historical_log";

export interface AccessEntry {
  id: string;
  timestamp: number;
  isoTime: string;
  mskTime: string;
  ip: string;
  action: AccessAction;
  endpoint: string;
  status: AccessStatus;

  // Telegram identity (when available)
  telegramId?: number;
  username?: string; // '@handle' or handle
  firstName?: string;
  lastName?: string;

  // Registered player identity (when registered)
  playerId?: string;
  playerName?: string;
  playerAlias?: string;

  // Telemetry
  userAgent?: string;
  referer?: string;
  details?: string;
  source?: "live" | "historical";
}

export interface AccountSummary {
  key: string; // "tg:12345678" or "@username" or "guest:ip"
  telegramId?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  status: AccessStatus;
  playerId?: string;
  playerName?: string;
  playerAlias?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  totalVisits: number;
  ips: string[];
  actions: string[];
  userAgents: string[];
}

export interface IpCluster {
  ip: string;
  accounts: AccountSummary[];
  hasRegistered: boolean;
  hasPending: boolean;
  hasUnregistered: boolean;
  hasGuest: boolean;
  isSuspicious: boolean;
  severity: "critical" | "warning" | "info" | "single";
  severityLabel: string;
  firstSeenAt: number;
  lastSeenAt: number;
  totalEntries: number;
  description: string;
}

export interface WhoisResult {
  query: string;
  found: boolean;
  account?: AccountSummary;
  targetIp?: string;
  ips: string[];
  connectedAccounts: AccountSummary[];
  entries: AccessEntry[];
  summaryText: string;
}

// In-memory state and indexes
let journalFile = "";
let entries: AccessEntry[] = [];
const ipIndex = new Map<string, AccessEntry[]>();
const tgIdIndex = new Map<number, AccessEntry[]>();
const handleIndex = new Map<string, AccessEntry[]>();

// Rate-limiting / deduplication of spammy guest visits (at most 1 per 60s per IP)
const guestThrottle = new Map<string, number>();

// Callbacks to read current players and pending requests
let getLivePlayers: () => Player[] = () => [];
let getLivePendingRequests: () => RegistrationRequest[] = () => [];

/**
 * Clean IP string (strips IPv6 mapped IPv4 prefix ::ffff:x.x.x.x)
 */
export function cleanIp(raw: string): string {
  let s = (raw || "").trim();
  if (s.startsWith("::ffff:")) s = s.slice(7);
  // strip port if present: 1.2.3.4:5678 -> 1.2.3.4 (IPv4 only)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(s)) {
    s = s.split(":")[0];
  }
  return s || "unknown";
}

/**
 * Extract client IP from Express request, checking reverse-proxy headers first.
 */
export function extractClientIp(req: {
  headers: Record<string, any>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  // 1. X-Forwarded-For (can be comma-separated list: "client, proxy1, proxy2")
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
    const parts = xForwardedFor.split(",");
    for (const part of parts) {
      const candidate = cleanIp(part);
      if (candidate && candidate !== "unknown" && candidate !== "127.0.0.1") {
        return candidate;
      }
    }
    const first = cleanIp(parts[0]);
    if (first && first !== "unknown") return first;
  } else if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    const first = cleanIp(String(xForwardedFor[0]));
    if (first && first !== "unknown") return first;
  }

  // 2. X-Real-IP (standard Nginx / Caddy header)
  const xRealIp = req.headers["x-real-ip"];
  if (typeof xRealIp === "string" && xRealIp.trim()) {
    const candidate = cleanIp(xRealIp);
    if (candidate && candidate !== "unknown") return candidate;
  }

  // 3. Cloudflare Connecting IP
  const cfConnectingIp = req.headers["cf-connecting-ip"];
  if (typeof cfConnectingIp === "string" && cfConnectingIp.trim()) {
    const candidate = cleanIp(cfConnectingIp);
    if (candidate && candidate !== "unknown") return candidate;
  }

  // 4. Express req.ip or socket remote address
  const fallback = req.ip || req.socket?.remoteAddress;
  return cleanIp(fallback || "unknown");
}

/** Format timestamp in Europe/Moscow time (MSK, UTC+3) */
export function formatMskTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
  } catch {
    return new Date(ts).toLocaleString("ru-RU");
  }
}

function addToIndex(entry: AccessEntry): void {
  // IP index
  const ipList = ipIndex.get(entry.ip) || [];
  ipList.push(entry);
  ipIndex.set(entry.ip, ipList);

  // Telegram ID index
  if (entry.telegramId) {
    const tgList = tgIdIndex.get(entry.telegramId) || [];
    tgList.push(entry);
    tgIdIndex.set(entry.telegramId, tgList);
  }

  // Handle index
  if (entry.username) {
    const norm = normaliseHandle(entry.username);
    const hList = handleIndex.get(norm) || [];
    hList.push(entry);
    handleIndex.set(norm, hList);
  }
}

/**
 * Initialize Access Journal from DATA_DIR.
 * Loads existing access-journal.jsonl, builds index, and seeds known baseline
 * player history if journal is empty.
 */
export function initAccessJournal(
  dataDir: string,
  playersGetter?: () => Player[],
  pendingGetter?: () => RegistrationRequest[]
): void {
  if (dataDir && !fs.existsSync(dataDir)) {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  journalFile = path.join(dataDir, "access-journal.jsonl");
  if (playersGetter) getLivePlayers = playersGetter;
  if (pendingGetter) getLivePendingRequests = pendingGetter;

  entries = [];
  ipIndex.clear();
  tgIdIndex.clear();
  handleIndex.clear();

  if (fs.existsSync(journalFile)) {
    try {
      const content = fs.readFileSync(journalFile, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as AccessEntry;
          entries.push(entry);
          addToIndex(entry);
        } catch {
          /* ignore corrupted line */
        }
      }
      log.info("Access journal loaded", { totalEntries: entries.length, uniqueIps: ipIndex.size });
    } catch (err) {
      log.error("Failed to read access journal", errorContext(err));
    }
  }

  // If journal has no entries yet, seed baseline entries from existing registered players
  // so their accounts and last-seen timestamps are immediately recognized.
  if (entries.length === 0) {
    seedBaselineFromPlayers();
  }
}

export function seedBaselineFromPlayers(): void {
  let players: Player[] = [];
  try {
    if (typeof getLivePlayers === "function") {
      players = getLivePlayers() || [];
    }
  } catch {
    players = [];
  }
  if (!Array.isArray(players) || players.length === 0) return;

  log.info("Seeding baseline access journal from existing players", { count: players.length });
  for (const p of players) {
    const ts = p.lastSeenAt || p.createdAt || Date.now();
    const handle = p.name ? normaliseHandle(p.name) : undefined;
    const entry: AccessEntry = {
      id: `seed_${p.id}_${ts}`,
      timestamp: ts,
      isoTime: new Date(ts).toISOString(),
      mskTime: formatMskTime(ts),
      ip: "pre-seed",
      action: "historical_log",
      endpoint: "/baseline",
      status: "registered",
      telegramId: p.telegramId,
      username: handle,
      playerId: p.id,
      playerName: p.name,
      playerAlias: p.alias,
      details: "Начальная фиксация из базы игроков",
      source: "historical",
    };
    entries.push(entry);
    addToIndex(entry);
  }
}

/**
 * Determine the current status of an account given its Telegram info or handle.
 */
export function resolveAccountStatus(
  telegramId?: number,
  handle?: string
): {
  status: AccessStatus;
  player?: Player;
  pending?: RegistrationRequest;
} {
  const players = getLivePlayers();
  const normHandle = handle ? normaliseHandle(handle) : undefined;

  // 1. Check registered players
  let matchedPlayer: Player | undefined;
  if (telegramId) {
    matchedPlayer = players.find((p) => p.telegramId === telegramId);
  }
  if (!matchedPlayer && normHandle) {
    matchedPlayer = players.find((p) => {
      if (p.name && normaliseHandle(p.name) === normHandle) return true;
      if (p.telegramUsername && normaliseHandle(p.telegramUsername) === normHandle) return true;
      return (p.previousHandles || []).some((h) => normaliseHandle(h) === normHandle);
    });
  }

  if (matchedPlayer) {
    return { status: "registered", player: matchedPlayer };
  }

  // 2. Check pending registration requests
  const pendingRequests = getLivePendingRequests();
  let matchedPending: RegistrationRequest | undefined;
  if (telegramId) {
    matchedPending = pendingRequests.find((r) => r.telegramId === telegramId);
  }
  if (!matchedPending && normHandle) {
    matchedPending = pendingRequests.find((r) => normaliseHandle(r.username) === normHandle);
  }

  if (matchedPending) {
    return { status: "pending", pending: matchedPending };
  }

  // 3. Has Telegram credentials but is neither registered nor pending -> Unregistered!
  if (telegramId || normHandle) {
    return { status: "unregistered" };
  }

  // 4. No Telegram credentials -> Guest browser
  return { status: "guest" };
}

/**
 * Record an access entry into the journal.
 * Automatically enriches with status, formats Moscow time, and appends to disk.
 */
export function recordAccess(input: {
  ip: string;
  action: AccessAction;
  endpoint: string;
  telegramId?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  userAgent?: string;
  referer?: string;
  details?: string;
  source?: "live" | "historical";
  timestamp?: number;
}): AccessEntry | null {
  const clean = cleanIp(input.ip);
  const now = input.timestamp || Date.now();

  // Rate-limit pure guest page views to avoid spamming the log (max 1 per 60s per IP)
  if (input.action === "page_view" && !input.telegramId && !input.username) {
    const lastGuest = guestThrottle.get(clean);
    if (lastGuest && now - lastGuest < 60_000) {
      return null; // Skip redundant page-view entry within 60s window
    }
    guestThrottle.set(clean, now);
  }

  const { status, player } = resolveAccountStatus(input.telegramId, input.username);

  const entry: AccessEntry = {
    id: `acc_${now}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now,
    isoTime: new Date(now).toISOString(),
    mskTime: formatMskTime(now),
    ip: clean,
    action: input.action,
    endpoint: input.endpoint,
    status,
    telegramId: input.telegramId,
    username: input.username ? normaliseHandle(input.username) : undefined,
    firstName: input.firstName,
    lastName: input.lastName,
    playerId: player?.id,
    playerName: player?.name,
    playerAlias: player?.alias,
    userAgent: input.userAgent ? input.userAgent.slice(0, 255) : undefined,
    referer: input.referer ? input.referer.slice(0, 255) : undefined,
    details: input.details,
    source: input.source || "live",
  };

  entries.push(entry);
  addToIndex(entry);

  // Append to disk
  if (journalFile) {
    fs.appendFile(journalFile, JSON.stringify(entry) + "\n", "utf-8", (err) => {
      if (err) log.error("Failed to append to access journal", errorContext(err));
    });
  }

  return entry;
}

/**
 * Summarize accounts that have been observed on a set of entries.
 */
function summarizeAccounts(accEntries: AccessEntry[]): AccountSummary[] {
  const map = new Map<string, AccountSummary>();

  for (const e of accEntries) {
    let key = "";
    if (e.telegramId) key = `tg:${e.telegramId}`;
    else if (e.username) key = normaliseHandle(e.username);
    else if (e.playerId) key = `player:${e.playerId}`;
    else key = `guest:${e.ip}`;

    let summary = map.get(key);
    if (!summary) {
      summary = {
        key,
        telegramId: e.telegramId,
        username: e.username,
        firstName: e.firstName,
        lastName: e.lastName,
        status: e.status,
        playerId: e.playerId,
        playerName: e.playerName,
        playerAlias: e.playerAlias,
        firstSeenAt: e.timestamp,
        lastSeenAt: e.timestamp,
        totalVisits: 0,
        ips: [],
        actions: [],
        userAgents: [],
      };
      map.set(key, summary);
    }

    summary.totalVisits += 1;
    if (e.timestamp < summary.firstSeenAt) summary.firstSeenAt = e.timestamp;
    if (e.timestamp > summary.lastSeenAt) summary.lastSeenAt = e.timestamp;
    if (!summary.ips.includes(e.ip)) summary.ips.push(e.ip);
    if (!summary.actions.includes(e.action)) summary.actions.push(e.action);
    if (e.userAgent && !summary.userAgents.includes(e.userAgent)) {
      if (summary.userAgents.length < 5) summary.userAgents.push(e.userAgent);
    }
    // Update live status & names if became available
    if (e.status === "registered" && summary.status !== "registered") {
      summary.status = "registered";
      summary.playerId = e.playerId;
      summary.playerName = e.playerName;
      summary.playerAlias = e.playerAlias;
    } else if (e.status === "pending" && summary.status === "unregistered") {
      summary.status = "pending";
    }
    if (e.firstName && !summary.firstName) summary.firstName = e.firstName;
    if (e.username && !summary.username) summary.username = e.username;
    if (e.telegramId && !summary.telegramId) summary.telegramId = e.telegramId;
  }

  return Array.from(map.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Multi-account analysis: group by IP and identify suspicious clusters.
 */
export function analyzeMultiAccounts(): {
  totalEntries: number;
  uniqueIps: number;
  uniqueAccounts: number;
  clusters: IpCluster[];
  suspiciousCount: number;
} {
  const clusters: IpCluster[] = [];

  for (const [ip, ipEntries] of ipIndex.entries()) {
    // Skip empty or purely pre-seed dummy IPs
    if (!ip || ip === "pre-seed") continue;

    const accounts = summarizeAccounts(ipEntries);
    // Distinct Telegram / Player identities (excluding pure anonymous guests)
    const tgAccounts = accounts.filter((a) => a.telegramId || a.username || a.playerId);

    const hasRegistered = accounts.some((a) => a.status === "registered");
    const hasPending = accounts.some((a) => a.status === "pending");
    const hasUnregistered = accounts.some((a) => a.status === "unregistered");
    const hasGuest = accounts.some((a) => a.status === "guest");

    let isSuspicious = false;
    let severity: "critical" | "warning" | "info" | "single" = "single";
    let severityLabel = "Один аккаунт";
    let description = "";

    if (tgAccounts.length >= 2) {
      isSuspicious = true;
      if (hasRegistered && (hasPending || hasUnregistered)) {
        severity = "critical";
        severityLabel = "🚨 КРИТИЧЕСКИЙ (Игрок + Заявка/Гость)";
        description = "Зарегистрированный игрок делит IP с незарегистрированным аккаунтом или заявкой!";
      } else if (hasPending && (hasPending || hasUnregistered)) {
        severity = "warning";
        severityLabel = "⚠️ ВЫСОКИЙ (Несколько заявок)";
        description = "Несколько заявок на регистрацию с одного IP-адреса.";
      } else if (hasRegistered && tgAccounts.length > 2) {
        severity = "warning";
        severityLabel = "⚠️ ВЫСОКИЙ (3+ игроков)";
        description = "Три или более игрока играют с одного IP.";
      } else {
        severity = "info";
        severityLabel = "ℹ️ ИНФО (2 игрока)";
        description = "Два игрока делят один IP (общий Wi-Fi / офис / VPN).";
      }
    } else if (tgAccounts.length === 1 && hasGuest && (hasPending || hasUnregistered)) {
      // One applicant/unregistered user + guest web activity
      isSuspicious = false;
      severity = "single";
      severityLabel = "Одна заявка";
      description = "Заявка или переход без подтверждённых вторых аккаунтов.";
    }

    const firstSeenAt = Math.min(...ipEntries.map((e) => e.timestamp));
    const lastSeenAt = Math.max(...ipEntries.map((e) => e.timestamp));

    clusters.push({
      ip,
      accounts,
      hasRegistered,
      hasPending,
      hasUnregistered,
      hasGuest,
      isSuspicious,
      severity,
      severityLabel,
      firstSeenAt,
      lastSeenAt,
      totalEntries: ipEntries.length,
      description,
    });
  }

  // Sort: critical first, then warning, then info, then single; inside each group by lastSeenAt desc
  const severityOrder: Record<string, number> = { critical: 4, warning: 3, info: 2, single: 1 };
  clusters.sort((a, b) => {
    const diff = (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0);
    if (diff !== 0) return diff;
    return b.lastSeenAt - a.lastSeenAt;
  });

  const suspiciousCount = clusters.filter((c) => c.isSuspicious).length;

  return {
    totalEntries: entries.length,
    uniqueIps: ipIndex.size,
    uniqueAccounts: tgIdIndex.size + handleIndex.size,
    clusters,
    suspiciousCount,
  };
}

/**
 * Deep Whois / Dossier for a specific target (@handle, telegramId, IP, or player name).
 */
export function getWhois(target: string): WhoisResult {
  const cleanTarget = (target || "").trim();
  if (!cleanTarget) {
    return {
      query: target,
      found: false,
      ips: [],
      connectedAccounts: [],
      entries: [],
      summaryText: "Укажите @хендл, Telegram ID или IP адрес для поиска.",
    };
  }

  // Check if target is an IP address
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(cleanTarget) || cleanTarget.includes(":");
  if (isIp) {
    const ip = cleanIp(cleanTarget);
    const ipEntries = ipIndex.get(ip) || [];
    if (ipEntries.length === 0) {
      return {
        query: ip,
        found: false,
        targetIp: ip,
        ips: [ip],
        connectedAccounts: [],
        entries: [],
        summaryText: `По IP <code>${ip}</code> записей в журнале не обнаружено.`,
      };
    }

    const accounts = summarizeAccounts(ipEntries);
    const lines: string[] = [
      `🌐 <b>WHOIS ПО IP: <code>${ip}</code></b>`,
      `Всего заходов: <b>${ipEntries.length}</b>`,
      `Первый вход: ${formatMskTime(Math.min(...ipEntries.map((e) => e.timestamp)))}`,
      `Последний вход: ${formatMskTime(Math.max(...ipEntries.map((e) => e.timestamp)))}`,
      "",
      `<b>Обнаруженные аккаунты (${accounts.length}):</b>`,
    ];

    for (const acc of accounts) {
      const statusIcon =
        acc.status === "registered"
          ? "✅ Игрок"
          : acc.status === "pending"
            ? "⏳ Заявка"
            : acc.status === "unregistered"
              ? "⚠️ Не зарегистрирован (гость ТГ)"
              : "🌐 Браузер";
      const name = acc.playerName || acc.username || (acc.telegramId ? `ID:${acc.telegramId}` : "Гость");
      lines.push(
        `• <b>${name}</b> [${statusIcon}]` +
          (acc.telegramId ? ` (TG ID: <code>${acc.telegramId}</code>)` : "") +
          ` — визитов: ${acc.totalVisits}, посл: ${formatMskTime(acc.lastSeenAt)}`
      );
    }

    return {
      query: ip,
      found: true,
      targetIp: ip,
      ips: [ip],
      connectedAccounts: accounts,
      entries: ipEntries.slice(-50),
      summaryText: lines.join("\n"),
    };
  }

  // Target is user handle or numeric Telegram ID
  const isNum = /^\d+$/.test(cleanTarget);
  const numId = isNum ? parseInt(cleanTarget, 10) : undefined;
  const normHandle = normaliseHandle(cleanTarget);

  let matchedEntries: AccessEntry[] = [];
  if (numId) {
    matchedEntries = tgIdIndex.get(numId) || [];
  }
  if (matchedEntries.length === 0) {
    matchedEntries = handleIndex.get(normHandle) || [];
  }

  // Also check if matches player name in gameState
  if (matchedEntries.length === 0) {
    const players = getLivePlayers();
    const p = players.find(
      (x) =>
        (x.name && x.name.toLowerCase() === cleanTarget.toLowerCase()) ||
        (x.alias && x.alias.toLowerCase() === cleanTarget.toLowerCase())
    );
    if (p) {
      if (p.telegramId && tgIdIndex.has(p.telegramId)) {
        matchedEntries = tgIdIndex.get(p.telegramId) || [];
      } else if (p.name && handleIndex.has(normaliseHandle(p.name))) {
        matchedEntries = handleIndex.get(normaliseHandle(p.name)) || [];
      }
    }
  }

  if (matchedEntries.length === 0) {
    return {
      query: cleanTarget,
      found: false,
      ips: [],
      connectedAccounts: [],
      entries: [],
      summaryText: `Аккаунт <b>${cleanTarget}</b> не найден в журнале доступа.`,
    };
  }

  const accountSummary = summarizeAccounts(matchedEntries)[0];
  const userIps = Array.from(new Set(matchedEntries.map((e) => e.ip).filter((ip) => ip && ip !== "pre-seed")));

  // Find all other accounts seen on ANY of these IPs!
  const connectedEntries: AccessEntry[] = [];
  for (const ip of userIps) {
    const ipList = ipIndex.get(ip) || [];
    for (const entry of ipList) {
      if (
        (entry.telegramId && entry.telegramId !== accountSummary.telegramId) ||
        (entry.username && entry.username !== accountSummary.username) ||
        (!entry.telegramId && !entry.username && entry.status !== accountSummary.status)
      ) {
        connectedEntries.push(entry);
      }
    }
  }

  const connectedAccounts = summarizeAccounts(connectedEntries);

  const statusLabel =
    accountSummary.status === "registered"
      ? `✅ ЗАРЕГИСТРИРОВАН (${accountSummary.playerName || ""})`
      : accountSummary.status === "pending"
        ? "⏳ ОЖИДАЕТ РЕГИСТРАЦИИ (Заявка)"
        : "⚠️ НЕ ЗАРЕГИСТРИРОВАН (открывал Mini App без приглашения)";

  const lines: string[] = [
    `👤 <b>ДОСЬЕ: ${accountSummary.username || cleanTarget}</b>`,
    `Статус: <b>${statusLabel}</b>`,
    accountSummary.telegramId ? `Telegram ID: <code>${accountSummary.telegramId}</code>` : "",
    accountSummary.firstName ? `Имя в Telegram: ${accountSummary.firstName}` : "",
    accountSummary.playerAlias ? `Псевдоним RPG: ${accountSummary.playerAlias}` : "",
    `Всего заходов: <b>${accountSummary.totalVisits}</b>`,
    `Первый вход: ${formatMskTime(accountSummary.firstSeenAt)}`,
    `Последний вход: ${formatMskTime(accountSummary.lastSeenAt)}`,
    "",
    `🌐 <b>Использованные IP (${userIps.length}):</b>`,
    userIps.length > 0 ? userIps.map((ip) => `• <code>${ip}</code>`).join("\n") : "• (только начальная база)",
    "",
  ];

  if (connectedAccounts.length > 0) {
    lines.push(`🚨 <b>СВЯЗАННЫЕ АККАУНТЫ С ЭТИХ ЖЕ IP (${connectedAccounts.length}):</b>`);
    for (const ca of connectedAccounts) {
      const cStatus =
        ca.status === "registered"
          ? "✅ Зарегистрирован"
          : ca.status === "pending"
            ? "⏳ Заявка"
            : ca.status === "unregistered"
              ? "⚠️ Не зарегистрирован"
              : "🌐 Браузер";
      const cName = ca.playerName || ca.username || (ca.telegramId ? `ID:${ca.telegramId}` : "Гость");
      lines.push(
        `• <b>${cName}</b> [${cStatus}]` +
          (ca.telegramId ? ` (ID: <code>${ca.telegramId}</code>)` : "") +
          ` — IP: <code>${ca.ips.join(", ")}</code>`
      );
    }
  } else {
    lines.push("✅ Других аккаунтов на этих IP не замечено (мультиаккаунтов нет).");
  }

  return {
    query: cleanTarget,
    found: true,
    account: accountSummary,
    ips: userIps,
    connectedAccounts,
    entries: matchedEntries.slice(-50),
    summaryText: lines.filter(Boolean).join("\n"),
  };
}

/**
 * Check if a registration request shares an IP with any other accounts.
 * Used to immediately notify administrators upon receiving a new /register request.
 */
export function checkRegistrationMultiMatch(
  telegramId?: number,
  username?: string
): {
  hasMatch: boolean;
  isSuspicious: boolean;
  detectedIp?: string;
  matchedAccounts: AccountSummary[];
  warningHtml: string;
} {
  const whois = getWhois(username || (telegramId ? String(telegramId) : ""));
  if (!whois.found || whois.ips.length === 0) {
    return {
      hasMatch: false,
      isSuspicious: false,
      matchedAccounts: [],
      warningHtml: "",
    };
  }

  const primaryIp = whois.ips[whois.ips.length - 1]; // most recent IP
  const otherAccounts = whois.connectedAccounts;

  if (otherAccounts.length === 0) {
    return {
      hasMatch: false,
      isSuspicious: false,
      detectedIp: primaryIp,
      matchedAccounts: [],
      warningHtml: `IP заявителя: <code>${primaryIp}</code> (чистый, совпадений нет).`,
    };
  }

  const hasRegisteredMatch = otherAccounts.some((a) => a.status === "registered");
  const isSuspicious = true;

  const warnLines: string[] = [
    `🚨 <b>СОВПАДЕНИЕ ПО IP (МУЛЬТИАККАУНТ)!</b>`,
    `IP заявителя: <code>${primaryIp}</code>`,
    `С этого же IP в игру заходили:`,
  ];

  for (const acc of otherAccounts) {
    const tag =
      acc.status === "registered"
        ? "✅ Игрок"
        : acc.status === "pending"
          ? "⏳ Заявка"
          : "⚠️ Не зарегистрирован";
    const title = acc.playerName || acc.username || (acc.telegramId ? `ID:${acc.telegramId}` : "Гость");
    warnLines.push(`• <b>${title}</b> [${tag}]${acc.telegramId ? ` (ID: <code>${acc.telegramId}</code>)` : ""}`);
  }

  if (hasRegisteredMatch) {
    warnLines.push(`<i>⚠️ Внимание: на этом IP уже есть зарегистрированный игрок! Возможно создание твинка.</i>`);
  }

  return {
    hasMatch: true,
    isSuspicious,
    detectedIp: primaryIp,
    matchedAccounts: otherAccounts,
    warningHtml: warnLines.join("\n"),
  };
}

/**
 * Generate human-readable analytical text report for export.
 */
export function generateMultiAccountsReportText(): string {
  const analysis = analyzeMultiAccounts();
  const stamp = formatMskTime(Date.now());

  const lines: string[] = [
    "==================================================================",
    "  HAPSTORE CYBER GAME (HCG) — АНАЛИТИЧЕСКИЙ ОТЧЁТ ПО МУЛЬТИАККАУНТАМ",
    `  Сформирован: ${stamp} (время МСК)`,
    "==================================================================",
    "",
    "1. ОБЩАЯ СТАТИСТИКА:",
    `   Всего записей в журнале заходов: ${analysis.totalEntries}`,
    `   Уникальных IP-адресов:          ${analysis.uniqueIps}`,
    `   Подозрительных кластеров (2+):   ${analysis.suspiciousCount}`,
    "",
    "2. КЛАСТЕРЫ СОВПАДЕНИЙ ПО IP (ОДИН IP = НЕСКОЛЬКО АККАУНТОВ):",
    "------------------------------------------------------------------",
  ];

  const suspiciousClusters = analysis.clusters.filter((c) => c.isSuspicious);

  if (suspiciousClusters.length === 0) {
    lines.push("   Совпадений IP среди разных аккаунтов не обнаружено.");
  } else {
    for (let i = 0; i < suspiciousClusters.length; i++) {
      const c = suspiciousClusters[i];
      lines.push(
        `#${i + 1}. IP: ${c.ip}`,
        `    Уровень угрозы: ${c.severityLabel}`,
        `    Описание:       ${c.description}`,
        `    Первый вход:    ${formatMskTime(c.firstSeenAt)}`,
        `    Последний вход: ${formatMskTime(c.lastSeenAt)}`,
        `    Всего заходов:  ${c.totalEntries}`,
        "    Аккаунты на этом IP:"
      );

      for (const a of c.accounts) {
        const status =
          a.status === "registered"
            ? "ЗАРЕГИСТРИРОВАН (Игрок)"
            : a.status === "pending"
              ? "ОЖИДАЕТ РЕГИСТРАЦИИ (Заявка)"
              : a.status === "unregistered"
                ? "НЕ ЗАРЕГИСТРИРОВАН (Открывал Mini App)"
                : "БРАУЗЕР (Гость без TG)";
        const idStr = a.telegramId ? ` [TG ID: ${a.telegramId}]` : "";
        const nameStr = a.playerName ? ` (Имя: ${a.playerName})` : a.firstName ? ` (Имя: ${a.firstName})` : "";
        lines.push(`      • ${a.username || a.key}${idStr}${nameStr} — ${status}`);
        lines.push(`        Визитов: ${a.totalVisits}, посл. вход: ${formatMskTime(a.lastSeenAt)}`);
      }
      lines.push("------------------------------------------------------------------");
    }
  }

  lines.push("", "3. ОСТАЛЬНЫЕ IP (БЕЗ ПЕРЕСЕЧЕНИЙ):");
  const singleClusters = analysis.clusters.filter((c) => !c.isSuspicious);
  for (const c of singleClusters.slice(0, 30)) {
    const acc = c.accounts[0];
    const name = acc?.username || acc?.playerName || acc?.key || "Гость";
    lines.push(`   • ${c.ip}: ${name} (${acc?.status || "guest"}), заходов: ${c.totalEntries}`);
  }
  if (singleClusters.length > 30) {
    lines.push(`   ... и ещё ${singleClusters.length - 30} одиночных IP.`);
  }

  lines.push("", "==================================================================");
  return lines.join("\n");
}

/**
 * Generate CSV export of the access journal.
 * UTF-8 with BOM and semicolon delimiter for direct opening in Russian Excel / Sheets.
 */
export function generateJournalCsv(): string {
  const headers = [
    "Дата и время (МСК)",
    "ISO Timestamp",
    "IP адрес",
    "Статус",
    "Telegram ID",
    "Username",
    "Имя / First Name",
    "Игрок в игре",
    "RPG Псевдоним",
    "Действие",
    "Эндпоинт",
    "User-Agent",
    "Referer",
    "Детали",
    "Источник",
  ];

  const escapeCsv = (val: unknown): string => {
    const s = String(val ?? "").replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows: string[] = [headers.join(";")];

  // Output sorted newest first
  const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);

  for (const e of sorted) {
    const statusRu =
      e.status === "registered"
        ? "Зарегистрирован"
        : e.status === "pending"
          ? "Заявка (Ожидает)"
          : e.status === "unregistered"
            ? "Не зарегистрирован (ТГ)"
            : "Гость (Браузер)";

    const row = [
      escapeCsv(e.mskTime),
      escapeCsv(e.isoTime),
      escapeCsv(e.ip),
      escapeCsv(statusRu),
      escapeCsv(e.telegramId || ""),
      escapeCsv(e.username || ""),
      escapeCsv(e.firstName || ""),
      escapeCsv(e.playerName || ""),
      escapeCsv(e.playerAlias || ""),
      escapeCsv(e.action),
      escapeCsv(e.endpoint),
      escapeCsv(e.userAgent || ""),
      escapeCsv(e.referer || ""),
      escapeCsv(e.details || ""),
      escapeCsv(e.source || "live"),
    ];
    rows.push(row.join(";"));
  }

  // Prepend UTF-8 BOM so Excel opens Cyrillic properly without encoding prompts
  return "\uFEFF" + rows.join("\r\n");
}

/**
 * Import historical log lines (from Nginx or Caddy access logs).
 * Standard Nginx combined format or Caddy JSON / Common Log Format:
 * IP - - [23/Nov/2026:14:15:16 +0300] "GET /path HTTP/1.1" 200 1234 "referer" "user-agent"
 */
export function importLogLines(lines: string[]): {
  imported: number;
  skipped: number;
  totalNow: number;
} {
  let imported = 0;
  let skipped = 0;

  // Regular expression for standard Combined Log Format
  const clfRegex = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([A-Z]+)\s+([^"\s]+)\s+[^"]*"\s+(\d+)\s+(\d+|-)\s+"([^"]*)"\s+"([^"]*)"/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Check if line is already JSON
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const obj = JSON.parse(line);
        const ip = cleanIp(obj.ip || obj["client_ip"] || obj.remote_addr);
        if (ip && ip !== "unknown") {
          const ts = obj.timestamp || (obj.ts ? Number(obj.ts) * 1000 : Date.now());
          recordAccess({
            ip,
            action: "historical_log",
            endpoint: obj.endpoint || obj.uri || obj.path || "/",
            userAgent: obj.userAgent || obj["user_agent"],
            referer: obj.referer,
            details: "Импорт из JSON-лога",
            source: "historical",
            timestamp: ts,
          });
          imported++;
          continue;
        }
      } catch {
        /* fallback to CLF */
      }
    }

    const match = line.match(clfRegex);
    if (!match) {
      skipped++;
      continue;
    }

    const [, ipRaw, dateStr, method, uri, statusCode, , referer, userAgent] = match;
    const ip = cleanIp(ipRaw);

    // Skip internal health checks or localhost
    if (ip === "127.0.0.1" || ip === "::1" || uri === "/healthz") {
      skipped++;
      continue;
    }

    // Skip noisy static assets
    if (/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff2?|map)$/i.test(uri)) {
      skipped++;
      continue;
    }

    // Parse date: e.g. "23/Nov/2026:14:15:16 +0300"
    let timestamp = Date.now();
    try {
      const parsedDate = new Date(dateStr.replace(/^(\d{2})\/(\w{3})\/(\d{4}):/, "$1 $2 $3 "));
      if (!isNaN(parsedDate.getTime())) {
        timestamp = parsedDate.getTime();
      }
    } catch {
      /* keep now */
    }

    recordAccess({
      ip,
      action: "historical_log",
      endpoint: `${method} ${uri} [${statusCode}]`,
      userAgent,
      referer: referer === "-" ? undefined : referer,
      details: "Импорт из Nginx/Caddy access.log",
      source: "historical",
      timestamp,
    });
    imported++;
  }

  log.info("Historical log import finished", { imported, skipped, totalNow: entries.length });
  return {
    imported,
    skipped,
    totalNow: entries.length,
  };
}
