import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTelegramAdminHandle, loadTelegramAdminHandles } from "./telegramAdmins";

describe("telegramAdmins", () => {
  it("recognises the bootstrap handle from env", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-adm-"));
    expect(isTelegramAdminHandle("Boss_User", dir, "@boss_user")).toBe(true);
    expect(isTelegramAdminHandle("@other", dir, "@boss_user")).toBe(false);
  });

  it("reads extra handles from admin_list.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-adm-"));
    fs.writeFileSync(path.join(dir, "admin_list.json"), JSON.stringify(["@helper", "Second"]));
    const set = loadTelegramAdminHandles(dir, "@boss");
    expect(set.has("@boss")).toBe(true);
    expect(set.has("@helper")).toBe(true);
    expect(set.has("@second")).toBe(true);
  });
});
