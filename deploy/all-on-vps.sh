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
#      bash deploy/ВСЁ-НА-VPS.sh очистка
#      bash deploy/ВСЁ-НА-VPS.sh сервер-мусор
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }
die()  { echo; echo "${R}${B}ОСТАНОВЛЕНО: $*${N}"; echo; exit 1; }
now()  { date "+%H:%M:%S"; }
progress() {
  local n="$1" total="$2" title="$3"
  echo
  echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo "${B}${C}  ШАГ ${n}/${total}${N}  ${B}${title}${N}   ${Y}$(now)${N}"
  echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
}

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

# After a successful deploy: optionally announce the update to all players.
# Sends through the app container's own internal API (the server composes and
# delivers the Telegram messages itself), so no secrets leave the server and
# the bot's /update guard is mirrored here: live build must equal archive build.
step_update_broadcast() {
  hdr "РАССЫЛКА ОБ ОБНОВЛЕНИИ"

  if [ ! -t 0 ]; then
    warn "нет интерактивного ввода — рассылка пропущена (её можно сделать позже командой /update в боте)"
    return 0
  fi

  local answer=""
  printf "  Нужна ли рассылка игрокам о том, что обновление установлено? [y/N] "
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES|д|Д|да|ДА) ;;
    *)
      echo "  Рассылка выключена — игроки не получат сообщение об обновлении."
      echo "  Позже её можно отправить вручную: команда /update в боте."
      return 0
      ;;
  esac

  echo
  echo "  Введите текст обновления — что нового увидят игроки."
  echo "  Можно несколько строк; пустая строка — закончить ввод."
  echo "  Просто Enter без текста — стандартный текст про стабильность и связь."
  local whats_new="" line=""
  while true; do
    printf "  > "
    read -r line || break
    [ -z "$line" ] && break
    whats_new="${whats_new}${line}"$'\n'
  done
  whats_new="$(printf '%s' "$whats_new" | sed -e 's/[[:space:]]*$//')"
  if [ -z "$whats_new" ]; then
    whats_new="• Игра обновлена до актуальной версии."$'\n'"• Улучшены стабильность и соединение: игра сама переподключается, заново заходить через бота не нужно."
  fi

  # Expected build = the archive being deployed; live build = /healthz.
  local expected live
  expected="$(grep -o 'BUILD = "[^"]*"' "$ROOT/bot/src/version.ts" 2>/dev/null | head -1 | cut -d'"' -f2)"
  live="$(curl -sf --max-time 5 http://127.0.0.1:3001/healthz 2>/dev/null | grep -o '"build":"[^"]*"' | head -1 | cut -d'"' -f4)"
  if [ -z "$expected" ] || [ "$live" != "$expected" ]; then
    bad "сборка сервера («${live:-нет ответа}») не совпадает со сборкой архива («${expected:-?}») — рассылку не отправляю"
    echo "  Сначала добейтесь совпадения сборок, потом: /update в боте."
    return 1
  fi
  ok "сборка сервера совпадает с архивом: $expected"

  local text
  text="⚡ Обновление установлено (сборка ${expected})"$'\n\n'"Что нового:"$'\n'"${whats_new}"$'\n\n'"Если игра была открыта — закройте её и откройте кнопкой «ИГРАТЬ». Хороших бросков! 🎲"

  echo "  Отправляю рассылку всем игрокам..."
  local result
  result="$(printf '%s' "$text" | docker exec -i hcg_app node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", async () => {
      try {
        const res = await fetch("http://127.0.0.1:3000/api/admin/bot-broadcast", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Token": process.env.INTERNAL_API_SECRET || "",
          },
          body: JSON.stringify({ text: raw, admin: "deploy-script" }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          console.log("FAIL " + (data.error || ("HTTP " + res.status)));
          return;
        }
        console.log("OK " + (data.sent ?? 0) + " " + (data.total ?? 0) + " " + ((data.failed || []).join(", ")));
      } catch (e) {
        console.log("FAIL " + e.message);
      }
    });
  ' 2>/dev/null)"
  case "$result" in
    OK*)
      local _ok sent total failed
      read -r _ok sent total failed <<< "$result"
      ok "рассылка об обновлении отправлена: ${sent} из ${total}"
      [ -n "${failed:-}" ] && warn "не доставлено: $failed"
      ;;
    *)
      bad "рассылка не ушла: ${result#FAIL }"
      echo "  Её можно отправить вручную: команда /update в боте."
      return 1
      ;;
  esac
  return 0
}

