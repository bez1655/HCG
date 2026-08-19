import fs from "fs";
import express from "express";
import http from "http";
import path from "path";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import { CellType, GameState, Player, Cell, ChatMessage, GameLog } from "./src/types";
import crypto from "crypto";
import { hashPassword, verifyPassword, escapeHtml, generatePassword } from "./src/utils/security";
import * as firestore from "./src/persistence/firestore";
import { atomicWrite, ensureDir } from "./src/persistence/files";
import { choosePersistedState } from "./src/persistence/chooseState";
import { resolveMove, isMilestone } from "./src/game/rules";
import { pickAlias, publicName } from "./src/game/aliases";
import { findMentions } from "./src/game/mentions";
// Правило видимости применяет клиент (доска и админка); серверу нужны только
// проверка настройки и значение по умолчанию.
import { normaliseHideAfterHours, DEFAULT_HIDE_AFTER_HOURS } from "./src/game/presence";
import { formatRollReport, RollRecord } from "./src/game/rollReport";
import { buildTurnOutcome, formatTurnOutcomeForTelegram } from "./src/game/turnOutcome";
import {
  findPlayerByTarget,
  formatPlayerHistoryHtml,
  formatPlayerHistoryText,
  mergeMoves,
  movesFromLogs,
  type PlayerMove,
} from "./src/game/playerHistory";
import defaultCellsData from "./src/game/data/cells.json" with { type: "json" };
import {
  ADMIN_PLAYER_ID,
  issueSessionToken,
  verifySessionToken,
  decryptLegacyPass,
} from "./src/auth/session";
import {
  initTelegram,
  sendMessage as sendTelegramMessage,
  sendToUsername as sendTelegramMessageByUsername,
  sendToAdmin as sendTelegramMessageToAdmin,
  clearButtons as clearTelegramButtons,
  rememberUser as rememberTelegramUser,
  persist as saveTelegramUsers,
  sendGroupMessage,
  type SentMessage,
} from "./src/telegram/notifier";
import { verifyInitData, normaliseHandle } from "./src/telegram/initData";
import {
  initRegistrations,
  addRequest as addRegistrationRequest,
  removeRequest as removeRegistrationRequest,
  listRequests as listRegistrationRequests,
  persistRegistrations,
} from "./src/game/registrations";
import { createLogger, configureLogger, errorContext } from "./src/utils/logger";
import {
  validate,
  loginSchema,
  registrationRequestSchema,
  botRegistrationRequestSchema,
  botApproveRegistrationSchema,
  botRejectRegistrationSchema,
  telegramAuthSchema,
  botApproveTurnSchema,
  botRejectTurnSchema,
  botMessagePlayerSchema,
  botBroadcastSchema,
  botPlayerHistorySchema,
  adminPasswordsSchema,
  telegramUserSyncSchema,
  chatSendSchema,
  updatePlayerSchema,
  registerPlayerSchema,
  setPlayerPasswordSchema,
  calibrateCellSchema,
  resetGameSchema,
  updateAvatarSchema,
} from "./src/validation/schemas";
import {
  loadConfig,
  describeConfig,
  secrets,
  app as appConfig,
  firebase as firebaseConfig_env,
  telegram as telegramConfig,
  IS_PRODUCTION,
} from "./src/config/env";

// Validate configuration before anything else runs. Missing secrets abort the
// boot in production instead of silently falling back to a known default.
loadConfig();

configureLogger({
  level: appConfig.logLevel as "debug" | "info" | "warn" | "error" | "silent",
  json: IS_PRODUCTION,
});
const log = createLogger("Server");

// ---------------------------------------------------------------------------
// Firestore is accessed through the Admin SDK (src/persistence/firestore.ts).
// The previous client-SDK integration was bound by security rules, which is
// why /game/{docId} had to be publicly writable. Admin SDK requests bypass
// rules, so firestore.rules can now deny everything.
// ---------------------------------------------------------------------------
const firestoreConfigured = firestore.initFirestore({
  projectId: firebaseConfig_env.projectId,
  databaseId: firebaseConfig_env.firestoreDatabaseId,
  serviceAccountJson: firebaseConfig_env.serviceAccountJson,
  serviceAccountPath: firebaseConfig_env.serviceAccountPath,
});

// ---------------------------------------------------------------------------
// SECURITY CONFIGURATION
// ---------------------------------------------------------------------------
// All secrets come from src/config/env.ts, the single module that reads
// process.env. Nothing is hardcoded here.
// ---------------------------------------------------------------------------

const ADMIN_PASSWORD_HASH = secrets.adminPasswordHash;
const ADMIN_LOGIN = appConfig.adminLogin;

/**
 * Одобренный ход больше не сгорает по времени.
 *
 * Раньше окно жило 12 часов, и невыбранные броски пропадали: игрок,
 * купивший несколько товаров вечером, к утру терял оплаченное. Право на
 * бросок теперь определяется ТОЛЬКО счётчиком turnsApproved.
 *
 * Само поле turnApprovedUntil осталось и заполняется датой далеко в будущем.
 * Это не забытый код: установленный у игроков APK — сборка, которая ещё не
 * знает про счётчик и проверяет именно окно. Обнули поле — и у них молча
 * умрёт кнопка броска. Сервер значение игнорирует, оно живёт ради старых
 * клиентов до пересборки приложения.
 */
const LEGACY_WINDOW_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Upper bound for a single batch approval.
 *
 * A player who made several purchases used to wait for a separate approval
 * after every roll. An approval now opens a batch of rolls, but the number is
 * capped so a typo ("100" instead of "10") cannot hand out the whole board.
 */
const MAX_TURNS_PER_APPROVAL = 10;

/** Clamp any externally supplied turn count into 1..MAX_TURNS_PER_APPROVAL. */
function clampTurns(value: unknown, fallback = 1): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_TURNS_PER_APPROVAL);
}

/**
 * Unspent rolls in the player's current approval.
 *
 * State written before batches existed has no counter: there an open window
 * means exactly one roll, which is what it used to mean.
 */
function turnsLeftFor(player: Player, _now = Date.now()): number {
  /*
   * Только счётчик. Времени в этом решении больше нет.
   *
   * Состояние, записанное до появления счётчика, его не имеет: там открытое
   * окно означало ровно один бросок. Такую запись читаем как один ход, иначе
   * при обновлении у игрока молча пропал бы уже одобренный бросок.
   */
  if (typeof player.turnsApproved === "number") return Math.max(0, player.turnsApproved);
  return player.turnApprovedUntil ? 1 : 0;
}

/** Does this player still have a roll to make right now? */
function hasOpenTurn(player: Player, now = Date.now()): boolean {
  return turnsLeftFor(player, now) > 0;
}
const INTERNAL_API_SECRET = secrets.internalApiSecret;

// ---------------------------------------------------------------------------
// Persistence paths. All writable state lives under DATA_DIR so that it can be
// mapped to a Docker volume (previously files were written to process.cwd()
// while the volume was mounted at /app/data, so everything was lost on redeploy).
// ---------------------------------------------------------------------------
const DATA_DIR = path.isAbsolute(appConfig.dataDir)
  ? appConfig.dataDir
  : path.join(process.cwd(), appConfig.dataDir);

ensureDir(DATA_DIR);

// Telegram delivery lives in src/telegram/notifier.ts.
initTelegram(DATA_DIR);

// Pending registration requests are persisted separately from GameState: they
// hold Telegram ids, which must never be broadcast to clients.
initRegistrations(DATA_DIR);

/** Сколько моделей фишек лежит в public/chips/. */
const CHIP_COUNT = 13;

/**
 * Выдать игроку фишку, по возможности не занятую другими.
 *
 * Раньше номер выбирался случайно из 13, без оглядки на остальных. При шести
 * игроках совпадение случалось в 74% партий (проверено перебором), а две
 * одинаковые фишки на доске невозможно различить — именно за этим фишка и
 * нужна.
 *
 * Сначала берём из свободных; когда все 13 разобраны, возвращаемся к
 * случайному выбору — это честнее, чем отказать в регистрации.
 */
function getRandomChipImage(taken: Iterable<string | undefined> = []): string {
  const used = new Set(taken);
  const free: string[] = [];

  for (let i = 1; i <= CHIP_COUNT; i++) {
    const chip = `/chips/chip_${i}.svg`;
    if (!used.has(chip)) free.push(chip);
  }

  const pool =
    free.length > 0
      ? free
      : Array.from({ length: CHIP_COUNT }, (_, i) => `/chips/chip_${i + 1}.svg`);
  return pool[crypto.randomInt(0, pool.length)];
}

/** Фишки, уже занятые игроками. */
function takenChips(): (string | undefined)[] {
  return gameState.players.map((p) => p.chipImage);
}

/** Псевдонимы, уже занятые игроками. */
function takenAliases(): string[] {
  return gameState.players.map((p) => p.alias).filter((a): a is string => Boolean(a));
}

/** Имя игрока, которое разрешено показать остальным участникам. */
function shownName(player: { alias?: string; name?: string }): string {
  return publicName(player);
}

/** Игроки, названные администратором в сообщении чата. */
function findMentionedPlayers(text: string): Player[] {
  return findMentions(
    text,
    gameState.players.filter((p) => p.role === "player")
  );
}

/**
 * Запись игрока в том виде, в каком её можно отдать ДРУГОМУ игроку.
 *
 * Настоящий хендл заменён псевдонимом, телеграм-поля вырезаны. Всё, что
 * уходит клиенту без роли администратора, проходит через это.
 */
function maskPlayer(p: Player): Player {
  const masked: Player = { ...p, name: publicName(p) };
  delete masked.telegramId;
  delete masked.telegramUsername;
  return masked;
}

/**
 * Сообщение чата для чужих глаз.
 *
 * Имя отправителя в сообщении сохранено на момент отправки, поэтому старые
 * записи могут содержать хендл. Подменяем на псевдоним по senderId.
 */
function maskChatMessage(m: ChatMessage): ChatMessage {
  if (!m.senderName?.startsWith("@")) return m;
  const author = gameState.players.find((p) => p.id === m.senderId);
  return { ...m, senderName: author ? publicName(author) : "Игрок" };
}

/**
 * The default board.
 *
 * The 65 cells (names, effects and calibrated x/y coordinates) used to be
 * 258 lines of literals inside this file. They are data, not logic, so they
 * now live in src/game/data/cells.json and can be edited without touching
 * the server.
 */
function generateDefaultCells(): Cell[] {
  // Cloned so callers can never mutate the shared template.
  return defaultCellsData.map((cell) => ({ ...cell })) as Cell[];
}

const STATE_FILE = path.join(DATA_DIR, "game-state-persistent.json");
const AUTH_FILE = path.join(DATA_DIR, "game-auth-persistent.json");
const CALIBRATION_FILE = path.join(DATA_DIR, "game-calibration-persistent.json");

/** Maximum number of log entries kept in the live game state. The full journal
 *  is appended to a separate file so the Firestore document stays under 1 MB
 *  and the state broadcast to clients does not grow without bound. */
const MAX_LOGS_IN_STATE = 300;
const LOG_ARCHIVE_FILE = path.join(DATA_DIR, "game-logs-archive.jsonl");
const MOVES_FILE = path.join(DATA_DIR, "player-moves.jsonl");

/**
 * Build marker for the game server.
 *
 * Bump together with bot/src/version.ts when shipping something that must be
 * verifiable on a live server.
 */
const SERVER_BUILD = "2026-08-19.1";

// ---------------------------------------------------------------------------
// Persisted-state schema version.
//
// Loaded state used to be reconciled by guesswork (`cells.length === 65`).
// An explicit version lets migrations run deliberately instead of silently
// corrupting or discarding data when the shape changes.
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = 5;

/**
 * Bring a persisted snapshot up to SCHEMA_VERSION.
 * Each step is additive and must be safe to re-run.
 */
function migrateState(raw: any): GameState {
  const from = typeof raw?.schemaVersion === "number" ? raw.schemaVersion : 1;

  if (from > SCHEMA_VERSION) {
    log.warn("State was written by a newer release; loading as-is", {
      stateVersion: from,
      supported: SCHEMA_VERSION,
    });
    return raw as GameState;
  }

  const state = { ...raw } as any;

  // v1 -> v2: the abandoned "pending move" approval flow was removed, and the
  // log array became bounded.
  if (from < 2) {
    delete state.pendingMove;
    if (state.turnStatus === "waiting_admin_confirmation") state.turnStatus = "waiting_roll";
    if (Array.isArray(state.logs) && state.logs.length > MAX_LOGS_IN_STATE) {
      state.logs = state.logs.slice(0, MAX_LOGS_IN_STATE);
    }
    log.info("Migration: Applied v1 -> v2 (dropped pendingMove, bounded logs).");
  }

  // v2 -> v3: a turn approval became a batch of rolls (player.turnsApproved).
  // An approval saved by v2 was worth exactly one roll, so that is what it
  // becomes here; without this every live approval would read as zero turns
  // left and players would be locked out right after an upgrade.
  if (from < 3) {
    if (Array.isArray(state.players)) {
      const now = Date.now();
      for (const p of state.players) {
        if (typeof p.turnsApproved === "number") continue;
        p.turnsApproved = p.turnApprovedUntil && p.turnApprovedUntil > now ? 1 : 0;
      }
    }
    log.info("Migration: Applied v2 -> v3 (turn approvals carry a roll counter).");
  }

  /*
   * v3 -> v4: у игрока появился псевдоним.
   *
   * Без этого шага все, кто зарегистрировался раньше, остались бы с
   * Telegram-хендлом на виду у остальных — ровно та утечка, ради которой
   * псевдонимы и вводились.
   */
  if (from < 4) {
    if (Array.isArray(state.players)) {
      const used: string[] = state.players
        .map((p: any) => p.alias)
        .filter((a: unknown): a is string => typeof a === "string" && a.trim() !== "");

      for (const p of state.players) {
        if (typeof p.alias === "string" && p.alias.trim()) continue;
        const alias = pickAlias(used);
        p.alias = alias;
        used.push(alias);
      }
    }
    log.info("Migration: Applied v3 -> v4 (every player has a public alias).");
  }

  /*
   * v4 -> v5: у игрока появилась отметка последнего появления.
   *
   * Всем существующим ставим «сейчас», а НЕ ноль. Иначе в момент обновления
   * доска разом опустела бы: у каждого игрока стояло бы «не заходил никогда»,
   * и все фишки исчезли бы, хотя люди никуда не девались. Отсчёт начинается
   * с выкатки — кто не вернётся за отведённый срок, пропадёт естественно.
   */
  if (from < 5) {
    if (Array.isArray(state.players)) {
      const now = Date.now();
      for (const p of state.players) {
        if (typeof p.lastSeenAt !== "number") p.lastSeenAt = now;
      }
    }
    if (typeof state.hideTokensAfterHours !== "number") {
      state.hideTokensAfterHours = DEFAULT_HIDE_AFTER_HOURS;
    }
    log.info("Migration: Applied v4 -> v5 (players carry a last-seen stamp).");
  }

  state.schemaVersion = SCHEMA_VERSION;
  return state as GameState;
}

function trimLogs() {
  if (!gameState?.logs || gameState.logs.length <= MAX_LOGS_IN_STATE) return;
  const overflow = gameState.logs.splice(MAX_LOGS_IN_STATE);
  if (overflow.length === 0) return;
  const lines = overflow.map((l) => JSON.stringify(l)).join("\n") + "\n";
  fs.appendFile(LOG_ARCHIVE_FILE, lines, "utf-8", (err) => {
    if (err) log.error("Logs: Failed to append to log archive:", errorContext(err));
  });
}

/**
 * Leave a login/password pair for the bot to deliver.
 *
 * Written into the shared data volume, where the bot picks it up and hands
 * it to the player the first time they open the chat — then deletes it.
 *
 * A file rather than a call: the bot exposes no HTTP port, and Telegram
 * forbids messaging a user who has never written to the bot, so the pair has
 * to wait somewhere regardless. Both containers already mount this volume.
 *
 * Read-modify-write, so a hand-registration does not discard pairs the bot
 * has not collected yet.
 */
