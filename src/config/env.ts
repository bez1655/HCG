/**
 * ============================================================================
 * CENTRALISED CONFIGURATION — THE ONLY PLACE THAT READS process.env
 * ============================================================================
 *
 * Every secret, credential and deployment-specific value enters the
 * application through this module. Nothing else in the codebase should touch
 * `process.env` directly.
 *
 * Rules enforced here:
 *
 *  1. NO hardcoded secrets, ever. There is not a single real credential,
 *     password, API key, token, project id, username or hostname in the
 *     source tree — they all come from the environment at runtime.
 *
 *  2. Fail fast in production. If a required secret is missing the process
 *     exits instead of silently falling back to a well-known default, which
 *     is how a hardcoded password once ended up protecting the admin console.
 *
 *  3. Ephemeral dev fallbacks. Outside production, missing secrets are
 *     replaced with random values generated per boot. They are unguessable
 *     and do not survive a restart, so they can never become a de-facto
 *     shared password.
 *
 *  4. Never log secret values. `describeConfig()` reports only whether a
 *     value is present, plus a short fingerprint for support purposes.
 *
 * See `.env.example` for the full list and `npm run hash-password` to
 * generate the required values.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Load .env before anything reads process.env.
 *
 * Real environment variables always win: a value injected by Docker, systemd
 * or a secret manager is never overwritten by the file.
 *
 * Parsed here rather than via the `dotenv` package so that configuration has
 * no runtime dependency and the quoting rules stay explicit — service-account
 * JSON is stored single-quoted and must survive verbatim.
 */
function loadDotEnv(): void {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, "utf8");
  } catch (err) {
    console.warn(`[Config] Could not read .env: ${(err as Error).message}`);
    return;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue; // real env wins

    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
      // Only double quotes support escape sequences, so JSON kept in single
      // quotes (the service-account key) is passed through untouched.
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    }
    process.env[key] = value;
  }
}

loadDotEnv();

export type NodeEnv = "production" | "development" | "test";

export const NODE_ENV: NodeEnv = (process.env.NODE_ENV as NodeEnv) || "development";
export const IS_PRODUCTION = NODE_ENV === "production";
export const IS_TEST = NODE_ENV === "test";

/** Collected during load so a misconfigured deployment reports every problem at once. */
const fatalErrors: string[] = [];
const warnings: string[] = [];

function readRaw(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A secret that MUST be supplied in production.
 * In development a random per-boot value is generated instead.
 */
function requiredSecret(name: string, generateDevFallback: () => string): string {
  const value = readRaw(name);
  if (value) return value;

  if (IS_PRODUCTION) {
    fatalErrors.push(
      `${name} is required in production. Generate it with: npm run hash-password -- '<password>'`
    );
    return "";
  }

  warnings.push(
    `${name} is not set — using an ephemeral value for this session only. ` +
      `It changes on every restart and must never be relied upon.`
  );
  return generateDevFallback();
}

/** An optional value; absence is legitimate and simply disables a feature. */
function optional(name: string): string | undefined {
  return readRaw(name);
}

/** A non-secret value with a safe, non-personal default. */
function withDefault(name: string, fallback: string): string {
  return readRaw(name) ?? fallback;
}

const randomHex = (bytes: number) => () => crypto.randomBytes(bytes).toString("hex");

// ---------------------------------------------------------------------------
// Secrets (never logged, never committed)
// ---------------------------------------------------------------------------

export const secrets = {
  /** PBKDF2 "salt:hash" of the administrator password. */
  adminPasswordHash: requiredSecret(
    "ADMIN_PASSWORD_HASH",
    // Random salt AND random hash: no password can ever match it.
    () => `${crypto.randomBytes(16).toString("hex")}:${crypto.randomBytes(32).toString("hex")}`
  ),

  /** HMAC key for session tokens. */
  sessionSecret: requiredSecret("SESSION_SECRET", randomHex(32)),

  /** Shared credential between the game server and the bot container. */
  internalApiSecret: requiredSecret("INTERNAL_API_SECRET", randomHex(32)),

  /** Telegram bot token. Optional: without it Telegram features stay disabled. */
  telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),

  /**
   * Legacy AES password, used once to migrate credentials written by a
   * pre-hardening release. Remove from the environment after migrating.
   */
  legacyAesPassword: optional("LEGACY_AES_PASSWORD"),
} as const;

// ---------------------------------------------------------------------------
// Deployment settings (not secret, but environment-specific)
// ---------------------------------------------------------------------------

export const app = {
  port: Number(process.env.PORT) || 3000,
  /** Login name that authenticates against ADMIN_PASSWORD_HASH. */
  adminLogin: withDefault("ADMIN_LOGIN", "admin").toLowerCase(),
  /** Public origin, also used to build the CORS allow-list. */
  webAppUrl: optional("WEB_APP_URL"),
  /** Writable state directory; must match the Docker volume mount. */
  dataDir: withDefault("DATA_DIR", "./data"),
  /** How often a scheduled state snapshot is written (ms). Default 6 hours. */
  snapshotIntervalMs: Number(readRaw("SNAPSHOT_INTERVAL_MS")) || 6 * 60 * 60 * 1000,
  /** Logging verbosity: debug | info | warn | error | silent. */
  logLevel: withDefault("LOG_LEVEL", IS_PRODUCTION ? "info" : "debug"),
} as const;