step_import_past_logs() {
  hdr "ИМПОРТ ИСТОРИЧЕСКИХ ЛОГОВ ЗА ПРОШЕДШИЙ ПЕРИОД"
  local script="$TARGET/scripts/import-past-logs.sh"
  if [ ! -f "$script" ]; then
    script="$ROOT/scripts/import-past-logs.sh"
  fi
  if [ -f "$script" ]; then
    bash "$script" || warn "не удалось собрать исторические логи"
  else
    warn "скрипт $script не найден"
  fi
}

step_server() {
  echo
  echo "${B}╔══════════════════════════════════════════════════════╗${N}"
  echo "${B}║  РАЗВЁРТЫВАНИЕ HCG — ход работы на экране            ║${N}"
  echo "${B}╚══════════════════════════════════════════════════════╝${N}"
  echo "  Старт: $(now)"
  echo "  Архив: $ROOT"
  echo "  Куда:  $TARGET"
  echo "  Данные игроков в томе Docker — не трогаем."
  echo
  echo "  Будет 7 шагов внутри 1-СЕРВЕР.sh:"
  echo "    1 проверка Docker"
  echo "    2 файл .env"
  echo "    3 резервная копия"
  echo "    4 копирование файлов (сплэш, код, скрипты)"
  echo "    5 сборка образов — живой лог Docker, 2–5 мин"
  echo "    6 запуск контейнеров + ожидание /healthz"
  echo "    7 проверка BUILD в логах"
  echo
  progress 0 7 "запуск 1-СЕРВЕР.sh"
  run_step "1-server.sh"
  local rc=$?
  echo
  if [ "$rc" -eq 0 ]; then
    ok "развёртывание закончено  $(now)"
    step_import_past_logs || warn "шаг импорта логов завершён с предупреждением"
    step_update_broadcast || warn "шаг рассылки завершён с предупреждением — развёртывание при этом успешно"
  else
    bad "развёртывание остановилось с кодом $rc  $(now)"
  fi
  return "$rc"
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
  ( cd "$dir" && bash "$HERE/hcg-bot-silent.sh" )
}

step_player() {
  local who="${1:-hapalka228}"
  hdr "ДИАГНОСТИКА ИГРОКА @$who"
  bash "$HERE/player-diag.sh" "$who"
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

step_test_deploy() {
  bash "$HERE/test-server.sh" deploy
}

step_test_remove() {
  bash "$HERE/test-server.sh" remove
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
    очистка|clean)
      progress 1 1 "очистка папки от старых инструкций"
      bash "$HERE/cleanup-hcg-dir.sh" "$(work_dir)"
      ;;
    сервер-мусор|vps-clean)
      progress 1 1 "очистка всего VPS кроме HCG/ACG/Docker/Caddy/Amnezia"
      bash "$HERE/cleanup-vps.sh" "${2:-}"
      ;;
    пакеты|packages)
      bash "$HERE/cleanup-vps.sh" пакеты
      ;;
    логи|лог|logs|import-logs|ip-logs)
      step_import_past_logs
      ;;
    тест|test|test-deploy)
      step_test_deploy
      ;;
    тест-удалить|test-remove|test-clean|test-stop)
      step_test_remove
      ;;
    тест-статус|test-status)
      bash "$HERE/test-server.sh" status
      ;;
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
  ${B}13${N} Мусор на VPS (список; удаление — командой сервер-мусор)
  ${B}14${N} Пакеты: найти и отметить к удалению
  ${B}15${N} Импорт прошлых логов веб-сервера в журнал IP
  ${B}16${N} Тестовая сборка: развернуть отдельно (/var/www/hcg-test :3000)
  ${B}17${N} Тестовая сборка: остановить и удалить
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
    13)
      echo "  Сначала список. Удаление — отдельной командой."
      bash "$HERE/cleanup-vps.sh"
      ;;
    14) bash "$HERE/cleanup-vps.sh" пакеты ;;
    15) step_import_past_logs ;;
    16) step_test_deploy ;;
    17) step_test_remove ;;
    0|q|Q|выход) echo "  До связи."; echo; exit 0 ;;
    *) warn "нет такого пункта: «$choice»" ;;
  esac

  echo
  printf "  ${C}Enter — вернуться в меню${N} "
  read -r _ || { echo; exit 0; }
done
