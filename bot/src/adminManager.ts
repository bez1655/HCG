import fs from "fs";
import path from "path";
import { Context } from "telegraf";
import { config } from "./config.js";

const ADMIN_LIST_FILE = path.join(config.dataDir, "admin_list.json");

function formatHandle(username: string): string {
  const formatted = username.toLowerCase().trim();
  return formatted.startsWith("@") ? formatted : `@${formatted}`;
}

export class AdminManager {
  private adminUsernames: Set<string> = new Set();
  /** Handle from TELEGRAM_ADMIN_USERNAME — cannot be removed via /del_admin. */
  private bootstrap: string | null = null;

  constructor() {
    this.loadAdmins();
  }

  private loadAdmins() {
    // Bootstrap administrator comes from configuration only. Never hardcode a
    // personal handle: that granted rights in every copy and leaked identity.
    this.bootstrap = null;
    const envAdmin = config.adminUsername?.toLowerCase().trim();
    if (envAdmin) {
      this.bootstrap = formatHandle(envAdmin);
      this.adminUsernames.add(this.bootstrap);
    }

    if (fs.existsSync(ADMIN_LIST_FILE)) {
      try {
        const fileData = JSON.parse(fs.readFileSync(ADMIN_LIST_FILE, "utf-8"));
        if (Array.isArray(fileData)) {
          fileData.forEach((u: string) => {
            const formatted = u.toLowerCase().trim();
            this.adminUsernames.add(formatted.startsWith("@") ? formatted : `@${formatted}`);
          });
        }
      } catch (e) {
        console.error("[AdminManager] Error reading admin_list.json:", e);
      }
    } else {
      this.saveAdmins();
    }
  }

  private saveAdmins() {
    try {
      fs.writeFileSync(ADMIN_LIST_FILE, JSON.stringify(Array.from(this.adminUsernames), null, 2));
    } catch (e) {
      // Not fatal: the bootstrap administrator comes from configuration and is
      // held in memory, so approvals still work. But the list will not survive
      // a restart, and a stack trace here reads like a crash — say plainly
      // what is wrong and what to do about it.
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") {
        console.error(
          `[AdminManager] Нет прав на запись в ${ADMIN_LIST_FILE}.\n` +
            `  Список админов, добавленных через /set_admin, не сохранится после перезапуска.\n` +
            `  Проверьте владельца тома: docker compose exec hcg_bot ls -la /app/data`
        );
      } else {
        console.error(
          `[AdminManager] Не удалось сохранить admin_list.json: ${(e as Error)?.message || e}`
        );
      }
    }
  }

  public reloadAdmins() {
    this.adminUsernames.clear();
    this.loadAdmins();
  }

  public isAdmin(username?: string): boolean {
    if (!username) return false;
    return this.adminUsernames.has(formatHandle(username));
  }

  public isValidHandle(username: string): boolean {
    return /^@[a-z0-9_]{5,32}$/.test(formatHandle(username));
  }

  public addAdmin(username: string): boolean {
    if (!this.isValidHandle(username)) return false;
    this.adminUsernames.add(formatHandle(username));
    this.saveAdmins();
    return true;
  }

  public removeAdmin(username: string): "removed" | "missing" | "bootstrap" {
    const withAt = formatHandle(username);
    if (this.bootstrap && withAt === this.bootstrap) return "bootstrap";
    if (!this.adminUsernames.has(withAt)) return "missing";
    this.adminUsernames.delete(withAt);
    this.saveAdmins();
    return "removed";
  }

  public getAdmins(): string[] {
    return Array.from(this.adminUsernames);
  }

  public describeAdmins(): string {
    return this.getAdmins()
      .map((h) => (this.bootstrap && h === this.bootstrap ? `${h} (основной, из .env)` : h))
      .join("\n");
  }

  public middleware() {
    return (ctx: Context, next: () => Promise<void>) => {
      const username = ctx.from?.username;
      if (this.isAdmin(username)) {
        return next();
      }
      return ctx.reply("⛔ У вас нет прав администратора для выполнения этой команды.");
    };
  }
}