export const telegram = {
  botToken: secrets.telegramBotToken,
  groupChatId: optional("TELEGRAM_GROUP_CHAT_ID"),
  /**
   * Administrator handle. No default: hardcoding a personal username meant
   * every fork notified a stranger and leaked that identity in the source.
   */
  adminUsername: optional("TELEGRAM_ADMIN_USERNAME"),

  /**
   * Outbound proxy for Telegram, e.g. socks5://host:1080.
   *
   * The same variable configures the bot container. Both need it: the bot
   * receives updates, but the SERVER sends turn requests, prize
   * announcements and registration alerts. Setting it for only one of them
   * produced a bot that answered /start while every in-game notification
   * vanished silently.
   */
  proxyUrl: optional("TELEGRAM_PROXY"),
} as const;

export const firebase = {
  /**
   * Service-account key JSON itself. This is the credential the server uses:
   * the Admin SDK bypasses Firestore security rules, so the rules can deny all
   * public access. Treat it as a secret — it grants full database access.
   */
  serviceAccountJson: optional("FIREBASE_SERVICE_ACCOUNT"),

  /** Path to a service-account key file (alternative to the JSON above). */
  serviceAccountPath: optional("GOOGLE_APPLICATION_CREDENTIALS"),

  /** Target project and database. */
  projectId: optional("FIREBASE_PROJECT_ID"),
  firestoreDatabaseId: optional("FIREBASE_FIRESTORE_DATABASE_ID"),

  /**
   * Legacy client-SDK settings. No longer used for server persistence; kept
   * only so existing deployments do not break on an unknown variable.
   */
  configJson: optional("FIREBASE_CONFIG"),
  apiKey: optional("FIREBASE_API_KEY"),
  authDomain: optional("FIREBASE_AUTH_DOMAIN"),
  appId: optional("FIREBASE_APP_ID"),
} as const;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (telegram.botToken && !telegram.adminUsername) {
  warnings.push(
    "TELEGRAM_BOT_TOKEN is set but TELEGRAM_ADMIN_USERNAME is not — " +
      "registration and turn requests cannot be delivered to an administrator."
  );
}

if (IS_PRODUCTION && !app.webAppUrl) {
  warnings.push("WEB_APP_URL is not set — the CORS allow-list will reject browser origins.");
}

const hasAdminCredential = Boolean(firebase.serviceAccountJson || firebase.serviceAccountPath);
const hasLegacyClientConfig = Boolean(firebase.apiKey || firebase.configJson);

if (!hasAdminCredential && hasLegacyClientConfig) {
  warnings.push(
    "Firebase is configured with client-SDK values (FIREBASE_API_KEY/FIREBASE_CONFIG) " +
      "but no service account. The server now uses the Admin SDK, so Firestore will " +
      "stay DISABLED and state will persist to local disk only. Set " +
      "FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS to re-enable it."
  );
}

if (secrets.legacyAesPassword) {
  warnings.push(
    "LEGACY_AES_PASSWORD is set. It is only needed to migrate old credentials; " +
      "remove it from the environment once migration has completed."
  );
}

/** Non-reversible fingerprint, safe to print in logs for support. */
function fingerprint(value: string | undefined): string {
  if (!value) return "not set";
  return `set (sha256:${crypto.createHash("sha256").update(value).digest("hex").slice(0, 8)})`;
}

/**
 * Emit warnings and abort when the configuration is unusable.
 *
 * Uses console directly: the logger is configured *from* this module's output,
 * so it is not available yet, and a fatal misconfiguration must be readable
 * even when logging is misconfigured.
 */
export function loadConfig(): void {
  for (const w of warnings) console.warn(`[config] warn: ${w}`);

  if (fatalErrors.length > 0) {
    console.error("\n[config] FATAL — refusing to start with an insecure configuration:\n");
    for (const e of fatalErrors) console.error(`  • ${e}`);
    console.error("\nSee .env.example for the full list of variables.\n");
    process.exit(1);
  }
}

/** Startup summary. Reports presence only — never the values themselves. */
export function describeConfig(): Record<string, string> {
  return {
    NODE_ENV,
    PORT: String(app.port),
    DATA_DIR: app.dataDir,
    WEB_APP_URL: app.webAppUrl ?? "not set",
    ADMIN_PASSWORD_HASH: fingerprint(secrets.adminPasswordHash),
    SESSION_SECRET: fingerprint(secrets.sessionSecret),
    INTERNAL_API_SECRET: fingerprint(secrets.internalApiSecret),
    TELEGRAM_BOT_TOKEN: secrets.telegramBotToken ? "set" : "not set",
    TELEGRAM_ADMIN_USERNAME: telegram.adminUsername ?? "not set",
    TELEGRAM_PROXY: telegram.proxyUrl ? "set" : "not set (direct)",
    FIREBASE: firebase.serviceAccountJson
      ? "service account via FIREBASE_SERVICE_ACCOUNT (Admin SDK)"
      : firebase.serviceAccountPath
        ? "service account via GOOGLE_APPLICATION_CREDENTIALS (Admin SDK)"
        : "not configured (local disk persistence)",
  };
}
