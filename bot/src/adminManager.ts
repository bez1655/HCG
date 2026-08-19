import fs from "fs";
import path from "path";
import { Context } from "telegraf";
import { config } from "./config.js";

const ADMIN_LIST_FILE = path.join(config.dataDir, "admin_list.json");

export class AdminManager {
  private adminUsernames: Set<string> = new Set();

  constructor() {
    this.loadAdmins();
  }

  private loadAdmins() {
    // Bootstrap administrator comes from configuration only. Hardcoding a
    // personal handle previously granted that account admin rights in every
    // copy of this source and exposed the identity publicly.
    const envAdmin = config.adminUsername?.toLowerCase().trim();
    if (envAdmin) {
      this.adminUsernames.add(envAdmin.startsWith("@") ? envAdmin : `@${envAdmin}`);
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
    const formatted = username.toLowerCase().trim();
    const withAt = formatted.startsWith("@") ? formatted : `@${formatted}`;
    return this.adminUsernames.has(withAt);
  }

  public addAdmin(username: string): boolean {
    const formatted = username.toLowerCase().trim();
    const withAt = formatted.startsWith("@") ? formatted : `@${formatted}`;
    this.adminUsernames.add(withAt);
    this.saveAdmins();
    return true;
  }

  public removeAdmin(username: string): boolean {
    const formatted = username.toLowerCase().trim();
    const withAt = formatted.startsWith("@") ? formatted : `@${formatted}`;
    const result = this.adminUsernames.delete(withAt);
    this.saveAdmins();
    return result;
  }

  public getAdmins(): string[] {
    return Array.from(this.adminUsernames);
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
