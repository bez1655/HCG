/**
 * Pending registration requests.
 *
 * A player asks to join from the bot (or from the login screen); an
 * administrator approves or rejects it from Telegram. The request has to
 * survive a restart — otherwise the approve button in an old chat message
 * would point at a record the server no longer knows about — so it is kept on
 * disk next to the rest of the state.
 *
 * Deliberately NOT part of GameState: the queue contains Telegram ids and chat
 * ids, which are personal data and must never reach the broadcast state.
 */
import path from "node:path";
import { atomicWrite, readJson } from "../persistence/files";
import { createLogger } from "../utils/logger";
import { normaliseHandle } from "../telegram/initData";

const log = createLogger("Registrations");

export interface RegistrationRequest {
  /** "@handle", lower-case. Also the map key. */
  username: string;
  /** Numeric Telegram user id, when the request came through the bot. */
  telegramId?: number;
  /** Private chat with the bot, used to deliver the credentials. */
  chatId?: number;
  /** Display name, only for the administrator's notification. */
  firstName?: string;
  /** Epoch milliseconds. */
  requestedAt: number;
}

export type AddResult = "created" | "duplicate";

let file = "";
let pending: Record<string, RegistrationRequest> = {};

/** Point the store at DATA_DIR and load anything already queued. */
export function initRegistrations(dataDir: string): void {
  file = path.join(dataDir, "registration-requests.json");
  const loaded = readJson<Record<string, RegistrationRequest>>(file);
  pending = loaded && typeof loaded === "object" ? loaded : {};
  const count = Object.keys(pending).length;
  if (count > 0) log.info("Loaded pending registration requests", { count });
}

/**
 * Write the queue to disk.
 *
 * Synchronous on purpose. The file is a few hundred bytes and is touched only
 * on a registration decision — a handful of times a day — while the cost of
 * losing a write is high: the approve button lives in a Telegram message that
 * outlives the process, and pressing it after a crash must still resolve to a
 * real request. An async write left that window open (it also made the
 * restart test fail, which is how it was caught).
 */
function persist(): void {
  if (!file) return;
  atomicWrite(file, JSON.stringify(pending, null, 2), true);
}

/** Flush to disk; kept as a named export for the shutdown path. */
export function persistRegistrations(): void {
  persist();
}

/**
 * Queue a request.
 *
 * Returns "duplicate" when the same handle is already waiting, so the bot can
 * tell the player to be patient instead of spamming every administrator.
 * Known contact details are merged into the existing record either way — a
 * second attempt from inside the bot is how we learn the chat id.
 */
export function addRequest(
  input: Omit<RegistrationRequest, "requestedAt"> & { requestedAt?: number }
): { result: AddResult; request: RegistrationRequest } {
  const username = normaliseHandle(input.username);
  const existing = pending[username];

  if (existing) {
    if (input.telegramId) existing.telegramId = input.telegramId;
    if (input.chatId) existing.chatId = input.chatId;
    if (input.firstName) existing.firstName = input.firstName;
    persist();
    return { result: "duplicate", request: existing };
  }

  const request: RegistrationRequest = {
    username,
    telegramId: input.telegramId,
    chatId: input.chatId,
    firstName: input.firstName,
    requestedAt: input.requestedAt ?? Date.now(),
  };
  pending[username] = request;
  persist();
  return { result: "created", request };
}

export function getRequest(username: string): RegistrationRequest | undefined {
  return pending[normaliseHandle(username)];
}

/** Remove a request. Returns the record that was removed, if any. */
export function removeRequest(username: string): RegistrationRequest | undefined {
  const key = normaliseHandle(username);
  const found = pending[key];
  if (found) {
    delete pending[key];
    persist();
  }
  return found;
}

export function listRequests(): RegistrationRequest[] {
  return Object.values(pending).sort((a, b) => a.requestedAt - b.requestedAt);
}

/** Test hook: drop everything without touching disk layout expectations. */
export function resetRegistrations(): void {
  pending = {};
  persist();
}
