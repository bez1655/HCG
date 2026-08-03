#!/usr/bin/env bash
#
# HCG — standalone check: .env sanity + live deployment verification.
#
# Self-contained on purpose: needs only bash + curl, no npm scripts and no
# files from the repository. Safe to run on a live server — it reads .env,
# never writes to it, and never prints a secret value.
#
#   bash hcg-check.sh [base-url]      # default http://127.0.0.1:3001
#
set -uo pipefail

BASE="${1:-http://127.0.0.1:3001}"
FAIL=0
WARN=0

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; [ $# -gt 1 ] && printf "      %s\n" "$2"; FAIL=$((FAIL+1)); }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; [ $# -gt 1 ] && printf "      %s\n" "$2"; WARN=$((WARN+1)); }

echo
echo "════ HCG deployment check ════"

# ---------------------------------------------------------------- .env ------
echo
echo "=== 1. .env ==="

if [ ! -f .env ]; then
  bad ".env not found in $(pwd)" "Run this from the directory holding docker-compose.yml."
else
  ok ".env found"

  MODE=$(stat -c "%a" .env 2>/dev/null || echo "?")
  [ "$MODE" = "600" ] && ok "permissions 600" \
                      || warn "permissions $MODE" "Tighten: chmod 600 .env"

  # Read without executing: values may contain characters the shell would eat.
  getval() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//'; }

  AH=$(getval ADMIN_PASSWORD_HASH)
  SS=$(getval SESSION_SECRET)
  IS=$(getval INTERNAL_API_SECRET)
  SA=$(getval FIREBASE_SERVICE_ACCOUNT)
  GAC=$(getval GOOGLE_APPLICATION_CREDENTIALS)
  DBID=$(getval FIREBASE_FIRESTORE_DATABASE_ID)
  LEGACY=$(getval LEGACY_AES_PASSWORD)
  WURL=$(getval WEB_APP_URL)
  NENV=$(getval NODE_ENV)
  BOT=$(getval TELEGRAM_BOT_TOKEN)
  TADM=$(getval TELEGRAM_ADMIN_USERNAME)

  [ -n "$AH" ] || bad "ADMIN_PASSWORD_HASH is empty"
  [ -n "$SS" ] || bad "SESSION_SECRET is empty"
  [ -n "$IS" ] || bad "INTERNAL_API_SECRET is empty"

  if [ -n "$AH" ]; then
    if printf '%s' "$AH" | grep -qE '^[0-9a-f]{32}:[0-9a-f]{64}$'; then
      ok "ADMIN_PASSWORD_HASH format is valid"
    else
      bad "ADMIN_PASSWORD_HASH is not a salt:hash pair" \
          "Looks like the password itself. Regenerate: npm run hash-password -- '<password>'"
    fi
  fi

  if [ -n "$SS" ] && [ "$SS" = "$IS" ]; then
    bad "SESSION_SECRET equals INTERNAL_API_SECRET" "They must be independent values."
  fi

  # Migration-only knob: leaving it set makes every boot attempt AES decryption.
  if [ -n "$LEGACY" ]; then
    warn "LEGACY_AES_PASSWORD is set" \
         "Only needed once, to migrate pre-audit passwords. Clear it on a fresh install."
  else
    ok "LEGACY_AES_PASSWORD unset (correct for a fresh install)"
  fi

  if [ -n "$SA" ] && [ -n "$GAC" ]; then
    warn "Both FIREBASE_SERVICE_ACCOUNT and GOOGLE_APPLICATION_CREDENTIALS are set" \
         "The inline JSON wins. Keep only one to avoid targeting two projects."
  elif [ -z "$SA" ] && [ -z "$GAC" ]; then
    warn "No service account configured" "Firestore will stay disabled."
  else
    ok "One service-account source configured"
  fi

  if [ -n "$SA" ]; then
    if printf '%s' "$SA" | grep -q '"private_key"'; then
      ok "Service account JSON contains a private key"
    else
      bad "FIREBASE_SERVICE_ACCOUNT has no private_key field" \
          "Wrong file? Use Project settings → Service accounts → Generate new private key."
    fi
    LINES=$(grep -c "^FIREBASE_SERVICE_ACCOUNT" .env 2>/dev/null || echo 0)
    [ "$LINES" = "1" ] && ok "Service account is on a single line" \
                       || bad "FIREBASE_SERVICE_ACCOUNT must be one line"
  fi

  [ -n "$DBID" ] && ok "Firestore database: $DBID" \
                 || warn "FIREBASE_FIRESTORE_DATABASE_ID empty — (default) database will be used"

  [ "$NENV" = "production" ] && ok "NODE_ENV=production" \
                             || warn "NODE_ENV=\"${NENV:-unset}\"" 'Use "production" on a server.'

  if [ -z "$WURL" ]; then
    warn "WEB_APP_URL empty" "CORS will reject browser origins."
  elif printf '%s' "$WURL" | grep -qE '^https?://'; then
    ok "WEB_APP_URL=$WURL"
  else
    bad "WEB_APP_URL needs a scheme: $WURL"
  fi

  if [ -n "$BOT" ] && [ -z "$TADM" ]; then
    bad "Bot token set but TELEGRAM_ADMIN_USERNAME empty" "Nobody would receive approval requests."
  elif [ -n "$TADM" ]; then
    ok "Administrator: $TADM"
  fi
fi

# ----------------------------------------------------------- live check -----
echo
echo "=== 2. Running service ==="

HEALTH=$(curl -s --max-time 10 "$BASE/healthz" 2>/dev/null)
if [ -z "$HEALTH" ]; then
  bad "No response from $BASE/healthz" "Check: docker compose ps && docker compose logs --tail=50 hcg_app"
  echo
  echo "─────────────────────────────────────────"
  printf " \033[31m%d problem(s)\033[0m, %d warning(s)\n\n" "$FAIL" "$WARN"
  exit 1
fi
ok "Responding at $BASE"

FS=$(printf '%s' "$HEALTH" | grep -o '"firestore":"[^"]*"' | cut -d'"' -f4)
case "$FS" in
  connected)      ok "Firestore connected — the service account works" ;;
  disabled)       bad "Firestore DISABLED — state lives only on the container disk" \
                      "Why: docker compose logs hcg_app | grep -i firestore" ;;
  quota-exceeded) warn "Firestore quota exhausted — running on local disk" ;;
  *)              bad "Unexpected Firestore status: ${FS:-none}" ;;
