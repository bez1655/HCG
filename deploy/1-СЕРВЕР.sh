#!/usr/bin/env bash
# =============================================================================
#  HCG — развёртывание на сервер, одной командой
# =============================================================================
#  Куда: на сервер (root@VM-744336), в /var/www/hcg
#  Как:  bash 1-СЕРВЕР.sh
#
#  Что делает:
#    • сохраняет резервную копию текущей версии и .env
#    • раскладывает новые файлы
#    • пересобирает образы начисто и запускает
#    • проверяет, что внутри контейнеров действительно новый код
#    • при неудаче предлагает откат
#
#  Ничего не спрашивает без необходимости и не трогает данные игроков:
#  они лежат в томе Docker, а не в папке проекта.
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }
die()  { echo; echo "${R}${B}ОСТАНОВЛЕНО: $*${N}"; echo; exit 1; }

TARGET="${HCG_DIR:-/var/www/hcg}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/hcg-backup-$STAMP"

echo "${B}╔══════════════════════════════════════════════════╗${N}"
echo "${B}║   HCG — развёртывание на сервер                  ║${N}"
echo "${B}╚══════════════════════════════════════════════════╝${N}"
echo "  откуда: $SRC"
echo "  куда:   $TARGET"

# ---------------------------------------------------------------------------
hdr "1/7  Проверка окружения"
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker не установлен"
docker compose version >/dev/null 2>&1 || die "docker compose недоступен"
ok "docker на месте"

[ -f "$SRC/docker-compose.yml" ] || die "запускайте скрипт из распакованного архива (нет docker-compose.yml)"

# Архив, распакованный ПРЯМО В рабочий каталог, ломает шаг раскладки: tar
# читает и пишет один и тот же каталог, замечает изменения под собой и
# завершается кодом 1 («file changed as we read it»). Скрипт видел это как
# «не удалось скопировать файлы» и останавливался на 4/7, хотя с файлами
# всё в порядке. Моя недоработка: распаковать архив в саму папку проекта —
# самое естественное действие, и оно должно либо работать, либо
# объясняться. Здесь оно объясняется, потому что копировать каталог
# сам в себя бессмысленно.
if [ "$(cd "$SRC" && pwd -P)" = "$(cd "$TARGET" 2>/dev/null && pwd -P)" ]; then
  echo
  bad "архив распакован внутрь рабочего каталога ($TARGET)"
  echo
  echo "  Копировать каталог сам в себя нельзя. Распакуйте архив РЯДОМ:"
  echo
  echo "      ${B}cd /var/www${N}"
  echo "      ${B}mkdir -p hcg-new && unzip -o ~/HCG-VPS.zip -d hcg-new${N}"
  echo "      ${B}bash hcg-new/deploy/ВСЁ-НА-VPS.sh${N}"
  echo
  echo "  Рабочий каталог $TARGET и файл .env останутся нетронутыми —"
  echo "  скрипт сам разложит в него новые файлы."
  echo
  die "нужен отдельный каталог для архива"
fi
[ -f "$SRC/bot/src/version.ts" ] || die "это старая версия архива — скачайте свежий"
BUILD=$(grep -oE '"[0-9]{4}-[0-9]{2}-[0-9]{2}[^"]*"' "$SRC/bot/src/version.ts" | head -1 | tr -d '"')
ok "версия архива: ${B}${BUILD}${N}"

if [ ! -d "$TARGET" ]; then
  warn "каталог $TARGET не существует — создаю"
  mkdir -p "$TARGET" || die "не удалось создать $TARGET"
fi

# ---------------------------------------------------------------------------
hdr "2/7  Файл .env"
# ---------------------------------------------------------------------------
# .env — единственное, что нельзя потерять: там все секреты.
if [ -f "$TARGET/.env" ]; then
  # Копия .env важнее всего остального: без него сервер не стартует, а
  # восстановить содержимое неоткуда. Молчаливый провал здесь недопустим.
  if cp "$TARGET/.env" "/root/.env-hcg-$STAMP" 2>/dev/null; then
    ok "копия .env сохранена: /root/.env-hcg-$STAMP"
  else
    ENV_BACKUP="$TARGET/.env.backup-$STAMP"
    cp "$TARGET/.env" "$ENV_BACKUP" 2>/dev/null \
      || die "не удалось сделать копию .env — проверьте место на диске и права"
    warn "нет доступа к /root, копия .env здесь: $ENV_BACKUP"
  fi

  # Windows-переносы уже ломали конфиг раньше — чиним молча.
  if grep -q $'\r' "$TARGET/.env"; then
    sed -i 's/\r$//' "$TARGET/.env"
    warn "убраны windows-переносы из .env"
  fi

  MISSING=""
  for KEY in ADMIN_PASSWORD_HASH SESSION_SECRET INTERNAL_API_SECRET TELEGRAM_BOT_TOKEN WEB_APP_URL; do
    grep -qE "^${KEY}=.+" "$TARGET/.env" || MISSING="$MISSING $KEY"
  done
  [ -z "$MISSING" ] && ok "обязательные переменные заполнены" \
                    || warn "пустые переменные:$MISSING"
