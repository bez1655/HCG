import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyInitData, normaliseHandle, INIT_DATA_MAX_AGE_MS } from "./initData";

const BOT_TOKEN = "123456:TEST-TOKEN-FOR-UNIT-TESTS";

/** Build a correctly signed initData string, exactly as Telegram would. */
function signInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN,
  authDate = Math.floor(Date.now() / 1000)
): string {
  const all: Record<string, string> = { ...fields, auth_date: String(authDate) };
  const dataCheckString = Object.keys(all)
    .sort()
    .map((k) => `${k}=${all[k]}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const params = new URLSearchParams(all);
  params.set("hash", hash);
  return params.toString();
}

const validUser = JSON.stringify({
  id: 4242,
  first_name: "Нео",
  username: "neo",
  language_code: "ru",
});

describe("verifyInitData", () => {
  it("accepts a correctly signed payload and extracts the user", () => {
    const result = verifyInitData(signInitData({ user: validUser }), BOT_TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe(4242);
    expect(result.user.username).toBe("neo");
    expect(result.user.firstName).toBe("Нео");
  });

  it("rejects a payload signed with a different bot token", () => {
    const forged = signInitData({ user: validUser }, "999:SOMEONE-ELSES-TOKEN");
    const result = verifyInitData(forged, BOT_TOKEN);
    expect(result.ok).toBe(false);
  });

  it("rejects a tampered user id even when the rest is untouched", () => {
    // The classic attack: take a real payload, swap in somebody else's id.
    const real = signInitData({ user: validUser });
    const params = new URLSearchParams(real);
    params.set("user", JSON.stringify({ id: 1, username: "admin" }));
    expect(verifyInitData(params.toString(), BOT_TOKEN).ok).toBe(false);
  });

  it("rejects a missing signature", () => {
    const params = new URLSearchParams(signInitData({ user: validUser }));
    params.delete("hash");
    expect(verifyInitData(params.toString(), BOT_TOKEN).ok).toBe(false);
  });

  it("rejects a stale payload", () => {
    const old = Math.floor((Date.now() - INIT_DATA_MAX_AGE_MS - 60_000) / 1000);
    const result = verifyInitData(signInitData({ user: validUser }, BOT_TOKEN, old), BOT_TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("устарела");
  });

  it("accepts a stale payload when the age check is disabled", () => {
    const old = Math.floor((Date.now() - 10 * INIT_DATA_MAX_AGE_MS) / 1000);
    expect(verifyInitData(signInitData({ user: validUser }, BOT_TOKEN, old), BOT_TOKEN, 0).ok).toBe(
      true
    );
  });

  it("refuses to verify anything when no bot token is configured", () => {
    expect(verifyInitData(signInitData({ user: validUser }), undefined).ok).toBe(false);
  });

  it("rejects empty, oversized and non-string input", () => {
    expect(verifyInitData("", BOT_TOKEN).ok).toBe(false);
    expect(verifyInitData(null, BOT_TOKEN).ok).toBe(false);
    expect(verifyInitData(42, BOT_TOKEN).ok).toBe(false);
    expect(verifyInitData("a".repeat(5000), BOT_TOKEN).ok).toBe(false);
  });

  it("rejects a signed payload that carries no user object", () => {
    expect(verifyInitData(signInitData({ query_id: "abc" }), BOT_TOKEN).ok).toBe(false);
  });

  it("accepts a user without a username (handle is optional)", () => {
    const noHandle = JSON.stringify({ id: 77, first_name: "Тень" });
    const result = verifyInitData(signInitData({ user: noHandle }), BOT_TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.username).toBeUndefined();
    expect(result.user.id).toBe(77);
  });
});

describe("normaliseHandle", () => {
  it("adds the @ prefix and lower-cases", () => {
    expect(normaliseHandle("Neo")).toBe("@neo");
    expect(normaliseHandle("@NEO")).toBe("@neo");
    expect(normaliseHandle("  @Neo  ")).toBe("@neo");
  });
});
