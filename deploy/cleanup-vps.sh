#!/usr/bin/env bash
# =============================================================================
#  Оставить на VPS только то, без чего не живут HCG и ACG.
#
#  СОХРАНЯЕТ:
#    • Docker и его тома данных игр (hcg_*, ali_*)
#    • Caddy (прокси и сертификаты)
#    • Amnezia VPN
#    • /var/www/hcg          — живая HCG
#    • /var/www/ali          — живая ACG
#    • /var/www/hcg-apk      — сборка APK Hapstore
#    • /var/www/ali-apk      — если есть APK Али
#    • .env внутри этих папок
#    • SSH, systemd, само ядро системы
#
#  УДАЛЯЕТ (после слова УДАЛИТЬ):
#    • старые распаковки hcg-new, архивы zip на /root и /var/www
#    • резервные копии hcg-backup-* / .env-hcg-* старше текущей игры
#    • чужие сайты в /var/www
#    • docker-контейнеры, образы и тома НЕ от hcg/ali/amnezia/caddy
#    • /tmp /var/tmp, кэши npm/apt, старые логи, node_modules/dist в распаковках
#    • лишние пакеты: apache/nginx, mysql, php, desktop, cups, bluetooth…
#
#  Сначала только список:
#      bash deploy/ОЧИСТКА-СЕРВЕРА.sh
#  Удалить:
#      bash deploy/ОЧИСТКА-СЕРВЕРА.sh применить
#      затем ввести: УДАЛИТЬ
# =============================================================================
set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }

APPLY=0
[ "${1:-}" = "применить" ] || [ "${1:-}" = "apply" ] && APPLY=1

if [ "$(id -u)" -ne 0 ]; then
  echo; bad "запустите от root в PuTTY:  bash $0 ${1:-}"; echo; exit 1
fi

