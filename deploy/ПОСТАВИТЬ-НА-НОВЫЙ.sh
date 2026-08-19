#!/usr/bin/env bash
# =============================================================================
#  HCG — поднять проект на чистом сервере
# =============================================================================
#  Куда: на НОВЫЙ сервер (PuTTY), под root
#  Как:  bash ПОСТАВИТЬ-НА-НОВЫЙ.sh /root/HCG-ПЕРЕЕЗД-*.tgz
#
#  Что делает:
#    • ставит docker и Caddy, если их нет
#    • распаковывает секреты, данные игры и сертификаты Caddy
#    • разворачивает исходники и собирает контейнеры
#    • проверяет, что игроки на месте, а не пустая доска
#
#  Порядок важен: данные заливаются в том ДО первого запуска. Если контейнер
#  стартует раньше, он создаст пустое состояние и запишет его на диск —
#  тогда восстановление придётся делать поверх, с остановкой.
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }
die()  { echo; echo "${R}${B}ОСТАНОВЛЕНО: $*${N}"; echo; exit 1; }

ARCHIVE="${1:-}"
HCG_DIR="${HCG_DIR:-/var/www/hcg}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo "${B}╔══════════════════════════════════════════════════╗${N}"
echo "${B}║   HCG — установка на новый сервер                ║${N}"
echo "${B}╚══════════════════════════════════════════════════╝${N}"

[ -n "$ARCHIVE" ] || die "укажите архив: bash ПОСТАВИТЬ-НА-НОВЫЙ.sh /root/HCG-ПЕРЕЕЗД-….tgz"
[ -f "$ARCHIVE" ] || die "файл не найден: $ARCHIVE"
[ -f "$SRC/docker-compose.yml" ] || die "запускайте из распакованного архива проекта (нет docker-compose.yml)"

# ---------------------------------------------------------------------------
hdr "1/8  Docker"
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "уже установлен: $(docker --version)"
else
  echo "  ставлю docker, это 1–3 минуты…"
  curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
  systemctl enable --now docker >/dev/null 2>&1
  command -v docker >/dev/null 2>&1 || die "docker не установился"
  ok "docker установлен: $(docker --version)"
fi

# ---------------------------------------------------------------------------
hdr "2/8  Распаковка перевозимого"
# ---------------------------------------------------------------------------
WORK="/root/переезд-распаковано"
rm -rf "$WORK"; mkdir -p "$WORK"
tar xzf "$ARCHIVE" -C "$WORK" --strip-components=1 2>/dev/null || die "архив не распаковался"
ok "распаковано в $WORK"
ls "$WORK" | sed 's/^/     /'

# ---------------------------------------------------------------------------
hdr "3/8  Исходники проекта"
# ---------------------------------------------------------------------------
mkdir -p "$HCG_DIR"
if [ "$(cd "$SRC" && pwd -P)" = "$(cd "$HCG_DIR" && pwd -P)" ]; then
  ok "исходники уже на месте"
else
  cp -a "$SRC"/. "$HCG_DIR"/ || die "не удалось скопировать файлы"
  ok "файлы разложены в $HCG_DIR"
fi

# ---------------------------------------------------------------------------
hdr "4/8  Секреты"
# ---------------------------------------------------------------------------
if [ -f "$WORK/env-файл" ]; then
  cp "$WORK/env-файл" "$HCG_DIR/.env"; chmod 600 "$HCG_DIR/.env"
  ok ".env восстановлен"
  # Домен мог смениться вместе с сервером — покажем, что стоит сейчас.
  CUR_URL=$(grep -E '^WEB_APP_URL=' "$HCG_DIR/.env" | cut -d= -f2- | tr -d '"')
  echo "     WEB_APP_URL сейчас: ${B}$CUR_URL${N}"
  echo "     ${Y}если домен переезжает — поправьте: nano $HCG_DIR/.env${N}"
else
  die "в архиве нет env-файла. Без паролей сервер не стартует."
fi

if [ -f "$WORK/firebase-ключ.json" ]; then
  cp "$WORK/firebase-ключ.json" "$HCG_DIR/service-account.json"
  chmod 600 "$HCG_DIR/service-account.json"
  ok "ключ Firebase на месте"
fi

