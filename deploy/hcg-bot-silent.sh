#!/usr/bin/env bash
# =============================================================================
#  HCG — почему бот молчит
# =============================================================================
#  Запуск на сервере:  cd /var/www/hcg && bash hcg-бот-молчит.sh
#
#  Проверяет по порядку четыре вещи и называет ту, что сломалась:
#    1. работает ли контейнер и что он пишет
#    2. жив ли токен          (прямой запрос к Telegram)
#    3. жив ли прокси         (тот же запрос через него)
#    4. не занят ли токен вторым процессом
#
#  Ничего не меняет.
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }

[ -f docker-compose.yml ] || { echo "Запускайте из /var/www/hcg" >&2; exit 2; }

VERDICT=""; FIX=""

echo "${B}╔════════════════════════════════════════════╗${N}"
echo "${B}║  Почему молчит бот                         ║${N}"
echo "${B}╚════════════════════════════════════════════╝${N}"

TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')
PROXY=$(grep -E "^TELEGRAM_PROXY=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')

# ---------------------------------------------------------------------------
hdr "1/6  Контейнер"
# ---------------------------------------------------------------------------
ST=$(docker inspect -f '{{.State.Status}}' hcg_bot 2>/dev/null || echo "нет")
RC=$(docker inspect -f '{{.State.ExitCode}}' hcg_bot 2>/dev/null || echo "?")
RS=$(docker inspect -f '{{.RestartCount}}' hcg_bot 2>/dev/null || echo "?")
echo "     статус: $ST | код выхода: $RC | перезапусков: $RS"

LOGS=$(docker logs --tail 120 hcg_bot 2>&1 || echo "")

BUILD=$(echo "$LOGS" | grep -o "\[HCG bot\] build [^ ]*" | tail -1)
if [ -n "$BUILD" ]; then
  ok "работает: $BUILD"
else
  bad "метки сборки в логе нет — образ старый или бот не стартовал"
  VERDICT="Запущена старая сборка."
  FIX='docker compose build --no-cache hcg_bot && docker compose up -d'
fi

TRANSPORT=$(echo "$LOGS" | grep -o "Telegram transport: .*" | tail -1)
[ -n "$TRANSPORT" ] && echo "     $TRANSPORT"

if echo "$LOGS" | grep -q "started successfully"; then
  ok "бот сообщил об успешном подключении"
  CONNECTED=1
else
  warn "строки об успешном подключении нет"
  CONNECTED=0
fi

# Разбор ошибок из лога
if echo "$LOGS" | grep -qE "401|Unauthorized"; then
  bad "Telegram отверг токен (401)"
  VERDICT="Токен недействителен."
  FIX='Возьмите новый у @BotFather → /mybots → Bot Settings → API Token
  затем: nano .env  и  docker compose up -d --force-recreate hcg_bot'
elif echo "$LOGS" | grep -qE "409|Conflict|terminated by other"; then
  bad "конфликт 409 — тем же токеном пользуется другой процесс"
  VERDICT="Два бота с одним токеном."
  FIX='docker compose up -d --remove-orphans
  Проверьте, не запущен ли бот где-то ещё: docker ps -a | grep -i bot'
elif echo "$LOGS" | grep -q "НЕТ ОТВЕТА ОТ TELEGRAM"; then
  bad "сторож сработал: Telegram не ответил за 45 с"
  VERDICT="Прокси не пропускает трафик до Telegram."
elif echo "$LOGS" | grep -qE "ETIMEDOUT|ECONNREFUSED|ENOTFOUND"; then
  bad "сетевая ошибка при подключении"
  VERDICT="Telegram недоступен с этого сервера."
fi

echo
echo "     ${C}последние 8 строк лога:${N}"
echo "$LOGS" | tail -8 | sed 's/^/       /'

# ---------------------------------------------------------------------------
hdr "2/6  Токен — прямая проверка"
# ---------------------------------------------------------------------------
if [ -z "$TOKEN" ]; then
  bad "TELEGRAM_BOT_TOKEN пуст в .env"
  VERDICT="Нет токена."
  FIX='Впишите TELEGRAM_BOT_TOKEN в .env'
else
  echo "     длина токена: ${#TOKEN} символов"
  if ! echo "$TOKEN" | grep -qE '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$'; then
    bad "токен не похож на настоящий (ожидается «цифры:буквы»)"
    VERDICT="Токен записан неверно."
  fi

  echo "     запрос напрямую (без прокси), до 15 с..."
  RESP=$(timeout 20 curl -s -m 15 "https://api.telegram.org/bot${TOKEN}/getMe" 2>/dev/null)
  if echo "$RESP" | grep -q '"ok":true'; then
    NAME=$(echo "$RESP" | grep -o '"username":"[^"]*"' | head -1 | cut -d'"' -f4)
    ok "Telegram доступен НАПРЯМУЮ, бот: @${NAME}"
    ok "токен действителен"
    DIRECT_OK=1
  elif echo "$RESP" | grep -q '"error_code":401'; then
    bad "токен отвергнут (401) — недействителен"
    # Telegram ОТВЕТИЛ, значит сеть в порядке: проблема только в токене.
    ok "но сеть работает — Telegram доступен напрямую"
    VERDICT="Токен недействителен."
    FIX='Новый токен: @BotFather → /mybots → Bot Settings → API Token
  затем: nano .env  и  docker compose up -d --force-recreate hcg_bot'
    DIRECT_OK=1
  else
    warn "напрямую недоступен (ожидаемо, если Telegram блокируется)"
    DIRECT_OK=0
  fi
fi

# ---------------------------------------------------------------------------
hdr "3/6  Прокси"
# ---------------------------------------------------------------------------
if [ -z "$PROXY" ]; then
  if [ "${DIRECT_OK:-0}" = 1 ]; then
    ok "прокси не задан и не нужен — Telegram доступен напрямую"
  else
    bad "прокси не задан, а напрямую Telegram недоступен"
    VERDICT="Нужен прокси."
    FIX='Добавьте в .env:  TELEGRAM_PROXY=socks5://хост:порт'
  fi
else
  SCHEME="${PROXY%%://*}"
  REST="${PROXY#*://}"
  [[ "$REST" == *"@"* ]] && REST="${REST##*@}"
  echo "     прокси: ${SCHEME}://${REST}"

  case "$SCHEME" in
    socks5|socks5h|socks|socks4|socks4a) OPT=(--socks5-hostname "${PROXY#*://}") ;;
    *)                                   OPT=(--proxy "$PROXY") ;;
  esac

  echo "     запрос ЧЕРЕЗ прокси, до 30 с..."
  S=$(date +%s)
  PRESP=$(timeout 35 curl -s -m 30 "${OPT[@]}" "https://api.telegram.org/bot${TOKEN}/getMe" 2>/dev/null)
  PRC=$?
  EL=$(( $(date +%s) - S ))

  # Сначала смотрим, что ОТВЕТИЛ Telegram, и только потом на код возврата:
  # ответ с 401 приходит и при ненулевом коде, и он важнее таймаута.
  if echo "$PRESP" | grep -q '"ok":true'; then
    ok "прокси работает, ответ за ${EL} с"
    if [ "$EL" -gt 20 ]; then
      warn "но очень медленно — бот может не уложиться в лимит 45 с"
      VERDICT="Прокси слишком медленный."
    fi
  elif echo "$PRESP" | grep -q '"error_code":401'; then
    bad "прокси работает, но токен недействителен"
    VERDICT="Токен недействителен."
    FIX='Новый токен: @BotFather → /mybots → Bot Settings → API Token'
  elif [ "$PRC" -eq 28 ] || [ "$PRC" -eq 124 ]; then
    bad "таймаут за ${EL} с — ПРОКСИ НЕ ПРОПУСКАЕТ ТРАФИК"
    VERDICT="Прокси умер."
    FIX='Бесплатные прокси живут часы. Нужен рабочий:
    • VPS за рубежом (~$4/мес) + свой SOCKS5 — надёжнее всего;
    • платный SOCKS5 у провайдера прокси;
    • хостинг, с которого Telegram доступен напрямую.
  После замены: nano .env  и  docker compose up -d --force-recreate hcg_bot'
  else
    bad "прокси отказал (код curl $PRC): $(echo "$PRESP" | head -c 100)"
    VERDICT="Прокси не отвечает."
    FIX='Проверьте адрес, порт и — если требуется — логин с паролем:
      TELEGRAM_PROXY=socks5://логин:пароль@хост:порт'
  fi
