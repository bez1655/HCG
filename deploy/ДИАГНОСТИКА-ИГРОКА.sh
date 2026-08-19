#!/usr/bin/env bash
# Сверка клетки игрока: живое состояние, диск, журнал, логи бота.
# На сервере:  bash deploy/ДИАГНОСТИКА-ИГРОКА.sh hapalka228
set -uo pipefail
WHO="${1:-hapalka228}"
WHO="${WHO#@}"
echo "=== игрок @$WHO ==="
docker exec hcg_app node -e '
const fs=require("fs");
const who=process.argv[1].toLowerCase();
const raw=fs.readFileSync("/app/data/game-state-persistent.json","utf8");
const s=JSON.parse(raw);
const p=(s.players||[]).find(x =>
  String(x.name||"").toLowerCase().replace(/^@/,"")===who ||
  String(x.alias||"").toLowerCase()===who ||
  String(x.telegramUsername||"").toLowerCase()===who
);
console.log("revision", s.revision, "updatedAt", s.updatedAt, new Date(s.updatedAt||0).toISOString());
if(!p){ console.log("ИГРОК НЕ НАЙДЕН в файле"); process.exit(0); }
console.log(JSON.stringify({
  id:p.id, name:p.name, alias:p.alias, cell:p.cell, lastRoll:p.lastRoll,
  turnsApproved:p.turnsApproved, lastSeenAt:p.lastSeenAt,
  lastSeen: p.lastSeenAt? new Date(p.lastSeenAt).toISOString():null
},null,2));
const logs=(s.logs||[]).filter(l =>
  (l.message||"").includes(p.alias||"___") ||
  (l.message||"").includes(p.name||"___") ||
  /клетк/i.test(l.message||"")
).slice(0,25);
console.log("--- последние записи журнала ---");
for (const l of logs) console.log(l.timestamp, l.type, l.message);
' "$WHO"
echo
echo "=== docker logs hcg_app (ходы) ==="
docker logs hcg_app --since 48h 2>&1 | grep -iE "hapalka|$WHO|roll:request|Loaded game state" | tail -40
echo
echo "=== docker logs hcg_bot ==="
docker logs hcg_bot --since 48h 2>&1 | grep -iE "hapalka|$WHO|direct|BOT_USE_PROXY|build " | tail -20