else
  warn ".env отсутствует"
  echo
  echo "  Создайте его перед запуском. Минимум:"
  echo "      cd $TARGET"
  echo "      npm run setup-env -- --password 'ваш-пароль-админа'"
  echo "  затем впишите TELEGRAM_BOT_TOKEN, WEB_APP_URL, TELEGRAM_ADMIN_USERNAME"
  die "нет .env"
fi

# ---------------------------------------------------------------------------
hdr "3/7  Резервная копия"
# ---------------------------------------------------------------------------
if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  # Если /root недоступен (нет прав, нет места) — кладём рядом. Проверяем
  # результат: первая версия скрипта рапортовала об успехе даже когда
  # mkdir падал, и откатываться было бы не с чего.
  if ! mkdir -p "$BACKUP" 2>/dev/null; then
    BACKUP="$(dirname "$TARGET")/hcg-backup-$STAMP"
    mkdir -p "$BACKUP" 2>/dev/null || die "не удалось создать каталог для резервной копии"
    warn "нет доступа к /root, резервная копия здесь: $BACKUP"
  fi

  tar -C "$TARGET" --exclude=node_modules --exclude=.git --exclude=dist \
      -cf - . 2>/dev/null | tar -C "$BACKUP" -xf - 2>/dev/null

  if [ -n "$(ls -A "$BACKUP" 2>/dev/null)" ]; then
    ok "копия текущей версии: $BACKUP"
  else
    die "резервная копия пуста — прерываю, чтобы не остаться без отката"
  fi
else
  BACKUP=""
  ok "каталог пуст — копировать нечего"
fi

# ---------------------------------------------------------------------------
hdr "4/7  Раскладка новых файлов"
# ---------------------------------------------------------------------------
# Мусор от прошлых версий: unzip его не удаляет, а старый ключ Firebase
# оставлять на диске нельзя.
for JUNK in firebase-applet-config.json firebase-blueprint.json bun.lock metadata.json; do
  if [ -e "$TARGET/$JUNK" ]; then
    rm -f "$TARGET/$JUNK"
    ok "удалён устаревший $JUNK"
  fi
done

# Копируем всё, кроме служебного и .env.
#
# Ошибки tar НЕ глушатся в /dev/null: раньше глушились, и любая причина
# сводилась к безликому «не удалось скопировать файлы». Вместо этого текст
# ошибки сохраняется и показывается — без него диагностика сводится
# к гаданию.
COPY_ERR="/tmp/hcg-copy-$STAMP.log"
# deploy/ копируется вместе со всем остальным. Раньше он исключался, и в
# рабочем каталоге скриптов не оказывалось: меню было вынуждено запускать
# сборку APK из каталога архива, то есть собирать не то, что развёрнуто.
# Теперь рядом с проектом всегда лежат актуальные скрипты, и повторный
# запуск возможен прямо из /var/www/hcg без исходного архива.
tar -C "$SRC" --exclude=.git --exclude=node_modules \
    --exclude=.env --exclude=apk/node_modules --exclude=apk/www \
    -cf - . 2>"$COPY_ERR" | tar -C "$TARGET" -xf - 2>>"$COPY_ERR"
COPY_RC=${PIPESTATUS[1]}

# Судим по РАСПАКОВКЕ, а не по чтению. Читающий tar выдаёт код 1 на
# безобидных предупреждениях вроде «file changed as we read it» — например,
# когда работающий контейнер пишет лог внутри каталога. Файлы при этом
# скопированы полностью, и падать тут значит останавливать исправное
# развёртывание.
if [ "$COPY_RC" != 0 ]; then
  bad "не удалось разложить файлы"
  [ -s "$COPY_ERR" ] && sed 's/^/      /' "$COPY_ERR" | head -10
  die "ошибка копирования (подробности выше, полный текст: $COPY_ERR)"
fi

if [ -s "$COPY_ERR" ]; then
  warn "tar предупредил (на копирование не повлияло):"
  sed 's/^/      /' "$COPY_ERR" | head -3
fi
rm -f "$COPY_ERR"
ok "файлы разложены"

cd "$TARGET" || die "не удалось перейти в $TARGET"

if grep -q "self_register" bot/src/index.ts 2>/dev/null; then
  ok "новый код бота на месте"
else
  die "в bot/src/index.ts нет новых кнопок — архив неполный"
fi

# ---------------------------------------------------------------------------
hdr "5/7  Сборка образов (2–5 минут)"
# ---------------------------------------------------------------------------
# --no-cache обязателен: Docker уже подсовывал старый слой.
echo "  Идёт сборка, это долго. Не прерывайте."
if docker compose build --no-cache >/tmp/hcg-build.log 2>&1; then
  ok "образы собраны"