fi

# ---------------------------------------------------------------------------
hdr "4/6  Двойники"
# ---------------------------------------------------------------------------
ORPH=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -iE "bot|hapstore|cyberpunk" | grep -v "^hcg_bot$" || true)
if [ -n "${ORPH:-}" ]; then
  bad "есть другие контейнеры, возможно с тем же токеном:"
  echo "$ORPH" | sed 's/^/       /'
  echo "       Убрать: docker compose up -d --remove-orphans"
else
  ok "посторонних контейнеров нет"
fi

# ---------------------------------------------------------------------------
hdr "5/6  Совпадает ли код внутри контейнера"
# ---------------------------------------------------------------------------
if docker exec hcg_bot grep -q "self_register" dist/index.js 2>/dev/null; then
  ok "новый код на месте"
elif docker exec hcg_bot test -f src/index.ts 2>/dev/null; then
  bad "внутри исходники, а не сборка — образ старый"
  VERDICT="Старый образ."
  FIX='docker compose build --no-cache hcg_bot && docker compose up -d'
else
  warn "проверить не удалось (контейнер не отвечает)"
fi

# ---------------------------------------------------------------------------
hdr "6/6  Сборщик прокси"
# ---------------------------------------------------------------------------
# Добавлено после случая со 168 перезапусками: в логе бота значилось
# «Прокси: 2 вариант(ов)», хотя сборщик обязан давать десяток. Причина была
# видна только тому, кто знал, что искать, — сам скрипт про hcg_proxy
# не спрашивал вовсе.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hcg_proxy$'; then
  ok "контейнер hcg_proxy работает"

  PLIST=$(docker exec hcg_proxy cat /app/data/proxies.txt 2>/dev/null | grep -c . || echo 0)
  if [ "$PLIST" -ge 15 ]; then
    ok "резерв прокси: $PLIST (норма 15-20)"
  elif [ "$PLIST" -gt 0 ]; then
    warn "резерв всего $PLIST — сборщик добирает (норма 15-20)"
  else
    warn "резерв пуст — сборщик ещё не нашёл ни одного рабочего адреса"
    echo "       Посмотреть: docker compose logs --tail 40 hcg_proxy"
  fi

  # Аренда: сколько прокси реально на руках у бота и сервера. Это и есть
  # то, чем они пользуются, — резерв сам по себе ничего не гарантирует.
  for WHO in bot server; do
    # Имя переменной НЕ N: $N в этом скрипте — код сброса цвета, и счётчик
    # затирал его, из-за чего ломался весь дальнейший вывод. Ловится только
    # запуском: глазами это выглядит совершенно безобидно.
    LEASED=$(docker exec hcg_proxy sh -c "grep -o '\"address\"' /app/data/lease-$WHO.json 2>/dev/null | wc -l" 2>/dev/null | tr -dc '0-9')
    [ -z "$LEASED" ] && LEASED=0
    if [ "$LEASED" -ge 5 ]; then
      ok "$WHO: $LEASED прокси в аренде"
    elif [ "$LEASED" -gt 0 ]; then
      warn "$WHO: только $LEASED прокси (должно быть 5)"
    else
      bad "$WHO: прокси не выданы"
      if [ -z "$VERDICT" ]; then
        VERDICT="Сборщик не выдал прокси потребителям."
        FIX='docker compose logs --tail 40 hcg_proxy'
      fi
    fi
  done

  # Тот же том глазами БОТА. Если тома разъехались, бот файл не увидит,
  # и сколько бы прокси ни нашёл сборщик, толку не будет.
  if docker exec hcg_bot test -f /app/data/lease-bot.json 2>/dev/null; then
    ok "бот видит свою аренду (общий том подключён)"
  elif [ "$PLIST" -gt 0 ]; then
    bad "сборщик работает, но БОТ не видит файл аренды — общий том не подключён"
    VERDICT="Контейнеры не делят том с прокси."
    FIX='docker compose down && docker compose up -d'
  fi