function queueCredentialsForBot(handle: string, password: string): void {
  const file = path.join(DATA_DIR, "pending-credentials.json");
  const key = normaliseHandle(handle);

  let items: Array<{ handle: string; password: string; createdAt: number }> = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    // Absent or corrupt: start fresh rather than fail the registration.
  }

  // A newer password supersedes an undelivered older one: the server now
  // accepts only this hash, so handing over the previous pair would lock the
  // player out with credentials that look official.
  items = items.filter((i) => normaliseHandle(i.handle ?? "") !== key);
  items.push({ handle: key, password, createdAt: Date.now() });

  const tmp = `${file}.tmp-${process.pid}`;
  try {
    // mode 0600: this file holds plaintext passwords until collected.
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, file);
    log.info("Credentials queued for delivery by the bot", { handle: key });
  } catch (err) {
    log.error("Could not queue credentials for the bot", errorContext(err));
  }
}

/** Push a log entry and enforce the size cap. */
function addLog(entry: GameLog) {
  gameState.logs.unshift(entry);
  trimLogs();
}

function recordPlayerMove(
  player: Player,
  move: {
    kind: PlayerMove["kind"];
    fromCell: number | null;
    toCell: number | null;
    steps: number | null;
    note: string;
  }
): void {
  const row = {
    playerId: player.id,
    name: player.name,
    alias: player.alias ?? null,
    at: Date.now(),
    timeLabel: new Date().toLocaleString("ru-RU"),
    ...move,
  };
  fs.appendFile(MOVES_FILE, JSON.stringify(row) + "\n", "utf-8", (err) => {
    if (err) log.error("Could not append player move", errorContext(err));
  });

  const who = player.alias
    ? `<b>${escapeHtml(player.alias)}</b> (${escapeHtml(player.name)})`
    : `<b>${escapeHtml(player.name)}</b>`;
  let line = `📜 ${who}`;
  if (move.kind === "roll") {
    const from = move.fromCell != null ? `${move.fromCell} ➔ ` : "";
    line += `\n🎲 ${from}<b>${move.toCell ?? "?"}</b> · кубик ${move.steps ?? "?"}`;
    if (move.note) line += `\n<i>${escapeHtml(move.note)}</i>`;
  } else if (move.kind === "admin") {
    line += `\n🛠️ админ: ${move.fromCell} ➔ <b>${move.toCell}</b>`;
  } else if (move.kind === "restart") {
    line += `\n🔄 новый круг с клетки ${move.fromCell ?? "?"} на 0`;
  } else if (move.kind === "skip") {
    line += `\n⏳ пропуск хода`;
  } else {
    line += `\n${escapeHtml(move.note || move.kind)}`;
  }
  void sendGroupMessage(line);
}

function loadStoredMoves(playerId: string): PlayerMove[] {
  if (!fs.existsSync(MOVES_FILE)) return [];
  try {
    const out: PlayerMove[] = [];
    for (const line of fs.readFileSync(MOVES_FILE, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let row: any;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.playerId !== playerId) continue;
      out.push({
        at: Number(row.at) || 0,
        timeLabel: String(row.timeLabel || ""),
        kind: row.kind || "other",
        fromCell: typeof row.fromCell === "number" ? row.fromCell : null,
        toCell: typeof row.toCell === "number" ? row.toCell : null,
        steps: typeof row.steps === "number" ? row.steps : null,
        note: String(row.note || ""),
      });
    }
    return out;
  } catch (err) {
    log.error("Could not read player-moves.jsonl", errorContext(err));
    return [];
  }
}

