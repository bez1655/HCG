import { describe, it, expect, beforeEach } from "vitest";
import {
  initAccessJournal,
  recordAccess,
  extractClientIp,
  cleanIp,
  analyzeMultiAccounts,
  getWhois,
  checkRegistrationMultiMatch,
  generateMultiAccountsReportText,
  generateJournalCsv,
  importLogLines,
} from "./accessJournal";
import type { Player } from "../types";
import type { RegistrationRequest } from "./registrations";

describe("accessJournal & multi-account control", () => {
  let mockPlayers: Player[] = [];
  let mockPending: RegistrationRequest[] = [];

  beforeEach(() => {
    mockPlayers = [
      {
        id: "p1",
        name: "@legit_boss",
        telegramId: 1001,
        telegramUsername: "legit_boss",
        role: "player",
        cell: 10,
        turnsApproved: 3,
        createdAt: 1700000000000,
        lastSeenAt: 1700000050000,
      } as Player,
      {
        id: "p2",
        name: "@regular_guy",
        telegramId: 1002,
        telegramUsername: "regular_guy",
        role: "player",
        cell: 5,
        turnsApproved: 1,
        createdAt: 1700000010000,
        lastSeenAt: 1700000060000,
      } as Player,
    ];

    mockPending = [
      {
        username: "@suspect_alt",
        telegramId: 2001,
        chatId: 2001,
        firstName: "Suspect",
        requestedAt: 1700000100000,
      },
    ];

    // Initialize with empty dir (in-memory)
    initAccessJournal(
      "/tmp/hcg-test-journal-" + Math.random().toString(36).slice(2),
      () => mockPlayers,
      () => mockPending
    );
  });

  it("extracts client IP from proxy headers correctly", () => {
    expect(
      extractClientIp({
        headers: { "x-forwarded-for": "185.120.30.40, 10.0.0.1" },
      })
    ).toBe("185.120.30.40");

    expect(
      extractClientIp({
        headers: { "x-real-ip": "95.161.22.33" },
      })
    ).toBe("95.161.22.33");

    expect(
      extractClientIp({
        headers: { "cf-connecting-ip": "77.88.99.11" },
      })
    ).toBe("77.88.99.11");

    expect(cleanIp("::ffff:192.168.1.5")).toBe("192.168.1.5");
    expect(cleanIp("192.168.1.5:8080")).toBe("192.168.1.5");
  });

  it("correctly identifies status for registered, pending, and unregistered visitors", () => {
    // 1. Registered player opens Mini App
    const regEntry = recordAccess({
      ip: "185.10.10.1",
      action: "telegram_auth",
      endpoint: "/api/telegram/auth",
      telegramId: 1001,
      username: "@legit_boss",
      firstName: "Boss",
    });
    expect(regEntry?.status).toBe("registered");
    expect(regEntry?.playerId).toBe("p1");

    // 2. Pending applicant opens Mini App
    const penEntry = recordAccess({
      ip: "185.10.10.1",
      action: "telegram_auth",
      endpoint: "/api/telegram/auth",
      telegramId: 2001,
      username: "@suspect_alt",
      firstName: "Suspect",
    });
    expect(penEntry?.status).toBe("pending");

    // 3. Uninvited / uninvited visitor opens Mini App from Telegram
    const unregEntry = recordAccess({
      ip: "185.10.10.1",
      action: "telegram_auth",
      endpoint: "/api/telegram/auth",
      telegramId: 9999,
      username: "@uninvited_intruder",
      firstName: "Intruder",
    });
    expect(unregEntry?.status).toBe("unregistered");

    // 4. Guest browser visiting site without Telegram
    const guestEntry = recordAccess({
      ip: "185.20.20.2",
      action: "page_view",
      endpoint: "/",
      userAgent: "Mozilla/5.0 Chrome",
    });
    expect(guestEntry?.status).toBe("guest");
  });

  it("detects critical multi-account cluster when a registered player and unapproved user share an IP", () => {
    const sharedIp = "185.50.50.50";

    // Legit player uses this IP
    recordAccess({
      ip: sharedIp,
      action: "telegram_auth",
      endpoint: "/api/telegram/auth",
      telegramId: 1001,
      username: "@legit_boss",
    });

    // Unregistered intruder or suspect alt uses the exact same IP!
    recordAccess({
      ip: sharedIp,
      action: "telegram_auth",
      endpoint: "/api/telegram/auth",
      telegramId: 2001,
      username: "@suspect_alt",
    });

    const analysis = analyzeMultiAccounts();
    expect(analysis.suspiciousCount).toBeGreaterThanOrEqual(1);

    const cluster = analysis.clusters.find((c) => c.ip === sharedIp);
    expect(cluster).toBeDefined();
    expect(cluster?.isSuspicious).toBe(true);
    expect(cluster?.severity).toBe("critical");
    expect(cluster?.hasRegistered).toBe(true);
    expect(cluster?.hasPending).toBe(true);
  });

  it("checks registration multi-match immediately for incoming requests", () => {
    const ip = "178.62.1.200";

    // Record legit boss on this IP first
    recordAccess({
      ip,
      action: "telegram_auth",
      endpoint: "/api/telegram/auth",
      telegramId: 1001,
      username: "@legit_boss",
    });

    // An unknown user opened Mini App from that IP earlier
    recordAccess({
      ip,
      action: "telegram_auth",
      endpoint: "/api/telegram/auth",
      telegramId: 3003,
      username: "@clone_farmer",
    });

    // Now @clone_farmer submits /register in the bot
    const match = checkRegistrationMultiMatch(3003, "@clone_farmer");
    expect(match.hasMatch).toBe(true);
    expect(match.isSuspicious).toBe(true);
    expect(match.detectedIp).toBe(ip);
    expect(match.warningHtml).toContain("СОВПАДЕНИЕ ПО IP");
    expect(match.warningHtml).toContain("@legit_boss");
  });

  it("provides detailed whois by handle, telegramId, or IP", () => {
    recordAccess({
      ip: "95.10.20.30",
      action: "telegram_auth",
      endpoint: "/api/telegram/auth",
      telegramId: 1002,
      username: "@regular_guy",
    });

    // Whois by handle
    const whoisUser = getWhois("@regular_guy");
    expect(whoisUser.found).toBe(true);
    expect(whoisUser.ips).toContain("95.10.20.30");
    expect(whoisUser.summaryText).toContain("regular_guy");

    // Whois by IP
    const whoisIp = getWhois("95.10.20.30");
    expect(whoisIp.found).toBe(true);
    expect(whoisIp.summaryText).toContain("WHOIS ПО IP");
    expect(whoisIp.summaryText).toContain("regular_guy");
  });

  it("exports CSV and analytical text report", () => {
    recordAccess({
      ip: "109.200.1.1",
      action: "telegram_auth",
      endpoint: "/api/telegram/auth",
      telegramId: 1001,
      username: "@legit_boss",
    });

    const report = generateMultiAccountsReportText();
    expect(report).toContain("АНАЛИТИЧЕСКИЙ ОТЧЁТ ПО МУЛЬТИАККАУНТАМ");
    expect(report).toContain("109.200.1.1");

    const csv = generateJournalCsv();
    expect(csv.startsWith("\uFEFF")).toBe(true); // BOM present
    expect(csv).toContain("109.200.1.1");
    expect(csv).toContain("legit_boss");
  });

  it("imports historical log lines from Nginx access.log format", () => {
    const nginxLines = [
      '185.12.34.56 - - [23/Nov/2026:14:15:16 +0300] "GET / HTTP/1.1" 200 4521 "https://t.me/" "Mozilla/5.0"',
      '185.12.34.56 - - [23/Nov/2026:14:15:18 +0300] "POST /api/telegram/auth HTTP/1.1" 200 892 "https://hapstore.cyber-game.online" "TelegramMiniApp"',
      '127.0.0.1 - - [23/Nov/2026:14:15:20 +0300] "GET /healthz HTTP/1.1" 200 24 "-" "curl/7.88.1"', // must be skipped
      '185.99.99.99 - - [23/Nov/2026:14:15:22 +0300] "GET /assets/index-abc.js HTTP/1.1" 200 120400 "-" "Mozilla/5.0"', // static file must be skipped
    ];

    const result = importLogLines(nginxLines);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(2);

    const whois = getWhois("185.12.34.56");
    expect(whois.found).toBe(true);
  });
});
