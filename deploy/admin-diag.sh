#!/usr/bin/env bash
# HCG admin diagnostic: repeats cell move + turn approval against the live
# server and writes a full log. No secrets are printed.
# Run on the VPS (PuTTY, root):
#   bash admin-diag.sh
# Or non-interactive:
#   bash admin-diag.sh <playerId> <cell> <turns>

set -uo pipefail

TARGET="${HCG_DIR:-/var/www/hcg}"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="/root/hcg-admin-diag-$STAMP.log"

exec > >(tee -a "$LOG") 2>&1

echo "=================================================="
echo " HCG admin diagnostic  $(date -Is)"
echo " target: $TARGET"
echo " log:    $LOG"
echo "=================================================="

say() { echo; echo "---- $* ----"; }

say "1. Containers"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' 2>&1 || true
(cd "$TARGET" && docker compose ps) 2>&1 || true

say "2. Build markers in logs"
docker logs hcg_app 2>&1 | grep -i "build" | tail -5 || true
docker logs hcg_bot 2>&1 | grep -i "build" | tail -5 || true

say "3. Health"
curl -s -m 5 -w "\nHTTP:%{http_code}\n" http://127.0.0.1:3001/healthz || echo "healthz FAILED"

say "4. Env presence (values not printed)"
docker exec hcg_app sh -c '
  for k in SESSION_SECRET TELEGRAM_BOT_TOKEN TELEGRAM_ADMIN_USERNAME WEB_APP_URL; do
    v="$(printenv "$k" || true)"
    if [ -n "$v" ]; then echo "$k=set"; else echo "$k=MISSING"; fi
  done
  echo "TELEGRAM_ADMIN_USERNAME=$(printenv TELEGRAM_ADMIN_USERNAME || true)"
' 2>&1 || echo "docker exec FAILED"

say "5. Players (public state)"
PLAYERS_JSON="$(curl -s -m 8 http://127.0.0.1:3001/api/state || echo '{}')"
echo "$PLAYERS_JSON" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    try {
      const j=JSON.parse(s||"{}");
      const ps=j.players||[];
      if(!ps.length){ console.log("(no players)"); return; }
      ps.forEach((p,i)=>console.log(`${i+1}. id=${p.id} name=${p.name} cell=${p.cell} turns=${p.turnsApproved ?? "-"} role=${p.role}`));
    } catch(e){ console.log("state parse failed:", String(e)); }
  });
'

PLAYER_ID="${1:-}"
CELL="${2:-}"
TURNS="${3:-1}"

if [ -z "$PLAYER_ID" ]; then
  echo
  printf "Player number or id from the list above: "
  read -r INPUT < /dev/tty
  PLAYER_ID="$(echo "$PLAYERS_JSON" | INPUT="$INPUT" node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const inp=(process.env.INPUT||"").trim();
      try {
        const ps=(JSON.parse(s||"{}").players)||[];
        const n=parseInt(inp,10);
        if(Number.isFinite(n) && String(n)===inp && ps[n-1]) console.log(ps[n-1].id);
        else console.log(inp);
      } catch { console.log(inp); }
    });
  ')" 
fi
if [ -z "$CELL" ]; then
  printf "Target cell (0-64): "
  read -r CELL < /dev/tty
fi
printf "Turns to approve (default 1): "
if [ -z "${3:-}" ]; then
  read -r TURNS < /dev/tty
  TURNS="${TURNS:-1}"
fi

echo "playerId=$PLAYER_ID cell=$CELL turns=$TURNS"

say "6. Mint admin session inside container (token not printed)"
TOKEN="$(docker exec hcg_app node -e '
  const c=require("crypto");
  const s=process.env.SESSION_SECRET;
  if(!s){ console.error("NO_SESSION_SECRET"); process.exit(2); }
  const p={sub:"admin_user",role:"admin",exp:Date.now()+3600000};
  const b=Buffer.from(JSON.stringify(p)).toString("base64url");
  const sig=c.createHmac("sha256",s).update(b).digest("base64url");
  console.log(b+"."+sig);
' 2>/tmp/hcg-diag-token.err || true)"
if [ -z "$TOKEN" ]; then
  echo "TOKEN MINT FAILED:"
  cat /tmp/hcg-diag-token.err || true
  echo
  echo "LOG READY: $LOG"
  exit 1
fi
echo "token minted: yes (hidden)"

api_post() {
  local path="$1" body="$2"
  echo
  echo "POST $path  body=$(echo "$body" | sed -E 's/"token":"[^"]+"/"token":"***"/g')"
  curl -s -m 10 -w "\nHTTP:%{http_code}\n" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$body" \
    "http://127.0.0.1:3001$path" || echo "curl FAILED"
}

say "7. ACTION: move player cell"
api_post "/api/admin/set-player-cell" "{\"playerId\":\"$PLAYER_ID\",\"cell\":$CELL,\"token\":\"$TOKEN\"}"

say "8. ACTION: approve turns"
api_post "/api/admin/approve-turn" "{\"playerId\":\"$PLAYER_ID\",\"turns\":$TURNS,\"confirmBonusUse\":false,\"token\":\"$TOKEN\"}"

say "9. Read back state for this player"
curl -s -m 8 http://127.0.0.1:3001/api/state | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const want=process.argv[1];
    try {
      const ps=(JSON.parse(s||"{}").players)||[];
      const p=ps.find(x=>x.id===want)||ps.find(x=>x.name===want);
      console.log(p ? JSON.stringify(p,null,2) : "PLAYER NOT FOUND IN STATE");
    } catch(e){ console.log("parse failed", String(e)); }
  });
' "$PLAYER_ID"

say "10. Last server logs"
docker logs --tail 80 hcg_app 2>&1 | tail -80

echo
echo "=================================================="
echo " DONE. Send this file back: $LOG"
echo "=================================================="
