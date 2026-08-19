/**
 * ============================================================================
 * STRUCTURED LOGGER
 * ============================================================================
 *
 * Replaces bare console.* calls, which produced unparseable free-form text and
 * offered no way to silence noise or raise severity per environment.
 *
 * Deliberately dependency-free: pino/winston would add install weight for what
 * amounts to level filtering and JSON serialisation.
 *
 *   • production  → one JSON object per line, ready for log shipping
 *   • development → colourised, human-readable output
 *
 * Control with LOG_LEVEL: debug | info | warn | error | silent (default info).
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const COLORS = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
  reset: "\x1b[0m",
  dim: "\x1b[2m",
};

export interface LoggerOptions {
  level?: LogLevel;
  /** Emit newline-delimited JSON instead of prettified text. */
  json?: boolean;
}

let currentLevel: LogLevel = "info";
let useJson = false;

export function configureLogger(options: LoggerOptions = {}): void {
  if (options.level) currentLevel = options.level;
  if (typeof options.json === "boolean") useJson = options.json;
}

function shouldLog(level: Exclude<LogLevel, "silent">): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

/**
 * Never let a logging call leak a credential. Values under these keys are
 * replaced before serialisation.
 */
const REDACT_KEYS = /^(password|token|secret|apiKey|api_key|authorization|private_key)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function emit(
  level: Exclude<LogLevel, "silent">,
  scope: string,
  message: string,
  context?: Record<string, unknown>
): void {
  if (!shouldLog(level)) return;

  const safeContext = context ? (redact(context) as Record<string, unknown>) : undefined;

  if (useJson) {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      scope,
      msg: message,
      ...(safeContext ?? {}),
    });
    (level === "error" ? process.stderr : process.stdout).write(line + "\n");
    return;
  }

  const time = new Date().toISOString().slice(11, 19);
  const head = `${COLORS.dim}${time}${COLORS.reset} ${COLORS[level]}${level.toUpperCase().padEnd(5)}${COLORS.reset} ${COLORS.dim}[${scope}]${COLORS.reset}`;
  const tail =
    safeContext && Object.keys(safeContext).length ? ` ${JSON.stringify(safeContext)}` : "";
  const out = `${head} ${message}${tail}`;
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** Create a logger bound to a subsystem name, e.g. createLogger("Firestore"). */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, c) => emit("debug", scope, m, c),
    info: (m, c) => emit("info", scope, m, c),
    warn: (m, c) => emit("warn", scope, m, c),
    error: (m, c) => emit("error", scope, m, c),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

/** Normalise a thrown value into something safe to log. */
export function errorContext(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error: err.message,
      ...(err.stack ? { stack: err.stack.split("\n")[1]?.trim() } : {}),
    };
  }
  return { error: String(err) };
}
