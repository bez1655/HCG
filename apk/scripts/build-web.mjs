#!/usr/bin/env node
/**
 * Build the web client for the standalone Android app.
 *
 * Deliberately reuses the main project's sources instead of copying them.
 * A second copy of ~5500 lines of UI would drift from the original within
 * days, and the two would quietly disagree about how login works — the kind
 * of divergence nobody notices until a player reports something impossible.
 *
 * The only difference is one build-time variable: VITE_API_BASE_URL. In the
 * browser build the client is served BY the game server, so relative paths
 * work. Inside the APK the page comes from the device, so every request needs
 * an absolute origin.
 *
 * Output goes to apk/www/, which capacitor.config.json points at.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APK = path.resolve(HERE, "..");
const ROOT = path.resolve(APK, "..");
const WWW = path.join(APK, "www");

/** Read apk/.env without pulling in a dependency. */
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = readEnvFile(path.join(APK, ".env"));
const apiBase = (process.env.VITE_API_BASE_URL || fileEnv.VITE_API_BASE_URL || "").trim();

// Fail loudly and early. A build without a server address produces an APK that
// installs, opens, and then cannot reach anything — a failure that is
// expensive to diagnose on a phone and trivial to prevent here.
if (!apiBase) {
  console.error("\n❌ Не задан адрес игрового сервера.\n");
  console.error("   Создайте файл apk/.env со строкой:");
  console.error("       VITE_API_BASE_URL=https://ваш-домен\n");
  console.error("   Пример: VITE_API_BASE_URL=https://hcg.bez12.store\n");
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(apiBase);
} catch {
  console.error(`\n❌ VITE_API_BASE_URL не похож на адрес: "${apiBase}"`);
  console.error("   Ожидается, например: https://hcg.bez12.store\n");
  process.exit(1);
}

// Android blocks cleartext HTTP by default, and the game carries session
// tokens. Refusing http:// here is friendlier than an APK that silently fails
// on every request.
if (parsed.protocol !== "https:") {
  console.error(`\n❌ Адрес должен начинаться с https:// — получено "${parsed.protocol}//"`);
  console.error("   Android блокирует незашифрованные соединения.\n");
  process.exit(1);
}

console.log(`\n▸ Сервер игры: ${apiBase}`);
console.log("▸ Собираю веб-клиент из общих исходников...\n");

fs.rmSync(WWW, { recursive: true, force: true });

execFileSync(
  "npx",
  ["vite", "build", "--outDir", WWW, "--emptyOutDir"],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, VITE_API_BASE_URL: apiBase },
  }
);

// Verify rather than assume: if the origin did not make it into the bundle,
// the APK is broken and this is the last cheap moment to notice.
const assets = path.join(WWW, "assets");
const bundles = fs.existsSync(assets)
  ? fs.readdirSync(assets).filter((f) => f.endsWith(".js"))
  : [];
const baked = bundles.some((f) =>
  fs.readFileSync(path.join(assets, f), "utf8").includes(apiBase)
);

if (!baked) {
  console.error("\n❌ Адрес сервера не попал в сборку. Приложение не заработает.");
  process.exit(1);
}

console.log(`\n✅ Готово: ${path.relative(ROOT, WWW)}`);
console.log(`   Адрес сервера вшит в сборку: ${apiBase}\n`);
