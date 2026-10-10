#!/usr/bin/env bash
# =============================================================================
#  Очистка VPS: оставить HCG, ACG (Ali), Amnezia VPN и сборку APK
# =============================================================================
#
#      bash ОЧИСТКА-СЕРВЕРА.sh              # только показать
#      bash ОЧИСТКА-СЕРВЕРА.sh применить    # спросит ДА, потом удалит
#
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }

WANT_APPLY=0
[ "${1:-}" = "применить" ] || [ "${1:-}" = "apply" ] && WANT_APPLY=1

if [ "$(id -u)" -ne 0 ]; then
  echo; bad "запустите от root:  sudo bash $0 ${1:-}"; echo; exit 1
fi

TO_DELETE=()
TO_WHY=()

add() {
  local p="$1" why="$2"
  [ -e "$p" ] || return 0
  TO_DELETE+=("$p")
  TO_WHY+=("$why")
}

echo
echo "${B}╔══════════════════════════════════════════════════════╗${N}"
echo "${B}║   Очистка сервера (HCG + ACG + VPN + APK)            ║${N}"
echo "${B}╚══════════════════════════════════════════════════════╝${N}"
echo
df -h / | sed 's/^/  /'

hdr "Не трогаем"
cat <<'KEEP'
  /var/www/hcg          игра HCG
  /var/www/ali          игра Али (ACG)
  /var/www/hcg-apk      готовые APK
  тома Docker *hcg* *ali* *hapstore* *amnezia*
  контейнеры hcg_* ali_* amnezia* awg* caddy*
  /etc/caddy, сертификаты, .env
  Android SDK / JDK, если стоят для APK
  ssh, ufw, fail2ban
KEEP

shopt -s nullglob

add /var/www/hcg-new "черновик распаковки HCG"
add /var/www/ali-new "черновик распаковки Али"
add /tmp/hcg-build.log "лог сборки Docker"
add /root/.npm "кэш npm ~гигабайты, Docker свой Node несёт сам"
add /root/.cache "кэш pip/yarn/прочее"
add /root/.aichat-toolchain "инструменты ИИ-чата, к играм и VPN не относятся"
add /root/.nvm "Node на хосте не нужен: HCG/Ali собираются в Docker"
add /usr/src "исходники ядер, для работы игр не нужны"
add /root/.gradle/caches "кэш Gradle (APK потом скачает заново, SDK не трогаем)"

for z in /root/HCG-VPS.zip /root/HCG*.zip /root/hcg*.zip; do
  case "$z" in *amnezia*|*vpn*) continue ;; esac
  add "$z" "старый zip в /root"
done

mapfile -t BACKUPS < <(ls -1d /root/hcg-backup-* /var/www/hcg-backup-* 2>/dev/null | sort)
if [ "${#BACKUPS[@]}" -gt 2 ]; then
  drop=$(( ${#BACKUPS[@]} - 2 ))
  for ((i=0; i<drop; i++)); do
    add "${BACKUPS[$i]}" "старый бэкап HCG (2 свежих остаются)"
  done
fi

hdr "Будет удалено"
if [ "${#TO_DELETE[@]}" -eq 0 ]; then
  ok "лишних папок из списка не найдено"
else
  TOTAL=0
  for i in "${!TO_DELETE[@]}"; do
    p="${TO_DELETE[$i]}"
    sz="$(du -sb "$p" 2>/dev/null | awk '{print $1}')"
    TOTAL=$((TOTAL + ${sz:-0}))
    echo "  ${Y}•${N} $p"
    echo "      ${TO_WHY[$i]}  ($(numfmt --to=iec "${sz:-0}" 2>/dev/null || echo "$sz"))"
  done
  echo
  echo "  вместе примерно: ${B}$(numfmt --to=iec "$TOTAL" 2>/dev/null || echo "$TOTAL")${N}"
fi

hdr "Ещё очистим (Docker / журналы) при «применить»"
echo "  docker builder prune, docker image prune (неиспользуемые образы)"
echo "  docker volume prune — только безымянные, тома hcg/ali не трогает"
echo "  journalctl старше 7 дней, apt clean, старые *.gz в /var/log"
echo "  json-логи контейнеров больше 50 МБ — обнулить"

hdr "Имеет смысл убрать вручную (скрипт не решает за вас)"
cat <<'EXTRA'
  • nginx, если сайт уже на Caddy:   systemctl disable --now nginx
  • apache2 / php / mysql, если не используются
  • snap-пакеты:   snap list
  • nvm и лишний Node на хосте (/root/.nvm) — Docker свой Node несёт сам
  • найти гигантов:   du -xh / --max-depth=2 2>/dev/null | sort -h | tail -25
  • fail2ban и ufw НЕ удалять — это защита SSH
EXTRA

if [ "$WANT_APPLY" != 1 ]; then
  echo
  echo "  Это был ${B}просмотр${N}. Чтобы удалить:"
  echo "      ${B}bash $0 применить${N}"
  echo
  exit 0
fi

echo
printf "  Введите ${B}ДА${N} заглавными буквами: "
read -r ans || ans=""
if [ "$ans" != "ДА" ]; then
  echo; warn "отменено — ничего не удалено"; echo; exit 0
fi

echo
hdr "Удаление"
for p in "${TO_DELETE[@]}"; do
  rm -rf "$p" && ok "нет больше $p" || bad "не удалось $p"
done

if command -v docker >/dev/null 2>&1; then
  docker builder prune -af >/dev/null 2>&1 && ok "кэш сборки Docker" || true
  docker image prune -af >/dev/null 2>&1 && ok "лишние образы Docker" || true
  docker volume prune -f >/dev/null 2>&1 && ok "безымянные тома" || true
fi

journalctl --vacuum-time=7d >/dev/null 2>&1 && ok "journalctl 7 дней" || true
apt-get clean >/dev/null 2>&1 && ok "apt clean" || true
find /var/log -type f \( -name '*.gz' -o -name '*.old' -o -name '*.1' \) -delete 2>/dev/null || true
ok "сжатые логи /var/log"

find /var/lib/docker/containers -name '*-json.log' -size +50M -print0 2>/dev/null \
  | while IFS= read -r -d '' f; do
      : > "$f"
      ok "обрезан лог контейнера"
    done

echo
df -h / | sed 's/^/  /'
echo
echo "  Проверьте, что игры живы:"
echo "      docker ps"
echo "      ls /var/www/hcg /var/www/ali /var/www/hcg-apk"
echo