function loadArchivedLogs(): GameLog[] {
  if (!fs.existsSync(LOG_ARCHIVE_FILE)) return [];
  try {
    const out: GameLog[] = [];
    for (const line of fs.readFileSync(LOG_ARCHIVE_FILE, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

function buildPlayerHistory(player: Player) {
  const moves = mergeMoves(
    loadStoredMoves(player.id),
    movesFromLogs(loadArchivedLogs(), player),
    movesFromLogs(gameState.logs || [], player)
  );
  return {
    playerId: player.id,
    name: player.name,
    alias: player.alias ?? null,
    cell: player.cell,
    moves,
  };
}

// ---------------------------------------------------------------------------
// Snapshots
//
// admin:reset_game with clearPlayers wipes every player AND their password
// hashes with no way back. A snapshot is written first so a mistaken click is
// always recoverable, and the same routine powers scheduled backups.
// ---------------------------------------------------------------------------

/** Typed phrase an admin must send to confirm a destructive reset. */
const RESET_CONFIRM_PHRASE = "УДАЛИТЬ ВСЕХ";

const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
const MAX_SNAPSHOTS = 20;
/** How often a scheduled snapshot is written (default 6h, override for tests). */
const SNAPSHOT_INTERVAL_MS = appConfig.snapshotIntervalMs;

/** Write a point-in-time copy of state + credentials. Returns the file path. */
function createSnapshot(reason: string): string | null {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(SNAPSHOT_DIR, `${stamp}_${reason}.json`);
    const payload = {
      createdAt: new Date().toISOString(),
      reason,
      schemaVersion: SCHEMA_VERSION,
      gameState,
      authPasswords,
      cellCalibration: cellCalibrationMap,
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
    pruneSnapshots();
    log.info("Snapshot saved", { file: path.basename(file) });
    return file;
  } catch (err) {
    log.error("Snapshot: Failed to create snapshot:", errorContext(err));
    return null;
  }
}

/** Keep only the newest MAX_SNAPSHOTS files. */
function pruneSnapshots() {
  try {
    const files = fs
      .readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_SNAPSHOTS))) {
      fs.unlinkSync(path.join(SNAPSHOT_DIR, stale));
    }
  } catch {
    /* pruning is best-effort */
  }
}

/** Is there any player at all who may roll right now? */
function anyoneCanRoll(now = Date.now()): boolean {
  return gameState.players.some((p) => hasOpenTurn(p, now));
}

// ---------------------------------------------------------------------------
// Контроль выдачи разрешений на ход.
//
// Заявка игрока порождает сообщение админу с кнопкой «Одобрить». Кнопка —
// это ДЕЙСТВИЕ, а не украшение: пока она на месте, её можно нажать ещё раз.
//
// Одобрение из админки или с доски о ней ничего не знало, и сообщение в
// Telegram оставалось живым. Админ, не глядя, жал кнопку — и тот же игрок
// получал ход второй раз. Ровно на это пожаловался пользователь.
//
// Теперь у каждой заявки есть запись здесь. Любое решение — из бота, из
// админки, с доски — закрывает её: кнопки снимаются, текст заменяется на
// итог, повторное нажатие отбивается.
//
// В памяти намеренно: после перезапуска сервера заявки всё равно нет, а
// висящее сообщение обезврежено проверкой turnRequested на стороне бота.
// ---------------------------------------------------------------------------

interface PendingApproval {
  /** Сообщение админу с кнопками — его нужно погасить. */
  message: SentMessage;
  /** Сколько ходов просил игрок: попадёт в итоговый текст. */
  requested: number;
  /** Когда заявка создана. */
  at: number;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Закрыть заявку игрока: снять кнопки и подписать, чем всё кончилось.
 *
 * @param outcome Текст итога. Без него кнопки просто снимаются.
 */
function closeApproval(playerId: string, outcome?: string): void {
  const pending = pendingApprovals.get(playerId);
  if (!pending) return;
  pendingApprovals.delete(playerId);
  void clearTelegramButtons(pending.message, outcome);
}

// ---------------------------------------------------------------------------
// Отчёт администратору о бросках.
//
// Призы выдаются вручную, поэтому админ обязан видеть каждый бросок и его
// исход. Но одобрение открывает ПАЧКУ: отдельное письмо на каждый бросок
// превратило бы серию из десяти в десять уведомлений подряд — и Telegram
// начал бы их резать по лимиту частоты.
//
// Поэтому броски копятся здесь и уходят одним сообщением, когда пачка
// закрылась. Хранится в памяти намеренно: недоставленный отчёт о ходе,
// который уже сыгран, ценности не имеет и переживать перезапуск не должен.
// ---------------------------------------------------------------------------
const pendingRollReports = new Map<string, RollRecord[]>();

/** Запомнить бросок до конца пачки. */
function recordRoll(playerId: string, record: RollRecord): void {
  const list = pendingRollReports.get(playerId);
  if (list) list.push(record);
  else pendingRollReports.set(playerId, [record]);
}

/**
 * Отправить накопленный отчёт и очистить буфер.
 *
 * @param force Отправить, даже если у игрока остались ходы. Нужно, когда
 *   пачку закрыли снаружи — например, администратор отозвал остаток.
 */
function flushRollReport(player: Player, force = false): void {
  const rolls = pendingRollReports.get(player.id);
  if (!rolls || rolls.length === 0) return;

  const remaining = turnsLeftFor(player);
  // Пока в пачке есть ходы, отчёт ждёт: админу нужна одна сводка, а не
  // поток из десяти сообщений.
  if (remaining > 0 && !force) return;

  pendingRollReports.delete(player.id);

  /*
   * В отчёте — и псевдоним, и настоящий хендл.
   *
   * Отчёт видит только администратор, и ему нужны оба: по псевдониму он
   * узнаёт игрока на доске, по хендлу — пишет ему в Telegram.
   */
  const alias = shownName(player);
  const text = formatRollReport({
    playerName: player.name && player.name !== alias ? `${alias} (${player.name})` : alias,
    rolls,
    turnsRemaining: remaining,
  });
  if (text) {
    void sendTelegramMessageToAdmin(text);
    // Та же сводка пачки — в закрытую группу.
    void sendGroupMessage(text);
  }
}

/** Broadcast the current state to every connected client.
 *  Assigned once the Socket.IO server exists. */
let broadcastState: () => void = () => {};

/** Broadcast only the named slices. Assigned alongside broadcastState. */
let broadcastSlices: (...slices: string[]) => void = () => {};

// ---------------------------------------------------------------------------
// Turn approval — single implementation.
//
// This logic previously existed in three near-identical copies
// (admin:approve_player_turn, admin:confirm_turn and the bot REST endpoint),
// which had already started to drift apart. Everything now funnels through
// approveTurn() so the bonus rules can never differ between entry points.
// ---------------------------------------------------------------------------

export interface ApproveTurnResult {
  ok: boolean;
  /** Present when ok === false: a human-readable reason. */
  error?: string;
  player?: Player;
  /** Present when ok === true: how many rolls the approval opened. */
  turns?: number;
  /**
   * Решение по этой заявке уже принято.
   *
   * Отличается от обычной ошибки: бот должен погасить кнопку и сказать
   * «уже обработано», а не показывать красную ошибку.
   */
  alreadyHandled?: boolean;
}

/** Russian pluralisation for "ход" (1 ход / 2 хода / 5 ходов). */
function pluralizeTurns(count: number): string {
  const n = Math.abs(count) % 100;
  if (n >= 11 && n <= 14) return "ходов";
  const last = n % 10;
  if (last === 1) return "ход";
  if (last >= 2 && last <= 4) return "хода";
  return "ходов";
}

/**
 * Grant a player a batch of turns.
 *
 * @param playerId   Player id, or their name (the bot may pass either).
 * @param options.turns  How many rolls to open at once (1..MAX_TURNS_PER_APPROVAL).
 *   Defaults to whatever the player asked for in their request, or 1.
 * @param options.confirmBonusUse  Admin confirms the outstanding prize was
 *   handed over in real life. Without it a player holding an unused bonus
 *   cannot be approved — that is the prize-control rule of the game.
 * @param options.approvedBy  Free-form label used in the log entry.
 */
function approveTurn(
  playerId: string,
  options: {
    confirmBonusUse?: boolean;
    approvedBy?: string;
    turns?: number;
    /** Нажатие кнопки в Telegram: требует непогашенной заявки. */
    requireRequest?: boolean;
  } = {}
): ApproveTurnResult {
  const { confirmBonusUse = false, approvedBy, requireRequest = false } = options;

  const needle = playerId.toLowerCase();
  const player = gameState.players.find(
    (p) => p.id === playerId || p.name.toLowerCase() === needle
  );
  if (!player) return { ok: false, error: "Игрок не найден" };

  /*
   * Защита от повторной выдачи по устаревшей кнопке.
   *
   * Кнопка «Одобрить» живёт в чате и после того, как решение принято в
   * админке или на доске. Нажатие по ней выдавало ход второй раз — жалоба
   * пользователя ровно об этом.
   *
   * Проверка нарочно стоит ЗДЕСЬ, а не в боте: сервер — единственный, кто
   * знает истину, и обойти его нельзя ни старым ботом, ни повтором запроса.
   * Кнопки в интерфейсе админа этого флага не ставят: там админ видит
   * актуальное состояние на экране и вправе выдать ход без всякой заявки.
   */
  if (requireRequest && !player.turnRequested) {
    const left = turnsLeftFor(player);
    return {
      ok: false,
      alreadyHandled: true,
      error:
        left > 0
          ? `Запрос уже обработан: у игрока ${player.name} есть ${left} ${pluralizeTurns(left)}. ` +
            `Повторно выдавать не нужно.`
          : `Запрос уже обработан ранее. Чтобы выдать ход заново, воспользуйтесь ` +
            `админкой или командой /turns.`,
      player,
    };
  }

  // Prize control: an unused bonus blocks the next roll until an admin
  // confirms it was redeemed.
  if (player.activeBonus && !confirmBonusUse) {
    const label = player.activeBonus.extra || player.activeBonus.name;
    return {
      ok: false,
      error:
        `⚠️ Нельзя одобрить ход! У игрока ${player.name} есть неиспользованный бонус ` +
        `(${label}). Подтвердите его использование перед одобрением.`,
      player,
    };
  }

  if (player.activeBonus && confirmBonusUse) {
    const usedBonus = player.activeBonus;
    player.activeBonus = null;
    addLog({
      id: "bonus_use_" + Date.now(),
      message:
        `✅ Подтверждено использование бонуса "${usedBonus.extra || usedBonus.name}" ` +
        `игроком ${player.name} в реальной жизни. Бонус списан.`,
      timestamp: new Date().toLocaleTimeString(),
      type: "admin",
    });
  }

  /*
   * How many rolls this approval opens.
   *
   * Priority: what the admin typed → what the player asked for → one.
   * The counter is not added to a leftover batch: a fresh approval replaces
   * the previous one, so "выдать 3" always means exactly three, whatever was
   * left unspent before.
   */
  const turns = clampTurns(options.turns, clampTurns(player.turnsRequested, 1));

  // Дата в далёком будущем — только ради старого APK, который ещё проверяет
  // окно. Сервер на неё не смотрит: право на бросок держит turnsApproved.
  player.turnApprovedUntil = Date.now() + LEGACY_WINDOW_MS;
  player.turnsApproved = turns;
  player.turnBatchStartedAt = Date.now();
  player.turnRequested = false;
  player.turnsRequested = undefined;
  if (gameState.turnRequestUserId === player.id) {
    gameState.turnRequestUserId = null;
  }

  /*
   * Погасить кнопку в Telegram.
   *
   * Все три входа — бот, админка, доска — сходятся здесь, поэтому и заявка
   * закрывается в одном месте. Иначе одобривший из админки оставлял живую
   * кнопку в чате, и следующее нажатие выдавало ход повторно.
   */
  closeApproval(
    player.id,
    `🟢 <b>ХОД ОДОБРЕН</b>\nИгрок: <b>${escapeHtml(player.name)}</b>\n` +
      `Выдано: <b>${turns}</b> ${pluralizeTurns(turns)}` +
      `${approvedBy ? `\nКем: ${escapeHtml(approvedBy)}` : ""}`
  );

  /*
   * Открыть ход и на общем состоянии, а не только на игроке.
   *
   * Кнопка броска проверяет ДВА условия: turnApprovedUntil у игрока и
   * gameState.turnStatus === "waiting_roll". Одобрение выставляло первое и
   * не трогало второе, так что turnStatus оставался "idle" — кнопка молча
   * возвращалась, не отправив roll:request. Снаружи это выглядит как
   * сломанная анимация: нажатие есть, кубик не появляется.
   *
   * currentPlayerId тоже переводим: он определяет, чей ход показывает
   * интерфейс, и рассинхрон с одобрением сбивал бы подсветку.
   */
  gameState.currentPlayerId = player.id;
  gameState.turnStatus = "waiting_roll";

  addLog({
    id: "approve_" + Date.now(),
    message:
      `👑 Игроку ${shownName(player)} одобрено ${turns} ${pluralizeTurns(turns)} (без ограничения по времени)` +
      `${approvedBy ? ` (${approvedBy})` : ""}.`,
    timestamp: new Date().toLocaleTimeString(),
    type: "admin",
  });

  if (player.telegramId || player.name) {
    void sendTelegramMessage(
      player.telegramId || player.name,
      turns > 1
        ? `ПОРА СДЕЛАТЬ БРОСОК — вам одобрено ${turns} ${pluralizeTurns(turns)} подряд, ` +
            `ждать одобрения между ними не нужно.`
        : "ПОРА СДЕЛАТЬ БРОСОК"
    );
  }

  saveState();
  broadcastSlices("players", "logs", "meta");
  return { ok: true, player, turns };
}

/** Withdraw a pending turn request. Mirror of approveTurn(). */
function rejectTurn(playerId: string, rejectedBy?: string): ApproveTurnResult {
  const needle = playerId.toLowerCase();
  const player = gameState.players.find(
    (p) => p.id === playerId || p.name.toLowerCase() === needle
  );
  if (!player) return { ok: false, error: "Игрок не найден" };

  player.turnRequested = false;
  player.turnsRequested = undefined;
  player.turnApprovedUntil = null;
  // The whole batch is withdrawn, not just the nearest roll: otherwise a
  // rejected player would keep rolling on the leftovers of the last approval.
  player.turnsApproved = 0;
  player.turnBatchStartedAt = undefined;
  if (gameState.turnRequestUserId === player.id) {
    gameState.turnRequestUserId = null;
  }

  // Отказ — тоже решение: кнопка «Одобрить» после него нажиматься не должна.
  closeApproval(
    player.id,
    `🔴 <b>ЗАПРОС ОТКЛОНЁН</b>\nИгрок: <b>${escapeHtml(player.name)}</b>` +
      `${rejectedBy ? `\nКем: ${escapeHtml(rejectedBy)}` : ""}`
  );

  // Пачку закрыли снаружи — досылаем сводку по уже сыгранным броскам, иначе
  // она осталась бы в буфере навсегда.
  flushRollReport(player, true);

  /*
   * Закрыть ход и на общем состоянии — зеркально approveTurn().
   *
   * Отказ снимал одобрение с игрока, но turnStatus оставался
   * "waiting_roll". Кнопка броска проверяет оба условия, так что видимого
   * эффекта не было; зато состояние оставалось «полуоткрытым» и скрывало
   * настоящую ошибку в approveTurn при тестировании.
   */
  if (gameState.currentPlayerId === player.id) {
    // Не закрывать поле всем сразу: у другого игрока может быть живая пачка
    // одобренных ходов, а turnStatus — общий флаг.
    gameState.turnStatus = anyoneCanRoll() ? "waiting_roll" : "idle";
  }

  addLog({
    id: "reject_" + Date.now(),
    message:
      `❌ Запрос хода для игрока ${shownName(player)} отклонен` +
      `${rejectedBy ? ` (${rejectedBy})` : " администратором"}.`,
    timestamp: new Date().toLocaleTimeString(),
    type: "admin",
  });

  saveState();
  broadcastState();
  return { ok: true, player };
}

// ---------------------------------------------------------------------------
// Registration — single implementation.
//
// A player can be created from three places: the bot's approve button, the
// legacy REST endpoint and the admin console. They all funnel through
// registerApprovedPlayer() so the generated credentials, the Telegram binding
// and the log entry can never drift apart.
// ---------------------------------------------------------------------------

export interface RegistrationOutcome {
  /** false when the handle already belongs to a registered player. */
  created: boolean;
  player: Player;
  /** Plaintext one-time password. Only present when created === true. */
  password?: string;
}

/**
 * Create a player from an approved registration request.
 *
 * @param username    Telegram handle, with or without the leading "@".
 * @param options.telegramId  Numeric Telegram id. Storing it is what allows
 *   the player to open the Mini App later and be recognised without a
 *   password.
 * @param options.approvedBy  Free-form label used in the log entry.
 */
async function registerApprovedPlayer(
  username: string,
  options: { telegramId?: number; approvedBy?: string } = {}
): Promise<RegistrationOutcome> {
  const handle = normaliseHandle(username);

  const existing = gameState.players.find((p) => p.name.toLowerCase() === handle);
  if (existing) {
    // Idempotent: re-approving an existing player only refreshes the binding.
    let changed = false;
    if (options.telegramId && existing.telegramId !== options.telegramId) {
      existing.telegramId = options.telegramId;
      changed = true;
    }
    const bareHandle = handle.slice(1);
    if (existing.telegramUsername !== bareHandle) {
      existing.telegramUsername = bareHandle;
      changed = true;
    }
    if (changed) {
      saveState();
      broadcastSlices("players");
    }
    return { created: false, player: existing };
  }

  const newId = "player_" + Date.now() + "_" + crypto.randomInt(100, 1000);
  const password = generatePassword();

  const newPlayer: Player = {
    id: newId,
    name: handle,
    // Псевдоним выдаётся сразу: без него игрок засветил бы свой хендл
    // остальным участникам в первом же журнале.
    alias: pickAlias(takenAliases()),
    role: "player",
    cell: 0,
    color: "#059669",
    isOnline: false,
    lastRoll: null,
    skipNextTurn: false,
    chipImage: getRandomChipImage(takenChips()),
    telegramId: options.telegramId,
    telegramUsername: handle.slice(1),
  };

  authPasswords[newId] = await hashPassword(password);
  gameState.players.push(newPlayer);

  if (!gameState.currentPlayerId) {
    gameState.currentPlayerId = newId;
    gameState.turnStatus = "waiting_roll";
  }

  addLog({
    id: "admin_reg_" + Date.now(),
    message: `➕ Игрок ${newPlayer.alias} зарегистрирован${options.approvedBy ? ` (${options.approvedBy})` : ""}.`,
    timestamp: new Date().toLocaleTimeString(),
    type: "admin",
  });

  saveState();
  broadcastState();

  return { created: true, player: newPlayer, password };
}

let cellCalibrationMap: Record<number, { x: number; y: number }> = {};

function saveCalibration() {
  try {
    const dataStr = JSON.stringify(cellCalibrationMap, null, 2);
    void atomicWrite(CALIBRATION_FILE, dataStr, false);
    void firestore.mergeDoc("cellCalibration", { map: cellCalibrationMap });
  } catch (err) {
    log.error("Failed to save calibration", errorContext(err));
  }
}

// Loaded or fallback state
let gameState: GameState = {
  schemaVersion: SCHEMA_VERSION,
  players: [],
  cells: generateDefaultCells(),
  currentPlayerId: null,
  turnRequestUserId: null,
  turnStatus: "idle",
  chatMessages: [],
  logs: [
    {
      id: "1",
      message: "Добро пожаловать в Hapstore! Все системы в неоне.",
      timestamp: new Date().toLocaleTimeString(),
      type: "system",
    },
  ],
  boardImage: null,
  loginBackground: null,
  rulesBackground: null,
  hideTokensAfterHours: DEFAULT_HIDE_AFTER_HOURS,
  calibrationMode: false,
  selectedCalibrationCellId: null,
};

let authPasswords: Record<string, string> = {};

let firestoreWriteTimeout: NodeJS.Timeout | null = null;
let firestoreWritePending = false;

async function performFirestoreWrite() {
  if (!firestore.isEnabled()) return;
  const cleanGameState = JSON.parse(JSON.stringify(gameState));
  cleanGameState.calibrationMode = false;
  cleanGameState.selectedCalibrationCellId = null;
  // One batch keeps the game state and the credential map consistent with
  // each other; quota errors are handled inside the persistence layer.
  await firestore.writeBatch({
    gameState: cleanGameState,
    authPasswords,
  });
}

let localWriteTimeout: NodeJS.Timeout | null = null;
let localWritePending = false;

function performLocalWrite(sync = false) {
  try {
    const cleanGameState = {
      ...gameState,
      calibrationMode: false,
      selectedCalibrationCellId: null,
    };
    const stateStr = JSON.stringify(cleanGameState, null, 2);
    const authStr = JSON.stringify(authPasswords, null, 2);
    if (sync) {
      atomicWrite(STATE_FILE, stateStr, true);
      atomicWrite(AUTH_FILE, authStr, true);
      return;
    }
    void atomicWrite(STATE_FILE, stateStr, false);
    void atomicWrite(AUTH_FILE, authStr, false);
  } catch (fsErr) {
    log.error("Failed to serialise state for local write", errorContext(fsErr));
  }
}

async function saveState() {
  try {
    gameState.revision = (typeof gameState.revision === "number" ? gameState.revision : 0) + 1;
    gameState.updatedAt = Date.now();

    // Save locally with a 500ms debounce to prevent blocking the event loop
    if (!localWriteTimeout) {
      performLocalWrite();
      localWriteTimeout = setTimeout(() => {
        localWriteTimeout = null;
        if (localWritePending) {
          localWritePending = false;
          performLocalWrite();
        }
      }, 500);
    } else {
      localWritePending = true;
    }

    // Save to Firestore with a debounce/throttle to avoid quota exhaustion
    // Maximum 1 write per 5 seconds
    if (firestore.isEnabled()) {
      if (!firestoreWriteTimeout) {
        performFirestoreWrite();
        firestoreWriteTimeout = setTimeout(() => {
          firestoreWriteTimeout = null;
          if (firestoreWritePending && firestore.isEnabled()) {
            firestoreWritePending = false;
            performFirestoreWrite();
          }
        }, 5000);
      } else {
        firestoreWritePending = true;
      }
    }
  } catch (err) {
    log.error("saveState failed", errorContext(err));
  }
}

async function start() {
  log.info("Initializing persistent state");

  // Prove the credential works before treating Firestore as durable storage.
  if (firestoreConfigured) {
    await firestore.verifyConnection();
  }

  // Load cell calibration from Firestore first, fallback to local file
  {
    const calData = await firestore.readDoc<{ map?: Record<number, { x: number; y: number }> }>(
      "cellCalibration"
    );
    if (calData?.map) {
      cellCalibrationMap = calData.map;
      log.info("Loaded calibrated cell coordinates from Firestore", {
        count: Object.keys(cellCalibrationMap).length,
      });
    }
  }

  if (Object.keys(cellCalibrationMap).length === 0 && fs.existsSync(CALIBRATION_FILE)) {
    try {
      const raw = fs.readFileSync(CALIBRATION_FILE, "utf-8");
      cellCalibrationMap = JSON.parse(raw);
      log.info("Loaded calibrated cell coordinates from local file", {
        count: Object.keys(cellCalibrationMap).length,
      });
    } catch (err) {
      log.error("Calibration: Failed to load local calibration file:", errorContext(err));
    }
  }

  let remoteState: GameState | null = null;
  {
    const data = await firestore.readDoc<GameState>("gameState");
    if (data) remoteState = migrateState(data);
  }

  let localState: GameState | null = null;
  if (fs.existsSync(STATE_FILE)) {
    try {
      localState = migrateState(JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")));
    } catch (localErr) {
      log.error("Failed to load local state fallback", errorContext(localErr));
    }
  }

  const picked = choosePersistedState(localState, remoteState);
  if (picked.state) {
    gameState =
      picked.state.cells && picked.state.cells.length === 65
        ? { ...gameState, ...picked.state }
        : { ...gameState, ...picked.state, cells: generateDefaultCells() };
    log.info("Loaded game state", {
      source: picked.source,
      reason: picked.reason,
      revision: gameState.revision ?? 0,
      updatedAt: gameState.updatedAt ?? 0,
    });
  }

  // Populate cellCalibrationMap from loaded cells if not already set
  if (gameState && gameState.cells) {
    gameState.cells.forEach((c) => {
      if (typeof c.x === "number" && typeof c.y === "number") {
        if (!cellCalibrationMap[c.id]) {
          cellCalibrationMap[c.id] = { x: c.x, y: c.y };
        }
      }
    });
  }

  // Reconcile loaded cells with defaults while STRICTLY PRESERVING calibrated coordinates from cellCalibrationMap
  const defaultCells = generateDefaultCells();
  gameState.cells = defaultCells.map((dc) => {
    const loaded = gameState.cells ? gameState.cells.find((c) => c.id === dc.id) : null;
    const cal = cellCalibrationMap[dc.id];

    const finalX =
      cal && typeof cal.x === "number"
        ? cal.x
        : loaded && typeof loaded.x === "number"
          ? loaded.x
          : dc.x;
    const finalY =
      cal && typeof cal.y === "number"
        ? cal.y
        : loaded && typeof loaded.y === "number"
          ? loaded.y
          : dc.y;

    return {
      ...(loaded || {}),
      ...dc,
      x: finalX,
      y: finalY,
    };
  });

  // Always reset calibrationMode on server initialization
  gameState.calibrationMode = false;
  gameState.selectedCalibrationCellId = null;

  // Ensure all loaded players have chipImage assigned
  if (gameState && gameState.players) {
    let chipAssigned = false;
    gameState.players.forEach((p) => {
      if (!p.chipImage) {
        p.chipImage = getRandomChipImage(takenChips());
        chipAssigned = true;
      }
    });
    if (chipAssigned) {
      log.info("Chips: Assigned random chip model images to players missing chipImage.");
    }
  }

  // Save reconciled calibration map to keep persistence in sync
  saveCalibration();

  // Write back updated cells to state file
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(gameState, null, 2), "utf-8");
  } catch (err) {
    log.error("Storage: Failed to write the reconciled state file:", errorContext(err));
  }

  // Load auth passwords from Firestore first, fallback to local file
  let loadedAuthFromFirestore = false;
  {
    const authData = await firestore.readDoc<Record<string, string>>("authPasswords");
    if (authData) {
      authPasswords = authData;
      loadedAuthFromFirestore = true;
      log.info("Loaded auth state from Firestore");
    }
  }

  if (!loadedAuthFromFirestore) {
    if (fs.existsSync(AUTH_FILE)) {
      try {
        const data = fs.readFileSync(AUTH_FILE, "utf-8");
        authPasswords = JSON.parse(data);
        log.info("Loaded auth state from local fallback");
      } catch (localErr) {
        log.error("Failed to load local auth fallback", errorContext(localErr));
      }
    }
  }

  // Ensure all loaded passwords are migrated to secure one-way salted hashes
  let authMigrated = false;
  for (const pid in authPasswords) {
    const rawVal = authPasswords[pid];
    if (rawVal && !rawVal.includes(":")) {
      let plain = rawVal;
      const dec = decryptLegacyPass(rawVal);
      if (dec) plain = dec;
      authPasswords[pid] = await hashPassword(plain);
      authMigrated = true;
    }
  }
  if (authMigrated) {
    log.info("Security: All legacy passwords migrated to secure salted PBKDF2 hashes.");
    saveState();
  }

  // NOTE: The previous implementation ran its own getUpdates long-polling loop
  // here. That competed with the dedicated bot container for the same updates
  // (Telegram delivers each update only once), causing non-deterministic message
  // loss and HTTP 409 conflicts. Long-polling now lives exclusively in bot/,
  // which pushes the username -> chatId mapping to this server via
  // POST /api/internal/telegram-user.

  const app = express();
  app.disable("x-powered-by");

  const server = http.createServer(app);

  // CORS allow-list. Telegram Mini Apps are served from web.telegram.org, and
  // the public deployment origin comes from WEB_APP_URL.
  //
  // The Android build is a different case: a Capacitor WebView serves the page
  // from the device, so its requests carry an Origin of https://localhost (or
  // capacitor://localhost on some versions) and are cross-origin from the
  // server's point of view. Without these entries the standalone app cannot
  // even log in — the browser blocks the response before the app sees it.
  const allowedOrigins = [
    appConfig.webAppUrl,
    "https://web.telegram.org",
    // Android WebView (Capacitor)
    "https://localhost",
    "capacitor://localhost",
    "http://localhost",
    ...(IS_PRODUCTION ? [] : ["http://localhost:3000", "http://127.0.0.1:3000"]),
  ].filter(Boolean) as string[];

  const io = new Server(server, {
    cors: {
      origin: allowedOrigins.length > 0 ? allowedOrigins : false,
      methods: ["GET", "POST"],
      credentials: true,
    },
    maxHttpBufferSize: 1e6, // 1 MB per socket message
  });

  // -------------------------------------------------------------------------
  // Delta broadcasting
  //
  // Every mutation used to emit the whole GameState to every client — roughly
  // 68 KB with a full log buffer, of which the logs (42 KB), chat (15 KB) and
  // cells (10 KB) rarely change. Clients now receive only the slices that
  // actually changed (~1.4 KB for a typical roll) and merge them locally.
  // The full snapshot is still sent once, on connect.
  // -------------------------------------------------------------------------

  /** Slices whose contents are large and change independently. */
  type StateSlice = "players" | "cells" | "logs" | "chatMessages" | "meta";

  let pendingSlices = new Set<StateSlice>();
  let flushTimer: NodeJS.Timeout | null = null;

  /** Fields that are small and always shipped together as "meta". */
  function metaSlice() {
    return {
      schemaVersion: gameState.schemaVersion,
      currentPlayerId: gameState.currentPlayerId,
      turnRequestUserId: gameState.turnRequestUserId,
      turnStatus: gameState.turnStatus,
      boardImage: gameState.boardImage,
      loginBackground: gameState.loginBackground,
      rulesBackground: gameState.rulesBackground,
      calibrationMode: gameState.calibrationMode,
      selectedCalibrationCellId: gameState.selectedCalibrationCellId,
      hideTokensAfterHours: gameState.hideTokensAfterHours,
    };
  }

  /*
   * Рассылка идёт ДВУМЯ версиями состояния.
   *
   * Обычный игрок не должен видеть Telegram-хендлы других участников:
   * наружу уходит псевдоним. Администратору нужен настоящий хендл — он по
   * нему пишет игроку и ищет его в боте.
   *
   * Раньше и патч, и первый снимок отдавали сырых игроков всем подряд, так
   * что хендлы утекали в обход publicGameState().
   */
  function flushDelta() {
    flushTimer = null;
    if (pendingSlices.size === 0) return;

    /*
     * Снимок набора ДО очистки.
     *
     * Здесь была моя регрессия. Раньше патч собирался один раз, и очистка
     * pendingSlices стояла сразу после сборки. Когда я разделил рассылку на
     * две версии (игрокам — псевдонимы, администратору — настоящие хендлы),
     * очистка осталась на прежнем месте — ПЕРЕД вызовами build(). Обе
     * функции обходили уже пустой набор и отправляли `{}`.
     *
     * Снаружи это выглядело так: удалил игрока, а он не исчезает, пока не
     * перезапустишь приложение. Обновления шли, но были пустыми.
     */
    const slices = [...pendingSlices];
    pendingSlices = new Set();

    const build = (forAdmin: boolean) => {
      const patch: Record<string, unknown> = {};
      for (const slice of slices) {
        if (slice === "meta") Object.assign(patch, metaSlice());
        else if (slice === "players") {
          patch.players = forAdmin
            ? gameState.players.map((p) => ({ ...p }))
            : gameState.players.map(maskPlayer);
        } else if (slice === "chatMessages") {
          patch.chatMessages = forAdmin
            ? gameState.chatMessages
            : gameState.chatMessages.map(maskChatMessage);
        } else patch[slice] = (gameState as any)[slice];
      }
      return patch;
    };

    const forPlayers = build(false);
    const forAdmins = build(true);

    for (const sock of io.sockets.sockets.values()) {
      sock.emit("state:patch", sock.data?.role === "admin" ? forAdmins : forPlayers);
    }
  }

  /**
   * Queue a partial update. Slices are coalesced over a short window so a
   * burst of mutations results in a single frame.
   */
  broadcastSlices = (...slices: string[]) => {
    for (const s of slices) pendingSlices.add(s as StateSlice);
    if (!flushTimer) flushTimer = setTimeout(flushDelta, 50);
  };

  // Default entry point kept for call sites that touch several areas at once
  // (registration, reset, restore). Sends every slice as one patch.
  broadcastState = () => {
    broadcastSlices("players", "cells", "logs", "chatMessages", "meta");
  };

  // Baseline security headers (kept dependency-free).
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // NOTE: X-Frame-Options is deliberately NOT set.
    //
    // It only understands SAMEORIGIN / DENY — there is no way to allow a
    // specific third-party origin. Setting SAMEORIGIN blocked the Telegram
    // Mini App webview outright ("Не удалось загрузить"). Framing is instead
    // controlled by the CSP frame-ancestors directive below, which is the
    // modern replacement and supports an allow-list.
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://telegram.org",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' data: https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        // Telegram serves the webview from several hosts depending on the
        // client (web, desktop, mobile), so all of them must be reachable.
        "connect-src 'self' ws: wss: https://telegram.org https://*.telegram.org",
        "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org https://telegram.org",
      ].join("; ")
    );
    if (IS_PRODUCTION) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // Default body limit is small; only the admin image upload route allows more.
  app.use(express.json({ limit: "128kb" }));

  // ---------------------------------------------------------------------------
  // CORS for the REST API.
  //
  // Socket.IO had its own allow-list from the start, but plain HTTP requests
  // had none: same-origin callers (the browser build, the Telegram Mini App)
  // never needed one. The Android build does — its WebView serves the page
  // from the device, so /api/login is cross-origin and the browser discards
  // the response unless the server says otherwise.
  //
  // Echoing back only origins from the same allow-list keeps this from turning
  // into an open API: an unlisted origin gets no header at all.
  // ---------------------------------------------------------------------------
  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (typeof origin === "string" && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      // Responses differ per origin; without this a shared cache could serve
      // one origin's headers to another.
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Token");
      res.setHeader("Access-Control-Max-Age", "86400");
    }

    // Preflight: answer and stop, never fall through to a route handler.
    if (req.method === "OPTIONS") {
      return res.sendStatus(origin && res.getHeader("Access-Control-Allow-Origin") ? 204 : 403);
    }

    next();
  });

  // --- Simple in-memory rate limiter ---------------------------------------
  const rateBuckets = new Map<string, { count: number; resetAt: number }>();

  function rateLimit(options: { windowMs: number; max: number; key: string }) {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const ip =
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
      const bucketKey = `${options.key}:${ip}`;
      const now = Date.now();
      const bucket = rateBuckets.get(bucketKey);

      if (!bucket || bucket.resetAt < now) {
        rateBuckets.set(bucketKey, { count: 1, resetAt: now + options.windowMs });
        return next();
      }
      if (bucket.count >= options.max) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        res.setHeader("Retry-After", String(retryAfter));
        return res
          .status(429)
          .json({ error: `Слишком много запросов. Повторите через ${retryAfter} с.` });
      }
      bucket.count += 1;
      next();
    };
  }

  // Periodically evict stale rate-limit buckets.
  const rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateBuckets) if (v.resetAt < now) rateBuckets.delete(k);
  }, 60_000);
  rateCleanupTimer.unref?.();

  /** Guards internal endpoints that only the Telegram bot container may call. */
  function requireInternalAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) {
    const provided = req.headers["x-internal-token"];
    if (typeof provided !== "string" || provided.length !== INTERNAL_API_SECRET.length) {
      return res.status(403).json({ error: "Forbidden" });
    }
    try {
      if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(INTERNAL_API_SECRET))) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } catch (e) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  }

  /** Strip sensitive fields before sending state to unauthenticated callers. */
  function publicGameState(state: GameState) {
    return {
      ...state,
      players: state.players.map((p) => ({
        id: p.id,
        // Псевдоним, а не Telegram-хендл: этот ответ открыт без авторизации.
        name: publicName(p),
        alias: p.alias,
        role: p.role,
        cell: p.cell,
        color: p.color,
        isOnline: p.isOnline,
        lastRoll: p.lastRoll,
        skipNextTurn: p.skipNextTurn,
        turnRequested: p.turnRequested,
        turnsRequested: p.turnsRequested,
        turnApprovedUntil: p.turnApprovedUntil,
        turnsApproved: p.turnsApproved,
        // Нужна доске, чтобы скрыть фишку давно пропавшего игрока. Это не
        // персональные данные: только момент последнего появления в игре.
        lastSeenAt: p.lastSeenAt,
        avatar: p.avatar,
        chipImage: p.chipImage,
        activeBonus: p.activeBonus,
        // telegramId / telegramUsername intentionally omitted (personal data)
      })),
    };
  }

  // API endpoints
  app.get("/api/state", (req, res) => {
    res.json(publicGameState(gameState));
  });

  app.post(
    "/api/admin/passwords",
    rateLimit({ windowMs: 60_000, max: 10, key: "adminpw" }),
    async (req, res) => {
      const pwParsed = validate(adminPasswordsSchema, req.body);
      if (!pwParsed.ok) {
        return res.status(400).json({ error: pwParsed.error });
      }
      if (!(await verifyPassword(pwParsed.data.password, ADMIN_PASSWORD_HASH))) {
        return res.status(403).json({ error: "Неверный пароль" });
      }
      const secStatus: Record<string, string> = {};
      for (const key in authPasswords) {
        const val = authPasswords[key];
        secStatus[key] = val ? "🔐 Защищен (Хэш PBKDF2)" : "— (Без пароля)";
      }
      res.json(secStatus);
    }
  );

  // Internal: the bot pushes the @username -> chatId mapping it observes.
  app.post("/api/internal/telegram-user", requireInternalAuth, (req, res) => {
    const syncParsed = validate(telegramUserSyncSchema, req.body);
    if (!syncParsed.ok) {
      return res.status(400).json({ error: syncParsed.error });
    }
    const { username, chatId } = syncParsed.data;
    rememberTelegramUser(username, chatId);
    res.json({ success: true });
  });

  /**
   * Registration request from the web login screen.
   *
   * The browser only knows a handle typed by hand, so the resulting request
   * carries no Telegram id. Requesting from inside the bot is preferable:
   * that path binds the account immediately and enables password-free entry.
   */
  app.post(
    "/api/telegram/request-registration",
    rateLimit({ windowMs: 10 * 60_000, max: 3, key: "reg" }),
    async (req, res) => {
      const regReqParsed = validate(registrationRequestSchema, req.body);
      if (!regReqParsed.ok) {
        return res.status(400).json({ error: regReqParsed.error });
      }
      const cleanUser = normaliseHandle(regReqParsed.data.username);

      if (gameState.players.some((p) => p.name.toLowerCase() === cleanUser)) {
        return res.status(409).json({ error: "Этот игрок уже зарегистрирован" });
      }

      const { result } = addRegistrationRequest({ username: cleanUser });
      if (result === "duplicate") {
        return res.json({ success: true, alreadyPending: true });
      }

      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: `✅ Зарегистрировать`, callback_data: `approve_reg:${cleanUser}` },
            { text: "❌ Отказать", callback_data: `reject_reg:${cleanUser}` },
          ],
        ],
      };

      await sendTelegramMessageToAdmin(
        `⚡ <b>НОВЫЙ ЗАПРОС НА РЕГИСТРАЦИЮ</b>\n` +
          `Игрок: <b>${escapeHtml(cleanUser)}</b>\n` +
          `<i>Источник: веб-форма входа</i>`,
        inlineKeyboard
      );
      res.json({ success: true });
    }
  );

  /**
   * Registration request forwarded by the bot.
   *
   * This is the preferred path: it supplies the numeric Telegram id and the
   * private chat id, so the approved player is bound to their Telegram account
   * and never has to type the password again.
   */
  app.post("/api/internal/registration-request", requireInternalAuth, (req, res) => {
    const parsed = validate(botRegistrationRequestSchema, req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    const { username, telegramId, chatId, firstName } = parsed.data;
    const handle = normaliseHandle(username);

    const existing = gameState.players.find((p) => p.name.toLowerCase() === handle);
    if (existing) {
      // Already a player: refresh the binding so password-free entry works
      // even for accounts registered before this feature existed.
      let changed = false;
      if (existing.telegramId !== telegramId) {
        existing.telegramId = telegramId;
        changed = true;
      }
      if (existing.telegramUsername !== handle.slice(1)) {
        existing.telegramUsername = handle.slice(1);
        changed = true;
      }
      if (changed) {
        saveState();
        broadcastSlices("players");
      }
      return res.json({ success: true, status: "already_registered", name: existing.name });
    }

    const { result } = addRegistrationRequest({ username: handle, telegramId, chatId, firstName });
    return res.json({
      success: true,
      status: result === "duplicate" ? "already_pending" : "queued",
      username: handle,
    });
  });

  /**
   * Is this handle already a player?
   *
   * Advisory only — the bot uses it to decide which buttons to draw. It is
   * behind the internal token because the roster is not public information.
   */
  app.get("/api/internal/player-status", requireInternalAuth, (req, res) => {
    const raw = typeof req.query.username === "string" ? req.query.username : "";
    if (!raw) return res.status(400).json({ error: "username is required" });

    const handle = normaliseHandle(raw);
    const player = gameState.players.find((p) => p.name.toLowerCase() === handle);
    res.json({
      success: true,
      registered: Boolean(player),
      pending: Boolean(listRegistrationRequests().find((r) => r.username === handle)),
    });
  });

  /**
   * Полное состояние — для администратора и служебных вызовов.
   *
   * /api/state отдаёт псевдонимы вместо Telegram-хендлов, и это правильно:
   * его читают игроки. Но администратору и боту нужен настоящий хендл, чтобы
   * найти человека и написать ему. Точка закрыта внутренним токеном.
   */
  app.get("/api/admin/state", requireInternalAuth, (req, res) => {
    res.json(gameState);
  });

  /**
   * Сводка всего, что ждёт решения администратора.
   *
   * До сих пор /pending показывал только заявки на регистрацию, а запросы
   * ходов и невыданные призы жили каждый в своём сообщении. Если админ
   * пролистал чат, узнать «что вообще висит» было неоткуда — приходилось
   * открывать админку.
   */
  /**
   * Полный список игроков одним файлом.
   *
   * Админка показывает таблицу на экране, но выгрузить её было нельзя:
   * посчитать что-то в Excel, отдать бухгалтеру или просто сохранить срез
   * на память — некуда. Отдаём CSV: открывается и в Excel, и в Google
   * Таблицах без плясок.
   */
  app.get("/api/admin/players-export", requireInternalAuth, (req, res) => {
    const players = gameState.players.filter((p) => p.role === "player");
    const now = Date.now();

    const columns = [
      "Псевдоним",
      "Telegram",
      "Клетка",
      "Последний бросок",
      "Ходов осталось",
      "Ждёт одобрения",
      "Невыданный приз",
      "Сейчас в сети",
      "Последняя активность",
      "Часов без активности",
      "ID",
    ];

    /*
     * Экранирование по RFC 4180: кавычки удваиваются, поле в кавычках.
     * Псевдоним «Ц-3ПО (бета)» или имя с запятой иначе разъехались бы по
     * соседним столбцам.
     */
    const cell = (value: unknown): string => {
      const text = value === null || value === undefined ? "" : String(value);
      return `"${text.replace(/"/g, '""')}"`;
    };

    const rows = players.map((p) => {
      const idleHours =
        typeof p.lastSeenAt === "number" ? Math.floor((now - p.lastSeenAt) / (60 * 60 * 1000)) : "";
      return [
        p.alias ?? "",
        p.name,
        p.cell,
        p.lastRoll ?? "",
        turnsLeftFor(p),
        p.turnRequested ? `да (${Math.max(1, p.turnsRequested ?? 1)})` : "нет",
        p.activeBonus ? p.activeBonus.extra || p.activeBonus.name : "",
        p.isOnline ? "да" : "нет",
        typeof p.lastSeenAt === "number" ? new Date(p.lastSeenAt).toLocaleString("ru-RU") : "",
        idleHours,
        p.id,
      ]
        .map(cell)
        .join(",");
    });

    /*
     * BOM в начале файла обязателен.
     *
     * Без него Excel читает UTF-8 как кодировку системы, и весь русский текст
     * превращается в «ÐŸÑÐµÐ²Ð´Ð¾Ð½Ð¸Ð¼». Файл при этом «открывается успешно» —
     * ошибку заметил бы только тот, кто в него заглянул.
     */
    const csv = "\uFEFF" + [columns.map(cell).join(","), ...rows].join("\r\n") + "\r\n";

    res.json({
      success: true,
      csv,
      total: players.length,
      generatedAt: new Date().toLocaleString("ru-RU"),
    });
  });

  app.get("/api/admin/pending-summary", requireInternalAuth, (req, res) => {
    const players = gameState.players.filter((p) => p.role === "player");

    const turnRequests = players
      .filter((p) => p.turnRequested)
      .map((p) => ({
        id: p.id,
        name: p.name,
        alias: p.alias ?? null,
        cell: p.cell,
        requested: Math.max(1, p.turnsRequested ?? 1),
        // Неиспользованный приз блокирует одобрение — админу это видно сразу.
        blockingBonus: p.activeBonus ? p.activeBonus.extra || p.activeBonus.name : null,
      }));

    const unredeemedPrizes = players
      .filter((p) => p.activeBonus)
      .map((p) => ({
        id: p.id,
        name: p.name,
        alias: p.alias ?? null,
        prize: p.activeBonus!.extra || p.activeBonus!.name,
        cell: p.cell,
      }));

    const approvedTurns = players
      .filter((p) => turnsLeftFor(p) > 0)
      .map((p) => ({
        id: p.id,
        name: p.name,
        alias: p.alias ?? null,
        left: turnsLeftFor(p),
      }));

    res.json({
      success: true,
      registrations: listRegistrationRequests(),
      turnRequests,
      unredeemedPrizes,
      approvedTurns,
      playersTotal: players.length,
    });
  });

  /** Requests still waiting for a decision. Used by the bot's /pending. */
  app.get("/api/admin/registration-requests", requireInternalAuth, (req, res) => {
    res.json({ success: true, requests: listRegistrationRequests() });
  });

  /**
   * Approve a registration.
   *
   * Generates a one-time 8–10 character password, stores its PBKDF2 hash and
   * returns the plaintext exactly once so the caller can deliver it. When
   * `deliverBy` is "bot" the caller sends the message itself — it knows the
   * private chat id even for players the server has never seen.
   */
  app.post("/api/admin/bot-approve-registration", requireInternalAuth, async (req, res) => {
    const botRegParsed = validate(botApproveRegistrationSchema, req.body);
    if (!botRegParsed.ok) {
      return res.status(400).json({ error: botRegParsed.error });
    }
    const { username, admin, deliverBy } = botRegParsed.data;
    const handle = normaliseHandle(username);

    // A queued request may carry the Telegram id even when the caller did not.
    const queued = removeRegistrationRequest(handle);
    const telegramId = botRegParsed.data.telegramId ?? queued?.telegramId;

    const outcome = await registerApprovedPlayer(handle, {
      telegramId,
      approvedBy: `одобрено в Telegram: ${admin || "администратор"}`,
    });

    if (!outcome.created) {
      return res.json({
        success: true,
        created: false,
        name: outcome.player.name,
        message: "Игрок уже зарегистрирован",
      });
    }

    // Legacy callers rely on the server delivering the credentials.
    if (deliverBy !== "bot") {
      void sendTelegramMessageByUsername(
        handle,
        `✅ <b>Регистрация одобрена!</b>\nВаш логин: <b>${escapeHtml(handle)}</b>\n` +
          `Пароль: <code>${escapeHtml(outcome.password!)}</code>\n\n` +
          `<i>Сохраните его. Внутри Telegram пароль не потребуется — нажмите «ИГРАТЬ».</i>`
      );
    }

    return res.json({
      success: true,
      created: true,
      name: outcome.player.name,
      playerId: outcome.player.id,
      password: outcome.password,
      chatId: queued?.chatId,
    });
  });

  /** Reject a registration: drop the queued request, nothing is created. */
  app.post("/api/admin/bot-reject-registration", requireInternalAuth, (req, res) => {
    const parsed = validate(botRejectRegistrationSchema, req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    const handle = normaliseHandle(parsed.data.username);
    const removed = removeRegistrationRequest(handle);

    addLog({
      id: "admin_reg_reject_" + Date.now(),
      /*
       * Псевдонима ещё нет: игрок не создан. Хендл в журнал не пишем —
       * журнал читают все участники, а заявка отклонена и в игре человека
       * нет. Кто именно, администратор видит в боте.
       */
      message: `🚫 Заявка на регистрацию отклонена (${parsed.data.admin || "администратор"}).`,
      timestamp: new Date().toLocaleTimeString(),
      type: "admin",
    });
    saveState();
    broadcastSlices("logs");

    return res.json({ success: true, found: Boolean(removed), chatId: removed?.chatId });
  });

  /**
   * Password-free entry from inside Telegram.
   *
   * The Mini App forwards the signed `initData` blob; its HMAC is verified
   * against the bot token, which proves the caller really is the Telegram user
   * they claim to be. A registered player is matched by numeric id first and
   * by handle second (handles can be changed by their owner, ids cannot), then
   * receives the same signed session token that /api/login issues.
   *
   * Nobody is created here: an unknown user is told to request registration.
   */
  app.post(
    "/api/telegram/auth",
    rateLimit({ windowMs: 60_000, max: 20, key: "tgauth" }),
    (req, res) => {
      const parsed = validate(telegramAuthSchema, req.body);
      if (!parsed.ok) {
        return res.status(400).json({ error: parsed.error });
      }

      const verified = verifyInitData(parsed.data.initData, telegramConfig.botToken);
      if (!verified.ok) {
        return res.status(403).json({ error: verified.error });
      }

      const { id: tgId, username } = verified.user;
      const handle = username ? normaliseHandle(username) : null;

      // Numeric id is the stable identity; the handle is only a fallback for
      // players registered before the binding existed.
      let player = gameState.players.find((p) => p.telegramId === tgId);
      if (!player && handle) {
        player = gameState.players.find((p) => p.name.toLowerCase() === handle);
        // Bind on first successful match so later logins skip the fallback.
        if (player) player.telegramId = tgId;
      }

      if (!player) {
        return res.status(404).json({
          error: "Вы ещё не зарегистрированы. Запросите регистрацию в боте командой /register.",
          needsRegistration: true,
          username: handle ?? undefined,
        });
      }

      player.isOnline = true;
      // Отметка присутствия: по ней фишка остаётся на доске.
      player.lastSeenAt = Date.now();
      if (handle) player.telegramUsername = handle.slice(1);
      if (!player.chipImage) player.chipImage = getRandomChipImage(takenChips());
      if (parsed.data.color) player.color = parsed.data.color;

      saveState();
      broadcastSlices("players");

      return res.json({
        success: true,
        id: player.id,
        name: player.name,
        role: player.role === "admin" ? "admin" : "player",
        color: player.color,
        chipImage: player.chipImage,
        token: issueSessionToken(player.id, player.role === "admin" ? "admin" : "player"),
      });
    }
  );

  app.post("/api/admin/bot-approve-turn", requireInternalAuth, (req, res) => {
    const botTurnParsed = validate(botApproveTurnSchema, req.body);
    if (!botTurnParsed.ok) {
      return res.status(400).json({ error: botTurnParsed.error });
    }
    const { playerId, admin, confirmBonusUse, turns, requireRequest } = botTurnParsed.data;

    // Shares the implementation with the socket handlers. Previously this
    // endpoint skipped the unused-bonus check entirely, so approving through
    // Telegram could bypass the prize-control rule.
    const result = approveTurn(playerId, {
      confirmBonusUse: confirmBonusUse === true,
      approvedBy: `через Telegram Bot ${admin || "администратором"}`,
      turns,
      /*
       * Проверку просит ТОЛЬКО кнопка под заявкой — она передаёт
       * requireRequest.
       *
       * Сначала я сделал наоборот: включил проверку по умолчанию и завёл
       * флаг force для исключений. Это молча поменяло смысл всей точки
       * входа — «админ выдаёт ход» превратилось в «админ отвечает на
       * заявку», и 19 тестов, выдающих ход без заявки, справедливо упали.
       * Выдача по инициативе администратора — законный сценарий, ломать
       * его нельзя.
       */
      requireRequest: requireRequest === true,
    });

    if (!result.ok) {
      /*
       * 409 занят контролем призов, поэтому «уже обработано» отдаём как 410
       * Gone: заявки больше нет. Боту нужно различать эти случаи — в первом
       * он предлагает подтвердить бонус, во втором гасит кнопку.
       */
      if (result.alreadyHandled) {
        return res.status(410).json({ error: result.error, alreadyHandled: true });
      }
      const status = result.player ? 409 : 404;
      return res.status(status).json({ error: result.error });
    }
    return res.json({ success: true, playerName: result.player!.name, turns: result.turns });
  });

  /**
   * Отклонить заявку кнопкой в Telegram.
   *
   * Кнопка «Отклонить» раньше только переписывала текст сообщения и серверу
   * ничего не сообщала: заявка оставалась открытой, игрок ждал решения,
   * которого никто уже не примет, а в админке висел мёртвый запрос.
   */
  app.post("/api/admin/bot-reject-turn", requireInternalAuth, (req, res) => {
    const parsed = validate(botRejectTurnSchema, req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    const { playerId, admin } = parsed.data;

    const needle = playerId.toLowerCase();
    const player = gameState.players.find(
      (p) => p.id === playerId || p.name.toLowerCase() === needle
    );
    if (!player) return res.status(404).json({ error: "Игрок не найден" });

    // Заявки уже нет — сообщаем боту, чтобы он погасил кнопку без ошибки.
    if (!player.turnRequested) {
      return res.status(410).json({
        error: "Запрос уже обработан ранее.",
        alreadyHandled: true,
        playerName: shownName(player),
      });
    }

    const result = rejectTurn(playerId, `через Telegram Bot ${admin || "администратором"}`);
    if (!result.ok) return res.status(404).json({ error: result.error });

    return res.json({ success: true, playerName: result.player!.name });
  });

  /**
   * Написать игроку в Telegram от имени администратора.
   *
   * Админ работает в боте и хочет обратиться к участнику, не заходя в игру.
   * Искать разрешено и по настоящему хендлу, и по псевдониму: на экране у
   * админа видно и то и другое.
   */
  app.post("/api/admin/bot-message-player", requireInternalAuth, async (req, res) => {
    const parsed = validate(botMessagePlayerSchema, req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    const { target, text, admin } = parsed.data;

    const needle = target.toLowerCase().replace(/^@/, "");
    const player = gameState.players.find(
      (p) =>
        p.id === target ||
        p.name.toLowerCase().replace(/^@/, "") === needle ||
        (p.alias ?? "").toLowerCase() === target.toLowerCase()
    );

    if (!player) {
      return res.status(404).json({
        error: `Игрок «${target}» не найден. Укажите @хендл, игровой псевдоним или id.`,
      });
    }

    if (!player.telegramId && !player.name) {
      return res.status(409).json({ error: "У игрока нет привязанного Telegram." });
    }

    await sendTelegramMessage(
      player.telegramId || player.name,
      `💬 <b>Сообщение от администратора</b>\n\n${escapeHtml(text)}`
    );

    addLog({
      id: "dm_" + Date.now(),
      // В журнале — псевдоним: журнал читают все участники.
      message: `✉️ Администратор написал игроку ${shownName(player)}${admin ? ` (${admin})` : ""}.`,
      timestamp: new Date().toLocaleTimeString(),
      type: "admin",
    });

    saveState();
    broadcastSlices("logs");

    return res.json({
      success: true,
      playerName: player.name,
      alias: player.alias ?? null,
    });
  });

  /**
   * Написать всем зарегистрированным игрокам.
   *
   * Не в группу: группа видна всем сразу и утекает в чужие чаты. Каждому —
   * личное сообщение, тем же путём, что /msg одному.
   */
  app.post("/api/admin/bot-broadcast", requireInternalAuth, async (req, res) => {
    const parsed = validate(botBroadcastSchema, req.body);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    const { text, admin } = parsed.data;

    const recipients = gameState.players.filter(
      (p) => p.role === "player" && (p.telegramId || p.name)
    );

    let sent = 0;
    const failed: string[] = [];
    for (const player of recipients) {
      try {
        await sendTelegramMessage(
          player.telegramId || player.name,
          `📢 <b>Сообщение всем игрокам</b>\n\n${escapeHtml(text)}`
        );
        sent += 1;
      } catch {
        failed.push(shownName(player));
      }
    }

    addLog({
      id: "broadcast_" + Date.now(),
      message: `📢 Администратор написал всем игрокам (${sent} из ${recipients.length})${admin ? ` (${admin})` : ""}.`,
      timestamp: new Date().toLocaleTimeString(),
      type: "admin",
    });
    saveState();
    broadcastSlices("logs");

    return res.json({
      success: true,
      total: recipients.length,
      sent,
      failed,
    });
  });

  app.get("/api/admin/logs-history", requireInternalAuth, (req, res) => {
    res.json({ success: true, logs: gameState.logs || [] });
  });

  /**
   * Выписка всех перемещений одного игрока.
   *
   * Берём постоянный файл player-moves.jsonl (пишется с этой сборки) и
   * дополняем тем, что ещё лежит в живом журнале и в архиве.
   */
  app.get("/api/admin/player-history", requireInternalAuth, (req, res) => {
    const raw = typeof req.query.target === "string" ? req.query.target : "";
    const parsed = validate(botPlayerHistorySchema, { target: raw });
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });

    const player = findPlayerByTarget(gameState.players, parsed.data.target);
    if (!player) {
      return res.status(404).json({ error: `Игрок «${parsed.data.target}» не найден.` });
    }

    const history = buildPlayerHistory(player);
    return res.json({
      success: true,
      ...history,
      text: formatPlayerHistoryText(history),
      html: formatPlayerHistoryHtml(history),
    });
  });

  app.post(
    "/api/login",
    rateLimit({ windowMs: 15 * 60_000, max: 20, key: "login" }),
    async (req, res) => {
      const loginParsed = validate(loginSchema, req.body);
      if (!loginParsed.ok) {
        return res.status(400).json({ error: loginParsed.error });
      }
      const { name, password, color, role } = loginParsed.data;

      const lowerName = name.toLowerCase();

      // Check if user is trying to login as admin
      if (role === "admin" || lowerName === ADMIN_LOGIN) {
        if (
          lowerName === ADMIN_LOGIN &&
          (await verifyPassword(password || "", ADMIN_PASSWORD_HASH))
        ) {
          return res.json({
            success: true,
            name: "Admin",
            role: "admin",
            color: "#FF00FF",
            id: ADMIN_PLAYER_ID,
            token: issueSessionToken(ADMIN_PLAYER_ID, "admin"),
          });
        }
        return res.status(403).json({ error: "Неверный логин или пароль" });
      }

      // Standard player entry
      const existingPlayer = gameState.players.find((p) => p.name.toLowerCase() === lowerName);

      // If player exists, let them reconnect securely
      if (existingPlayer) {
        const storedPass = authPasswords[existingPlayer.id];
        if (storedPass && !(await verifyPassword(password || "", storedPass))) {
          return res.status(403).json({ error: "Неверный пароль" });
        }
        // If user logged in using legacy format, auto-upgrade entry to salted hash
        if (storedPass && !storedPass.includes(":")) {
          authPasswords[existingPlayer.id] = await hashPassword(password || "");
          saveState();
        }
        existingPlayer.isOnline = true;
        existingPlayer.lastSeenAt = Date.now();
        if (!existingPlayer.chipImage) {
          existingPlayer.chipImage = getRandomChipImage(takenChips());
        }
        if (color) existingPlayer.color = color;
        if (loginParsed.data.telegramId) existingPlayer.telegramId = loginParsed.data.telegramId;
        if (loginParsed.data.telegramUsername) {
          existingPlayer.telegramUsername = loginParsed.data.telegramUsername;
        }
        saveState();
        return res.json({
          success: true,
          name: existingPlayer.name,
          role: "player",
          color: existingPlayer.color,
          chipImage: existingPlayer.chipImage,
          id: existingPlayer.id,
          token: issueSessionToken(existingPlayer.id, "player"),
        });
      }

      // New players cannot self-register
      return res.status(403).json({ error: "Только администратор может создавать новых игроков." });
    }
  );

  // Socket communication
  // Authenticate every socket during the handshake. The identity comes from a
  // signed session token issued by /api/login, never from a client-supplied id.
  io.use((socket, next) => {
    const token = (socket.handshake.auth as any)?.token || (socket.handshake.query as any)?.token;
    const session = verifySessionToken(token);
    if (!session) {
      return next(new Error("UNAUTHORIZED"));
    }
    socket.data.playerId = session.sub;
    socket.data.role = session.role;
    next();
  });

  io.on("connection", (socket) => {
    const authPlayerId: string = socket.data.playerId;
    const isAdmin = socket.data.role === "admin";
    log.debug("Client connected", {
      socket: socket.id,
      player: authPlayerId,
      role: socket.data.role,
    });

    /*
     * Персональная комната игрока.
     *
     * Нужна для адресных сообщений — прежде всего результата броска. Раньше
     * такие события летели через io.emit() всем подряд, и клиент отфильтровывал
     * чужое у себя. Это работало, пока в событии не было ничего личного, но
     * результат хода называет выпавший приз: отдавать его всем и надеяться на
     * фильтр в браузере — не защита. Комната делает адресность серверной.
     */
    if (authPlayerId) socket.join(`player:${authPlayerId}`);

    // Per-socket rate limiting for chat and dice rolls.
    const socketBuckets = new Map<string, { count: number; resetAt: number }>();
    function socketAllow(key: string, max: number, windowMs: number): boolean {
      const now = Date.now();
      const b = socketBuckets.get(key);
      if (!b || b.resetAt < now) {
        socketBuckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      if (b.count >= max) return false;
      b.count += 1;
      return true;
    }

    /*
     * Отметка присутствия в момент подключения.
     *
     * Раньше она стояла только в обработчике player:online — события,
     * которое шлёт клиент. Игрок, открывший доску старой сборкой или просто
     * не дошедший до этого шага, оставался «пропавшим», и его фишка исчезла
     * бы, хотя он в игре прямо сейчас.
     */
    {
      const connected = gameState.players.find((pl) => pl.id === authPlayerId);
      if (connected) {
        connected.lastSeenAt = Date.now();
        broadcastSlices("players");
      }
    }

    /*
     * Первый снимок состояния.
     *
     * Здесь была утечка: сырой gameState уходил ЛЮБОМУ подключившемуся, в
     * обход publicGameState(). Игрок получал Telegram-хендлы всех остальных
     * ещё до первого хода. Администратору по-прежнему нужен полный вид.
     */
    socket.emit(
      "state:update",
      isAdmin
        ? gameState
        : {
            ...gameState,
            players: gameState.players.map(maskPlayer),
            chatMessages: gameState.chatMessages.map(maskChatMessage),
          }
    );

    // Player/Admin reconnects — identity is taken from the verified session.
    socket.on("player:online", () => {
      const p = gameState.players.find((pl) => pl.id === authPlayerId);
      if (p) {
        p.isOnline = true;
        p.lastSeenAt = Date.now();
        broadcastSlices("players");
      }
    });

    socket.on("chat:send", (msg: unknown) => {
      const parsed = validate(chatSendSchema, msg);
      if (!parsed.ok) {
        socket.emit("error", parsed.error);
        return;
      }
      if (!socketAllow("chat", 10, 10_000)) {
        socket.emit("error", "Слишком много сообщений. Подождите немного.");
        return;
      }

      const text = parsed.data.text;
      // Sender identity is derived from the authenticated session, so a client
      // can no longer impersonate another player or forge the admin badge.
      const sender = gameState.players.find((p) => p.id === authPlayerId);
      // Псевдоним, а не хендл: чат читают все участники.
      const senderName = isAdmin ? "Admin" : sender ? shownName(sender) : "Игрок";
      const senderColor = isAdmin ? "#FF00FF" : (sender?.color ?? "#39FF14");

      const chatMsg: ChatMessage = {
        id: "chat_" + Date.now() + "_" + Math.floor(Math.random() * 100),
        senderId: authPlayerId,
        senderName,
        senderColor,
        text,
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        isAdmin,
      };

      gameState.chatMessages.push(chatMsg);
      // Keep only last 100 messages
      if (gameState.chatMessages.length > 100) {
        gameState.chatMessages.shift();
      }

      addLog({
        id: "log_chat_" + Date.now(),
        message: `[ЧАТ] ${senderName}: ${text}`,
        timestamp: new Date().toLocaleTimeString(),
        type: "chat",
      });

      /*
       * Обращение администратора к конкретному игроку.
       *
       * Админ пишет в чат игры «Бэтмен, зайдите за призом» — упомянутый
       * игрок получает ровно тот же текст в Telegram. Игрок в игру заходит
       * не постоянно, а бот всегда под рукой.
       *
       * Только для администратора: иначе любой участник смог бы рассылать
       * другим сообщения в личку через игровой чат.
       */
      if (isAdmin) {
        for (const mentioned of findMentionedPlayers(text)) {
          if (!mentioned.telegramId && !mentioned.name) continue;
          void sendTelegramMessage(
            mentioned.telegramId || mentioned.name,
            `💬 <b>Сообщение от администратора</b>\n\n${escapeHtml(text)}`
          );
        }
      }

      saveState();
      broadcastSlices("chatMessages", "logs");
    });

    // Roll Request
    socket.on("roll:request", () => {
      /*
       * Unconditional entry log.
       *
       * Two rounds of diagnosis were spent on a log that showed no roll at
       * all, which left the question open: did the click never reach the
       * server, or did the handler bail out on one of its five silent
       * returns? One line here separates those cases immediately.
       */
      log.info("roll:request received", {
        authPlayerId,
        role: socket.data.role,
        turnStatus: gameState.turnStatus,
      });

      /*
       * Rate limit sized for batches, not for a single roll.
       *
       * Five rolls per ten seconds was fine while every roll needed its own
       * approval. A player holding ten approved turns hits that wall halfway
       * through and is told "слишком частые броски" for turns they own — the
       * exact waiting the batch was meant to remove. The bucket is not
       * sliding, so two full batches handed out back to back land in the same
       * window; the allowance covers that case as well.
       *
       * This is not the защита that matters here: a roll without an approved
       * turn is refused above regardless. The limit only caps how fast the
       * server can be made to write state.
       */
      if (!socketAllow("roll", MAX_TURNS_PER_APPROVAL * 3, 10_000)) {
        log.warn("roll:request rejected: rate limit", { authPlayerId });
        socket.emit("error", "Слишком частые броски. Подождите немного.");
        return;
      }
      // The player is taken from the authenticated session: nobody can roll on
      // behalf of somebody else any more.
      const player = gameState.players.find((p) => p.id === authPlayerId);
      if (!player) {
        /*
         * Чаще всего сюда попадает администратор.
         *
         * Он входит под ADMIN_PLAYER_ID, но записи игрока с таким id в
         * gameState.players нет — это учётная запись, а не фишка на поле.
         * Обработчик молча возвращался: клиент ждал roll:result, который
         * никогда не придёт, оверлей оставался на экране, а в журнале
         * сервера не было ни строки. Снаружи — «нажал бросок, игра повисла».
         *
         * Теперь причина называется вслух. Играть админом можно, только
         * заведя ему обычного игрока: фишка, позиция и приз — свойства
         * игрока, а не роли.
         */
        log.warn("roll:request from a session with no player record", {
          authPlayerId,
          role: socket.data.role,
        });
        socket.emit(
          "error",
          "Эта учётная запись не участвует в игре. Администратору нужно " +
            "зарегистрировать себя как игрока, чтобы бросать кубик."
        );
        return;
      }

      const isAdminOrTest = player.role === "admin";
      /*
       * An approval is valid while BOTH hold: the window has not expired and
       * the batch still has unspent rolls. State saved before batches exist
       * has no counter at all — an open window there means exactly one roll,
       * which is what it used to mean.
       */
      const turnsLeft = turnsLeftFor(player);
      const isApproved = turnsLeft > 0;

      if (!isApproved && !isAdminOrTest) {
        log.warn("roll:request rejected: turn not approved", {
          player: player.name,
          turnApprovedUntil: player.turnApprovedUntil,
          turnsLeft,
        });
        socket.emit("error", "Сейчас не ваш ход! Запросите одобрение у администратора.");
        return;
      }

      /*
       * Prize control, batch-aware.
       *
       * An unredeemed prize still blocks the next *approval* — that rule is
       * enforced in approveTurn(). Inside an already approved batch it must
       * not slam the door: the player paid for those rolls and would be left
       * with a counter they cannot spend. So a prize won during the batch is
       * carried to its end and only blocks the next approval.
       *
       * A prize that predates the current approval is a different matter: it
       * means the batch was opened over an unredeemed prize (legacy state or
       * a manual edit), and the original rule applies.
       */
      /*
       * Когда открылась текущая пачка.
       *
       * Раньше запасным вариантом было «конец окна минус 12 часов». Окна
       * больше нет, и вычислять из него нечего: у записи без явной отметки
       * (сохранение прошлой версии) считаем пачку открытой только что — тогда
       * приз, полученный до обновления, честно признаётся старым.
       */
      const approvalStartedAt = player.turnBatchStartedAt ?? Date.now();
      const bonusPredatesBatch =
        !!player.activeBonus && player.activeBonus.receivedAt < approvalStartedAt;

      if (player.activeBonus && bonusPredatesBatch && !isAdminOrTest) {
        log.warn("roll:request rejected: unused bonus", {
          player: player.name,
          bonus: player.activeBonus.name,
        });
        socket.emit(
          "error",
          `⚠️ СИСТЕМА КОНТРОЛЯ ПРИЗОВ: Вы не можете сделать следующий бросок, пока не использовали текущий бонус (${player.activeBonus.extra || player.activeBonus.name}) в Таблице Жизни! Дождитесь подтверждения от администратора.`
        );
        return;
      }

      // Handle Skip Next Turn Penalty directly
      if (player.skipNextTurn && !isAdminOrTest) {
        player.skipNextTurn = false;
        /*
         * The penalty eats ONE roll of the batch, not the batch itself.
         * Zeroing the whole approval would silently confiscate turns the
         * player had already been granted for several purchases.
         */
        const left = Math.max(0, turnsLeft - 1);
        player.turnsApproved = left;
        if (left === 0) {
          player.turnApprovedUntil = null;
          player.turnBatchStartedAt = undefined;
          player.turnRequested = false;
        }

        addLog({
          id: "skip_" + Date.now(),
          message:
            `⏳ Игрок ${player.name} пропустил ход из-за системного сбоя!` +
            (left > 0 ? ` Осталось ${left} ${pluralizeTurns(left)}.` : ""),
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });
        recordPlayerMove(player, {
          kind: "skip",
          fromCell: player.cell,
          toCell: player.cell,
          steps: null,
          note: "пропуск хода",
        });

        // Штраф съел ход и мог закрыть пачку — отчёт по сыгранному не должен
        // застрять из-за раннего выхода.
        flushRollReport(player);

        saveState();
        broadcastState();
        return;
      }

      // Set currentPlayerId and turnStatus for backward compatibility
      gameState.currentPlayerId = player.id;
      gameState.turnStatus = "waiting_roll";

      // Ход — тоже присутствие: игрок мог не открывать доску подолгу, но
      // играть. Без этой отметки его фишка исчезла бы прямо во время партии.
      player.lastSeenAt = Date.now();

      // Roll d6 (1 to 6) using a cryptographically secure RNG. The result is
      // authoritative: the client only animates the number the server picked.
      const steps = crypto.randomInt(1, 7);
      player.lastRoll = steps;

      // Tell the roller which face to render before the state broadcast.
      socket.emit("roll:result", { steps });

      // Клетка, с которой игрок пошёл: нужна отчёту администратора и
      // затирается следующей же строкой.
      const fromCell = player.cell;

      // Movement and prize rules live in src/game/rules.ts (pure + unit-tested).
      const outcome = resolveMove(player, steps, gameState.cells);
      player.cell = outcome.finalCell;
      const bonusText = outcome.effectText;
      const extraRoll = outcome.extraRoll;
      const cell = outcome.cell;

      /*
       * Заготовка строки отчёта.
       *
       * Приз проставляется ниже, там же где выдаётся игроку: правила
       * возвращают awardedBonus, но сервер решает, записать его или нет, и
       * расходиться эти два решения не должны.
       */
      const report: RollRecord = {
        steps,
        fromCell,
        landedCell: outcome.landedCell,
        finalCell: outcome.finalCell,
        cell,
        // Клетка, где фишка встала после эффекта: телепорт может поставить её
        // на призовую, хотя приз даёт та, куда привёл кубик.
        destinationCell: gameState.cells.find((c) => c.id === outcome.finalCell),
        extraRoll,
        awardedBonus: null,
      };

      addLog({
        id: "roll_" + Date.now(),
        message: `🎲 ${shownName(player)} выбросил ${steps} и переместился на клетку ${player.cell}.${bonusText ? " " + bonusText : ""}`,
        timestamp: new Date().toLocaleTimeString(),
        type: "roll",
      });
      recordPlayerMove(player, {
        kind: "roll",
        fromCell,
        toCell: player.cell,
        steps,
        note: bonusText || "",
      });

      // Trigger milestone toasts
      if (isMilestone(player.cell)) {
        io.emit("toast:achievement", {
          title: "СИСТЕМНЫЙ УЗЕЛ",
          message: `${shownName(player)} достиг сектора ${player.cell}!`,
          icon: "⭐",
          type: "milestone",
        });
      }

      // Check if finished or landed on prize
      if (player.cell >= 64) {
        player.cell = 64;
        const bonusName = "МЕГА-КРИСТАЛЛ";
        const hadOldBonus = !!player.activeBonus;
        const previousBonus = player.activeBonus ?? null;
        player.activeBonus = {
          name: bonusName,
          extra: "МЕГА-КРИСТАЛЛ",
          description: "Главный приз: МЕГА-КРИСТАЛЛ",
          value: 13800,
          cellId: 64,
          receivedAt: Date.now(),
        };

        report.finished = true;
        report.awardedBonus = player.activeBonus;
        report.replacedBonus = previousBonus;

        addLog({
          id: "win_" + Date.now(),
          message: `🏆 КИБЕР-ПОБЕДИТЕЛЬ! ${shownName(player)} достигнул ЯДРО СИСТЕМЫ (клетка 64)! Получен приз: ${bonusName}!${hadOldBonus ? " (Предыдущий неиспользованный бонус заменен)" : ""}`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });

        io.emit("event:trigger", {
          title: "🏆 КИБЕР-ПОБЕДА!",
          description: `Невероятно! ${player.name} успешно преодолел все ловушки, завершил круг и заслужил главный приз: МЕГА-КРИСТАЛЛ! Хотите запустить новый цикл взлома и начать заново круг?`,
          playerName: shownName(player),
          type: "win",
          playerId: player.id,
        });

        io.emit("toast:achievement", {
          title: "ПОЛНЫЙ ЦИКЛ",
          message: `${shownName(player)} завершил круг!`,
          icon: "🏆",
          type: "lap",
        });

        /*
         * Только администратору, не в общий чат.
         *
         * Игрок не должен узнавать о чужих призах и победах: это его личное
         * дело с магазином. Раньше сообщение уходило в группу, где сидят все
         * участники сразу.
         */
        const winMsg = `🏆 <b>КИБЕР-ПОБЕДИТЕЛЬ!</b> Игрок <b>${escapeHtml(player.name)}</b> дошел до финала и забрал главный приз: ${escapeHtml(bonusName)}!`;
        void sendTelegramMessageToAdmin(winMsg);
        if (player.telegramId || player.name) {
          sendTelegramMessage(
            player.telegramId || player.name,
            `🏆 <b>ПОБЕДА!</b> Вы дошли до финала и забрали главный приз: МЕГА-КРИСТАЛЛ!`
          );
        }
      } else if (
        bonusText &&
        cell &&
        cell.type !== CellType.NORMAL &&
        cell.type !== CellType.START &&
        cell.type !== CellType.FINISH
      ) {
        io.emit("event:trigger", {
          title: cell.name,
          description: bonusText,
          playerName: shownName(player),
          type: cell.type,
          playerId: player.id,
        });

        io.emit("toast:achievement", {
          title: "ОБНАРУЖЕН АРТЕФАКТ",
          message: `${shownName(player)} нашел ${cell.name}!`,
          icon: "⚡",
          type: "special",
        });

        if (cell.type === CellType.FLASK || cell.type === CellType.BITCOIN) {
          const bonusName = cell.extra || cell.name;
          const hadOldBonus = !!player.activeBonus;
          const previousBonus = player.activeBonus ?? null;
          player.activeBonus = {
            name: cell.name,
            extra: cell.extra || "",
            description: cell.description,
            value: cell.value,
            cellId: cell.id,
            receivedAt: Date.now(),
          };

          report.awardedBonus = player.activeBonus;
          report.replacedBonus = previousBonus;

          // Выдача приза — дело администратора, остальным игрокам знать
          // о чужой награде незачем.
          const prizeMsg = `🎉 Игрок <b>${escapeHtml(player.name)}</b> получил награду: ${escapeHtml(bonusName)}!${hadOldBonus ? " <i>(Предыдущий бонус заменен, призы не суммируются)</i>" : ""}`;
          void sendTelegramMessageToAdmin(prizeMsg);
          if (player.telegramId || player.name) {
            sendTelegramMessage(
              player.telegramId || player.name,
              `Поздравляем! Вы получили награду: <b>${escapeHtml(bonusName)}</b>!\n<i>${escapeHtml(cell.description)}</i>`
            );
          }

          addLog({
            id: "bonus_grant_" + Date.now(),
            message: `🎁 Игрок ${shownName(player)} получил призовой бонус: "${bonusName}".${hadOldBonus ? " Предыдущий неиспользованный бонус заменен (не суммируются)." : ""} Требуется подтверждение админа об использовании в реальной жизни перед следующим броском.`,
            timestamp: new Date().toLocaleTimeString(),
            type: "system",
          });
        }
      }

      /*
       * Spend one roll of the batch.
       *
       * A "+1 ХОД" cell adds a roll instead of merely renewing the window, so
       * an extra roll earned in the middle of a batch no longer swallows the
       * turns that were approved after it.
       */
      const spent = Math.max(0, turnsLeft - 1);
      const remainingTurns = extraRoll ? spent + 1 : spent;
      player.turnsApproved = remainingTurns;

      if (extraRoll) {
        // Счётчик уже увеличен выше; дату держим в будущем ради старого APK.
        player.turnApprovedUntil = Date.now() + LEGACY_WINDOW_MS;
        addLog({
          id: "extra_" + Date.now(),
          message: `⚡ Игрок ${shownName(player)} делает дополнительный бросок!`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });

        if (player.telegramId || player.name) {
          sendTelegramMessage(
            player.telegramId || player.name,
            `⚡ <b>ДОПОЛНИТЕЛЬНЫЙ ХОД!</b>\nВы получили право на дополнительный бросок кубика.`
          );
        }
      } else if (remainingTurns === 0) {
        player.turnApprovedUntil = null;
        player.turnBatchStartedAt = undefined;
        player.turnRequested = false;
      } else {
        // Batch continues: the player rolls again without asking anybody.
        addLog({
          id: "batch_" + Date.now(),
          message: `🎯 У игрока ${shownName(player)} осталось ${remainingTurns} ${pluralizeTurns(remainingTurns)} без нового одобрения.`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });
      }

      /*
       * turnStatus follows the batch — but it is a GLOBAL flag, so it must
       * describe every player, not just this one.
       *
       * The roll button checks turnStatus alongside the player's own
       * approval. Setting it to "idle" merely because this player finished
       * would lock out anybody else holding a live approval, so the flag
       * stays open while at least one player still has turns left.
       */
      gameState.turnStatus = anyoneCanRoll() ? "waiting_roll" : "idle";
      if (remainingTurns === 0 && gameState.currentPlayerId === player.id) {
        const next = gameState.players.find((p) => p.id !== player.id && hasOpenTurn(p));
        if (next) gameState.currentPlayerId = next.id;
      }

      /*
       * Результат хода — САМОМУ ИГРОКУ, всегда.
       *
       * Раньше `event:trigger` уходил только из веток «попал на особую
       * клетку». Обычная клетка не давала игроку никакого ответа: фишка
       * молча переезжала, и человек, только что бросивший кубик, не понимал,
       * сработало ли вообще. Молчание читается как сбой, а не как «пусто».
       *
       * Шлём адресно, в персональную комнату игрока: результат чужого броска
       * никого не касается, а раскрывать чужие призы нельзя.
       */
      const outcomeMsg = buildTurnOutcome({
        steps,
        fromCell,
        landedCell: outcome.landedCell,
        finalCell: player.cell,
        cell: report.destinationCell || cell,
        awardedBonus: report.awardedBonus,
        replacedBonus: report.replacedBonus,
        extraRoll,
        finished: report.finished,
        turnsRemaining: player.turnsApproved ?? 0,
      });

      io.to(`player:${player.id}`).emit("turn:outcome", {
        ...outcomeMsg,
        playerId: player.id,
      });

      // Дубль в бот: игрок мог закрыть приложение сразу после броска, и тогда
      // сообщение в Telegram — единственный след того, что произошло.
      if (player.telegramId || player.name) {
        void sendTelegramMessage(
          player.telegramId || player.name,
          formatTurnOutcomeForTelegram(outcomeMsg)
        );
      }

      /*
       * Отчёт администратору.
       *
       * Записывается после того, как посчитан остаток пачки: flush решает по
       * нему, отправлять сводку сейчас или ждать следующего броска.
       */
      recordRoll(player.id, report);
      flushRollReport(player);

      saveState();
      broadcastSlices("players", "logs", "meta");
    });

    // Admin manual adjust player
    socket.on("admin:update_player", (raw: unknown) => {
      if (!isAdmin) return;
      const parsed = validate(updatePlayerSchema, raw);
      if (!parsed.ok) {
        socket.emit("error", parsed.error);
        return;
      }
      const updated = parsed.data;
      const p = gameState.players.find((pl) => pl.id === updated.id);
      if (p) {
        const oldCell = p.cell;
        p.cell = Math.min(64, Math.max(0, updated.cell));
        if (updated.color) p.color = updated.color;
        if (updated.name) p.name = updated.name;
        if (updated.chipImage) p.chipImage = updated.chipImage;

        addLog({
          id: "admin_upd_" + Date.now(),
          message: `🛠️ Админ изменил параметры ${shownName(p)}: Клетка: ${oldCell} ➔ ${p.cell}.`,
          timestamp: new Date().toLocaleTimeString(),
          type: "admin",
        });

        saveState();
        broadcastState();
      }
    });

    // Admin manual register player
    socket.on("admin:register_player", (raw: unknown) => {
      if (!isAdmin) return;
      const parsedReg = validate(registerPlayerSchema, raw);
      if (!parsedReg.ok) {
        socket.emit("error", parsedReg.error);
        return;
      }
      const reg = parsedReg.data;
      const playerId = "p_" + Date.now() + "_" + Math.floor(Math.random() * 100);
      const newPlayer: Player = {
        id: playerId,
        name: reg.name,
        // Псевдоним нужен и при ручной регистрации: админ мог завести
        // игрока под его настоящим хендлом.
        alias: pickAlias(takenAliases()),
        role: "player",
        cell: 0,
        color: reg.color,
        chipImage: reg.chipImage || getRandomChipImage(takenChips()),
        isOnline: false,
        lastRoll: null,
        skipNextTurn: false,
      };

      // Пароль: заданный админом или сгенерированный. Пустого больше нет —
      // раньше игрок, зарегистрированный вручную, не мог войти через браузер
      // вовсе, а узнать пароль ему было неоткуда.
      const plainPassword = reg.password || generatePassword();

      hashPassword(plainPassword)
        .then((h) => {
          authPasswords[playerId] = h;
          saveState();
        })
        .catch((e) => log.error("Security: Failed to hash new player password:", errorContext(e)));

      // Оставляем пару боту: он отдаст её, когда игрок впервые откроет чат.
      // Написать первым Telegram не позволяет, поэтому это единственный
      // способ доставить пароль, не диктуя его голосом.
      queueCredentialsForBot(reg.name, plainPassword);

      gameState.players.push(newPlayer);
      if (!gameState.currentPlayerId) {
        gameState.currentPlayerId = playerId;
        gameState.turnStatus = "waiting_roll";
      }

      addLog({
        id: "admin_reg_" + Date.now(),
        message: `➕ Админ зарегистрировал игрока: ${reg.name}. Пароль отправится в Telegram при первом запуске бота.`,
        timestamp: new Date().toLocaleTimeString(),
        type: "admin",
      });

      saveState();
      broadcastState();
    });

    // Admin set/change player password securely
    socket.on("admin:set_player_password", async (raw: unknown) => {
      if (!isAdmin) return;
      const parsedPw = validate(setPlayerPasswordSchema, raw);
      if (!parsedPw.ok) {
        socket.emit("error", parsedPw.error);
        return;
      }
      const data = parsedPw.data;
      const p = gameState.players.find((pl) => pl.id === data.playerId);
      if (p) {
        authPasswords[data.playerId] = data.password ? await hashPassword(data.password) : "";
        addLog({
          id: "admin_pass_" + Date.now(),
          message: `🔑 Админ обновил защищенный пароль игрока: ${shownName(p)}`,
          timestamp: new Date().toLocaleTimeString(),
          type: "admin",
        });
        saveState();
        broadcastState();
      }
    });

    // Admin delete player
    socket.on("admin:delete_player", (playerId: string) => {
      if (!isAdmin) return;
      const p = gameState.players.find((pl) => pl.id === playerId);
      const name = p ? p.name : "Неизвестный";

      gameState.players = gameState.players.filter((pl) => pl.id !== playerId);
      delete authPasswords[playerId];

      if (gameState.currentPlayerId === playerId) {
        const remaining = gameState.players.filter((pl) => pl.role === "player");
        gameState.currentPlayerId = remaining.length > 0 ? remaining[0].id : null;
        gameState.turnStatus = remaining.length > 0 ? "waiting_roll" : "idle";
      }

      addLog({
        id: "admin_del_" + Date.now(),
        message: `➖ Админ удалил игрока: ${name}`,
        timestamp: new Date().toLocaleTimeString(),
        type: "admin",
      });

      saveState();
      broadcastState();
    });

    /**
     * Clear the visible event log.
     *
     * Archived, not destroyed: the entries are appended to
     * game-logs-archive.jsonl exactly as trimLogs() does, so nothing is lost
     * and /api/admin/logs-history still returns them. A button labelled
     * "clear" that silently discards a game's history would be unforgiving
     * of a misclick.
     */
    socket.on("admin:clear_logs", () => {
      if (!isAdmin) return;

      const dropped = gameState.logs.length;
      if (dropped > 0) {
        const lines = gameState.logs.map((l) => JSON.stringify(l)).join("\n") + "\n";
        fs.appendFile(LOG_ARCHIVE_FILE, lines, "utf-8", (err) => {
          if (err) log.error("Logs: Failed to archive cleared logs:", errorContext(err));
        });
      }

      gameState.logs = [];

      // The clearing itself is logged, so the record does not simply end
      // without explanation.
      addLog({
        id: "logs_cleared_" + Date.now(),
        message: `🧹 Админ очистил журнал событий (в архив: ${dropped})`,
        timestamp: new Date().toLocaleTimeString(),
        type: "admin",
      });

      saveState();
      broadcastSlices("logs");
    });

    // Admin reset game
    socket.on("admin:reset_game", (raw: unknown) => {
      if (!isAdmin) return;
      const parsedReset = validate(resetGameSchema, raw);
      if (!parsedReset.ok) {
        socket.emit("error", parsedReset.error);
        return;
      }
      const options = parsedReset.data;

      // Wiping the roster also deletes every password hash and is irreversible,
      // so it needs an explicit typed confirmation and an automatic snapshot.
      if (options.clearPlayers) {
        if (options.confirm !== RESET_CONFIRM_PHRASE) {
          socket.emit(
            "error",
            `⚠️ Удаление всех игроков необратимо. Для подтверждения введите: ${RESET_CONFIRM_PHRASE}`
          );
          return;
        }
        const snapshot = createSnapshot("before-reset");
        if (snapshot) {
          addLog({
            id: "snapshot_" + Date.now(),
            message: `💾 Создан аварийный снимок перед сбросом: ${path.basename(snapshot)}`,
            timestamp: new Date().toLocaleTimeString(),
            type: "admin",
          });
        }
      }

      // Reconcile cells to ensure updated metadata while strictly preserving calibrated coordinates
      const currentCells = gameState.cells;
      const defaultCells = generateDefaultCells();
      gameState.cells = defaultCells.map((dc) => {
        const current = currentCells.find((c) => c.id === dc.id);
        const cal = cellCalibrationMap[dc.id];

        const finalX =
          cal && typeof cal.x === "number"
            ? cal.x
            : current && typeof current.x === "number"
              ? current.x
              : dc.x;
        const finalY =
          cal && typeof cal.y === "number"
            ? cal.y
            : current && typeof current.y === "number"
              ? current.y
              : dc.y;

        return {
          ...(current || {}),
          ...dc,
          x: finalX,
          y: finalY,
        };
      });

      if (options.clearPlayers) {
        gameState.players = [];
        authPasswords = {};
        gameState.currentPlayerId = null;
        gameState.turnStatus = "idle";
      } else {
        gameState.players.forEach((p) => {
          p.cell = 0;
          p.lastRoll = null;
          p.skipNextTurn = false;
          // Reset wipes approvals too: leftovers from the previous session
          // would let somebody roll before the new one is opened.
          p.turnsApproved = 0;
          p.turnBatchStartedAt = undefined;
          p.turnApprovedUntil = null;
          p.turnRequested = false;
          p.turnsRequested = undefined;
        });
        const active = gameState.players.filter((p) => p.role === "player");
        gameState.currentPlayerId = active.length > 0 ? active[0].id : null;
        gameState.turnStatus = active.length > 0 ? "waiting_roll" : "idle";
      }

      gameState.logs = [
        {
          id: "reset_" + Date.now(),
          message: "Сессия Hapstore перезапущена администратором.",
          timestamp: new Date().toLocaleTimeString(),
          type: "admin",
        },
      ];

      saveState();
      broadcastState();
    });

    // Player restart lap
    socket.on("player:restart_lap", (pId?: string) => {
      // Players may only restart their own lap; admins may restart anyone's.
      const targetId = isAdmin && typeof pId === "string" && pId ? pId : authPlayerId;
      const player = gameState.players.find((p) => p.id === targetId);
      if (player) {
        const fromLap = player.cell;
        player.cell = 0;
        player.skipNextTurn = false;
        player.lastRoll = null;

        addLog({
          id: "restart_lap_" + Date.now(),
          message: `🔄 Игрок ${shownName(player)} начал новый круг с клетки 0! Пожелаем удачи!`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });
        recordPlayerMove(player, {
          kind: "restart",
          fromCell: fromLap,
          toCell: 0,
          steps: null,
          note: "новый круг",
        });

        io.emit("toast:achievement", {
          title: "НОВЫЙ ЦИКЛ",
          message: `${shownName(player)} начал новый круг!`,
          icon: "🚀",
          type: "lap",
        });

        saveState();
        broadcastState();
      }
    });

    // Player update avatar
    socket.on("player:update_avatar", (raw: unknown) => {
      const parsedAvatar = validate(updateAvatarSchema, raw);
      if (!parsedAvatar.ok) {
        socket.emit("error", parsedAvatar.error);
        return;
      }
      const data = parsedAvatar.data;
      // A player can only change their own avatar.
      const targetId = isAdmin && data.id ? data.id : authPlayerId;
      const p = gameState.players.find((pl) => pl.id === targetId);
      if (p) {
        p.avatar = data.avatar;
        addLog({
          id: "avatar_" + Date.now(),
          message: `👤 Игрок ${shownName(p)} обновил свой неоновый аватар!`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });
        saveState();
        broadcastState();
      }
    });

    // Admin calibrate coordinates
    socket.on("admin:calibrate_cell", (raw: unknown) => {
      if (!isAdmin) return;
      const parsedCal = validate(calibrateCellSchema, raw);
      if (!parsedCal.ok) {
        socket.emit("error", parsedCal.error);
        return;
      }
      const cal = parsedCal.data;
      const cell = gameState.cells.find((c) => c.id === cal.cellId);
      if (cell) {
        cell.x = cal.x;
        cell.y = cal.y;

        // Save in memory map and persist immediately to Firestore and local disk
        cellCalibrationMap[cal.cellId] = { x: cal.x, y: cal.y };
        saveCalibration();
        saveState();
        broadcastState();
      }
    });

    /**
     * Через сколько часов бездействия убирать фишку с доски.
     *
     * Настройкой, а не константой: подходящий срок зависит от того, как
     * часто идёт игра. 0 выключает правило — доска показывает всех.
     */
    socket.on("admin:set_token_timeout", (rawHours: unknown) => {
      if (!isAdmin) return;
      const hours = normaliseHideAfterHours(rawHours);
      gameState.hideTokensAfterHours = hours;

      addLog({
        id: "token_timeout_" + Date.now(),
        message:
          hours > 0
            ? `⚙️ Фишки игроков скрываются после ${hours} ч без активности.`
            : "⚙️ Фишки игроков больше не скрываются: показываются все.",
        timestamp: new Date().toLocaleTimeString(),
        type: "admin",
      });

      saveState();
      broadcastSlices("logs", "meta");
    });

    // Admin toggle calibration mode
    socket.on("admin:toggle_calibration", (mode: boolean) => {
      if (!isAdmin) return;
      gameState.calibrationMode = mode;
      broadcastState();
    });

    // Admin select cell for calibration
    socket.on("admin:select_calibration_cell", (cellId: number | null) => {
      if (!isAdmin) return;
      gameState.selectedCalibrationCellId = cellId;
      broadcastState();
    });

    // Admin set board background image
    socket.on("admin:set_board_image", (image: string | null) => {
      if (!isAdmin) return;
      gameState.boardImage = image;
      addLog({
        id: "board_img_" + Date.now(),
        message: image
          ? "🖼️ Фоновое изображение карты обновлено!"
          : "🖼️ Установлен стандартный фон.",
        timestamp: new Date().toLocaleTimeString(),
        type: "admin",
      });
      saveState();
      broadcastState();
    });

    // Admin set login background
    socket.on("admin:set_login_background", (image: string | null) => {
      if (!isAdmin) return;
      gameState.loginBackground = image;
      addLog({
        id: "login_bg_" + Date.now(),
        message: image
          ? "🖼️ Фон экрана входа обновлен!"
          : "🖼️ Установлен стандартный фон экрана входа.",
        timestamp: new Date().toLocaleTimeString(),
        type: "admin",
      });
      saveState();
      broadcastState();
    });

    // Admin set rules background
    socket.on("admin:set_rules_background", (image: string | null) => {
      if (!isAdmin) return;
      gameState.rulesBackground = image;
      addLog({
        id: "rules_bg_" + Date.now(),
        message: image
          ? "🖼️ Фон экрана правил обновлен!"
          : "🖼️ Установлен стандартный фон экрана правил.",
        timestamp: new Date().toLocaleTimeString(),
        type: "admin",
      });
      saveState();
      broadcastState();
    });

    // Player requests turn. The optional argument is how many rolls they need
    // (several purchases at once); anything unusable falls back to one.
    socket.on("player:request_turn", (rawTurns?: unknown) => {
      if (!socketAllow("turnreq", 3, 60_000)) {
        socket.emit("error", "Слишком много запросов хода. Подождите минуту.");
        return;
      }
      const player = gameState.players.find((p) => p.id === authPlayerId);
      if (!player) return;

      const requested = clampTurns(rawTurns, 1);

      /*
       * Повторная заявка от того же игрока.
       *
       * Первое сообщение с кнопками остаётся в чате и продолжает работать:
       * админ мог бы одобрить сначала по старой кнопке, потом по новой — и
       * выдать ход дважды. Гасим предыдущую заявку прежде, чем слать новую.
       */
      closeApproval(
        player.id,
        `↩️ <b>ЗАЯВКА ОБНОВЛЕНА</b>\nИгрок <b>${escapeHtml(player.name)}</b> ` +
          `прислал новый запрос — решайте по свежему сообщению.`
      );

      player.turnRequested = true;
      player.turnsRequested = requested;
      player.lastSeenAt = Date.now();
      gameState.turnRequestUserId = authPlayerId; // backward compatibility

      /*
       * Two buttons per row: approve exactly what was asked, or override.
       * The admin should not have to open the web console just to hand out a
       * different number than the player typed.
       */
      const overrides = [1, 2, 3, 5].filter((n) => n !== requested);
      const turnKeyboard = {
        inline_keyboard: [
          [
            {
              text: `🟢 Одобрить ${requested} ${pluralizeTurns(requested)}`.slice(0, 60),
              callback_data: `approve_turn:${player.id}:${requested}`,
            },
            { text: "🔴 Отклонить", callback_data: `reject_turn:${player.id}` },
          ],
          overrides.map((n) => ({
            text: `${n}`,
            callback_data: `approve_turn:${player.id}:${n}`,
          })),
        ],
      };

      /*
       * Запоминаем отправленное сообщение.
       *
       * Гонка возможна: пока Telegram отвечает, админ успевает одобрить ход
       * из админки. Тогда заявки в реестре уже нет — и вешать её обратно
       * нельзя, иначе кнопка снова оживёт. Проверяем turnRequested: если
       * решение принято, оно сброшено, и мы сразу гасим свежее сообщение.
       */
      void sendTelegramMessageToAdmin(
        `🎲 <b>НОВЫЙ ЗАПРОС ХОДА</b> от <b>${escapeHtml(player.name)}</b>\n` +
          `Клетка: ${player.cell} · просит: <b>${requested}</b> ${pluralizeTurns(requested)}` +
          (player.activeBonus
            ? `\n⚠️ <b>НЕИСПОЛЬЗОВАННЫЙ БОНУС:</b> ` +
              `${escapeHtml(player.activeBonus.extra || player.activeBonus.name)}\n` +
              `<i>Подтвердите использование бонуса перед одобрением броска!</i>`
            : ""),
        turnKeyboard
      ).then((sent) => {
        if (!sent) return;
        const current = gameState.players.find((p) => p.id === player.id);
        if (!current?.turnRequested) {
          void clearTelegramButtons(
            sent,
            `✅ <b>Решение уже принято</b> — этот запрос неактуален.`
          );
          return;
        }
        pendingApprovals.set(player.id, { message: sent, requested, at: Date.now() });
      });

      const bonusAlert = player.activeBonus
        ? ` ⚠️ НЕИСПОЛЬЗОВАННЫЙ БОНУС: "${player.activeBonus.extra || player.activeBonus.name}". Требуется подтверждение использования перед одобрением броска!`
        : "";

      addLog({
        id: "req_" + Date.now(),
        message: `⏳ Игрок ${shownName(player)} запросил ход. Ожидание одобрения.${bonusAlert}`,
        timestamp: new Date().toLocaleTimeString(),
        type: "system",
      });

      /*
       * Здесь была рассылка «ЗАПРОС НА ХОД» в общую группу.
       *
       * Убрана по двум причинам. Во-первых, приватность: остальные игроки
       * не должны видеть, кто и когда просит ход. Во-вторых, дубль —
       * администратор уже получил этот же запрос выше, сообщением с
       * кнопками. Клетка и предупреждение о бонусе перенесены туда, так что
       * ничего не потеряно.
       */

      saveState();
      broadcastState();
    });

    // Admin explicitly consumes/redeems a player's active bonus
    socket.on("admin:consume_bonus", (pId: string) => {
      if (!isAdmin) return;
      const player = gameState.players.find((p) => p.id === pId);
      if (player && player.activeBonus) {
        const usedBonus = player.activeBonus;
        player.activeBonus = null;

        addLog({
          id: "bonus_consume_" + Date.now(),
          message: `✅ Администратор списал бонус "${usedBonus.extra || usedBonus.name}" игрока ${shownName(player)} (подтверждено использование в реальной жизни).`,
          timestamp: new Date().toLocaleTimeString(),
          type: "admin",
        });

        if (player.telegramId || player.name) {
          sendTelegramMessage(
            player.telegramId || player.name,
            `🎁 <b>БОНУС ИСПОЛЬЗОВАН!</b>\nАдминистратор подтвердил погашение вашего бонуса (${escapeHtml(usedBonus.extra || usedBonus.name)}) в реальной жизни.`
          );
        }

        saveState();
        broadcastState();
      }
    });

    /*
     * Admin approves a specific player's turns (12-hour window).
     *
     * `turns` is optional and appended last so older clients — the APK still
     * in players' hands among them — keep working: without it the batch is
     * whatever the player asked for, or one.
     */
    socket.on(
      "admin:approve_player_turn",
      (pId: string, confirmBonusUse?: boolean, turns?: number) => {
        if (!isAdmin) return;
        const result = approveTurn(pId, { confirmBonusUse, turns });
        if (!result.ok && result.error) socket.emit("error", result.error);
      }
    );

    // Admin rejects specific player turn
    socket.on("admin:reject_player_turn", (pId: string) => {
      if (!isAdmin) return;
      rejectTurn(pId);
    });

    // Legacy entry point: approves whoever currently has a pending request.
    // Kept for older clients; delegates to the same implementation.
    socket.on("admin:confirm_turn", (confirmBonusUse?: boolean, turns?: number) => {
      if (!isAdmin) return;
      const reqUserId =
        gameState.turnRequestUserId || gameState.players.find((p) => p.turnRequested)?.id;
      if (!reqUserId) return;
      const result = approveTurn(reqUserId, { confirmBonusUse, turns });
      if (!result.ok && result.error) socket.emit("error", result.error);
    });

    // Admin rights are established during the handshake from the signed session
    // token. This event now only reports the current status; it can no longer
    // grant privileges by comparing a password string.
    socket.on("auth:admin", () => {
      if (isAdmin) {
        socket.emit("admin:auth_success");
      } else {
        socket.emit("error", "Доступ к админке разрешен только администратору");
      }
    });

    // Passwords are stored as one-way PBKDF2 hashes and are never revealed.
    // Only their protection status is exposed.
    socket.on("admin:get_passwords", () => {
      if (!isAdmin) return;
      const status: Record<string, string> = {};
      for (const key in authPasswords) {
        status[key] = authPasswords[key] ? "🔐 Защищен (Хэш PBKDF2)" : "— (Без пароля)";
      }
      socket.emit("admin:passwords", status);
    });

    socket.on("disconnect", () => {
      const p = gameState.players.find((pl) => pl.id === authPlayerId);
      if (p && p.isOnline) {
        // Only mark offline when this player has no other active sockets.
        const stillConnected = Array.from(io.sockets.sockets.values()).some(
          (s) => s.id !== socket.id && s.data?.playerId === authPlayerId
        );
        if (!stillConnected) {
          p.isOnline = false;
          broadcastSlices("players");
        }
      }
      log.debug("Client disconnected", { socket: socket.id });
    });
  });

  // Scheduled backup. Firestore has no automatic export on the free tier, and
  // the local volume is the only copy when it is disabled, so keep a rolling
  // set of on-disk snapshots.
  const backupTimer = setInterval(() => {
    if (gameState.players.length > 0) createSnapshot("scheduled");
  }, SNAPSHOT_INTERVAL_MS);
  backupTimer.unref?.();

  /*
   * Таймер, сжигавший неиспользованные ходы, удалён.
   *
   * Он раз в минуту обходил игроков и обнулял одобрение, которому исполнилось
   * 12 часов. Ограничения по времени больше нет: оплаченный бросок ждёт
   * игрока столько, сколько нужно. Закрыть ход теперь может только
   * администратор кнопкой отказа.
   */

  // Lightweight health endpoint for Docker/orchestrator health checks.
  /**
   * Crash reports from the browser.
   *
   * Players run inside Telegram's webview, where devtools are unreachable —
   * a render crash is a blank screen and nothing else. Three rounds of this
   * bug were spent guessing because the actual error was never captured.
   * Now it arrives here and shows up in `docker compose logs hcg_app`.
   *
   * Unauthenticated by design: a crash can happen before login, and the
   * report is worthless if it needs a session that may itself be broken.
   * Bounded and rate-limited so it cannot be used to flood the log.
   */
  const clientErrorHits = new Map<string, { count: number; since: number }>();

  app.post("/api/client-error", express.json({ limit: "16kb" }), (req, res) => {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const seen = clientErrorHits.get(ip);

    if (!seen || now - seen.since > 60_000) {
      clientErrorHits.set(ip, { count: 1, since: now });
    } else if (seen.count >= 10) {
      return res.status(429).json({ ok: false });
    } else {
      seen.count += 1;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);

    log.error("Client crash reported", {
      area: clip(body.area, 40),
      message: clip(body.message, 300),
      stack: clip(body.stack, 1200),
      componentStack: clip(body.componentStack, 1200),
      userAgent: clip(body.userAgent, 200),
      url: clip(body.url, 200),
    });

    return res.json({ ok: true });
  });

  app.get("/healthz", (req, res) => {
    res.json({
      status: "ok",
      uptime: Math.round(process.uptime()),
      players: gameState.players.length,
      firestore: firestore.getStatus(),
    });
  });

  // Prometheus-compatible metrics. Guarded by the internal token: the counters
  // reveal roster size and activity, which is not public information.
  app.get("/metrics", requireInternalAuth, (req, res) => {
    const online = gameState.players.filter((p) => p.isOnline).length;
    const awaitingTurn = gameState.players.filter((p) => p.turnRequested).length;
    const withBonus = gameState.players.filter((p) => p.activeBonus).length;
    const firestoreUp = firestore.getStatus() === "connected" ? 1 : 0;

    const lines = [
      "# HELP hcg_uptime_seconds Process uptime.",
      "# TYPE hcg_uptime_seconds gauge",
      `hcg_uptime_seconds ${Math.round(process.uptime())}`,
      "# HELP hcg_players_total Registered players.",
      "# TYPE hcg_players_total gauge",
      `hcg_players_total ${gameState.players.length}`,
      "# HELP hcg_players_online Players currently connected.",
      "# TYPE hcg_players_online gauge",
      `hcg_players_online ${online}`,
      "# HELP hcg_players_awaiting_turn Players waiting for turn approval.",
      "# TYPE hcg_players_awaiting_turn gauge",
      `hcg_players_awaiting_turn ${awaitingTurn}`,
      "# HELP hcg_turns_approved_total Unspent approved rolls across all players.",
      "# TYPE hcg_turns_approved_total gauge",
      `hcg_turns_approved_total ${gameState.players.reduce((sum, p) => sum + turnsLeftFor(p), 0)}`,
      "# HELP hcg_players_with_unredeemed_bonus Players holding an unredeemed prize.",
      "# TYPE hcg_players_with_unredeemed_bonus gauge",
      `hcg_players_with_unredeemed_bonus ${withBonus}`,
      "# HELP hcg_sockets_connected Open Socket.IO connections.",
      "# TYPE hcg_sockets_connected gauge",
      `hcg_sockets_connected ${io.sockets.sockets.size}`,
      "# HELP hcg_firestore_up Firestore reachable (1) or degraded to disk (0).",
      "# TYPE hcg_firestore_up gauge",
      `hcg_firestore_up ${firestoreUp}`,
      "# HELP hcg_log_entries Log entries held in memory.",
      "# TYPE hcg_log_entries gauge",
      `hcg_log_entries ${gameState.logs.length}`,
      "# HELP hcg_heap_used_bytes V8 heap in use.",
      "# TYPE hcg_heap_used_bytes gauge",
      `hcg_heap_used_bytes ${process.memoryUsage().heapUsed}`,
    ];

    res.type("text/plain; version=0.0.4").send(lines.join("\n") + "\n");
  });

  // Vite Integration
  if (!IS_PRODUCTION) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // Express 5 requires a named wildcard ("*" alone is no longer valid).
    app.get("/*splat", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const PORT = appConfig.port;
  server.listen(PORT, "0.0.0.0", () => {
    /*
     * Build marker, first line after startup.
     *
     * The bot has printed one for weeks; the server did not, and that cost a
     * diagnostic round: given a log with no roll in it, there was no way to
     * tell whether the fix was running or the image had simply not been
     * rebuilt. Now the log answers that on its own.
     */
    log.info("Server build", { build: SERVER_BUILD });
    log.info("Server listening", { url: `http://localhost:${PORT}` });
    // Presence-only summary: secret values are never printed.
    log.info("Configuration", describeConfig());
  });

  // --- Graceful shutdown ---------------------------------------------------
  // Flush any state still sitting in the debounce buffers before exiting,
  // otherwise up to 5 seconds of changes were silently lost on redeploy.
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutdown requested — flushing state", { signal });

    const forceExit = setTimeout(() => {
      log.warn("Shutdown: Timed out waiting for clean exit. Forcing.");
      process.exit(1);
    }, 10_000);
    forceExit.unref?.();

    try {
      performLocalWrite(true);
      saveTelegramUsers(true);
      persistRegistrations();
      if (firestore.isEnabled()) {
        await performFirestoreWrite();
      }
      log.info("Shutdown: State flushed successfully.");
    } catch (err) {
      log.error("Shutdown: Error while flushing state:", errorContext(err));
    }

    io.close();
    server.close(() => {
      clearTimeout(forceExit);
      log.info("Shutdown: Server closed. Bye.");
      process.exit(0);
    });
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((err) => {
  log.error("Failed to start server", errorContext(err));
  process.exit(1);
});
