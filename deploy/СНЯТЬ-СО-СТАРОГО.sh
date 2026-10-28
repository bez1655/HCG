#!/usr/bin/env bash
# =============================================================================
#  HCG — снять всё незаменимое со старого сервера в один архив
# =============================================================================
#  Куда: на СТАРЫЙ сервер (PuTTY), в любую папку
#  Как:  bash СНЯТЬ-СО-СТАРОГО.sh
#
#  Что собирает (это то, чего НЕТ в исходниках и что нельзя скачать заново):
#    • .env — все пароли и ключи
#    • том Docker hapstore-data — игроки, состояние доски, журнал, снимки
#    • Caddyfile и данные Caddy (сертификаты + ACME-аккаунт)
#    • ключ Firebase, если он лежит файлом
#    • список установленного и версии — чтобы повторить окружение
#
#  Чего НЕ собирает намеренно: node_modules, dist, образы Docker, исходники.
#  Всё это ставится заново из архива проекта одной командой.
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }

HCG_DIR="${HCG_DIR:-/var/www/hcg}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="/root/hcg-переезд-$STAMP"
mkdir -p "$OUT"

# ---------------------------------------------------------------------------
# Найти том с данными игры, как бы он ни назывался.
#
# Моя ошибка в первой версии: имя было записано жёстко как "hapstore-data".
# Docker Compose приписывает к тому имя проекта — каталог /var/www/hcg
# превращает его в "hcg_hapstore-data". Скрипт честно докладывал «том не
# найден» и продолжал работу, а это ровно те данные, ради которых переезд
# и затевается: игроки, доска, журнал.
#
# Спрашиваем сначала у контейнера — он знает, что реально смонтировано
# в /app/data, независимо от имени. Тома чужих проектов (pgdata и подобные)
# отсеиваем явно, чтобы случайно не увезти чужую базу вместо своей.
# ---------------------------------------------------------------------------
find_data_volume() {
  local v="" all=""

  # Явное указание побеждает любую догадку.
  if [ -n "${HCG_DATA_VOLUME:-}" ]; then echo "$HCG_DATA_VOLUME"; return 0; fi

  for c in hcg_app hcg_bot; do
    v=$(docker inspect "$c" \
          --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' \
          2>/dev/null | tr -d '[:space:]')
    [ -n "$v" ] && { echo "$v"; return 0; }
  done

  all=$(docker volume ls --format '{{.Name}}' 2>/dev/null)
  echo "$all" | grep -qx "hapstore-data" && { echo "hapstore-data"; return 0; }

  v=$(echo "$all" | grep -E '_hapstore-data$' | head -1)
  [ -n "$v" ] && { echo "$v"; return 0; }

  v=$(echo "$all" | grep -i "hapstore" | grep -viE "pgdata|postgres|mysql|redis" | head -1)
  [ -n "$v" ] && { echo "$v"; return 0; }

  return 1
}

echo "${B}╔══════════════════════════════════════════════════╗${N}"
echo "${B}║   HCG — сбор данных для переезда                 ║${N}"
echo "${B}╚══════════════════════════════════════════════════╝${N}"
echo "  проект:  $HCG_DIR"
echo "  собираю: $OUT"

MISSING=0

# ---------------------------------------------------------------------------
hdr "1/7  Секреты (.env)"
# ---------------------------------------------------------------------------
# Это самое незаменимое. SESSION_SECRET и ADMIN_PASSWORD_HASH можно сгенерировать
# заново, но тогда разлогинятся все и сменится пароль админа. TELEGRAM_BOT_TOKEN
# восстанавливается только через @BotFather с отзывом старого.
if [ -f "$HCG_DIR/.env" ]; then
  cp "$HCG_DIR/.env" "$OUT/env-файл"
  chmod 600 "$OUT/env-файл"
  ok ".env сохранён ($(wc -l < "$HCG_DIR/.env") строк)"
  for KEY in ADMIN_PASSWORD_HASH SESSION_SECRET INTERNAL_API_SECRET TELEGRAM_BOT_TOKEN WEB_APP_URL; do
    if grep -qE "^${KEY}=\"?.+\"?$" "$HCG_DIR/.env" && \
       ! grep -qE "^${KEY}=\"\"$" "$HCG_DIR/.env"; then
      ok "  $KEY — заполнен"
    else
      bad "  $KEY — ПУСТОЙ (сервер без него не стартует)"
      MISSING=1
    fi
  done
else
  bad ".env не найден в $HCG_DIR — без него новый сервер не запустится"
  MISSING=1
fi

# ---------------------------------------------------------------------------
hdr "2/7  Данные игры (том Docker)"
# ---------------------------------------------------------------------------
# Здесь живут игроки, позиции фишек, пароли входа, журнал и автоснимки.
# Папки проекта это НЕ касается: том отдельный, копирование /var/www/hcg
# данные игроков не спасает — типичная ловушка при переезде.
DATA_VOL="$(find_data_volume)"
if [ -n "$DATA_VOL" ]; then
  ok "том с данными: ${B}$DATA_VOL${N}"
  echo "$DATA_VOL" > "$OUT/имя-тома.txt"
  docker run --rm \
    -v "$DATA_VOL":/data:ro \
    -v "$OUT":/out \
    alpine tar czf /out/данные-игры.tgz -C /data . 2>/dev/null
  if [ -s "$OUT/данные-игры.tgz" ]; then
    SIZE=$(du -h "$OUT/данные-игры.tgz" | cut -f1)
    ok "том выгружен ($SIZE)"
    echo "     внутри:"
    tar tzf "$OUT/данные-игры.tgz" 2>/dev/null | grep -vE '^\./$' | head -20 | sed 's/^/       /'
    COUNT=$(tar tzf "$OUT/данные-игры.tgz" 2>/dev/null | wc -l)
    [ "$COUNT" -gt 20 ] && echo "       … всего $COUNT файлов"
  else
    bad "не удалось выгрузить том"
    MISSING=1
  fi
else
  # Если тома нет — возможно, данные лежат папкой рядом с проектом.
  bad "том с данными игры не найден"
  warn "вот что есть на сервере — найдите нужный глазами:"
  docker volume ls 2>/dev/null | sed 's/^/       /'
  warn "и укажите его явно:  HCG_DATA_VOLUME=имя bash $0"
  if [ -d "$HCG_DIR/data" ]; then
    tar czf "$OUT/данные-игры.tgz" -C "$HCG_DIR/data" . 2>/dev/null && \
      ok "зато найдена папка $HCG_DIR/data — сохранил её"
  else
    MISSING=1
  fi
fi

# ---------------------------------------------------------------------------
hdr "3/7  Caddy — настройки"
# ---------------------------------------------------------------------------
# Caddy, в отличие от nginx+certbot, держит сертификаты НЕ в /etc/letsencrypt,
# а в своей папке данных. Конфиг же обычно один короткий файл.
CADDY_MODE="нет"
if [ -f /etc/caddy/Caddyfile ]; then
  tar czf "$OUT/caddy-конфиг.tgz" -C /etc caddy 2>/dev/null
  ok "Caddyfile сохранён"
  CADDY_MODE="служба"
  echo "     что проксируется:"
  grep -nE "^[a-z0-9.*-]+ *\{|reverse_proxy|:[0-9]{2,5}" /etc/caddy/Caddyfile 2>/dev/null | \
    head -15 | sed 's/^/       /'
elif docker ps -a --format '{{.Image}} {{.Names}}' 2>/dev/null | grep -qi caddy; then
  CADDY_MODE="docker"
  warn "Caddy найден как КОНТЕЙНЕР, а не служба"
  docker ps -a --format '{{.Names}}\t{{.Image}}' | grep -i caddy | sed 's/^/     /'
else
  bad "Caddyfile не найден в /etc/caddy — ищу в других местах"
  find / -maxdepth 4 -name Caddyfile -not -path "*/node_modules/*" 2>/dev/null | \
    head -5 | sed 's/^/     найдено: /'
fi

# ---------------------------------------------------------------------------
hdr "4/7  Caddy — сертификаты и ACME-аккаунт"
# ---------------------------------------------------------------------------
# Папка данных зависит от того, КАК запущен Caddy:
#   • служба systemd  → /var/lib/caddy/.local/share/caddy   (пользователь caddy)
#   • руками от root  → /root/.local/share/caddy
#   • контейнер       → том, смонтированный в /data
# Это разные хранилища, они НЕ общие. Забрать не ту — приехать без сертификата.
#
# Копия нужна не только ради сертификата: там же ACME-аккаунт. Без него новый
# сервер регистрируется у Let's Encrypt заново, а у них есть лимиты на выпуск.
CADDY_DATA=""
for D in /var/lib/caddy/.local/share/caddy \
         /root/.local/share/caddy \
         /home/caddy/.local/share/caddy; do
  if [ -d "$D" ]; then CADDY_DATA="$D"; break; fi
done

if [ -n "$CADDY_DATA" ]; then
  tar czf "$OUT/caddy-данные.tgz" -C "$(dirname "$CADDY_DATA")" caddy 2>/dev/null
  echo "$CADDY_DATA" > "$OUT/caddy-путь-данных.txt"
  ok "данные Caddy сохранены из $CADDY_DATA"
  ok "  размер: $(du -h "$OUT/caddy-данные.tgz" | cut -f1)"
  echo "     сертификаты на домены:"
  find "$CADDY_DATA/certificates" -name "*.crt" 2>/dev/null | \
    sed 's|.*/||; s|\.crt$||' | sort -u | head -10 | sed 's/^/       /'
  if [ -d "$CADDY_DATA/acme" ]; then
    ok "  ACME-аккаунт на месте (не придётся регистрироваться заново)"
  fi
elif [ "$CADDY_MODE" = "docker" ]; then
  # У контейнера данные в томе. Найдём том по имени контейнера.
  CNAME=$(docker ps -a --format '{{.Names}}' | grep -i caddy | head -1)
  CVOL=$(docker inspect "$CNAME" 2>/dev/null | grep -oE '"Name": "[^"]*caddy[^"]*data[^"]*"' | \
         head -1 | cut -d'"' -f4)
  [ -z "$CVOL" ] && CVOL=$(docker inspect "$CNAME" 2>/dev/null | \
         grep -B2 '"Destination": "/data"' | grep -oE '"Name": "[^"]*"' | cut -d'"' -f4 | head -1)
  if [ -n "$CVOL" ]; then
    docker run --rm -v "$CVOL":/data:ro -v "$OUT":/out \
      alpine tar czf /out/caddy-данные.tgz -C /data . 2>/dev/null
    echo "docker:$CVOL" > "$OUT/caddy-путь-данных.txt"
    ok "данные Caddy выгружены из тома $CVOL"
  else
    bad "не нашёл том с данными Caddy — проверьте: docker volume ls"
    MISSING=1
  fi
else
  bad "папка данных Caddy не найдена"
  warn "найдите вручную:  find / -name 'certificates' -path '*caddy*' 2>/dev/null"
  warn "и посмотрите, от кого запущен:  systemctl cat caddy | grep User"
  MISSING=1
fi

# Юнит systemd — если его правили руками, повторить будет нечем.
if [ -f /etc/systemd/system/caddy.service ]; then
  cp /etc/systemd/system/caddy.service "$OUT/caddy.service"
  warn "юнит caddy.service переопределён вручную — сохранил, проверьте на новом"
fi

# ---------------------------------------------------------------------------
hdr "5/7  Ключ Firebase (если файлом)"
# ---------------------------------------------------------------------------
FOUND_KEY=0
for F in "$HCG_DIR/service-account.json" /root/service-account.json /etc/hcg/service-account.json; do
  if [ -f "$F" ]; then
    cp "$F" "$OUT/firebase-ключ.json"; chmod 600 "$OUT/firebase-ключ.json"
    ok "найден $F"; FOUND_KEY=1
  fi
done
if [ "$FOUND_KEY" = 0 ]; then
  if grep -q '^FIREBASE_SERVICE_ACCOUNT="."' "$HCG_DIR/.env" 2>/dev/null; then
    ok "ключ Firebase лежит прямо в .env — он уже сохранён вместе с ним"
  else
    warn "ключ Firebase не найден — значит, Firestore не используется"
    warn "это нормально: состояние хранится на диске в томе"
  fi
fi

# ---------------------------------------------------------------------------
hdr "6/7  Доступ по SSH"
# ---------------------------------------------------------------------------
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "$OUT/ssh-ключи-доступа"
  ok "authorized_keys сохранён ($(wc -l < /root/.ssh/authorized_keys) ключ(ей))"
fi

# ---------------------------------------------------------------------------
hdr "7/7  Слепок окружения — чтобы повторить, а не угадывать"
# ---------------------------------------------------------------------------
{
  echo "=== Снято: $(date) ==="
  echo
  echo "--- ОС ---";              cat /etc/os-release 2>/dev/null | head -3
  echo; echo "--- Ядро ---";      uname -a
  echo; echo "--- Docker ---";    docker --version; docker compose version
  echo; echo "--- Контейнеры ---";docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
  echo; echo "--- Тома ---";      docker volume ls
  echo; echo "--- Порты ---";     ss -tlnp 2>/dev/null | head -25
  echo; echo "--- Диск ---";      df -h /
  echo; echo "--- Память ---";    free -h
  echo; echo "--- Задания cron ---"; crontab -l 2>/dev/null || echo "нет"
  echo; echo "--- Caddy ---"
  caddy version 2>/dev/null || echo "бинарник caddy недоступен"
  systemctl status caddy --no-pager 2>/dev/null | head -8
  echo "  от какого пользователя:"; systemctl cat caddy 2>/dev/null | grep -E "^User=|^Group=" || echo "  (не служба)"
  echo "  Caddyfile:"; cat /etc/caddy/Caddyfile 2>/dev/null | sed 's/^/    /'
  echo; echo "--- Автозапуск ---";  systemctl list-unit-files --state=enabled 2>/dev/null | head -25
  echo; echo "--- Файрвол ---";     ufw status 2>/dev/null || iptables -S 2>/dev/null | head -20
  echo; echo "--- Внешний IP ---";  curl -s -m 10 ifconfig.me 2>/dev/null || echo "не определился"
  echo; echo "--- Сборка на сервере ---"
  docker exec hcg_app node -e "console.log(process.env.npm_package_version||'—')" 2>/dev/null
  docker exec hcg_bot cat /app/dist/version.js 2>/dev/null | head -5
} > "$OUT/слепок-сервера.txt" 2>&1
ok "слепок окружения записан"

# ---------------------------------------------------------------------------
# Один архив на выход
# ---------------------------------------------------------------------------
FINAL="/root/HCG-ПЕРЕЕЗД-$STAMP.tgz"
tar czf "$FINAL" -C "$(dirname "$OUT")" "$(basename "$OUT")" 2>/dev/null
chmod 600 "$FINAL"

echo
echo "${B}╔══════════════════════════════════════════════════╗${N}"
if [ "$MISSING" = 0 ]; then
  echo "${B}${G}║   Готово. Всё незаменимое собрано.               ║${N}"
else
  echo "${B}${R}║   Собрано, но ЕСТЬ ПРОБЕЛЫ — смотрите ✗ выше.    ║${N}"
fi
echo "${B}╚══════════════════════════════════════════════════╝${N}"
echo
echo "  Файл:   ${B}$FINAL${N}"
echo "  Размер: $(du -h "$FINAL" | cut -f1)"
echo
echo "  ${B}Заберите его на свой компьютер${N} — в PowerShell на Windows:"
echo "    ${C}scp root@СТАРЫЙ-IP:$FINAL C:\\Users\\%USERNAME%\\Desktop\\${N}"
echo
echo "  ${Y}Внутри пароли и токен бота. Не пересылайте в мессенджерах.${N}"
echo