else
  bad "контейнер hcg_proxy НЕ ЗАПУЩЕН"
  echo "       Поэтому список прокси не пополняется, и бот пробует"
  echo "       только адреса из .env — пока они не умрут все."
  if [ -z "$VERDICT" ]; then
    VERDICT="Сборщик прокси не запущен."
    FIX='docker compose up -d hcg_proxy
docker compose logs --tail 30 hcg_proxy'
  fi
fi

# ---------------------------------------------------------------------------
echo
echo "${B}═══════════════ ВЫВОД ═══════════════${N}"
if [ -n "$VERDICT" ]; then
  echo "${R}${B}  $VERDICT${N}"
  [ -n "$FIX" ] && { echo; echo "${B}  ЧТО ДЕЛАТЬ:${N}"; echo "$FIX" | sed 's/^/  /'; }
elif [ "${CONNECTED:-0}" = 1 ]; then
  echo "${G}${B}  Бот подключён и работает.${N}"
  echo
  echo "  Если он всё же не отвечает в Telegram:"
  echo "    • отправьте НОВУЮ команду /start — в старом сообщении"
  echo "      кнопки не меняются никогда;"
  echo "    • проверьте, что пишете тому же боту, чей токен в .env"
  echo "      (имя бота видно выше, в пункте 2)."
else
  echo "${Y}  Однозначной причины не нашлось.${N}"
  echo "  Пришлите вывод: docker logs --tail 60 hcg_bot"
fi
echo
