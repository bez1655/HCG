#!/usr/bin/env bash
#
# Pre-flight check for the deployment host.
# Run it in the directory that holds docker-compose.yml, BEFORE `docker compose up`.
#
#   bash scripts/check-deployment.sh
#
set -uo pipefail

FAIL=0
WARN=0

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; WARN=$((WARN+1)); }

echo
echo "=== 1. Location ==="

if [ ! -f docker-compose.yml ]; then
  bad "docker-compose.yml not found. Run this from the project directory on the server."
  echo
  exit 1
fi
ok "docker-compose.yml found in $(pwd)"

if [ ! -f .env ]; then
  bad ".env not found. Compose reads it from this exact directory."
  echo
  echo "    Create it with:"
  echo "      npm run setup-env -- --password '<admin-password>' \\"
  echo "                           --service-account ./service-account.json"
  echo
  exit 1
fi
ok ".env found next to docker-compose.yml"

PERMS=$(stat -c "%a" .env 2>/dev/null || stat -f "%A" .env 2>/dev/null)
if [ "$PERMS" = "600" ]; then
  ok ".env permissions are 600"
else
  warn ".env permissions are $PERMS — tighten with: chmod 600 .env"
fi

echo
echo "=== 2. Required secrets ==="

# shellcheck disable=SC1091
set -a; . ./.env 2>/dev/null; set +a

for var in ADMIN_PASSWORD_HASH SESSION_SECRET INTERNAL_API_SECRET; do
  value="${!var:-}"
  if [ -z "$value" ]; then
    bad "$var is empty — the container will refuse to start"
  else
    ok "$var is set"
  fi
done

if [ -n "${ADMIN_PASSWORD_HASH:-}" ]; then
  if printf '%s' "$ADMIN_PASSWORD_HASH" | grep -qE '^[0-9a-f]{32}:[0-9a-f]{64}$'; then
    ok "ADMIN_PASSWORD_HASH has the expected salt:hash format"
  else
    bad "ADMIN_PASSWORD_HASH is malformed — regenerate with: npm run hash-password"
  fi
fi

echo
echo "=== 3. Firestore credential ==="

if [ -n "${FIREBASE_SERVICE_ACCOUNT:-}" ]; then
  if printf '%s' "$FIREBASE_SERVICE_ACCOUNT" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception as e:
    print('INVALID_JSON'); sys.exit()
missing = [k for k in ('type','project_id','private_key','client_email') if k not in d]
print('MISSING:' + ','.join(missing) if missing else 'OK:' + d['project_id'])
" > /tmp/_sa_check 2>/dev/null; then
    result=$(cat /tmp/_sa_check)
    case "$result" in
      OK:*)      ok "FIREBASE_SERVICE_ACCOUNT is a valid key (project: ${result#OK:})" ;;
      MISSING:*) bad "FIREBASE_SERVICE_ACCOUNT is missing fields: ${result#MISSING:}" ;;
      *)         bad "FIREBASE_SERVICE_ACCOUNT is not valid JSON (check the quoting)" ;;
    esac
  fi
  rm -f /tmp/_sa_check

  LINES=$(grep -c '^FIREBASE_SERVICE_ACCOUNT' .env 2>/dev/null || echo 0)
  if [ "$LINES" -eq 1 ]; then
    ok "FIREBASE_SERVICE_ACCOUNT occupies a single line"
  else
    warn "FIREBASE_SERVICE_ACCOUNT should be exactly one line in .env"
  fi
elif [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  ok "GOOGLE_APPLICATION_CREDENTIALS=$GOOGLE_APPLICATION_CREDENTIALS"
  if grep -qE '^\s*-\s*\./.*service-account.*:ro' docker-compose.yml; then
    ok "A read-only volume mount for the key is enabled"
  else
    bad "The key path is set but no volume mounts it into the container."
    echo "      Uncomment this line under hcg_app.volumes in docker-compose.yml:"
    echo "        - ./service-account.json:/run/secrets/service-account.json:ro"
  fi
else
  warn "No Firestore credential — the app will run on local disk persistence only"
fi

if [ -z "${FIREBASE_FIRESTORE_DATABASE_ID:-}" ]; then
  warn "FIREBASE_FIRESTORE_DATABASE_ID is empty — the (default) database will be used"
else
  ok "Firestore database: $FIREBASE_FIRESTORE_DATABASE_ID"
fi

echo
echo "=== 4. Telegram ==="
[ -n "${TELEGRAM_BOT_TOKEN:-}" ]      && ok "TELEGRAM_BOT_TOKEN is set"      || warn "TELEGRAM_BOT_TOKEN is empty — Telegram features stay off"
[ -n "${TELEGRAM_ADMIN_USERNAME:-}" ] && ok "TELEGRAM_ADMIN_USERNAME=$TELEGRAM_ADMIN_USERNAME" || warn "TELEGRAM_ADMIN_USERNAME is empty — approvals cannot be delivered"
[ -n "${WEB_APP_URL:-}" ]             && ok "WEB_APP_URL=$WEB_APP_URL"       || warn "WEB_APP_URL is empty — CORS will reject browser origins"

echo
echo "=== 5. Git hygiene ==="
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git check-ignore -q .env 2>/dev/null; then
    ok ".env is ignored by git"
  else
    bad ".env is NOT ignored by git — it could be committed"
  fi
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    bad ".env is TRACKED by git. Remove it: git rm --cached .env"
  else
    ok ".env is not tracked"
  fi
else
  ok "Not a git repository (deployment copy)"
fi

echo
echo "=== 6. Compose interpolation ==="
if command -v docker >/dev/null 2>&1; then
  if docker compose config >/dev/null 2>&1; then
    ok "docker compose config resolves without errors"
  else
    bad "docker compose config failed — see: docker compose config"
  fi
else
  warn "docker not found on PATH — skipping compose validation"
fi

echo
echo "─────────────────────────────────────────"
if [ "$FAIL" -gt 0 ]; then
  printf " \033[31m%d problem(s) must be fixed\033[0m, %d warning(s)\n\n" "$FAIL" "$WARN"
  exit 1
fi
printf " \033[32mReady to deploy\033[0m (%d warning(s))\n\n" "$WARN"
echo " Next:"
echo "   docker compose up --build -d"
echo "   curl http://127.0.0.1:3001/healthz"
echo