esac

echo
echo "=== 3. Security controls ==="
code() { curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@" 2>/dev/null; }

C=$(code -X POST -H 'Content-Type: application/json' -d '{"username":"@probe_user"}' \
     "$BASE/api/admin/bot-approve-registration")
[ "$C" = "403" ] && ok "Internal API rejects untokened callers (403)" \
                 || bad "Internal API returned $C (expected 403)"

C=$(code "$BASE/metrics")
[ "$C" = "403" ] && ok "Metrics endpoint protected (403)" \
                 || bad "Metrics returned $C (expected 403)"

C=$(code -X POST -H 'Content-Type: application/json' \
     -d '{"name":"adm_hap","password":"bez1655"}' "$BASE/api/login")
[ "$C" = "403" ] && ok "Retired credentials rejected (403)" \
                 || bad "Old credentials returned $C (expected 403)"

curl -s -D - -o /dev/null --max-time 10 "$BASE/healthz" 2>/dev/null \
  | grep -qi "content-security-policy" \
  && ok "Security headers present" || bad "CSP header missing"

curl -s --max-time 10 "$BASE/api/state" 2>/dev/null | grep -q "telegramId" \
  && bad "Public state leaks telegramId" || ok "Public state omits personal identifiers"

# ------------------------------------------------------- write round-trip ---
echo
echo "=== 4. Firestore round-trip ==="
if [ -z "${IS:-}" ]; then
  warn "INTERNAL_API_SECRET unavailable — skipping write test"
elif [ "$FS" != "connected" ]; then
  warn "Skipping: Firestore is not connected"
else
  PROBE="@verify_$(date +%s)"
  RESP=$(curl -s --max-time 15 -X POST \
    -H 'Content-Type: application/json' -H "X-Internal-Token: $IS" \
    -d "{\"username\":\"$PROBE\",\"admin\":\"check-script\"}" \
    "$BASE/api/admin/bot-approve-registration" 2>/dev/null)

  if printf '%s' "$RESP" | grep -q '"success":true'; then
    ok "Wrote a probe player"
    sleep 7   # let the debounced Firestore write flush
    curl -s --max-time 10 "$BASE/api/state" | grep -q "$PROBE" \
      && ok "Probe visible in live state" || bad "Probe missing from live state"
    echo
    echo "    Remove this probe player in the admin console: $PROBE"
  else
    bad "Write failed: $(printf '%s' "$RESP" | head -c 120)"
  fi
fi

echo
echo "─────────────────────────────────────────"
if [ "$FAIL" -gt 0 ]; then
  printf " \033[31m%d problem(s)\033[0m, %d warning(s)\n\n" "$FAIL" "$WARN"
  exit 1
fi
printf " \033[32mDeployment verified\033[0m (%d warning(s))\n\n" "$WARN"
