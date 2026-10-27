/**
 * Durable file writes.
 *
 * A plain fs.writeFile truncates the destination immediately, so a crash — or
 * simply the process exiting before the async callback ran — left an empty or
 * half-written file behind. That is how state and password hashes were lost on
 * redeploy. Every write here goes to a temporary file and is then renamed,
 * which is atomic on POSIX filesystems.
 */
import fs from "node:fs";
import path from "node:path";
import { createLogger, errorContext } from "../utils/logger";

const log = createLogger("Storage");

/**
 * Write a file atomically.
 *
 * @param sync Use the blocking variant. Required during shutdown, where the
 *             process may exit before an async callback fires.
 */
export function atomicWrite(file: string, contents: string, sync = false): Promise<void> | void {
  const tmp = `${file}.tmp`;

  if (sync) {
    try {
      fs.writeFileSync(tmp, contents, "utf-8");
      fs.renameSync(tmp, file);
    } catch (err) {
      log.error("Failed to write file", { file: path.basename(file), ...errorContext(err) });
    }
    return;
  }

  return new Promise<void>((resolve) => {
    fs.writeFile(tmp, contents, "utf-8", (writeErr) => {
      if (writeErr) {
        log.error("Failed to write file", {
          file: path.basename(file),
          ...errorContext(writeErr),
        });
        return resolve();
      }
      fs.rename(tmp, file, (renameErr) => {
        if (renameErr) {
          log.error("Failed to replace file", {
            file: path.basename(file),
            ...errorContext(renameErr),
          });
        }
        resolve();
      });
    });
  });
}

/** Read and parse a JSON file, returning null when absent or unreadable. */
export function readJson<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (err) {
    log.error("Failed to read file", { file: path.basename(file), ...errorContext(err) });
    return null;
  }
}

/** Ensure a directory exists; logs instead of throwing. */
export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.error("Unable to create directory", { dir, ...errorContext(err) });
  }
}
