import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatWorkingProxies, listWorkingProxies } from "./workingProxies.js";

describe("listWorkingProxies", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hcg-px-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty list when the harvester file is missing", () => {
    expect(listWorkingProxies(dir)).toEqual([]);
  });

  it("returns only addresses that answered on the last check", () => {
    fs.writeFileSync(
      path.join(dir, "proxies.json"),
      JSON.stringify({
        proxies: [
          { address: "1.1.1.1:1080", protocol: "socks5", latencyMs: 80, strikes: 0, lastOk: "x" },
          { address: "2.2.2.2:1080", protocol: "socks5", latencyMs: 20, strikes: 2, lastOk: "x" },
          { address: "3.3.3.3:8080", protocol: "http", latencyMs: 40, strikes: 0, lastOk: "x" },
        ],
      })
    );

    const list = listWorkingProxies(dir);
    expect(list.map((p) => p.url)).toEqual(["http://3.3.3.3:8080", "socks5://1.1.1.1:1080"]);
    expect(list[0].latencyMs).toBe(40);
  });

  it("says so in the admin message when nothing is live", () => {
    expect(formatWorkingProxies([])).toMatch(/Рабочих прокси нет/);
  });
});
