#!/usr/bin/env node
/**
 * Generates a PBKDF2 "salt:hash" value for ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   npm run hash-password -- 'my-strong-password'
 *   node scripts/hash-password.mjs 'my-strong-password'
 *
 * The parameters below must stay in sync with verifyPassword() in server.ts.
 */
import crypto from "node:crypto";

const ITERATIONS = 100000;
const KEYLEN = 32;
const DIGEST = "sha256";

const password = process.argv[2];

if (!password) {
  console.error("Usage: npm run hash-password -- '<password>'");
  process.exit(1);
}

if (password.length < 12) {
  console.warn(
    `[warn] The password is only ${password.length} characters long. ` +
      `12+ characters are strongly recommended.`
  );
}

const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, DIGEST).toString("hex");

console.log("\nAdd this line to your .env file:\n");
console.log(`ADMIN_PASSWORD_HASH="${salt}:${hash}"\n`);
console.log("You will also need these (generate once, keep secret):\n");
console.log(`SESSION_SECRET="${crypto.randomBytes(32).toString("hex")}"`);
console.log(`INTERNAL_API_SECRET="${crypto.randomBytes(32).toString("hex")}"\n`);
