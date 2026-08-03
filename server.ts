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
import { resolveMove, isMilestone } from "./src/game/rules";
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
  sendGroupMessage as sendTelegramGroupMessage,
  sendToUsername as sendTelegramMessageByUsername,
  sendToAdmin as sendTelegramMessageToAdmin,
  rememberUser as rememberTelegramUser,
  persist as saveTelegramUsers,
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

/** How long an approved turn stays valid. */
const TURN_WINDOW_MS = 12 * 60 * 60 * 1000;
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

// ---------------------------------------------------------------------------
// Persisted-state schema version.
//
// Loaded state used to be reconciled by guesswork (`cells.length === 65`).
// An explicit version lets migrations run deliberately instead of silently
// corrupting or discarding data when the shape changes.
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = 2;

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

/** Push a log entry and enforce the size cap. */
function addLog(entry: GameLog) {
  gameState.logs.unshift(entry);
  trimLogs();
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
}

/**
 * Grant a player a turn window.
 *
 * @param playerId   Player id, or their name (the bot may pass either).
 * @param options.confirmBonusUse  Admin confirms the outstanding prize was
 *   handed over in real life. Without it a player holding an unused bonus
 *   cannot be approved — that is the prize-control rule of the game.
 * @param options.approvedBy  Free-form label used in the log entry.
 */
function approveTurn(
  playerId: string,
  options: { confirmBonusUse?: boolean; approvedBy?: string } = {}
): ApproveTurnResult {
  const { confirmBonusUse = false, approvedBy } = options;

  const needle = playerId.toLowerCase();
  const player = gameState.players.find(
    (p) => p.id === playerId || p.name.toLowerCase() === needle
  );
  if (!player) return { ok: false, error: "Игрок не найден" };

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

  player.turnApprovedUntil = Date.now() + TURN_WINDOW_MS;
  player.turnRequested = false;
  if (gameState.turnRequestUserId === player.id) {
    gameState.turnRequestUserId = null;
  }

  addLog({
    id: "approve_" + Date.now(),
    message:
      `👑 Ход одобрен для игрока ${player.name} на 12 часов` +
      `${approvedBy ? ` (${approvedBy})` : ""}.`,
    timestamp: new Date().toLocaleTimeString(),
    type: "admin",
  });

  if (player.telegramId || player.name) {
    void sendTelegramMessage(player.telegramId || player.name, "ПОРА СДЕЛАТЬ БРОСОК");
  }

  saveState();
  broadcastSlices("players", "logs", "meta");
  return { ok: true, player };
}

