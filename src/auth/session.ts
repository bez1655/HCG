/**
 * Session tokens and legacy credential migration.
 *
 * Extracted from server.ts so authentication can be reasoned about (and
 * tested) on its own, rather than sitting in the middle of a 2000-line file.
 */
import crypto from "node:crypto";
import {
  issueSessionToken as signSession,
  verifySessionToken as checkSession,
  type SessionPayload,
} from "../utils/security";
import { secrets } from "../config/env";

export type { SessionPayload };

/** Stable identifier used for the administrator session. */
export const ADMIN_PLAYER_ID = "admin_user";

/** Sign a session token for a player or the administrator. */
export function issueSessionToken(playerId: string, role: "admin" | "player"): string {
  return signSession(playerId, role, secrets.sessionSecret);
}

/** Verify a token and return its payload, or null when it is not usable. */
export function verifySessionToken(token: unknown): SessionPayload | null {
  return checkSession(token, secrets.sessionSecret);
}

// ---------------------------------------------------------------------------
// Legacy AES-CBC support
//
// An older release encrypted passwords with AES-CBC and a fixed zero IV, which
// made the ciphertext deterministic. Encryption has been removed; decryption
// stays only long enough to migrate stored values to PBKDF2 hashes, and only
// when LEGACY_AES_PASSWORD is explicitly provided.
// ---------------------------------------------------------------------------

const LEGACY_AES_KEY = secrets.legacyAesPassword
  ? crypto.createHash("sha256").update(secrets.legacyAesPassword).digest()
  : null;
const LEGACY_IV = Buffer.alloc(16, 0);

/** Decrypt a legacy value, or null when unavailable/undecryptable. */
export function decryptLegacyPass(encrypted: string): string | null {
  if (!encrypted || !LEGACY_AES_KEY) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", LEGACY_AES_KEY, LEGACY_IV);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}
