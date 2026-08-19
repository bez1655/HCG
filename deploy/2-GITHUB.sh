#!/usr/bin/env bash
# =============================================================================
#  HCG — отправить проект в GitHub прямо с сервера
# =============================================================================
#  Где запускать: на сервере, в каталоге проекта
#  Как:  bash deploy/2-GITHUB.sh
#
#  Что делает:
#    • ставит git, если его нет
#    • создаёт чистый репозиторий (история с нуля — в старой лежали
#      утёкшие токен бота и ключ Firebase)
#    • проверяет, что в коммит не попали секреты, ДО отправки
#    • отправляет код
#
#  Токен GitHub можно передать заранее, чтобы не вводить руками:
#      GITHUB_TOKEN=github_pat_xxx bash deploy/2-GITHUB.sh
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
echo "${B}║  HCG — отправка в GitHub                   ║${N}"
echo "${B}╚════════════════════════════════════════════╝${N}"
echo "  Проект: $ROOT"

# ---------------------------------------------------------------------------
hdr "1/5  Проверка окружения"
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  echo "  Ставлю git..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q git >/dev/null 2>&1
  fi
  command -v git >/dev/null 2>&1 || die "не удалось установить git"
fi
ok "$(git --version)"

[ -f package.json ] || die "здесь нет package.json — вы не в каталоге проекта"
ok "файлы проекта на месте"

# Права на скриптах теряются при копировании через архивы и облако.
[ -f scripts/fix-permissions.sh ] && bash scripts/fix-permissions.sh >/dev/null 2>&1

# ---------------------------------------------------------------------------
hdr "2/5  Адрес репозитория"
# ---------------------------------------------------------------------------
CFG="$HOME/.hcg-github"

if [ -f "$CFG" ]; then
  # shellcheck disable=SC1090
  . "$CFG"
  ok "сохранённый адрес: ${REPO_URL:-нет}"
  printf "  Использовать его? [Д/н] "
  read -r keep
  case "$keep" in [nNнН]*) REPO_URL="" ;; esac
fi

if [ -z "${REPO_URL:-}" ]; then
  echo
  echo "  Если репозитория ещё нет — создайте его в браузере:"
  echo "      ${C}https://github.com/new${N}"
  echo "      имя: HCG-Production, видимость: Private,"
  echo "      галочки README / .gitignore / license ${Y}НЕ ставить${N}"
  echo
  printf "  Адрес репозитория: "
  read -r REPO_URL
  REPO_URL="$(echo "$REPO_URL" | tr -d ' ')"

  case "$REPO_URL" in
    https://github.com/*/*.git) ;;
    https://github.com/*/*)     REPO_URL="${REPO_URL}.git" ;;
    *) die "адрес не похож на репозиторий GitHub" ;;
  esac

  echo "REPO_URL=$REPO_URL" > "$CFG"
  chmod 600 "$CFG"
fi
ok "репозиторий: $REPO_URL"

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

  # На сервере рядом лежит рабочий .env — попасть в репозиторий он не должен
  # ни при каких обстоятельствах.
  DANGER="$(echo "$STAGED" | grep -E '(^|/)\.env$|serviceAccount|credentials|\.pem$|\.key$|firebase-adminsdk' || true)"
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
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

# С токеном в переменной окружения отправка проходит без вопросов. Токен
# подставляется только в саму команду и в конфиг git не записывается —
# иначе он остался бы в .git/config открытым текстом.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_URL="$(echo "$REPO_URL" | sed "s|https://|https://${GITHUB_TOKEN}@|")"
  echo "  Отправляю (токен взят из GITHUB_TOKEN)..."
  PUSH_TARGET="$AUTH_URL"
else
  echo
  echo "  ${Y}GitHub попросит логин и пароль.${N}"
  echo "  ${Y}В поле пароля вводится НЕ пароль от аккаунта, а токен доступа.${N}"
  echo "  Создать: ${C}https://github.com/settings/tokens?type=beta${N}"
  echo "  Права токена: Contents → Read and write"
  echo
  PUSH_TARGET="origin"
fi

if git push -u "$PUSH_TARGET" main 2>&1 | sed "s|${GITHUB_TOKEN:-НЕТТОКЕНА}|***|g"; then
  # После отправки по URL с токеном возвращаем чистый адрес.
  git remote set-url origin "$REPO_URL"

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
  git remote set-url origin "$REPO_URL"
  echo
  bad "отправка не удалась"
  echo
  echo "  Частые причины:"
  echo "    • введён пароль вместо токена;"
  echo "    • репозиторий создан с README — удалите и создайте пустой;"
  echo "    • у токена нет права Contents: Read and write."
  exit 1
fi
