/**
 * Who may open the in-game admin console from Telegram.
 *
 * Same sources the bot uses: TELEGRAM_ADMIN_USERNAME and DATA_DIR/admin_list.json.
 * The Mini App used to always issue a player session, so a bot admin saw no
 * «АДМИНКА» button after pressing «ИГРАТЬ».
 */
import fs from "node:fs";
import path from "node:path";

function formatHandle(username: string): string {
  const formatted = username.toLowerCase().trim();
  return formatted.startsWith("@") ? formatted : `@${formatted}`;
}

export function loadTelegramAdminHandles(dataDir: string, envAdmin?: string): Set<string> {
  const set = new Set<string>();
  if (envAdmin?.trim()) set.add(formatHandle(envAdmin));

  const file = path.join(dataDir, "admin_list.json");
  if (!fs.existsSync(file)) return set;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (Array.isArray(parsed)) {
      for (const u of parsed) {
        if (typeof u === "string" && u.trim()) set.add(formatHandle(u));
      }
    }
  } catch {
    /* corrupt file: env bootstrap still works */
  }
  return set;
}

export function isTelegramAdminHandle(
  username: string | null | undefined,
  dataDir: string,
  envAdmin?: string
): boolean {
  if (!username) return false;
  return loadTelegramAdminHandles(dataDir, envAdmin).has(formatHandle(username));
}
