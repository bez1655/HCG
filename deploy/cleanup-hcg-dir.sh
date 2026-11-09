#!/usr/bin/env bash
# =============================================================================
#  Убрать из рабочей папки HCG старые инструкции и лишние скрипты.
#  Код игры, docker, public, bot, .env — не трогаем.
#  Запуск: bash deploy/ОЧИСТКА-ПАПКИ-HCG.sh
#           (каталог = родитель этой папки deploy, или $HCG_DIR / $TARGET)
# =============================================================================
set -uo pipefail

G=$'\e[32m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }

ROOT="${1:-}"
if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fi

echo
echo "${B}Очистка папки проекта: $ROOT${N}"

[ -f "$ROOT/package.json" ] || [ -f "$ROOT/docker-compose.yml" ] || {
  echo "  это не каталог HCG — пропуск"
  exit 0
}

# Never delete live secrets or the game itself.
KEEP_HINT=".env docker-compose.yml Dockerfile server.ts src bot public package.json"

rm_if() {
  local p
  for p in "$@"; do
    if [ -e "$p" ]; then
      rm -rf "$p"
      ok "удалено: ${p#$ROOT/}"
    fi
  done
}

# Garbled unzip names (Windows/cp437) and note files.
find "$ROOT" -maxdepth 2 \( -name '╨*' -o -name '*╤*' \) -print0 2>/dev/null \
  | while IFS= read -r -d '' f; do
      rm -rf "$f"
      ok "мусорное имя: ${f#$ROOT/}"
    done

rm_if \
  "$ROOT/ИНСТРУКЦИЯ.md" \
  "$ROOT/НАЧНИТЕ-ОТСЮДА.md" \
  "$ROOT/ПЛАН-РАЗВИТИЯ.md" \
  "$ROOT/ПРОМПТЫ-DARK-MARKET.md" \
  "$ROOT/ПРОМПТЫ-НЕОН-2027.md" \
  "$ROOT/СТАБИЛЬНО.md" \
  "$ROOT/ИСТОРИЯ.md" \
  "$ROOT/ИСТОРИЯ-инфографика.png" \
  "$ROOT/ПЕРВОЕ-СООБЩЕНИЕ.md" \
  "$ROOT/ЧИТАЙ-МЕНЯ.md" \
  "$ROOT/РЕЛИЗ-2026-10-27.1.md" \
  "$ROOT/ОТЧЁТ-ЗАКАЗЧИКУ-2026-10-27.png" \
  "$ROOT/СМЕНА-АДМИНА.sh" \
  "$ROOT/env.example.txt" \
  "$ROOT/docs" \
  "$ROOT/termux" \
  "$ROOT/scripts/infographic"

# Extra deploy helpers — live ops keep ВСЁ-НА-VPS, 1/2/3, check, this cleaner.
rm_if \
  "$ROOT/deploy/СНЯТЬ-СО-СТАРОГО.sh" \
  "$ROOT/deploy/ПОСТАВИТЬ-НА-НОВЫЙ.sh" \
  "$ROOT/deploy/ПРОКСИ.sh" \
  "$ROOT/deploy/БЕЗ-ПРОКСИ.sh" \
  "$ROOT/deploy/VPS.sh" \
  "$ROOT/deploy/СМЕНА-ДОМЕНА.md" \
  "$ROOT/deploy/СМЕНА-АДМИНА.sh" \
  "$ROOT/deploy/VPS.sh"

echo "  оставлено: код, docker, public, bot, $KEEP_HINT"
echo
ok "папка подчищена"
echo
