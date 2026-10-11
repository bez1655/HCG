#!/usr/bin/env bash
# =============================================================================
#  HCG — всё на сервере, из одного места
# =============================================================================
#  Где:  на сервере (PuTTY), в каталоге проекта
#  Как:  bash deploy/ВСЁ-НА-VPS.sh
#
#  Без меню:
#      bash deploy/ВСЁ-НА-VPS.sh все
#      bash deploy/ВСЁ-НА-VPS.sh сервер
#      bash deploy/ВСЁ-НА-VPS.sh github
#      bash deploy/ВСЁ-НА-VPS.sh apk
#      bash deploy/ВСЁ-НА-VPS.sh статус
#      bash deploy/ВСЁ-НА-VPS.sh проверка
#      bash deploy/ВСЁ-НА-VPS.sh бот
#      bash deploy/ВСЁ-НА-VPS.sh игрок hapalka228
#      bash deploy/ВСЁ-НА-VPS.sh напрямую
#      bash deploy/ВСЁ-НА-VPS.sh пересобрать
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }
die()  { echo; echo "${R}${B}ОСТАНОВЛЕНО: $*${N}"; echo; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TARGET="${HCG_DIR:-/var/www/hcg}"

run_step() {
  local script="$1"; shift
  [ -f "$HERE/$script" ] || die "не найден $HERE/$script — архив неполный"
  bash "$HERE/$script" "$@"
}

work_dir() {
  if [ -f "$TARGET/docker-compose.yml" ]; then
    echo "$TARGET"
  else
    echo "$ROOT"
  fi
}

banner() {
  echo
  echo "${B}╔══════════════════════════════════════════════════════╗${N}"
  echo "${B}║   HCG — управление на сервере                        ║${N}"
  echo "${B}╚══════════════════════════════════════════════════════╝${N}"
  echo "  каталог архива:  $ROOT"
  echo "  рабочий каталог: $TARGET"
}

# Archive unpacked inside the live directory cannot copy onto itself.
if [ "$(cd "$ROOT" && pwd -P)" = "$(cd "$TARGET" 2>/dev/null && pwd -P)" ]; then
  banner
  echo
  bad "архив распакован ВНУТРЬ рабочего каталога"
  echo
  echo "  Архив должен лежать ${B}рядом${N} с папкой проекта, а не в ней."
  echo
  echo "      cd /var/www"
  echo "      mkdir -p hcg-new && unzip -o ~/HCG-VPS.zip -d hcg-new"
  echo "      bash hcg-new/deploy/ВСЁ-НА-VPS.sh"
  echo
  exit 1
fi

show_status() {
  hdr "Что сейчас работает"

  if ! command -v docker >/dev/null 2>&1; then
    bad "docker не установлен"
    return 1
  fi

  local dir
  dir="$(work_dir)"

  echo
  ( cd "$dir" && docker compose ps 2>/dev/null ) || warn "не удалось получить список контейнеров"
  echo

  for name in hcg_app hcg_bot hcg_proxy; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${name}$"; then
      ok "$name — работает"
    else
      warn "$name — не запущен"
    fi
  done

  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hcg_bot$'; then
    if docker logs --tail 80 hcg_bot 2>&1 | grep -q "started successfully"; then
      ok "бот подключён к Telegram"
    else
      warn "бот пока не сообщил об успешном подключении"
      echo "      Смотреть: docker logs --tail 40 hcg_bot"
    fi
  fi

  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^hcg_proxy$'; then
    local n
    n=$(docker logs --tail 60 hcg_proxy 2>&1 | grep -o "в списке [0-9]* рабочих" | tail -1 | grep -o "[0-9]*")
    [ -n "$n" ] && ok "прокси в списке: $n" || ok "сборщик прокси запущен, первый цикл идёт"
  fi

  if curl -sf --max-time 4 http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    ok "сервер отвечает на /healthz"
  else
    warn "сервер не ответил на http://127.0.0.1:3001/healthz"
  fi

  if [ -f /var/www/hcg-apk/Hapstore.apk ]; then
    ok "приложение собрано: /var/www/hcg-apk/Hapstore.apk ($(du -h /var/www/hcg-apk/Hapstore.apk | cut -f1))"
  else
    warn "приложение ещё не собрано"
  fi
  echo
}

step_server() {
  hdr "РАЗВЁРТЫВАНИЕ"
  echo "  Разложит файлы, пересоберёт образы и запустит контейнеры."
  echo "  Данные игроков не пострадают: они в томе Docker, а не в папке."
  echo
  run_step "1-СЕРВЕР.sh"
}

step_github() {
  hdr "ОТПРАВКА В GITHUB"
  echo "  Отправляется рабочая копия из $TARGET."
  echo
  if [ -f "$TARGET/package.json" ] && [ -f "$TARGET/deploy/2-GITHUB.sh" ]; then
    ( cd "$TARGET" && bash deploy/2-GITHUB.sh )
  else
    warn "в $TARGET нет развёрнутого проекта — отправляю из архива"
    run_step "2-GITHUB.sh"
  fi
}

step_apk() {
  hdr "СБОРКА ПРИЛОЖЕНИЯ ДЛЯ ANDROID"
  echo "  Первый запуск: 10–20 минут, нужно ~4 ГБ на диске."
  echo
  if [ -f "$TARGET/apk/package.json" ]; then
    ( cd "$TARGET" && bash deploy/3-APK.sh )
  else
    run_step "3-APK.sh"
  fi
}

step_check() {
  hdr "ПРОВЕРКА .env И ЖИВОГО СЕРВЕРА"
  local dir
  dir="$(work_dir)"
  ( cd "$dir" && bash "$HERE/hcg-check.sh" )
}

step_bot_silent() {
  hdr "ПОЧЕМУ МОЛЧИТ БОТ"
  local dir
  dir="$(work_dir)"
  ( cd "$dir" && bash "$HERE/hcg-бот-молчит.sh" )
}

step_player() {
  local who="${1:-hapalka228}"
  hdr "ДИАГНОСТИКА ИГРОКА @$who"
  bash "$HERE/ДИАГНОСТИКА-ИГРОКА.sh" "$who"
}

# Bot talks to Telegram directly. Harvester stays up for /proxies.
step_direct() {
  hdr "БОТ НАПРЯМУЮ, ПАРСЕР ОСТАЁТСЯ"
  local dir
  dir="$(work_dir)"
  cd "$dir" || die "нет каталога $dir"
  [ -f .env ] || die "нет .env"

  if curl -fsS -m 15 -o /dev/null -w '%{http_code}' https://api.telegram.org/ 2>/dev/null | grep -qE '^(200|302|404)$'; then
    ok "с хоста Telegram отвечает"
  else
    warn "с хоста Telegram может быть недоступен — всё равно ставлю BOT_USE_PROXY=0"
  fi

  STAMP="$(date +%Y%m%d-%H%M%S)"
  cp .env ".env.до-прямого-$STAMP"
  ok "копия .env: .env.до-прямого-$STAMP"

  if grep -qE '^BOT_USE_PROXY=' .env; then
    sed -i 's|^BOT_USE_PROXY=.*|BOT_USE_PROXY=0|' .env
  else
    echo 'BOT_USE_PROXY=0' >> .env
  fi
  ok "BOT_USE_PROXY=0"

  docker compose up -d --force-recreate hcg_app hcg_bot >/dev/null 2>&1
  docker compose up -d hcg_proxy >/dev/null 2>&1
  sleep 8
  ok "hcg_app и hcg_bot перезапущены, hcg_proxy оставлен"
  docker logs --tail 20 hcg_bot 2>&1 | sed 's/^/     /'
}

step_rebuild() {
  hdr "ПЕРЕСБОРКА app + bot (парсер не трогаем)"
  local dir
  dir="$(work_dir)"
  cd "$dir" || die "нет каталога $dir"
  docker compose up -d --build hcg_app hcg_bot
  show_status
}

if [ $# -gt 0 ]; then
  banner
  case "$1" in
    сервер|server|deploy)  step_server ;;
    github|гитхаб|git)     step_github ;;
    apk|апк|android)       step_apk ;;
    статус|status)         show_status ;;
    проверка|check)        step_check ;;
    бот|bot|молчит)        step_bot_silent ;;
    игрок|player|diag)     step_player "${2:-hapalka228}" ;;
    напрямую|direct)       step_direct ;;
    пересобрать|rebuild)   step_rebuild ;;
    все|всё|all)
      step_server || die "развёртывание не удалось — остальные шаги пропущены"
      step_github || warn "отправка в GitHub не удалась — продолжаю"
      step_apk    || warn "сборку приложения завершить не удалось"
      show_status
      ;;
    *)
      die "неизвестная команда «$1». Доступны: все, сервер, github, apk, статус, проверка, бот, игрок, напрямую, пересобрать"
      ;;
  esac
  exit $?
