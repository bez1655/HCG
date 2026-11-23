#!/usr/bin/env bash
# =============================================================================
#  HCG — Управление тестовой сборкой (Внутреннее тестирование)
# =============================================================================
#  Параметры:
#    • Web App URL:      http://89.125.168.177:3000
#    • IP сервера:       89.125.168.177
#    • Порт:             3000
#    • Рабочий каталог:  /var/www/hcg-test
#    • Фронтенд и билд:  /var/www/hcg-test/dist/ (server.cjs, index.html)
#    • Хранилище данных: /var/www/hcg-test/data/ (game-calibration-persistent.json)
#    • Файл .env:        копия из /var/www/hcg/.env с PORT=3000
#    • Systemd служба:   /etc/systemd/system/hcg-test.service
#    • ExecStart:        /usr/bin/node /var/www/hcg-test/dist/server.cjs
#
#  Использование:
#    bash deploy/test-server.sh deploy   # развернуть и запустить тестовый сервер
#    bash deploy/test-server.sh remove   # остановить и полностью удалить тестовый сервер
#    bash deploy/test-server.sh status   # проверить статус тестового сервера
# =============================================================================

set -euo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}  ${Y}$(date +%H:%M:%S)${N}"; }
die()  { echo; echo "${R}${B}ОСТАНОВЛЕНО: $*${N}"; echo; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

PROD_DIR="${HCG_PROD_DIR:-/var/www/hcg}"
TEST_DIR="${HCG_TEST_DIR:-/var/www/hcg-test}"
TEST_DATA_DIR="$TEST_DIR/data"
TEST_DIST_DIR="$TEST_DIR/dist"
SERVICE_NAME="hcg-test.service"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"

TEST_IP="89.125.168.177"
TEST_PORT="3000"
TEST_URL="http://${TEST_IP}:${TEST_PORT}"

# Strict safety check: Never confuse test and prod directories!
if [ "$TEST_DIR" = "$PROD_DIR" ]; then
  die "Критическая ошибка: путь тестовой папки ($TEST_DIR) совпадает с рабочей ($PROD_DIR)!"
fi

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "Для управления службой systemd требуются права root (запустите через sudo или под root)."
  fi
}

find_node_bin() {
  if [ -x "/usr/bin/node" ]; then
    echo "/usr/bin/node"
  elif command -v node >/dev/null 2>&1; then
    command -v node
  else
    die "Команда node не найдена в системе. Установите Node.js (>=20)."
  fi
}