# ---------------------------------------------------------------------------
hdr "5/8  Данные игры — ДО первого запуска"
# ---------------------------------------------------------------------------
if [ -f "$WORK/данные-игры.tgz" ]; then
  # Имя тома на НОВОМ сервере определяет Compose: он берёт имя каталога
  # проекта и приписывает его спереди. /var/www/hcg -> hcg_hapstore-data.
  # Заливать надо именно в то имя, которое Compose потом подключит, иначе
  # данные лягут в том, к которому никто не обратится, и доска будет пустой
  # при полностью «успешном» переезде.
  PROJ="$(basename "$HCG_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
  DATA_VOL="${PROJ}_hapstore-data"
  ok "том для данных: ${B}$DATA_VOL${N} (имя задаёт каталог $HCG_DIR)"

  docker volume create "$DATA_VOL" >/dev/null 2>&1
  # Том пустой? Если нет — предупредим, чтобы не затереть чужое молча.
  EXISTING=$(docker run --rm -v "$DATA_VOL":/data:ro alpine sh -c 'ls -1 /data 2>/dev/null | wc -l')
  if [ "${EXISTING:-0}" -gt 0 ]; then
    warn "в томе уже есть $EXISTING файл(ов) — они будут заменены"
    docker run --rm -v "$DATA_VOL":/data alpine sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null' || true
  fi
  docker run --rm \
    -v "$DATA_VOL":/data \
    -v "$WORK":/in:ro \
    alpine tar xzf /in/данные-игры.tgz -C /data 2>/dev/null || die "не удалось залить данные"
  RESTORED=$(docker run --rm -v "$DATA_VOL":/data:ro alpine sh -c 'ls -1 /data | wc -l')
  ok "данные залиты в том ($RESTORED объект(ов) в корне)"
  docker run --rm -v "$DATA_VOL":/data:ro alpine ls -la /data | tail -n +4 | sed 's/^/     /'
else
  DATA_VOL=""
  warn "данных игры в архиве нет — игра начнётся с пустой доски"
fi

# ---------------------------------------------------------------------------
hdr "6/8  Caddy"
# ---------------------------------------------------------------------------
if [ -f "$WORK/caddy-конфиг.tgz" ] || [ -f "$WORK/caddy-данные.tgz" ]; then

  # 6.1 — установка. Пакет из репозитория Ubuntu старый; ставим официальный.
  if command -v caddy >/dev/null 2>&1; then
    ok "Caddy уже установлен: $(caddy version 2>/dev/null | head -1)"
  else
    echo "  ставлю Caddy из официального репозитория…"
    apt-get update -qq >/dev/null 2>&1
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null 2>&1
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>/dev/null | \
      gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' 2>/dev/null \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq >/dev/null 2>&1
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy >/dev/null 2>&1
    if command -v caddy >/dev/null 2>&1; then
      ok "Caddy установлен: $(caddy version 2>/dev/null | head -1)"
    else
      bad "Caddy не установился — поставьте вручную и запустите скрипт снова"
    fi
  fi

  # 6.2 — конфиг
  if [ -f "$WORK/caddy-конфиг.tgz" ]; then
    systemctl stop caddy >/dev/null 2>&1
    tar xzf "$WORK/caddy-конфиг.tgz" -C /etc 2>/dev/null && ok "Caddyfile восстановлен"
  fi

  # 6.3 — сертификаты и ACME-аккаунт.
  #
  # Кладём туда, где ищет ИМЕННО ЭТА установка, а не туда, откуда взяли.
  # Служба systemd работает от пользователя caddy и в /root/.local/... не заглянет.
  # Перепутать папку — приехать без сертификата и упереться в лимиты Let's Encrypt.
  if [ -f "$WORK/caddy-данные.tgz" ]; then
    CADDY_USER=$(systemctl cat caddy 2>/dev/null | grep -E "^User=" | cut -d= -f2)
    CADDY_USER="${CADDY_USER:-caddy}"
    if id "$CADDY_USER" >/dev/null 2>&1; then
      DEST_HOME=$(getent passwd "$CADDY_USER" | cut -d: -f6)
      DEST_HOME="${DEST_HOME:-/var/lib/caddy}"
    else
      DEST_HOME="/var/lib/caddy"; CADDY_USER="root"
    fi
    DEST="$DEST_HOME/.local/share"
    mkdir -p "$DEST"
    tar xzf "$WORK/caddy-данные.tgz" -C "$DEST" 2>/dev/null || \
      { mkdir -p "$DEST/caddy" && tar xzf "$WORK/caddy-данные.tgz" -C "$DEST/caddy" 2>/dev/null; }
    chown -R "$CADDY_USER":"$CADDY_USER" "$DEST_HOME" 2>/dev/null
    ok "сертификаты Caddy восстановлены в $DEST/caddy (владелец: $CADDY_USER)"
    CERTS=$(find "$DEST/caddy/certificates" -name "*.crt" 2>/dev/null | wc -l)
    if [ "${CERTS:-0}" -gt 0 ]; then
      ok "  найдено сертификатов: $CERTS"
      find "$DEST/caddy/certificates" -name "*.crt" 2>/dev/null | \
        sed 's|.*/||; s|\.crt$||' | sort -u | head -5 | sed 's/^/     /'
    else
      warn "  сертификатов не видно — Caddy выпустит новые сам, когда DNS переключится"
    fi
  fi

  # 6.4 — запуск
  if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    ok "Caddyfile корректен"
  else
    bad "Caddy ругается на конфиг:"
    caddy validate --config /etc/caddy/Caddyfile 2>&1 | head -8 | sed 's/^/     /'
  fi
  systemctl enable caddy >/dev/null 2>&1
  systemctl restart caddy >/dev/null 2>&1
  sleep 3
  if systemctl is-active caddy >/dev/null 2>&1; then
    ok "Caddy запущен"
  else
    bad "Caddy не поднялся:"
    journalctl -u caddy --no-pager -n 15 2>/dev/null | sed 's/^/     /'
  fi
