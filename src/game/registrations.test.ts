import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initRegistrations,
  addRequest,
  getRequest,
  removeRequest,
  listRequests,
  resetRegistrations,
} from "./registrations";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-reg-"));
  initRegistrations(dir);
  resetRegistrations();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("registration queue", () => {
  it("queues a request and normalises the handle", () => {
    const { result, request } = addRequest({ username: "Neo", telegramId: 1, chatId: 10 });
    expect(result).toBe("created");
    expect(request.username).toBe("@neo");
    expect(getRequest("@NEO")?.telegramId).toBe(1);
  });

  it("reports a repeated request as a duplicate instead of queueing twice", () => {
    addRequest({ username: "@neo", telegramId: 1, chatId: 10 });
    const second = addRequest({ username: "@neo", telegramId: 1, chatId: 10 });
    expect(second.result).toBe("duplicate");
    expect(listRequests()).toHaveLength(1);
  });

  it("merges newly learned contact details into an existing request", () => {
    // The web form knows only the handle; a later /register in the bot is how
    // the chat id becomes known.
    addRequest({ username: "@neo" });
    expect(getRequest("@neo")?.chatId).toBeUndefined();

    addRequest({ username: "@neo", telegramId: 5, chatId: 55, firstName: "Нео" });
    const merged = getRequest("@neo");
    expect(merged?.chatId).toBe(55);
    expect(merged?.telegramId).toBe(5);
    expect(merged?.firstName).toBe("Нео");
  });

  it("removes a request and returns the record", () => {
    addRequest({ username: "@neo", chatId: 10 });
    const removed = removeRequest("NEO");
    expect(removed?.chatId).toBe(10);
    expect(getRequest("@neo")).toBeUndefined();
    expect(removeRequest("@neo")).toBeUndefined();
  });

  it("lists requests oldest first", () => {
    addRequest({ username: "@first", requestedAt: 1000 });
    addRequest({ username: "@second", requestedAt: 2000 });
    expect(listRequests().map((r) => r.username)).toEqual(["@first", "@second"]);
  });

  it("survives a restart", () => {
    addRequest({ username: "@neo", telegramId: 1, chatId: 10 });
    // An approve button in an old chat message must still resolve after a
    // redeploy, so the queue is persisted rather than kept in memory.
    initRegistrations(dir);
    expect(getRequest("@neo")?.chatId).toBe(10);
  });

  it("starts empty when the stored file is corrupt", () => {
    fs.writeFileSync(path.join(dir, "registration-requests.json"), "{ not json", "utf-8");
    initRegistrations(dir);
    expect(listRequests()).toHaveLength(0);
  });
});

/**
 * Re-applying after a rejection or a removal.
 *
 * The operator asked for this explicitly, so it needs a test rather than an
 * assurance: a rejected request is deleted outright, and a deleted player
 * leaves gameState.players, so neither leaves a tombstone that would block a
 * second attempt. If someone ever adds a "rejected" blocklist, this fails.
 */
describe("re-applying after rejection or removal", () => {
  beforeEach(() => {
    resetRegistrations();
  });

  it("accepts a new request after the previous one was rejected", () => {
    expect(addRequest({ username: "@player", telegramId: 1, chatId: 1 }).result).toBe("created");

    // Rejection removes the request; nothing is remembered about it.
    expect(removeRequest("@player")).toBeTruthy();
    expect(getRequest("@player")).toBeUndefined();

    expect(addRequest({ username: "@player", telegramId: 1, chatId: 1 }).result).toBe("created");
  });

  it("still collapses a second request while the first is pending", () => {
    // Re-applying must not spam the administrator with duplicate cards.
    addRequest({ username: "@player", telegramId: 1, chatId: 1 });
    expect(addRequest({ username: "@player", telegramId: 1, chatId: 1 }).result).toBe("duplicate");
  });

  it("refreshes the contact details on a repeat attempt", () => {
    // A player who switched devices must still be reachable, otherwise the
    // approval message goes to a chat that no longer exists.
    addRequest({ username: "@player", telegramId: 1, chatId: 100 });
    addRequest({ username: "@player", telegramId: 2, chatId: 200 });

    const req = getRequest("@player");
    expect(req?.telegramId).toBe(2);
    expect(req?.chatId).toBe(200);
  });

  it("treats handles case-insensitively across attempts", () => {
    addRequest({ username: "@Player", telegramId: 1, chatId: 1 });
    expect(addRequest({ username: "@player", telegramId: 1, chatId: 1 }).result).toBe("duplicate");
    removeRequest("@PLAYER");
    expect(getRequest("@player")).toBeUndefined();
  });
});