else
  bad "сборка не удалась. Последние строки:"
  tail -20 /tmp/hcg-build.log | sed 's/^/      /'
  echo
  echo "  Полный лог: /tmp/hcg-build.log"
  echo "  Откат:      rm -rf $TARGET && cp -r $BACKUP $TARGET"
  die "ошибка сборки"
fi

# ---------------------------------------------------------------------------
hdr "6/7  Запуск"
# ---------------------------------------------------------------------------
docker compose up -d --remove-orphans >/tmp/hcg-up.log 2>&1 \
  || { tail -15 /tmp/hcg-up.log | sed 's/^/      /'; die "не удалось запустить"; }
ok "контейнеры запущены"

echo "  Жду готовности сервера..."
READY=0
for i in $(seq 1 40); do
  if curl -sf --max-time 3 http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 2
done
[ "$READY" = 1 ] && ok "сервер отвечает" || warn "сервер не ответил за 80 с — проверьте логи"

# ---------------------------------------------------------------------------
hdr "7/7  Проверка того, что реально запустилось"
# ---------------------------------------------------------------------------
FAIL=0

if docker exec hcg_bot grep -q "self_register" dist/index.js 2>/dev/null; then
  ok "бот: новый код внутри контейнера"
else
  bad "бот: внутри контейнера старый код"; FAIL=1
fi

if docker exec hcg_app grep -q "telegram/auth" dist/server.cjs 2>/dev/null; then
  ok "сервер: вход без пароля на месте"
else
  bad "сервер: старая сборка"; FAIL=1
fi

sleep 3
LOGS=$(docker logs --tail 60 hcg_bot 2>&1 || echo "")

if echo "$LOGS" | grep -q "started successfully"; then
  ok "бот подключился к Telegram"
elif echo "$LOGS" | grep -qE "401|Unauthorized"; then
  bad "Telegram отверг токен (401) — токен неверный или отозван"; FAIL=1
elif echo "$LOGS" | grep -qE "ETIMEDOUT|НЕТ ОТВЕТА"; then
  bad "Telegram недоступен с этого сервера"
  echo "      Нужен прокси: TELEGRAM_PROXY=socks5://хост:порт в .env"
  FAIL=1
elif echo "$LOGS" | grep -qE "409|Conflict"; then
  bad "конфликт: тем же токеном пользуется другой процесс"; FAIL=1
else
  warn "бот ещё подключается — проверьте: docker logs --tail 30 hcg_bot"
fi

TRANSPORT=$(docker logs --tail 40 hcg_app 2>&1 | grep -o "Telegram transport[^\"]*" | tail -1)
[ -n "$TRANSPORT" ] && ok "сервер: ${TRANSPORT}"

# Сборщик прокси. Отдельный контейнер, появился позже двух остальных, поэтому
# проверяется мягко: его отсутствие — не повод считать развёртывание
# неудачным, игра работает и без него.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hcg_proxy$'; then
  PLOG=$(docker logs --tail 40 hcg_proxy 2>&1 || echo "")
  PCOUNT=$(echo "$PLOG" | grep -o "в списке [0-9]* рабочих" | tail -1 | grep -o "[0-9]*")
  if [ -n "$PCOUNT" ] && [ "$PCOUNT" -gt 0 ]; then
    ok "сборщик прокси: рабочих адресов — $PCOUNT"
  elif echo "$PLOG" | grep -q "Цикл 1"; then
    ok "сборщик прокси: первый цикл идёт (30–60 секунд)"
  else
    warn "сборщик прокси запущен, но ещё ничего не сообщил"
    echo "      Посмотреть: docker compose logs -f hcg_proxy"
  fi
else
  warn "контейнер hcg_proxy не запущен"
  echo "      Список прокси не будет обновляться сам."
  echo "      Проверьте: docker compose ps"
fi

# ---------------------------------------------------------------------------
echo
if [ "$FAIL" = 0 ]; then
  echo "${G}${B}╔══════════════════════════════════════════════════╗${N}"
  echo "${G}${B}║   ГОТОВО. Игра развёрнута.                       ║${N}"
  echo "${G}${B}╚══════════════════════════════════════════════════╝${N}"
  cat <<'NEXT'

  Дальше вручную — два действия в Telegram:

    1. Отправьте боту НОВУЮ команду /start
       (в старом сообщении кнопки не меняются никогда)

    2. Проверьте /pending — команда только для администратора

NEXT
else
  echo "${R}${B}Развёртывание прошло, но проверки нашли проблемы (см. выше).${N}"
  echo
  echo "  Диагностика:  docker logs --tail 50 hcg_bot"
  echo "  Откат:        rm -rf $TARGET && cp -r $BACKUP $TARGET && cd $TARGET && docker compose up -d"
fi
echo "  Резервная копия: $BACKUP"
echo "  Копия .env:      /root/.env-hcg-$STAMP"
echo
exit $FAIL