else
  warn "данных Caddy в архиве нет — настройте HTTPS вручную после переключения DNS"
fi

# ---------------------------------------------------------------------------
hdr "7/8  Сборка и запуск"
# ---------------------------------------------------------------------------
cd "$HCG_DIR" || die "нет $HCG_DIR"
echo "  собираю образы начисто, это 3–8 минут…"
docker compose build --no-cache >/tmp/hcg-build.log 2>&1 || {
  bad "сборка не прошла — хвост журнала:"; tail -25 /tmp/hcg-build.log | sed 's/^/     /'
  die "смотрите /tmp/hcg-build.log"
}
ok "образы собраны"
docker compose up -d >/tmp/hcg-up.log 2>&1 || {
  bad "запуск не прошёл:"; tail -25 /tmp/hcg-up.log | sed 's/^/     /'; die "смотрите /tmp/hcg-up.log"
}
ok "контейнеры запущены"

# ---------------------------------------------------------------------------
hdr "8/8  Проверка живьём"
# ---------------------------------------------------------------------------
echo "  жду, пока сервер поднимется…"
HEALTHY=0
for i in $(seq 1 30); do
  if curl -fs -m 5 http://127.0.0.1:3001/healthz >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
if [ "$HEALTHY" = 1 ]; then ok "сервер отвечает на /healthz"
else bad "сервер не ответил за минуту"; docker compose logs --tail=30 hcg_app | sed 's/^/     /'; fi

docker ps --format '  {{.Names}}\t{{.Status}}' | grep hcg_ || bad "контейнеры не видны"

# Данные доехали? Пустая доска после переезда — самая частая тихая беда.
#
# Спрашиваем у запущенного контейнера, а не у имени тома: только так видно,
# что подключилось на самом деле. Если Compose взял другой том, чем тот,
# куда мы заливали, — здесь это и вскроется.
LIVE_VOL=$(docker inspect hcg_app \
  --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' \
  2>/dev/null | tr -d '[:space:]')
if [ -n "$LIVE_VOL" ]; then
  ok "контейнер использует том: $LIVE_VOL"
  if [ -n "${DATA_VOL:-}" ] && [ "$LIVE_VOL" != "$DATA_VOL" ]; then
    bad "а данные заливались в $DATA_VOL — имена разошлись!"
    warn "перенесите:  docker run --rm -v $DATA_VOL:/from:ro -v $LIVE_VOL:/to alpine cp -a /from/. /to/"
  fi
  PLAYERS=$(docker run --rm -v "$LIVE_VOL":/data:ro alpine sh -c \
    'grep -o "\"id\"" /data/game-state-persistent.json 2>/dev/null | wc -l')
else
  PLAYERS=0
  bad "не удалось определить том контейнера hcg_app"
fi
if [ "${PLAYERS:-0}" -gt 0 ]; then
  ok "состояние игры на месте (записей с id: ${PLAYERS})"
else
  bad "состояние игры пустое — проверьте шаг 5"
fi

echo
echo "${B}╔══════════════════════════════════════════════════╗${N}"
echo "${B}${G}║   Установка завершена                            ║${N}"
echo "${B}╚══════════════════════════════════════════════════╝${N}"
echo
echo "  Осталось руками (сюда скрипт не лезет — это вне сервера):"
echo "    1. ${B}DNS${N}: A-запись домена → новый IP"
echo "    2. ${B}@BotFather${N}: /setmenubutton и /setdomain — на новый адрес,"
echo "       ЕСЛИ домен сменился. Если домен тот же — ничего не трогайте."
echo "    3. Проверить бота в Telegram: /start и /help"
echo "    4. Старый сервер держать включённым ещё сутки — на откат"
echo
