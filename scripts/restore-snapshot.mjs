#!/usr/bin/env node
/**
 * Restore game state from a snapshot.
 *
 *   npm run restore -- --list
 *   npm run restore -- --file data/snapshots/2026-07-28T10-00-00_scheduled.json
 *   npm run restore -- --latest
 *
 * Writes the persisted files that the server reads on boot. Stop the server
 * first — it keeps state in memory and would overwrite the restored files.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const arg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};

const DATA_DIR = process.env.DATA_DIR || "./data";
const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");

function listSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs
    .readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
}

if (has("list") || args.length === 0) {
  const files = listSnapshots();
  if (files.length === 0) {
    console.log(`\nNo snapshots in ${SNAPSHOT_DIR}\n`);
    process.exit(0);
  }
  console.log(`\nSnapshots in ${SNAPSHOT_DIR}:\n`);
  for (const f of files) {
    const full = path.join(SNAPSHOT_DIR, f);
    let summary;
    try {
      const d = JSON.parse(fs.readFileSync(full, "utf8"));
      summary = `${d.gameState?.players?.length ?? "?"} players, reason: ${d.reason ?? "?"}`;
    } catch {
      summary = "unreadable";
    }
    console.log(`  ${f}\n      ${summary}`);
  }
  console.log(
    `\nRestore with:\n  npm run restore -- --file ${path.join(SNAPSHOT_DIR, files[0])}\n`
  );
  process.exit(0);
}

let target = arg("file");
if (has("latest")) {
  const files = listSnapshots();
  if (files.length === 0) {
    console.error("No snapshots available.");
    process.exit(1);
  }
  target = path.join(SNAPSHOT_DIR, files[0]);
}

if (!target) {
  console.error("Specify --file <path>, --latest, or --list.");
  process.exit(1);
}
if (!fs.existsSync(target)) {
  console.error(`Snapshot not found: ${target}`);
  process.exit(1);
}

let snapshot;
try {
  snapshot = JSON.parse(fs.readFileSync(target, "utf8"));
} catch (err) {
  console.error(`Snapshot is not valid JSON: ${err.message}`);
  process.exit(1);
}

if (!snapshot.gameState || !Array.isArray(snapshot.gameState.players)) {
  console.error("Snapshot does not contain a usable gameState.");
  process.exit(1);
}

const STATE_FILE = path.join(DATA_DIR, "game-state-persistent.json");
const AUTH_FILE = path.join(DATA_DIR, "game-auth-persistent.json");
const CAL_FILE = path.join(DATA_DIR, "game-calibration-persistent.json");

// Preserve whatever is there now, so a wrong restore is itself reversible.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const f of [STATE_FILE, AUTH_FILE, CAL_FILE]) {
  if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.${stamp}.pre-restore`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot.gameState, null, 2), "utf-8");
fs.writeFileSync(AUTH_FILE, JSON.stringify(snapshot.authPasswords ?? {}, null, 2), "utf-8");
if (snapshot.cellCalibration) {
  fs.writeFileSync(CAL_FILE, JSON.stringify(snapshot.cellCalibration, null, 2), "utf-8");
}

console.log(`
✅ Restored from ${path.basename(target)}

   players : ${snapshot.gameState.players.length}
   created : ${snapshot.createdAt ?? "unknown"}
   reason  : ${snapshot.reason ?? "unknown"}

   Previous files kept as *.${stamp}.pre-restore

Restart the server to load the restored state.
Note: if Firestore is enabled it is the source of truth on boot — clear the
remote documents first, or the restored local files will be overwritten.
`);