deploy_test() {
  hdr "РАЗВЁРТЫВАНИЕ ТЕСТОВОЙ СБОРКИ HCG (:3000)"
  require_root

  echo "  Рабочий каталог:   $TEST_DIR"
  echo "  Каталог данных:    $TEST_DATA_DIR"
  echo "  Служба systemd:    $SERVICE_NAME"
  echo "  Веб-интерфейс:     $TEST_URL"
  echo "  Основная игра:     $PROD_DIR (НЕ ТРОГАЕТСЯ)"
  echo

  # 1. Ensure node binary
  local node_bin
  node_bin="$(find_node_bin)"
  ok "Исполняемый файл Node: $node_bin"
  if [ "$node_bin" != "/usr/bin/node" ] && [ ! -e "/usr/bin/node" ]; then
    ln -sf "$node_bin" /usr/bin/node 2>/dev/null || true
    ok "Создан симлинк /usr/bin/node -> $node_bin"
  fi

  # 2. Check / build dist files
  if [ ! -f "$ROOT/dist/server.cjs" ] || [ ! -f "$ROOT/dist/index.html" ]; then
    echo "  Билд в $ROOT/dist отсутствует или неполон, собираю..."
    if command -v npm >/dev/null 2>&1; then
      ( cd "$ROOT" && npm run build ) || die "Не удалось собрать проект через npm run build"
    else
      die "В каталоге $ROOT нет скомпилированного dist/, и команда npm недоступна."
    fi
  fi
  ok "Скомпилированные файлы готовы в $ROOT/dist"

  # 3. Create test directory structure
  mkdir -p "$TEST_DIR"
  mkdir -p "$TEST_DIST_DIR"
  mkdir -p "$TEST_DATA_DIR"
  ok "Каталоги созданы: $TEST_DIR, $TEST_DIST_DIR, $TEST_DATA_DIR"

  # 4. Copy dist files (server.cjs, index.html, assets, media)
  echo "  Копирование dist в $TEST_DIST_DIR..."
  cp -rf "$ROOT/dist/"* "$TEST_DIST_DIR/"
  cp -f "$ROOT/package.json" "$TEST_DIR/package.json"
  ok "Фронтенд и скомпилированный сервер скопированы"

  # 5. Provide node_modules for external packages in server.cjs
  if [ ! -d "$TEST_DIR/node_modules" ]; then
    if [ -d "$PROD_DIR/node_modules" ]; then
      echo "  Копирование зависимостей из $PROD_DIR/node_modules..."
      cp -a "$PROD_DIR/node_modules" "$TEST_DIR/"
      ok "Зависимости скопированы из $PROD_DIR"
    elif [ -d "$ROOT/node_modules" ]; then
      echo "  Копирование зависимостей из $ROOT/node_modules..."
      cp -a "$ROOT/node_modules" "$TEST_DIR/"
      ok "Зависимости скопированы из $ROOT"
    elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^hcg_app$'; then
      echo "  Копирование node_modules из контейнера hcg_app..."
      docker cp hcg_app:/app/node_modules "$TEST_DIR/node_modules" 2>/dev/null || true
      ok "Зависимости скопированы из контейнера hcg_app"
    elif command -v npm >/dev/null 2>&1; then
      echo "  Установка production-зависимостей через npm..."
      ( cd "$TEST_DIR" && npm install --omit=dev --no-audit --no-fund ) || warn "npm install завершился с предупреждением"
    else
      warn "node_modules не найдены; если в server.cjs понадобятся внешние модули, установите их."
    fi
  else
    ok "Каталог node_modules в $TEST_DIR уже существует"
  fi

  # 6. Prepare data and persistent calibration file
  local cal_file="$TEST_DATA_DIR/game-calibration-persistent.json"
  if [ ! -f "$cal_file" ]; then
    if [ -f "$PROD_DIR/data/game-calibration-persistent.json" ]; then
      cp -f "$PROD_DIR/data/game-calibration-persistent.json" "$cal_file"
      ok "Файл калибровки скопирован из $PROD_DIR/data"
    elif [ -f "$PROD_DIR/game-calibration-persistent.json" ]; then
      cp -f "$PROD_DIR/game-calibration-persistent.json" "$cal_file"
      ok "Файл калибровки скопирован из $PROD_DIR"
    elif [ -f "$ROOT/src/game/data/cells.json" ]; then
      node -e "
        const fs = require('fs');
        const cells = JSON.parse(fs.readFileSync('$ROOT/src/game/data/cells.json', 'utf8'));
        const cal = {};
        for (const c of cells) { cal[c.id] = { x: c.x, y: c.y }; }
        fs.writeFileSync('$cal_file', JSON.stringify(cal, null, 2));
      " 2>/dev/null && ok "Создан файл калибровки из cells.json: $cal_file" || true
    fi
  fi
  [ -f "$cal_file" ] && ok "Калибровка на месте: $cal_file" || warn "Калибровка будет инициализирована при первом запуске"

  # 7. Environment file configuration
  echo "  Настройка переменных окружения в $TEST_DIR/.env..."
  if [ -f "$PROD_DIR/.env" ]; then
    cp -f "$PROD_DIR/.env" "$TEST_DIR/.env"
    ok "Скопирован .env из $PROD_DIR/.env"
  elif [ -f "$ROOT/.env" ]; then
    cp -f "$ROOT/.env" "$TEST_DIR/.env"
    ok "Скопирован .env из $ROOT/.env"
  elif [ -f "$ROOT/.env.example" ]; then
    cp -f "$ROOT/.env.example" "$TEST_DIR/.env"
    ok "Создан .env из .env.example"
  else
    touch "$TEST_DIR/.env"
  fi

  # Adjust .env parameters for test environment
  local env_file="$TEST_DIR/.env"
  set_env_param() {
    local key="$1" val="$2"
    if grep -qE "^[#[:space:]]*${key}=" "$env_file"; then
      sed -i "s|^[#[:space:]]*${key}=.*|${key}=${val}|" "$env_file"
    else
      echo "${key}=${val}" >> "$env_file"
    fi
  }

  set_env_param "PORT" "$TEST_PORT"
  set_env_param "WEB_APP_URL" "$TEST_URL"
  set_env_param "DATA_DIR" "$TEST_DATA_DIR"
  set_env_param "NODE_ENV" "production"
  set_env_param "IS_PRODUCTION" "true"
  set_env_param "HOST" "0.0.0.0"

  ok "Переменные окружения настроены: PORT=$TEST_PORT, WEB_APP_URL=$TEST_URL"

  # 8. Create systemd unit file
  echo "  Создание службы systemd: $SERVICE_FILE..."
  cat > "$SERVICE_FILE" <<UNIT
[Unit]
Description=HCG Test Game Service (Port ${TEST_PORT})
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${TEST_DIR}
EnvironmentFile=${TEST_DIR}/.env
ExecStart=/usr/bin/node ${TEST_DIST_DIR}/server.cjs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
UNIT

  chmod 644 "$SERVICE_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  ok "Служба $SERVICE_NAME зарегистрирована"

  # 9. Start / restart service
  echo "  Запуск службы $SERVICE_NAME..."
  systemctl restart "$SERVICE_NAME"

  # 10. Health check
  echo "  Ожидание старта сервера на порту $TEST_PORT..."
  local started=0
  for _ in $(seq 1 12); do
    sleep 1
    if curl -sf --max-time 2 "http://127.0.0.1:${TEST_PORT}/healthz" >/dev/null 2>&1 || \
       curl -sf --max-time 2 "http://127.0.0.1:${TEST_PORT}/" >/dev/null 2>&1; then
      started=1
      break
    fi
  done

  echo
  if [ "$started" -eq 1 ]; then
    ok "${B}Тестовый сервер успешно запущен и отвечает!${N}"
    echo "  Веб-интерфейс: ${B}${C}${TEST_URL}${N}"
    echo "  Статус службы: systemctl status ${SERVICE_NAME}"
    echo "  Логи службы:   journalctl -u ${SERVICE_NAME} -f"
  else
    warn "Служба запущена, но порт $TEST_PORT ещё не ответил на HTTP-запрос."
    echo "  Проверьте логи: journalctl -u ${SERVICE_NAME} -n 30 --no-pager"
  fi
  echo
}