fi

while true; do
  banner
  cat <<MENU

  ${B}1${N}  Развернуть игру
  ${B}2${N}  Отправить в GitHub
  ${B}3${N}  Собрать приложение APK
  ${B}4${N}  Всё сразу (1 → 2 → 3)
  ${B}5${N}  Показать состояние
  ${B}6${N}  Логи бота
  ${B}7${N}  Логи сборщика прокси
  ${B}8${N}  Проверка .env и сервера
  ${B}9${N}  Почему молчит бот
  ${B}10${N} Диагностика игрока (клетка / откат)
  ${B}11${N} Бот напрямую, парсер оставить
  ${B}12${N} Пересобрать app + bot
  ${B}0${N}  Выход

MENU
  printf "  Выберите пункт: "
  if ! read -r choice; then
    echo
    echo "  Ввод закрыт — выхожу."
    echo
    exit 0
  fi
  echo

  case "$choice" in
    1) step_server ;;
    2) step_github ;;
    3) step_apk ;;
    4)
      if step_server; then
        step_github || warn "отправка в GitHub не удалась — продолжаю"
        step_apk    || warn "сборку приложения завершить не удалось"
        show_status
      else
        bad "развёртывание не удалось — остальные шаги пропущены"
      fi
      ;;
    5) show_status ;;
    6)
      echo "  Выход из просмотра — Ctrl+C"
      echo
      docker logs --tail 60 -f hcg_bot 2>&1 || warn "контейнер hcg_bot не найден"
      ;;
    7)
      echo "  Выход из просмотра — Ctrl+C"
      echo
      docker logs --tail 60 -f hcg_proxy 2>&1 || warn "контейнер hcg_proxy не найден"
      ;;
    8) step_check ;;
    9) step_bot_silent ;;
    10)
      printf "  Ник игрока (Enter = hapalka228): "
      read -r who || who=""
      step_player "${who:-hapalka228}"
      ;;
    11) step_direct ;;
    12) step_rebuild ;;
    0|q|Q|выход) echo "  До связи."; echo; exit 0 ;;
    *) warn "нет такого пункта: «$choice»" ;;
  esac

  echo
  printf "  ${C}Enter — вернуться в меню${N} "
  read -r _ || { echo; exit 0; }
done
