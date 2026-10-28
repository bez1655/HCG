#!/usr/bin/env bash
# =============================================================================
#  HCG — отключить прокси, если Telegram доступен напрямую
# =============================================================================
#  Куда: на НОВЫЙ сервер (PuTTY), после переезда
#  Как:  bash deploy/БЕЗ-ПРОКСИ.sh
#
#  Зачем: сборщик прокси нужен только там, где Telegram заблокирован. За
#  пределами России он обычно доступен напрямую, и тогда весь этот механизм —
#  лишний источник сбоев: бесплатные прокси живут часами, отваливаются в
#  произвольный момент и оставляют бота молчащим без единой ошибки в журнале.
#
#  Скрипт НИЧЕГО не меняет, пока не убедится настоящим запросом к Telegram,
#  что прямой маршрут работает. Проверка идёт ИЗНУТРИ контейнера: у хоста и
#  у контейнера разные сетевые пути, и «с сервера curl проходит» ещё не значит,
#  что пройдёт у бота.
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }

HCG_DIR="${HCG_DIR:-/var/www/hcg}"
cd "$HCG_DIR" || { bad "нет каталога $HCG_DIR"; exit 1; }

echo "${B}╔══════════════════════════════════════════════════╗${N}"
echo "${B}║   Telegram напрямую — проверка и переключение    ║${N}"
echo "${B}╚══════════════════════════════════════════════════╝${N}"

# ---------------------------------------------------------------------------
hdr "1/5  Доступен ли Telegram с хоста"
# ---------------------------------------------------------------------------
if curl -fsS -m 15 -o /dev/null -w '%{http_code}' https://api.telegram.org/ 2>/dev/null | grep -qE '^(200|302|404)$'; then
  ok "с хоста api.telegram.org отвечает"
else
  CODE=$(curl -s -m 15 -o /dev/null -w '%{http_code}' https://api.telegram.org/ 2>/dev/null)
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
    ok "с хоста ответ получен (код $CODE) — маршрут живой"
  else
    bad "с хоста Telegram недоступен — прокси остаётся нужен"
    echo
    echo "  Ничего не меняю. Это нормально, если сервер в России."
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
hdr "2/5  Доступен ли Telegram ИЗ КОНТЕЙНЕРА"
# ---------------------------------------------------------------------------
# Тот самый шаг, который легко пропустить. У контейнера свой сетевой стек.
if ! docker ps --format '{{.Names}}' | grep -q '^hcg_bot$'; then
  warn "контейнер hcg_bot не запущен — проверяю временным контейнером"
  RESULT=$(docker run --rm --network bridge node:20-alpine \
    node -e 'fetch("https://api.telegram.org/bot0:0/getMe",{signal:AbortSignal.timeout(15000)}).then(r=>console.log("HTTP "+r.status)).catch(e=>console.log("ОШИБКА "+e.message))' 2>/dev/null)
else
  RESULT=$(docker exec hcg_bot \
    node -e 'fetch("https://api.telegram.org/bot0:0/getMe",{signal:AbortSignal.timeout(15000)}).then(r=>console.log("HTTP "+r.status)).catch(e=>console.log("ОШИБКА "+e.message))' 2>/dev/null)
fi

echo "     ответ: ${RESULT:-пусто}"
# 401 — это УСПЕХ: Telegram ответил «неверный токен», значит маршрут до него есть.
if echo "$RESULT" | grep -qE "HTTP (401|200|404)"; then
  ok "из контейнера Telegram отвечает — прямое соединение работает"
  ok "  (401 «неверный токен» здесь и есть успех: сервер Telegram ответил)"
else
  bad "из контейнера Telegram НЕ отвечает"
  echo
  echo "  Прокси остаётся нужен. Ничего не меняю."
  exit 0
fi

# ---------------------------------------------------------------------------
hdr "3/5  Резервная копия .env"
# ---------------------------------------------------------------------------
[ -f .env ] || { bad "нет .env"; exit 1; }
STAMP="$(date +%Y%m%d-%H%M%S)"
cp .env ".env.до-отключения-прокси-$STAMP"
ok "копия: .env.до-отключения-прокси-$STAMP"
echo "     вернуть всё как было:  cp .env.до-отключения-прокси-$STAMP .env && docker compose up -d"

# ---------------------------------------------------------------------------
hdr "4/5  Правка .env"
# ---------------------------------------------------------------------------
# Пустой TELEGRAM_PROXY означает «только прямое соединение»: parseRoutes("")
# возвращает единственный маршрут direct connection. Проверено на коде.
if grep -qE '^TELEGRAM_PROXY=' .env; then
  BEFORE=$(grep -E '^TELEGRAM_PROXY=' .env | head -1)
  sed -i 's|^TELEGRAM_PROXY=.*|TELEGRAM_PROXY=""|' .env
  ok "было:  ${BEFORE:0:70}…"
  ok "стало: TELEGRAM_PROXY=\"\""
else
  echo 'TELEGRAM_PROXY=""' >> .env
  ok "добавлено TELEGRAM_PROXY=\"\""
fi

# ---------------------------------------------------------------------------
hdr "5/5  Остановка сборщика прокси"
# ---------------------------------------------------------------------------
# Контейнер не удаляем, а останавливаем: вернуть его — одна команда.
if docker ps --format '{{.Names}}' | grep -q '^hcg_proxy$'; then
  docker compose stop hcg_proxy >/dev/null 2>&1
  ok "hcg_proxy остановлен"
else
  ok "hcg_proxy и так не запущен"
fi

# Файлы аренды в томе больше не нужны: без них потребители идут напрямую.
# Имя тома спрашиваем у контейнера — Compose приписывает к нему имя проекта
# (/var/www/hcg -> hcg_hapstore-data), и жёстко зашитое имя тут промахнулось бы.
LEASE_VOL=$(docker inspect hcg_app \
  --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' \
  2>/dev/null | tr -d '[:space:]')
if [ -n "$LEASE_VOL" ]; then
  docker run --rm -v "$LEASE_VOL":/data alpine \
    sh -c 'rm -f /data/lease-*.json /data/proxies.json /data/harvester-status.json 2>/dev/null' >/dev/null 2>&1
  ok "файлы аренды прокси убраны из тома $LEASE_VOL"
else
  warn "том не определился — файлы аренды остались (не страшно, они игнорируются)"
fi

echo
echo "  перезапускаю бот и сервер с новыми настройками…"
docker compose up -d --force-recreate hcg_app hcg_bot >/dev/null 2>&1
sleep 12

echo
hdr "Проверка результата"
docker logs hcg_bot --tail 25 2>&1 | grep -iE "прокси|proxy|direct|запущен|started|ошибк|error" | tail -10 | sed 's/^/     /'

if docker logs hcg_bot --tail 60 2>&1 | grep -qiE "direct connection|прям"; then
  ok "бот использует прямое соединение"
fi

echo
echo "${B}╔══════════════════════════════════════════════════╗${N}"
echo "${B}${G}║   Готово                                         ║${N}"
echo "${B}╚══════════════════════════════════════════════════╝${N}"
echo
echo "  ${B}Проверьте вручную:${N} напишите боту @hcg1_bot команду /start"
echo "  Если ответил — прокси больше не нужен, система стала проще."
echo
echo "  ${Y}Если бот молчит — откат одной командой:${N}"
echo "    ${C}cd $HCG_DIR${N}"
echo "    ${C}cp .env.до-отключения-прокси-$STAMP .env${N}"
echo "    ${C}docker compose up -d --force-recreate${N}"
echo
