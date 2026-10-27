#!/usr/bin/env bash
# =============================================================================
#  Восстановить флаг исполняемости на скриптах
# =============================================================================
#  Prettier и некоторые редакторы переписывают файл целиком и теряют права.
#  Для .githooks/pre-commit это особенно неприятно: хук молча перестаёт
#  работать, и проверка на секреты больше не запускается — а узнать об этом
#  можно только когда секрет уже уехал в репозиторий.
#
#  Запуск:  bash scripts/fix-permissions.sh
#  Проверка без изменений:  bash scripts/fix-permissions.sh --check
# =============================================================================

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; N=$'\e[0m'

# Всё, что должно быть исполняемым.
TARGETS=(
  ".githooks/pre-commit"
  "scripts/check-deployment.sh"
  "scripts/verify-deployment.sh"
  "scripts/fix-permissions.sh"
  "scripts/check-env.mjs"
  "scripts/check-secrets.mjs"
  "scripts/hash-password.mjs"
  "scripts/restore-snapshot.mjs"
  "scripts/setup-env.mjs"
  "apk/scripts/build-web.mjs"
  "deploy/1-СЕРВЕР.sh"
  "deploy/2-GITHUB.sh"
  "deploy/3-APK.sh"
  "deploy/ВСЁ-НА-VPS.sh"
  "deploy/hcg-check.sh"
  "deploy/hcg-бот-молчит.sh"
)

# Скрипты добавляются со временем, а список выше — ручной: ПРОКСИ.sh и
# ВСЁ-НА-VPS.sh в него не попали и остались без флага исполняемости.
# Дособираем всё автоматически, чтобы новый скрипт больше никогда
# не оказался забытым.
#
# Auto-collect remaining .sh so a new deploy script is never forgotten.
while IFS= read -r found; do
  case " ${TARGETS[*]} " in
    *" $found "*) ;;
    *) TARGETS+=("$found") ;;
  esac
done < <(find . deploy scripts -maxdepth 1 -name "*.sh" -type f 2>/dev/null | sed 's|^\./||' | sort -u)

BROKEN=0
FIXED=0

for f in "${TARGETS[@]}"; do
  [ -e "$f" ] || continue
  if [ ! -x "$f" ]; then
    BROKEN=$((BROKEN + 1))
    if [ "$CHECK_ONLY" = 1 ]; then
      echo "  ${R}✗${N} не исполняемый: $f"
    else
      chmod +x "$f" && FIXED=$((FIXED + 1))
      echo "  ${G}✓${N} восстановлен: $f"
    fi
  fi
done

if [ "$BROKEN" = 0 ]; then
  echo "  ${G}✓${N} права на всех скриптах в порядке"
  exit 0
fi

if [ "$CHECK_ONLY" = 1 ]; then
  echo
  echo "  ${Y}Исправить:${N} bash scripts/fix-permissions.sh"
  exit 1
fi

echo
echo "  Восстановлено файлов: $FIXED"
exit 0
