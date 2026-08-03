/**
 * Security primitives shared between the server and its tests.
 *
 * These were previously inlined in server.ts, which made them impossible to
 * unit-test. The implementations must stay byte-compatible with the values
 * already persisted in authPasswords / ADMIN_PASSWORD_HASH.
 */
import crypto from "node:crypto";

export const PBKDF2_ITERATIONS = 100000;
export const PBKDF2_KEYLEN = 32;
export const PBKDF2_DIGEST = "sha256";

/** Async PBKDF2 so hashing never blocks the event loop. */
export function pbkdf2(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      password,
      salt,
      PBKDF2_ITERATIONS,
      PBKDF2_KEYLEN,
      PBKDF2_DIGEST,
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      }
    );
  });
}

/** Produce a "salt:hash" record for a plaintext password. */
export async function hashPassword(password: string, customSalt?: string): Promise<string> {
  if (!password) return "";
  const salt = customSalt || crypto.randomBytes(16).toString("hex");
  const hash = (await pbkdf2(password, salt)).toString("hex");
  return `${salt}:${hash}`;
}

/** Constant-time verification supporting the modern and legacy formats. */
export async function verifyPassword(password: string, storedValue: string): Promise<boolean> {
  if (!storedValue) return !password;

  if (storedValue.includes(":")) {
    const [salt, originalHash] = storedValue.split(":");
    if (!salt || !originalHash) return false;
    const newHash = (await pbkdf2(password, salt)).toString("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(originalHash, "hex"), Buffer.from(newHash, "hex"));
    } catch {
      return false;
    }
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(storedValue), Buffer.from(password));
  } catch {
    return false;
  }
}

// --- Password generation ----------------------------------------------------

/**
 * Character classes used for generated passwords.
 *
 * Symbols are restricted to a set that survives copy/paste out of a Telegram
 * message and cannot be mistaken for Markdown or HTML markup: no backtick,
 * underscore, asterisk, angle brackets, ampersand or quotes.
 */
const PW_LOWER = "abcdefghijkmnopqrstuvwxyz"; // no 'l'
const PW_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 'I', no 'O'
const PW_DIGIT = "23456789"; // no '0', no '1'
const PW_SYMBOL = "!@#$%^&*+-=?";
const PW_ALPHABET = PW_LOWER + PW_UPPER + PW_DIGIT + PW_SYMBOL;

/**
 * Pick one character uniformly at random.
 *
 * `randomInt` is used rather than `randomBytes() % length`, which is biased
 * whenever the alphabet size does not divide 256 evenly.
 */
function randomChar(alphabet: string): string {
  return alphabet[crypto.randomInt(0, alphabet.length)];
}

/** Fisher–Yates shuffle driven by the CSPRNG. */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Generate a one-time player password.
 *
 * Length is random within [minLength, maxLength] (8–10 by default) and the
 * result is guaranteed to contain at least one lower-case letter, one
 * upper-case letter, one digit and one symbol — the required characters are
 * placed first and then shuffled, so their positions carry no information.
 *
 * Look-alike characters (0/O, 1/l/I) are excluded: these passwords are read
 * off a phone screen and retyped by hand.
 */
export function generatePassword(minLength = 8, maxLength = 10): string {
  const lo = Math.max(4, Math.min(minLength, maxLength));
  const hi = Math.max(lo, maxLength);
  const length = crypto.randomInt(lo, hi + 1);

  const chars = [
    randomChar(PW_LOWER),
    randomChar(PW_UPPER),
    randomChar(PW_DIGIT),
    randomChar(PW_SYMBOL),
  ];
  while (chars.length < length) chars.push(randomChar(PW_ALPHABET));

  return shuffle(chars).join("");
}

/** Escape user-controlled text before embedding it in Telegram HTML messages. */
export function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Session tokens ---------------------------------------------------------

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  sub: string;
  role: "admin" | "player";
  exp: number;
}

export function issueSessionToken(
  playerId: string,
  role: "admin" | "player",
  secret: string,
  ttlMs: number = SESSION_TTL_MS
): string {
  const payload: SessionPayload = { sub: playerId, role, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySessionToken(token: unknown, secret: string): SessionPayload | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!payload?.sub || !payload?.exp || payload.exp < Date.now()) return null;
    if (payload.role !== "admin" && payload.role !== "player") return null;
    return payload;
  } catch {
    return null;
  }
}