# --- меню выбора пакетов ----------------------------------------------------
packages_menu() {
  if ! command -v dpkg-query >/dev/null 2>&1; then
    bad "это не Debian/Ubuntu — список пакетов недоступен"
    exit 1
  fi
  echo
  echo "${B}╔══════════════════════════════════════════════════════╗${N}"
  echo "${B}║  Пакеты и приложения — отметить к удалению          ║${N}"
  echo "${B}╚══════════════════════════════════════════════════════╝${N}"
  echo
  echo "  Не предлагаются: Docker, Caddy, SSH, Python, Node, Java (APK),"
  echo "  git, unzip, curl, ядро системы."
  echo

  local KEEP_RE='^(docker|containerd|runc|caddy|openssh|sudo|systemd|python3|curl|wget|unzip|git|nodejs|npm|openjdk|default-jre|default-jdk|wireguard|ca-certificates|apt|dpkg|bash|coreutils|login|passwd|adduser|netplan|udev|kmod|linux-|grub|e2fs|util-linux|sed|grep|gawk|tar|gzip|openssl|gnupg|tzdata|locales|less|nano|vim|cron|logrotate|rsyslog|dbus|mount|hostname|iproute|iputils|net-tools|iptables|nftables|procps|psmisc|findutils|diffutils|mawk|dash|debconf|gcc-.*-base|libc6|libssl|adduser)'

  mapfile -t ALL < <(dpkg-query -W -f='${Package}\n' 2>/dev/null | grep -vE "$KEEP_RE" | sort -u)
  if [ ${#ALL[@]} -eq 0 ]; then
    ok "лишних пакетов не видно"
    echo
    exit 0
  fi

  local i=1
  for p in "${ALL[@]}"; do
    printf "  ${C}%3d${N}  %s\n" "$i" "$p"
    i=$((i + 1))
  done
  echo
  echo "  Введите номера через пробел (например: 1 4 9)."
  echo "  Пустой ввод — выход без удаления."
  echo -n "  Номера: "
  local raw=""
  read -r raw || raw=""
  [ -z "$raw" ] && { echo "  отмена"; echo; exit 0; }

  local MARK=()
  local n
  for n in $raw; do
    if ! [[ "$n" =~ ^[0-9]+$ ]]; then
      warn "не номер: $n"
      continue
    fi
    if [ "$n" -lt 1 ] || [ "$n" -gt ${#ALL[@]} ]; then
      warn "нет пункта $n"
      continue
    fi
    MARK+=("${ALL[$((n - 1))]}")
  done
  if [ ${#MARK[@]} -eq 0 ]; then
    bad "ничего не отмечено"
    echo
    exit 1
  fi

  echo
  echo "  К снятию:"
  for p in "${MARK[@]}"; do echo "    • $p"; done
  echo
  echo -n "  Введите ${R}УДАЛИТЬ${N} чтобы снять отмеченное: "
  local conf=""
  read -r conf || conf=""
  if [ "$conf" != "УДАЛИТЬ" ]; then
    bad "отмена"
    echo
    exit 1
  fi
  local p
  for p in "${MARK[@]}"; do
    DEBIAN_FRONTEND=noninteractive apt-get purge -y "$p" >/dev/null 2>&1 \
      && ok "снят $p" || warn "не снял $p"
  done
  DEBIAN_FRONTEND=noninteractive apt-get autoremove -y --purge >/dev/null 2>&1 && ok "autoremove"
  echo
  ok "готово"
  echo
}

if [ "${1:-}" = "пакеты" ] || [ "${1:-}" = "packages" ]; then
  packages_menu
  exit $?
fi

KEEP_DIRS=(
  /var/www/hcg
  /var/www/ali
  /var/www/hcg-apk
  /var/www/ali-apk
  /etc/caddy
  /var/lib/caddy
  /opt/amnezia
  /opt/amnezia-vpn
)

is_keep_dir() {
  local p="$1"
  local k
  for k in "${KEEP_DIRS[@]}"; do
    [ -z "$k" ] && continue
    case "$p" in
      "$k"|"$k"/*) return 0 ;;
    esac
  done
  return 1
}

keep_docker_name() {
  echo "$1" | grep -qiE 'hcg_|ali_|amnezia|caddy'
}

echo
echo "${B}╔══════════════════════════════════════════════════════╗${N}"
echo "${B}║  Очистка VPS: только HCG + ACG + Docker + Caddy     ║${N}"
echo "${B}╚══════════════════════════════════════════════════════╝${N}"
echo
echo "  Режим: $([ "$APPLY" -eq 1 ] && echo "${R}УДАЛЕНИЕ${N}" || echo "${Y}ТОЛЬКО СПИСОК (ничего не трогаю)${N}")"
echo

TO_RM=()
add() {
  local p="$1"
  [ -e "$p" ] || return 0
  is_keep_dir "$p" && return 0
  TO_RM+=("$p")
}

hdr "1. Каталоги /var/www (чужие сайты и старые распаковки)"
if [ -d /var/www ]; then
  for d in /var/www/*; do
    [ -e "$d" ] || continue
    base="$(basename "$d")"
    case "$base" in
      hcg|ali|hcg-apk|ali-apk|html) ok "оставляю $d" ;;
      *) add "$d"; warn "кандидат: $d" ;;
    esac
  done
fi

hdr "2. Архивы и старые бэкапы в /root и /var/www"
for f in /root/*.zip /root/HCG*.zip /root/hcg-backup-* /root/.env-hcg-* \
         /root/*-backup-* /var/www/*.zip /var/www/hcg-new /var/www/hcg-old \
         /var/www/ali-new /var/www/ali-old; do
  [ -e "$f" ] || continue
  add "$f"
  warn "кандидат: $f"
done

hdr "2b. Мусор и временные папки"
# /tmp и /var/tmp — кроме служебных сокетов systemd/snap
if [ -d /tmp ]; then
  for f in /tmp/*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    case "$base" in
      systemd-private*|snap.*|ssh-*|.X11-unix|.ICE-unix) ok "tmp служебный: $f" ;;
      *) add "$f"; warn "tmp: $f" ;;
    esac
  done
fi
if [ -d /var/tmp ]; then
  for f in /var/tmp/*; do
    [ -e "$f" ] || continue
    add "$f"
    warn "var/tmp: $f"
  done
fi

# Кэши сборки на машине (игры в Docker от этого не зависят)
for f in \
  /root/.cache /root/.npm /root/.node-gyp /root/.local/share/Trash \
  /root/.local/share/pnpm /var/cache/apt/archives \
  /var/www/hcg/node_modules /var/www/hcg/dist /var/www/hcg/.vite \
  /var/www/ali/node_modules /var/www/ali/dist /var/www/ali/.vite \
  /var/www/hcg/bot/node_modules /var/www/ali/bot/node_modules \
  /var/www/hcg-apk/node_modules /var/www/hcg-apk/www /var/www/hcg-apk/android/app/build \
  /var/www/ali-apk/node_modules; do
  [ -e "$f" ] || continue
  # apt archives: чистим содержимое, не саму папку системы
  if [ "$f" = "/var/cache/apt/archives" ]; then
    TO_RM+=("apt-clean")
    warn "кэш apt"
    continue
  fi
  TO_RM+=("$f")
  warn "кэш/сборка: $f"
done

# Старые журналы journald пометим отдельной командой
TO_RM+=("journal-vacuum")
warn "старые логи journald (>3 дней)"
TO_RM+=("docker-prune-build")
warn "кэш сборки Docker (builder)"

hdr "3. Docker: контейнеры не HCG/ACG/Amnezia/Caddy"
if command -v docker >/dev/null 2>&1; then
  while read -r id name; do
    [ -z "$id" ] && continue
    if keep_docker_name "$name"; then
      ok "контейнер оставляю: $name"
    else
      warn "контейнер чужой: $name ($id)"
      TO_RM+=("docker-container:$id:$name")
    fi
  done < <(docker ps -a --format '{{.ID}} {{.Names}}' 2>/dev/null)

  hdr "4. Docker-тома не игр"
  while read -r vol; do
    [ -z "$vol" ] && continue
    if echo "$vol" | grep -qiE 'hcg|ali|hapstore|amnezia|caddy'; then
      ok "том оставляю: $vol"
    else
      warn "том чужой: $vol"
      TO_RM+=("docker-volume:$vol")
    fi
  done < <(docker volume ls -q 2>/dev/null)
else
  warn "docker не найден — шаг контейнеров пропущен"
fi

hdr "5. Лишние пакеты (не нужны HCG/ACG/Caddy/Docker/APK)"
# Не трогаем: docker, caddy, openssh, python3, curl, unzip, git, nodejs, openjdk (APK).
JUNK_PKGS=(
  apache2 apache2-bin nginx nginx-common lighttpd
  mysql-server mysql-server-core-8.0 mariadb-server postgresql postgresql-contrib
  php php-cli php-fpm php8.1-fpm php8.2-fpm php8.3-fpm libapache2-mod-php
  bind9 bind9-utils
  vsftpd proftpd-basic
  redis-server mongodb-org memcached
  cups cups-daemon avahi-daemon
  bluetooth bluez bluez-obexd
  modemmanager
  transmission-daemon
  tomcat9 tomcat10
  ubuntu-desktop gnome-shell gdm3 lightdm
  snapd-desktop-integration
)
pkg_ok() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "install ok installed"
}
if command -v dpkg-query >/dev/null 2>&1; then
  JUNK_FOUND=0
  for pkg in "${JUNK_PKGS[@]}"; do
    if pkg_ok "$pkg"; then
      JUNK_FOUND=1
      warn "пакет: $pkg"
      TO_RM+=("apt-purge:$pkg")
    fi
  done
  if [ "$JUNK_FOUND" -eq 0 ]; then
    ok "лишних пакетов из списка нет"
  else
    TO_RM+=("apt-autoremove")
    warn "после снятия пакетов: apt autoremove"
  fi
else
  warn "не Debian/Ubuntu — пакеты не трогаю"
fi

hdr "6. Что НЕ трогаем никогда"
ok "Docker, Caddy, Amnezia, OpenSSH"
ok "nodejs / java — нужны для APK"
ok "/var/www/hcg  /var/www/ali  APK-папки, тома, .env"

echo
if [ ${#TO_RM[@]} -eq 0 ]; then
  ok "лишнего не нашёл — сервер уже чистый"
  echo
  exit 0
fi

echo "  К удалению позиций: ${B}${#TO_RM[@]}${N}"
echo

if [ "$APPLY" -ne 1 ]; then
  echo "  Это был ${Y}просмотр${N}. Чтобы удалить:"
  echo "      ${B}bash $0 применить${N}"
  echo "      затем ввести слово ${R}УДАЛИТЬ${N}"
  echo
  exit 0
fi

echo -n "  Введите УДАЛИТЬ заглавными, если уверены: "
read -r CONFIRM || CONFIRM=""
if [ "$CONFIRM" != "УДАЛИТЬ" ]; then
  bad "отмена — ничего не удалено"
  echo
  exit 1
fi

hdr "Удаляю"
for item in "${TO_RM[@]}"; do
  case "$item" in
    docker-container:*)
      id="${item#docker-container:}"; id="${id%%:*}"
      docker rm -f "$id" >/dev/null 2>&1 && ok "контейнер $id снят" || warn "не снял $id"
      ;;
    docker-volume:*)
      vol="${item#docker-volume:}"
      docker volume rm "$vol" >/dev/null 2>&1 && ok "том $vol" || warn "том занят: $vol"
      ;;
    apt-clean)
      if command -v apt-get >/dev/null 2>&1; then
        apt-get clean >/dev/null 2>&1 && ok "кэш apt очищен" || warn "apt-get clean не вышел"
      fi
      ;;
    journal-vacuum)
      if command -v journalctl >/dev/null 2>&1; then
        journalctl --vacuum-time=3d >/dev/null 2>&1 && ok "старые journald срезаны" || warn "journalctl vacuum не вышел"
      fi
      ;;
    docker-prune-build)
      if command -v docker >/dev/null 2>&1; then
        docker builder prune -f >/dev/null 2>&1 && ok "кэш docker builder" || true
        docker image prune -f >/dev/null 2>&1 && ok "висячие образы" || true
      fi
      ;;
    apt-purge:*)
      pkg="${item#apt-purge:}"
      DEBIAN_FRONTEND=noninteractive apt-get purge -y "$pkg" >/dev/null 2>&1 \
        && ok "пакет снят: $pkg" || warn "не снял пакет: $pkg"
      ;;
    apt-autoremove)
      DEBIAN_FRONTEND=noninteractive apt-get autoremove -y --purge >/dev/null 2>&1 \
        && ok "apt autoremove" || warn "autoremove не вышел"
      ;;
    *)
      rm -rf "$item" && ok "удалено $item" || bad "не удалось $item"
      ;;
  esac
done

echo
ok "готово. HCG, ACG, Docker, Caddy, Amnezia на месте."
echo "  Проверка:  bash /var/www/hcg/deploy/ВСЁ-НА-VPS.sh статус"
echo
