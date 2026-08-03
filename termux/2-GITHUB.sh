#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
#  HCG — отправить проект в GitHub, из Termux
# =============================================================================
#  Где запускать: Termux на телефоне
#  Как:  bash termux/2-GITHUB.sh
#
#  Что делает:
#    • ставит git, если его нет
#    • создаёт чистый репозиторий (история начинается с нуля — в старой
#      лежали утёкшие токен бота и ключ Firebase)
#    • проверяет, что в коммит не попали секреты
#    • отправляет код
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }
die()  { echo; echo "${R}${B}ОСТАНОВЛЕНО: $*${N}"; echo; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || die "не удалось перейти в каталог проекта"

echo "${B}╔════════════════════════════════════════════╗${N}"
echo "${B}║  HCG — отправка в GitHub из Termux         ║${N}"
echo "${B}╚════════════════════════════════════════════╝${N}"
echo "  Проект: $ROOT"

# ---------------------------------------------------------------------------
hdr "1/5  Проверка окружения"
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "  Ставлю git..."
  pkg install -y git >/dev/null 2>&1 || die "не удалось установить git"
fi
ok "$(git --version)"

[ -f package.json ] || die "здесь нет package.json — вы не в каталоге проекта"
ok "файлы проекта на месте"

# ---------------------------------------------------------------------------
hdr "2/5  Адрес репозитория"
# ---------------------------------------------------------------------------
echo "  Если репозитория ещё нет — создайте его в браузере телефона:"
echo "      ${C}https://github.com/new${N}"
echo "      имя: HCG-Production, видимость: Private,"
echo "      галочки README / .gitignore / license ${Y}НЕ ставить${N}"
echo

printf "  Адрес репозитория: "
read -r REPO
REPO="$(echo "$REPO" | tr -d ' ')"

case "$REPO" in
  https://github.com/*/*.git) ;;
  https://github.com/*/*)     REPO="${REPO}.git"; ok "добавил .git: $REPO" ;;
  *) die "адрес не похож на репозиторий GitHub" ;;
esac

# ---------------------------------------------------------------------------
hdr "3/5  Подготовка репозитория"
# ---------------------------------------------------------------------------
if [ -d .git ]; then
  ok "репозиторий уже создан"
else
  git init -q -b main
  ok "создан новый репозиторий (ветка main)"
fi

git config user.name  >/dev/null 2>&1 || git config user.name  "HCG"
git config user.email >/dev/null 2>&1 || git config user.email "hcg@localhost"
git config core.hooksPath .githooks 2>/dev/null
ok "подпись и проверка секретов настроены"

# Права на скриптах теряются при копировании через облако и мессенджеры.
[ -f scripts/fix-permissions.sh ] && bash scripts/fix-permissions.sh >/dev/null 2>&1

# ---------------------------------------------------------------------------
hdr "4/5  Коммит"
# ---------------------------------------------------------------------------
git add -A

STAGED="$(git diff --cached --name-only)"
if [ -z "$STAGED" ]; then
  ok "изменений нет — всё уже сохранено"
else
  COUNT="$(echo "$STAGED" | wc -l | tr -d ' ')"
  echo "  файлов к отправке: $COUNT"

  # Секрет, попавший в коммит, remove-ить из истории потом дорого.
  DANGER="$(echo "$STAGED" | grep -E '(^|/)\.env$|serviceAccount|credentials|\.pem$|\.key$' || true)"
  if [ -n "$DANGER" ]; then
    bad "в коммит попали файлы с секретами:"
    echo "$DANGER" | sed 's/^/        /'
    die "проверьте .gitignore"
  fi
  ok "секретных файлов среди них нет"

  if git rev-parse HEAD >/dev/null 2>&1; then
    MSG="update: $(date '+%Y-%m-%d %H:%M')"
  else
    MSG="HCG Production — Hapstore Cyberpunk Board Quest"
  fi
  git commit -q -m "$MSG" || die "не удалось создать коммит"
  ok "коммит создан"
fi

# ---------------------------------------------------------------------------
hdr "5/5  Отправка"
# ---------------------------------------------------------------------------
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO"
else
  git remote add origin "$REPO"
fi
ok "адрес репозитория настроен"

echo
echo "  ${Y}GitHub попросит логин и пароль.${N}"
echo "  ${Y}В поле пароля вводится НЕ пароль от аккаунта, а токен доступа.${N}"
echo "  Где взять: https://github.com/settings/tokens?type=beta"
echo "  Права токена: Contents → Read and write"
echo

if git push -u origin main; then
  echo
  echo "${G}${B}╔════════════════════════════════════════════╗${N}"
  echo "${G}${B}║  ГОТОВО. Код на GitHub.                    ║${N}"
  echo "${G}${B}╚════════════════════════════════════════════╝${N}"
  echo
  echo "  Включите защиту (один раз, в браузере):"
  echo "    Settings → Code security → Secret scanning: Enable"
  echo "                             → Push protection:  Enable"
  echo
else
  echo
  bad "отправка не удалась"
  echo
  echo "  Частые причины:"
  echo "    • введён пароль вместо токена;"
  echo "    • репозиторий создан с README — удалите и создайте пустой;"
  echo "    • у токена нет права Contents: Read and write."
  exit 1
fi