/** Withdraw a pending turn request. Mirror of approveTurn(). */
function rejectTurn(playerId: string, rejectedBy?: string): ApproveTurnResult {
  const needle = playerId.toLowerCase();
  const player = gameState.players.find(
    (p) => p.id === playerId || p.name.toLowerCase() === needle
  );
  if (!player) return { ok: false, error: "Игрок не найден" };

  player.turnRequested = false;
  player.turnApprovedUntil = null;
  if (gameState.turnRequestUserId === player.id) {
    gameState.turnRequestUserId = null;
  }

  addLog({
    id: "reject_" + Date.now(),
    message:
      `❌ Запрос хода для игрока ${player.name} отклонен` +
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
    message: `➕ Игрок ${handle} зарегистрирован${options.approvedBy ? ` (${options.approvedBy})` : ""}.`,
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

  let loadedFromFirestore = false;

  // Load state from Firestore first if available, fallback to local file, fallback to defaults
  {
    const data = await firestore.readDoc<GameState>("gameState");
    if (data) {
      const migrated = migrateState(data);
      gameState =
        migrated.cells && migrated.cells.length === 65
          ? migrated
          : { ...migrated, cells: generateDefaultCells() };
      loadedFromFirestore = true;
      log.info("Loaded game state from Firestore");
    }
  }

  if (!loadedFromFirestore) {
    if (fs.existsSync(STATE_FILE)) {
      try {
        const data = fs.readFileSync(STATE_FILE, "utf-8");
        const parsed = migrateState(JSON.parse(data));
        if (parsed.cells && parsed.cells.length === 65) {
          gameState = { ...gameState, ...parsed };
        } else {
          gameState = { ...gameState, ...parsed, cells: generateDefaultCells() };
        }
        log.info("Loaded game state from local fallback");
      } catch (localErr) {
        log.error("Failed to load local state fallback", errorContext(localErr));
      }
    }
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
    };
  }

  function flushDelta() {
    flushTimer = null;
    if (pendingSlices.size === 0) return;

    const patch: Record<string, unknown> = {};
    for (const slice of pendingSlices) {
      if (slice === "meta") Object.assign(patch, metaSlice());
      else patch[slice] = (gameState as any)[slice];
    }
    pendingSlices = new Set();
    io.emit("state:patch", patch);
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
        name: p.name,
        role: p.role,
        cell: p.cell,
        color: p.color,
        isOnline: p.isOnline,
        lastRoll: p.lastRoll,
        skipNextTurn: p.skipNextTurn,
        turnRequested: p.turnRequested,
        turnApprovedUntil: p.turnApprovedUntil,
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
      message: `🚫 Запрос на регистрацию ${handle} отклонён (${parsed.data.admin || "администратор"}).`,
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
    const { playerId, admin, confirmBonusUse } = botTurnParsed.data;

    // Shares the implementation with the socket handlers. Previously this
    // endpoint skipped the unused-bonus check entirely, so approving through
    // Telegram could bypass the prize-control rule.
    const result = approveTurn(playerId, {
      confirmBonusUse: confirmBonusUse === true,
      approvedBy: `через Telegram Bot ${admin || "администратором"}`,
    });

    if (!result.ok) {
      const status = result.player ? 409 : 404;
      return res.status(status).json({ error: result.error });
    }
    return res.json({ success: true, playerName: result.player!.name });
  });

  app.get("/api/admin/logs-history", requireInternalAuth, (req, res) => {
    res.json({ success: true, logs: gameState.logs || [] });
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

    // Send initial state immediately
    socket.emit("state:update", gameState);

    // Player/Admin reconnects — identity is taken from the verified session.
    socket.on("player:online", () => {
      const p = gameState.players.find((pl) => pl.id === authPlayerId);
      if (p) {
        p.isOnline = true;
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
      const senderName = isAdmin ? "Admin" : (sender?.name ?? "Игрок");
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

      saveState();
      broadcastSlices("chatMessages", "logs");
    });

    // Roll Request
    socket.on("roll:request", () => {
      if (!socketAllow("roll", 5, 10_000)) {
        socket.emit("error", "Слишком частые броски. Подождите немного.");
        return;
      }
      // The player is taken from the authenticated session: nobody can roll on
      // behalf of somebody else any more.
      const player = gameState.players.find((p) => p.id === authPlayerId);
      if (!player) return;

      const isAdminOrTest = player.role === "admin";
      const isApproved = player.turnApprovedUntil && player.turnApprovedUntil > Date.now();

      if (!isApproved && !isAdminOrTest) {
        socket.emit("error", "Сейчас не ваш ход! Запросите одобрение у администратора.");
        return;
      }

      // Enforce prize control system: player cannot roll if they have an active unused bonus
      if (player.activeBonus && !isAdminOrTest) {
        socket.emit(
          "error",
          `⚠️ СИСТЕМА КОНТРОЛЯ ПРИЗОВ: Вы не можете сделать следующий бросок, пока не использовали текущий бонус (${player.activeBonus.extra || player.activeBonus.name}) в Таблице Жизни! Дождитесь подтверждения от администратора.`
        );
        return;
      }

      // Handle Skip Next Turn Penalty directly
      if (player.skipNextTurn && !isAdminOrTest) {
        player.skipNextTurn = false;
        player.turnApprovedUntil = null;
        player.turnRequested = false;

        addLog({
          id: "skip_" + Date.now(),
          message: `⏳ Игрок ${player.name} пропустил свой одобренный ход из-за системного сбоя!`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });

        saveState();
        broadcastState();
        return;
      }

      // Set currentPlayerId and turnStatus for backward compatibility
      gameState.currentPlayerId = player.id;
      gameState.turnStatus = "waiting_roll";

      // Roll d6 (1 to 6) using a cryptographically secure RNG. The result is
      // authoritative: the client only animates the number the server picked.
      const steps = crypto.randomInt(1, 7);
      player.lastRoll = steps;

      // Tell the roller which face to render before the state broadcast.
      socket.emit("roll:result", { steps });

      // Movement and prize rules live in src/game/rules.ts (pure + unit-tested).
      const outcome = resolveMove(player, steps, gameState.cells);
      player.cell = outcome.finalCell;
      const bonusText = outcome.effectText;
      const extraRoll = outcome.extraRoll;
      const cell = outcome.cell;

      addLog({
        id: "roll_" + Date.now(),
        message: `🎲 ${player.name} выбросил ${steps} и переместился на клетку ${player.cell}.${bonusText ? " " + bonusText : ""}`,
        timestamp: new Date().toLocaleTimeString(),
        type: "roll",
      });

      // Trigger milestone toasts
      if (isMilestone(player.cell)) {
        io.emit("toast:achievement", {
          title: "СИСТЕМНЫЙ УЗЕЛ",
          message: `${player.name} достиг сектора ${player.cell}!`,
          icon: "⭐",
          type: "milestone",
        });
      }

      // Check if finished or landed on prize
      if (player.cell >= 64) {
        player.cell = 64;
        const bonusName = "МЕГА-КРИСТАЛЛ";
        const hadOldBonus = !!player.activeBonus;
        player.activeBonus = {
          name: bonusName,
          extra: "МЕГА-КРИСТАЛЛ",
          description: "Главный приз: МЕГА-КРИСТАЛЛ",
          value: 13800,
          cellId: 64,
          receivedAt: Date.now(),
        };

        addLog({
          id: "win_" + Date.now(),
          message: `🏆 КИБЕР-ПОБЕДИТЕЛЬ! ${player.name} достигнул ЯДРО СИСТЕМЫ (клетка 64)! Получен приз: ${bonusName}!${hadOldBonus ? " (Предыдущий неиспользованный бонус заменен)" : ""}`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });

        io.emit("event:trigger", {
          title: "🏆 КИБЕР-ПОБЕДА!",
          description: `Невероятно! ${player.name} успешно преодолел все ловушки, завершил круг и заслужил главный приз: МЕГА-КРИСТАЛЛ! Хотите запустить новый цикл взлома и начать заново круг?`,
          playerName: player.name,
          type: "win",
          playerId: player.id,
        });

        io.emit("toast:achievement", {
          title: "ПОЛНЫЙ ЦИКЛ",
          message: `${player.name} завершил круг!`,
          icon: "🏆",
          type: "lap",
        });

        const winMsg = `🏆 <b>КИБЕР-ПОБЕДИТЕЛЬ!</b> Игрок <b>${escapeHtml(player.name)}</b> дошел до финала и забрал главный приз: ${escapeHtml(bonusName)}!`;
        sendTelegramGroupMessage(winMsg);
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
          playerName: player.name,
          type: cell.type,
          playerId: player.id,
        });

        io.emit("toast:achievement", {
          title: "ОБНАРУЖЕН АРТЕФАКТ",
          message: `${player.name} нашел ${cell.name}!`,
          icon: "⚡",
          type: "special",
        });

        if (cell.type === CellType.FLASK || cell.type === CellType.BITCOIN) {
          const bonusName = cell.extra || cell.name;
          const hadOldBonus = !!player.activeBonus;
          player.activeBonus = {
            name: cell.name,
            extra: cell.extra || "",
            description: cell.description,
            value: cell.value,
            cellId: cell.id,
            receivedAt: Date.now(),
          };

          const prizeMsg = `🎉 Игрок <b>${escapeHtml(player.name)}</b> получил награду: ${escapeHtml(bonusName)}!${hadOldBonus ? " <i>(Предыдущий бонус заменен, призы не суммируются)</i>" : ""}`;
          sendTelegramGroupMessage(prizeMsg);
          if (player.telegramId || player.name) {
            sendTelegramMessage(
              player.telegramId || player.name,
              `Поздравляем! Вы получили награду: <b>${escapeHtml(bonusName)}</b>!\n<i>${escapeHtml(cell.description)}</i>`
            );
          }

          addLog({
            id: "bonus_grant_" + Date.now(),
            message: `🎁 Игрок ${player.name} получил призовой бонус: "${bonusName}".${hadOldBonus ? " Предыдущий неиспользованный бонус заменен (не суммируются)." : ""} Требуется подтверждение админа об использовании в реальной жизни перед следующим броском.`,
            timestamp: new Date().toLocaleTimeString(),
            type: "system",
          });
        }
      }

      // Consume or renew approval
      if (!extraRoll) {
        player.turnApprovedUntil = null;
        player.turnRequested = false;
      } else {
        player.turnApprovedUntil = Date.now() + 12 * 60 * 60 * 1000; // Keep approved for extra turn
        addLog({
          id: "extra_" + Date.now(),
          message: `⚡ Игрок ${player.name} делает дополнительный бросок!`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });

        if (player.telegramId || player.name) {
          sendTelegramMessage(
            player.telegramId || player.name,
            `⚡ <b>ДОПОЛНИТЕЛЬНЫЙ ХОД!</b>\nВы получили право на дополнительный бросок кубика.`
          );
        }
      }

      gameState.turnStatus = "waiting_roll";

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
          message: `🛠️ Админ изменил параметры ${p.name}: Клетка: ${oldCell} ➔ ${p.cell}.`,
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
        role: "player",
        cell: 0,
        color: reg.color,
        chipImage: reg.chipImage || getRandomChipImage(takenChips()),
        isOnline: false,
        lastRoll: null,
        skipNextTurn: false,
      };

      if (reg.password) {
        hashPassword(reg.password)
          .then((h) => {
            authPasswords[playerId] = h;
            saveState();
          })
          .catch((e) =>
            log.error("Security: Failed to hash new player password:", errorContext(e))
          );
      } else {
        authPasswords[playerId] = "";
      }

      gameState.players.push(newPlayer);
      if (!gameState.currentPlayerId) {
        gameState.currentPlayerId = playerId;
        gameState.turnStatus = "waiting_roll";
      }

      addLog({
        id: "admin_reg_" + Date.now(),
        message: `➕ Админ зарегистрировал игрока: ${reg.name} (Пароль защищен хэшированием)`,
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
          message: `🔑 Админ обновил защищенный пароль игрока: ${p.name}`,
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
        player.cell = 0;
        player.skipNextTurn = false;
        player.lastRoll = null;

        addLog({
          id: "restart_lap_" + Date.now(),
          message: `🔄 Игрок ${player.name} начал новый круг с клетки 0! Пожелаем удачи!`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });

        io.emit("toast:achievement", {
          title: "НОВЫЙ ЦИКЛ",
          message: `${player.name} начал новый круг!`,
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
          message: `👤 Игрок ${p.name} обновил свой неоновый аватар!`,
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

    // Player requests turn
    socket.on("player:request_turn", () => {
      if (!socketAllow("turnreq", 3, 60_000)) {
        socket.emit("error", "Слишком много запросов хода. Подождите минуту.");
        return;
      }
      const player = gameState.players.find((p) => p.id === authPlayerId);
      if (!player) return;

      player.turnRequested = true;
      gameState.turnRequestUserId = authPlayerId; // backward compatibility

      const turnKeyboard = {
        inline_keyboard: [
          [
            {
              text: `🟢 Одобрить ход ${player.name}`.slice(0, 60),
              callback_data: `approve_turn:${player.id}`,
            },
            { text: "🔴 Отклонить", callback_data: `reject_turn:${player.id}` },
          ],
        ],
      };

      sendTelegramMessageToAdmin(
        `🎲 <b>НОВЫЙ ЗАПРОС ХОДА</b> от <b>${escapeHtml(player.name)}</b>`,
        turnKeyboard
      );

      const bonusAlert = player.activeBonus
        ? ` ⚠️ НЕИСПОЛЬЗОВАННЫЙ БОНУС: "${player.activeBonus.extra || player.activeBonus.name}". Требуется подтверждение использования перед одобрением броска!`
        : "";

      addLog({
        id: "req_" + Date.now(),
        message: `⏳ Игрок ${player.name} запросил ход. Ожидание одобрения.${bonusAlert}`,
        timestamp: new Date().toLocaleTimeString(),
        type: "system",
      });

      sendTelegramGroupMessage(
        `📩 <b>ЗАПРОС НА ХОД</b>\nИгрок: <b>${escapeHtml(player.name)}</b> (Клетка ${player.cell})${
          player.activeBonus
            ? `\n⚠️ <b>НЕИСПОЛЬЗОВАННЫЙ БОНУС:</b> ${escapeHtml(player.activeBonus.extra || player.activeBonus.name)}\n<i>Подтвердите использование бонуса перед одобрением броска!</i>`
            : ""
        }`
      );

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
          message: `✅ Администратор списал бонус "${usedBonus.extra || usedBonus.name}" игрока ${player.name} (подтверждено использование в реальной жизни).`,
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

    // Admin approves specific player turn (12 hour window)
    socket.on("admin:approve_player_turn", (pId: string, confirmBonusUse?: boolean) => {
      if (!isAdmin) return;
      const result = approveTurn(pId, { confirmBonusUse });
      if (!result.ok && result.error) socket.emit("error", result.error);
    });

    // Admin rejects specific player turn
    socket.on("admin:reject_player_turn", (pId: string) => {
      if (!isAdmin) return;
      rejectTurn(pId);
    });

    // Legacy entry point: approves whoever currently has a pending request.
    // Kept for older clients; delegates to the same implementation.
    socket.on("admin:confirm_turn", (confirmBonusUse?: boolean) => {
      if (!isAdmin) return;
      const reqUserId =
        gameState.turnRequestUserId || gameState.players.find((p) => p.turnRequested)?.id;
      if (!reqUserId) return;
      const result = approveTurn(reqUserId, { confirmBonusUse });
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

  // Periodically expire approved turns (runs every minute).
  const turnExpiryTimer = setInterval(() => {
    let stateChanged = false;
    const now = Date.now();
    for (const player of gameState.players) {
      if (player.turnApprovedUntil && player.turnApprovedUntil <= now) {
        player.turnApprovedUntil = null;
        player.turnRequested = false;
        stateChanged = true;

        addLog({
          id: "turn_timeout_" + Date.now() + "_" + Math.floor(Math.random() * 100),
          message: `⏰ Время отведенное на ход (12 часов) для игрока ${player.name} истекло. Ход отменен.`,
          timestamp: new Date().toLocaleTimeString(),
          type: "system",
        });

        io.emit("event:trigger", {
          title: "⏰ ВРЕМЯ НА ХОД ИСТЕКЛО",
          description: `Время отведенное на ваш ход (12 часов) истекло! Ваш ход был отменен. Запросите новый ход, когда будете готовы сделать бросок.`,
          playerName: player.name,
          type: "timeout",
          playerId: player.id,
        });

        if (player.telegramId || player.name) {
          sendTelegramMessage(
            player.telegramId || player.name,
            `⏰ <b>ВРЕМЯ НА ХОД ИСТЕКЛО</b>\n12 часов, отведенные на ваш ход, истекли. Ваш ход был отменен.`
          );
        }
      }
    }

    if (stateChanged) {
      saveState();
      broadcastSlices("players", "logs");
    }
    // A 12-hour window does not need second-level precision; polling every
    // 5s kept the event loop busy even with nobody connected.
  }, 60_000);

  turnExpiryTimer.unref?.();

  // Lightweight health endpoint for Docker/orchestrator health checks.
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
    log.info("Server listening", { url: `http://localhost:${PORT}` });
    // Presence-only summary: secret values are never printed.
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
