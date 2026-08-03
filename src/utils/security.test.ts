import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  generatePassword,
  hashPassword,
  verifyPassword,
  escapeHtml,
  issueSessionToken,
  verifySessionToken,
} from "./security";

const SECRET = "test-secret-key-for-unit-tests";

describe("hashPassword / verifyPassword", () => {
  it("produces a salt:hash record and verifies the correct password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    await expect(verifyPassword("correct horse battery staple", stored)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const stored = await hashPassword("s3cret-password");
    await expect(verifyPassword("wrong-password", stored)).resolves.toBe(false);
  });

  it("uses a fresh random salt for identical passwords", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    await expect(verifyPassword("same-password", a)).resolves.toBe(true);
    await expect(verifyPassword("same-password", b)).resolves.toBe(true);
  });

  it("treats an empty stored value as 'no password set'", async () => {
    await expect(verifyPassword("", "")).resolves.toBe(true);
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
  });

  it("verifies a legacy plaintext record and rejects a wrong one", async () => {
    await expect(verifyPassword("plaintext", "plaintext")).resolves.toBe(true);
    await expect(verifyPassword("nope", "plaintext")).resolves.toBe(false);
  });

  it("rejects a malformed hash record instead of throwing", async () => {
    await expect(verifyPassword("x", "onlysalt:")).resolves.toBe(false);
    await expect(verifyPassword("x", ":onlyhash")).resolves.toBe(false);
  });

  it("stays compatible with an externally generated PBKDF2 hash", async () => {
    // Mirrors scripts/hash-password.mjs so the CLI and the server agree.
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync("cli-generated", salt, 100000, 32, "sha256").toString("hex");
    await expect(verifyPassword("cli-generated", `${salt}:${hash}`)).resolves.toBe(true);
  });
});

describe("escapeHtml", () => {
  it("neutralises HTML injection in Telegram messages", () => {
    expect(escapeHtml('<a href="http://evil">click</a>')).toBe(
      "&lt;a href=&quot;http://evil&quot;&gt;click&lt;/a&gt;"
    );
  });

  it("escapes ampersands first so entities are not double-broken", () => {
    expect(escapeHtml("Tom & <b>Jerry</b>")).toBe("Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;");
  });

  it("handles null and undefined safely", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("session tokens", () => {
  it("round-trips a valid token", () => {
    const token = issueSessionToken("p_123", "player", SECRET);
    const payload = verifySessionToken(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("p_123");
    expect(payload!.role).toBe("player");
  });

  it("rejects a token signed with a different secret", () => {
    const token = issueSessionToken("p_123", "player", SECRET);
    expect(verifySessionToken(token, "another-secret")).toBeNull();
  });

  it("rejects a tampered payload (privilege escalation attempt)", () => {
    const token = issueSessionToken("p_123", "player", SECRET);
    const [, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "p_123", role: "admin", exp: Date.now() + 60000 }),
      "utf8"
    ).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = issueSessionToken("p_123", "player", SECRET, -1000);
    expect(verifySessionToken(token, SECRET)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifySessionToken(null, SECRET)).toBeNull();
    expect(verifySessionToken("", SECRET)).toBeNull();
    expect(verifySessionToken("no-dot", SECRET)).toBeNull();
    expect(verifySessionToken("a.b.c", SECRET)).toBeNull();
  });
});

describe("generatePassword", () => {
  it("respects the requested length range", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw.length).toBeGreaterThanOrEqual(8);
      expect(pw.length).toBeLessThanOrEqual(10);
    }
  });

  it("always contains a lower-case letter, an upper-case letter, a digit and a symbol", () => {
    for (let i = 0; i < 200; i++) {
      const pw = generatePassword();
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*+\-=?]/);
    }
  });

  it("excludes characters that are misread when retyped from a phone screen", () => {
    // 0/O and 1/l/I are the classic confusions; these passwords are read
    // aloud off a Telegram message and typed by hand.
    for (let i = 0; i < 200; i++) {
      expect(generatePassword()).not.toMatch(/[0O1lI]/);
    }
  });

  it("does not repeat itself", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(generatePassword());
    expect(seen.size).toBe(500);
  });

  it("does not place the required classes in fixed positions", () => {
    // A naive implementation emits lower/upper/digit/symbol in that order,
    // which leaks structure. Check the first character varies in class.
    const classes = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const first = generatePassword()[0];
      if (/[a-z]/.test(first)) classes.add("lower");
      else if (/[A-Z]/.test(first)) classes.add("upper");
      else if (/[0-9]/.test(first)) classes.add("digit");
      else classes.add("symbol");
    }
    expect(classes.size).toBe(4);
  });

  it("honours an explicit length", () => {
    const pw = generatePassword(16, 16);
    expect(pw).toHaveLength(16);
  });

  it("produces a hash that verifies against the generated plaintext", async () => {
    const pw = generatePassword();
    const stored = await hashPassword(pw);
    await expect(verifyPassword(pw, stored)).resolves.toBe(true);
    await expect(verifyPassword(pw + "x", stored)).resolves.toBe(false);
  });
});