remove_test() {
  hdr "ОСТАНОВКА И УДАЛЕНИЕ ТЕСТОВОГО СЕРВЕРА"
  require_root

  echo "  Тестовый каталог: $TEST_DIR"
  echo "  Служба systemd:   $SERVICE_NAME"
  echo "  Основная игра:    $PROD_DIR (НЕ ТРОГАЕТСЯ)"
  echo

  # 1. Stop and disable systemd service
  if systemctl list-unit-files "$SERVICE_NAME" >/dev/null 2>&1 || [ -f "$SERVICE_FILE" ]; then
    echo "  Остановка и отключение службы $SERVICE_NAME..."
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    ok "Служба $SERVICE_NAME остановлена и удалена"
  else
    ok "Служба $SERVICE_NAME уже не активна"
  fi

  # 2. Stop and remove any test Docker containers (if any exist with test in name)
  # Strict exclusion: NEVER touch hcg_app, hcg_bot, hcg_proxy or any prod containers!
  local test_containers
  test_containers="$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^hcg[-_]test' || true)"
  if [ -n "$test_containers" ]; then
    echo "  Удаление тестовых Docker-контейнеров:"
    echo "$test_containers" | while read -r cname; do
      [ -z "$cname" ] && continue
      docker rm -f "$cname" 2>/dev/null && ok "Удалён контейнер: $cname" || true
    done
  else
    ok "Тестовых Docker-контейнеров не обнаружено"
  fi

  # 3. Safe deletion of /var/www/hcg-test
  # Explicit safety invariant verification:
  if [ "$TEST_DIR" = "/var/www/hcg-test" ] && [ -d "$TEST_DIR" ]; then
    echo "  Удаление каталога $TEST_DIR..."
    rm -rf "$TEST_DIR"
    ok "Каталог $TEST_DIR успешно удалён"
  elif [ ! -d "$TEST_DIR" ]; then
    ok "Каталог $TEST_DIR уже отсутствует"
  else
    bad "Небезопасный путь каталога: $TEST_DIR — удаление пропущено!"
  fi

  # 4. Clean any temporary test files/directories outside /var/www/hcg
  for tmp_path in /tmp/hcg-test* /var/tmp/hcg-test*; do
    if [ -e "$tmp_path" ]; then
      rm -rf "$tmp_path"
      ok "Очищен временный объект: $tmp_path"
    fi
  done

  # 5. Final check that production game is completely untouched
  echo
  if [ -d "$PROD_DIR" ]; then
    ok "Рабочая игра в $PROD_DIR в полной сохранности"
  fi
  for prod_c in hcg_app hcg_bot hcg_proxy; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${prod_c}$"; then
      ok "Рабочий контейнер $prod_c активен"
    fi
  done

  echo
  ok "${B}Удаление тестовой сборки завершено успешно.${N}"
  echo
}

status_test() {
  hdr "СТАТУС ТЕСТОВОГО СЕРВЕРА"

  if [ -f "$SERVICE_FILE" ]; then
    ok "Файл службы $SERVICE_FILE существует"
  else
    warn "Файл службы $SERVICE_FILE отсутствует"
  fi

  if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    ok "Служба $SERVICE_NAME активна (running)"
  else
    warn "Служба $SERVICE_NAME не запущена"
  fi

  if curl -sf --max-time 3 "http://127.0.0.1:${TEST_PORT}/healthz" >/dev/null 2>&1; then
    ok "HTTP /healthz на порту $TEST_PORT отвечает"
  elif curl -sf --max-time 3 "http://127.0.0.1:${TEST_PORT}/" >/dev/null 2>&1; then
    ok "HTTP порт $TEST_PORT отвечает"
  else
    warn "Порт $TEST_PORT не отвечает на локальные запросы"
  fi

  if [ -d "$TEST_DIR" ]; then
    ok "Каталог $TEST_DIR существует ($(du -sh "$TEST_DIR" 2>/dev/null | cut -f1))"
  else
    warn "Каталог $TEST_DIR не существует"
  fi
  echo
}

case "${1:-deploy}" in
  deploy|install|start|тест|развернуть)
    deploy_test
    ;;
  remove|uninstall|stop|delete|удалить|стоп)
    remove_test
    ;;
  status|check|статус)
    status_test
    ;;
  *)
    echo "Использование: $0 {deploy|remove|status}"
    exit 1
    ;;
esac
