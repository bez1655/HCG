/**
 * Read the harvester's live list so an administrator can copy a working
 * address without digging through the volume.
 */
import fs from "node:fs";
import path from "node:path";

export interface WorkingProxy {
  url: string;
  address: string;
  protocol: string;
  latencyMs: number | null;
  source: string;
}

export function listWorkingProxies(dataDir: string, limit = 8): WorkingProxy[] {
  const file = path.join(dataDir, "proxies.json");
  if (!fs.existsSync(file)) return [];

  let parsed: {
    proxies?: Array<{
      address?: string;
      protocol?: string;
      latencyMs?: number;
      strikes?: number;
      lastOk?: string | null;
      issuedTo?: string;
      source?: string;
    }>;
  };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed.proxies) ? parsed.proxies : [];
  const live = rows
    .filter(
      (p) =>
        typeof p.address === "string" &&
        p.address.includes(":") &&
        (p.strikes ?? 0) === 0 &&
        p.lastOk
    )
    .sort((a, b) => (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9))
    .slice(0, Math.max(1, limit));

  return live.map((p) => {
    const protocol = p.protocol === "http" ? "http" : "socks5";
    return {
      url: `${protocol}://${p.address}`,
      address: p.address!,
      protocol,
      latencyMs: typeof p.latencyMs === "number" ? p.latencyMs : null,
      source: p.issuedTo ? `выдан ${p.issuedTo}` : (p.source ?? "парсер"),
    };
  });
}

export function formatWorkingProxies(list: WorkingProxy[]): string {
  if (list.length === 0) {
    return (
      "📡 <b>Рабочих прокси нет</b>\n\n" +
      "Парсер ещё не записал список, либо все адреса умерли.\n" +
      "Проверьте: <code>docker compose logs --tail 40 hcg_proxy</code>"
    );
  }

  const lines = list.map((p, i) => {
    const ms = p.latencyMs != null ? `${p.latencyMs} мс` : "—";
    return `${i + 1}. <code>${p.url}</code>\n    ${ms} · ${p.source}`;
  });

  return (
    `📡 <b>Рабочие прокси парсера</b> (${list.length})\n\n` +
    lines.join("\n") +
    "\n\n<i>Нажмите на адрес, чтобы скопировать. Бот сам ходит напрямую — эти адреса для ваших задач.</i>"
  );
}
