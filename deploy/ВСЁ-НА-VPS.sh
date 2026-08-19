#!/usr/bin/env bash
# =============================================================================
#  HCG — всё на сервере, из одного места
# =============================================================================
#  Где запускать: на сервере (PuTTY), в каталоге проекта
#  Как:  bash deploy/ВСЁ-НА-VPS.sh
#
#  Единая точка входа. Windows больше не нужен ни для чего, кроме доступа
#  к серверу: развёртывание, отправка в GitHub и сборка приложения для
#  Android выполняются здесь.
#
#  Можно и без меню, по шагам:
#      bash deploy/ВСЁ-НА-VPS.sh все       — всё подряд
#      bash deploy/ВСЁ-НА-VPS.sh сервер    — только развернуть
#      bash deploy/ВСЁ-НА-VPS.sh github    — только отправить в GitHub
#      bash deploy/ВСЁ-НА-VPS.sh apk       — только собрать приложение
#      bash deploy/ВСЁ-НА-VPS.sh статус    — что сейчас работает
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

# Скрипты вызываются через bash, а не напрямую: флаг исполняемости теряется
# при распаковке архива и при копировании через облако. Раньше это выглядело
# как «permission denied» на ровном месте.
run_step() {
  local script="$1"; shift
  [ -f "$HERE/$script" ] || die "не найден $HERE/$script — архив неполный"
  bash "$HERE/$script" "$@"
}

banner() {
  echo
  echo "${B}╔══════════════════════════════════════════════════════╗${N}"
  echo "${B}║   HCG — управление на сервере                        ║${N}"
  echo "${B}╚══════════════════════════════════════════════════════╝${N}"
  echo "  каталог архива:  $ROOT"
  echo "  рабочий каталог: $TARGET"
}

# Архив, распакованный внутрь рабочего каталога, не даст разложить файлы:
# каталог нельзя скопировать сам в себя. Ловим это сразу, а не на шаге 4
# из 7 после резервного копирования — там ошибка выглядела как «не удалось
# скопировать файлы» и ничего не объясняла.
if [ "$(cd "$ROOT" && pwd -P)" = "$(cd "$TARGET" 2>/dev/null && pwd -P)" ]; then
  banner
  echo
  bad "архив распакован ВНУТРЬ рабочего каталога"
  echo
  echo "  Так развернуть нельзя: каталог не копируется сам в себя."
  echo "  Архив должен лежать ${B}рядом${N} с папкой проекта, а не в ней."
  echo
  echo "  ${B}Что сделать (скопируйте целиком):${N}"
  echo
  echo "      cd /var/www"
  echo "      mkdir -p hcg-new && unzip -o ~/HCG-VPS.zip -d hcg-new"
  echo "      bash hcg-new/deploy/ВСЁ-НА-VPS.sh"
  echo
  echo "  Ваш $TARGET и файл .env останутся нетронутыми:"
  echo "  скрипт сам разложит в них новые файлы и сделает резервную копию."
  echo
  exit 1
fi

# ---------------------------------------------------------------------------
#  Состояние
# ---------------------------------------------------------------------------
show_status() {
  hdr "Что сейчас работает"

  if ! command -v docker >/dev/null 2>&1; then
    bad "docker не установлен"
    return 1
  fi

  local dir="$TARGET"
  [ -f "$dir/docker-compose.yml" ] || dir="$ROOT"

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

  # Главный признак здоровья: бот действительно подключился к Telegram.
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

  # APK — не контейнер, поэтому проверяется отдельно, по файлу на диске.
  if [ -f /var/www/hcg-apk/Hapstore.apk ]; then
    ok "приложение собрано: /var/www/hcg-apk/Hapstore.apk ($(du -h /var/www/hcg-apk/Hapstore.apk | cut -f1))"
  else
    warn "приложение ещё не собрано"
  fi
  echo
}

# ---------------------------------------------------------------------------
#  Шаги
# ---------------------------------------------------------------------------
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
  # Отправлять надо то, что реально развёрнуто, а не содержимое архива:
  # иначе в репозиторий уедет версия без сделанных на сервере правок.
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
  echo "  Дальнейшие сборки — 1–3 минуты."
  echo
  if [ -f "$TARGET/apk/package.json" ]; then
    ( cd "$TARGET" && bash deploy/3-APK.sh )
  else
    run_step "3-APK.sh"
  fi
}

# ---------------------------------------------------------------------------
#  Режим без меню
# ---------------------------------------------------------------------------
if [ $# -gt 0 ]; then
  banner
  case "$1" in
    сервер|server|deploy)  step_server ;;
    github|гитхаб|git)     step_github ;;
    apk|апк|android)       step_apk ;;
    статус|status)         show_status ;;
    все|всё|all)
      step_server || die "развёртывание не удалось — остальные шаги пропущены"
      step_github || warn "отправка в GitHub не удалась — продолжаю"
      step_apk    || warn "сборку приложения завершить не удалось"
      show_status
      ;;
    *)
      die "неизвестная команда «$1». Доступны: все, сервер, github, apk, статус"
      ;;
  esac
  exit $?
fi

# ---------------------------------------------------------------------------
#  Меню
# ---------------------------------------------------------------------------
while true; do
  banner
  cat <<MENU

  ${B}1${N}  Развернуть игру          — разложить файлы, пересобрать, запустить
  ${B}2${N}  Отправить в GitHub       — сохранить код в репозиторий
  ${B}3${N}  Собрать приложение APK   — Android-приложение администратора
  ${B}4${N}  Всё сразу (1 → 2 → 3)
  ${B}5${N}  Показать состояние
  ${B}6${N}  Логи бота
  ${B}7${N}  Логи сборщика прокси
  ${B}0${N}  Выход

MENU
  printf "  Выберите пункт: "
  # Ctrl+D (или запуск без терминала) закрывает поток ввода. Без этой
  # проверки read молча возвращает пустую строку, цикл крутится дальше и
  # заваливает экран меню — замерено 132 000 строк за 10 секунд.
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
      echo "  Выход из просмотра — Ctrl+C (контейнер продолжит работать)"
      echo
      docker logs --tail 60 -f hcg_bot 2>&1 || warn "контейнер hcg_bot не найден"
      ;;
    7)
      echo "  Выход из просмотра — Ctrl+C (контейнер продолжит работать)"
      echo
      docker logs --tail 60 -f hcg_proxy 2>&1 || warn "контейнер hcg_proxy не найден"
      ;;
    0|q|Q|выход) echo "  До связи."; echo; exit 0 ;;
    *) warn "нет такого пункта: «$choice»" ;;
  esac

  echo
  printf "  ${C}Enter — вернуться в меню${N} "
  read -r _ || { echo; exit 0; }
done
