#!/bin/bash
# Switch bootstrap Telegram admin to @bez_adm1 (old account is gone).
# Run ON THE VPS, in the live project directory (usually /var/www/hcg).
set -euo pipefail
NEW="@bez_adm1"
ROOT="${1:-/var/www/hcg}"
ENV="$ROOT/.env"

if [ ! -f "$ENV" ]; then
  echo "Нет файла $ENV"
  echo "Запуск: bash СМЕНА-АДМИНА.sh /путь/к/hcg"
  exit 1
fi

cp -a "$ENV" "$ENV.bak-admin-$(date +%Y%m%d-%H%M%S)"

if grep -q '^TELEGRAM_ADMIN_USERNAME=' "$ENV"; then
  sed -i "s|^TELEGRAM_ADMIN_USERNAME=.*|TELEGRAM_ADMIN_USERNAME=${NEW}|" "$ENV"
else
  printf '\nTELEGRAM_ADMIN_USERNAME=%s\n' "$NEW" >> "$ENV"
fi

echo "Сейчас в .env:"
grep '^TELEGRAM_ADMIN_USERNAME=' "$ENV"

cd "$ROOT"
docker compose up -d --force-recreate hcg_app hcg_bot
echo "Готово. С аккаунта ${NEW} напишите боту /start и нажмите ИГРАТЬ."
