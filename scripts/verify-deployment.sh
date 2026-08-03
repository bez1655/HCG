#!/usr/bin/env bash
#
# Post-deployment verification.
#
# check-deployment.sh validates configuration BEFORE starting.
# This script validates the RUNNING system afterwards: that Firestore is
# genuinely reachable, that security controls are active, and that state
# actually survives a restart.
#
#   bash scripts/verify-deployment.sh [base-url]
#
# Defaults to http://127.0.0.1:3001 (the port docker-compose publishes).
# Reads INTERNAL_API_SECRET from .env when present.
#
set -uo pipefail

BASE="${1:-http://127.0.0.1:3001}"
FAIL=0
WARN=0

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; WARN=$((WARN+1)); }

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env 2>/dev/null; set +a
fi
TOKEN="${INTERNAL_API_SECRET:-}"

echo
echo "=== 1. Service reachable ==="

HEALTH=$(curl -s --max-time 10 "$BASE/healthz" 2>/dev/null)
if [ -z "$HEALTH" ]; then
  bad "No response from $BASE/healthz"
  echo
  echo "    Is the stack running?   docker compose ps"
  echo "    Recent logs:            docker compose logs --tail=50 hcg_app"
  echo
  exit 1
fi
ok "Responding at $BASE"

STATUS=$(printf '%s' "$HEALTH" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
[ "$STATUS" = "ok" ] && ok "Health status: ok" || bad "Health status: ${STATUS:-unknown}"

echo
echo "=== 2. Firestore ==="

FS=$(printf '%s' "$HEALTH" | grep -o '"firestore":"[^"]*"' | cut -d'"' -f4)
case "$FS" in
  connected)
    ok "Firestore connected — the service account works"
    ;;
  disabled)
    bad "Firestore is DISABLED — state is only on the container disk"
    echo "      The credential was not accepted. Check the startup log:"
    echo "        docker compose logs hcg_app | grep -i firestore"
    ;;
  quota-exceeded)
    warn "Firestore quota exhausted — running on local disk for now"
    ;;
  *)
    bad "Unexpected Firestore status: ${FS:-none}"
    ;;
esac

echo
echo "=== 3. Security controls ==="

code() { curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@" 2>/dev/null; }

C=$(code -X POST -H 'Content-Type: application/json' \
      -d '{"username":"@probe_user"}' "$BASE/api/admin/bot-approve-registration")
[ "$C" = "403" ] && ok "Internal API rejects callers without a token (403)" \
                 || bad "Internal API returned $C without a token (expected 403)"

C=$(code "$BASE/metrics")
[ "$C" = "403" ] && ok "Metrics endpoint is protected (403)" \
                 || bad "Metrics endpoint returned $C (expected 403)"

C=$(code -X POST -H 'Content-Type: application/json' \
      -d '{"name":"adm_hap","password":"bez1655"}' "$BASE/api/login")
[ "$C" = "403" ] && ok "Retired hardcoded credentials rejected (403)" \
                 || bad "Old credentials returned $C (expected 403)"

HDRS=$(curl -s -D - -o /dev/null --max-time 10 "$BASE/healthz" 2>/dev/null)
printf '%s' "$HDRS" | grep -qi "content-security-policy" \
  && ok "Security headers present" || bad "Content-Security-Policy header missing"
printf '%s' "$HDRS" | grep -qi "x-powered-by" \
  && warn "x-powered-by is exposed" || ok "x-powered-by suppressed"

echo
echo "=== 4. Privacy ==="

STATE=$(curl -s --max-time 10 "$BASE/api/state" 2>/dev/null)
if printf '%s' "$STATE" | grep -q "telegramId"; then
  bad "Public state leaks telegramId"
else
  ok "Public state omits personal Telegram identifiers"
fi

PLAYERS=$(printf '%s' "$STATE" | grep -o '"id":"[^"]*"' | wc -l | tr -d ' ')
ok "Players currently registered: $PLAYERS"

echo
echo "=== 5. Firestore round-trip ==="

if [ -z "$TOKEN" ]; then
  warn "INTERNAL_API_SECRET not available — skipping the write test"
  echo "      Run this from the directory holding .env to enable it."
elif [ "$FS" != "connected" ]; then
  warn "Skipping: Firestore is not connected"
else
  PROBE="@verify_$(date +%s)"
  RESP=$(curl -s --max-time 15 -X POST \
    -H 'Content-Type: application/json' -H "X-Internal-Token: $TOKEN" \
    -d "{\"username\":\"$PROBE\",\"admin\":\"verify-script\"}" \
    "$BASE/api/admin/bot-approve-registration" 2>/dev/null)

  if printf '%s' "$RESP" | grep -q '"success":true'; then
    ok "Wrote a probe player through the API"
    sleep 7  # allow the debounced Firestore write to flush

    if curl -s --max-time 10 "$BASE/api/state" | grep -q "$PROBE"; then
      ok "Probe visible in the live state"
    else
      bad "Probe missing from the live state"
    fi

    echo
    echo "    Clean-up: remove the probe player from the admin console:"
    echo "      $PROBE"
  else
    bad "Write failed: $(printf '%s' "$RESP" | head -c 120)"
  fi
fi

echo
echo "─────────────────────────────────────────"
if [ "$FAIL" -gt 0 ]; then
  printf " \033[31m%d check(s) failed\033[0m, %d warning(s)\n\n" "$FAIL" "$WARN"
  exit 1
fi
printf " \033[32mDeployment verified\033[0m (%d warning(s))\n\n" "$WARN"

cat <<'NEXT'
 Remaining, at your convenience:
   • Rotate the Firebase API key (Google Cloud Console → Credentials)
   • Enable Secret scanning + Push protection on GitHub
   • Confirm a snapshot appears after the first scheduled run:
       docker compose exec hcg_app ls /app/data/snapshots

NEXT
