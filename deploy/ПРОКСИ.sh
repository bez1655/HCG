#!/usr/bin/env bash
# Вставить список прокси в .env и перезапустить контейнеры.
#
# Зачем скрипт, а не «откройте .env в редакторе»: строку TELEGRAM_PROXY надо
# заменить целиком, не сломав кавычки и не продублировав переменную. Ошибка в
# кавычках выглядит как «бот опять молчит» и ищется полчаса.
#
# Запускать НА СЕРВЕРЕ, в каталоге проекта:
#   cd /var/www/hcg && bash deploy/ПРОКСИ.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# Проверенные 5 августа 2026 года. Порядок = приоритет: сначала самый быстрый.
PROXIES="socks5://101.36.104.239:10808,socks5://144.22.165.206:1088,socks5://220.158.232.118:1080"

echo
echo "════════════════════════════════════════════════════════════"
echo "  ВСТАВКА СПИСКА ПРОКСИ"
echo "════════════════════════════════════════════════════════════"
echo

if [ ! -f .env ]; then
  echo "  ✗ Файл .env не найден в $(pwd)"
  echo "    Вы точно в каталоге проекта? Нужно: cd /var/www/hcg"
  exit 1
fi

cp .env ".env.backup-$(date +%Y%m%d-%H%M%S)"
echo "  ✓ Копия старого .env сохранена рядом"

# ШАГ 1. Проверяем адреса ДО записи. Мёртвый прокси в списке безвреден (пул его
# отбросит), но знать реальную картину полезно: если не отвечает ни один,
# проблема не в списке, и перезапуск ничего не даст.
echo
echo "  Проверяю адреса живым запросом к Telegram..."
alive=0
IFS=',' read -ra LIST <<< "$PROXIES"
for p in "${LIST[@]}"; do
  hostport="${p#socks5://}"
  printf "    %-32s " "$hostport"
  # 401 = Telegram ответил и отверг фальшивый токен, значит маршрут живой.
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 \
    --socks5-hostname "$hostport" "https://api.telegram.org/bot0:TEST/getMe" 2>/dev/null || echo "000")
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then
    echo "✓ живой"
    alive=$((alive + 1))
  else
    echo "✗ не отвечает"
  fi
done

echo
if [ "$alive" -eq 0 ]; then
  echo "  ⚠ Ни один адрес не отвечает С ЭТОГО СЕРВЕРА."
  echo "    Список всё равно будет записан — пул перепроверяет адреса каждую"
  echo "    минуту и подхватит тот, что оживёт. Но если так и останется тихо,"
  echo "    дело не в списке: нужен свой SOCKS5 на зарубежном VPS."
  echo
else
  echo "  ✓ Живых адресов: $alive из ${#LIST[@]}"
  echo
fi

# ШАГ 2. Заменяем строку. Переменная может быть закомментирована, пустая или
# отсутствовать — обрабатываем все три случая, иначе получим дубль.
if grep -qE '^[[:space:]]*#?[[:space:]]*TELEGRAM_PROXY=' .env; then
  grep -vE '^[[:space:]]*#?[[:space:]]*TELEGRAM_PROXY=' .env > .env.tmp
  mv .env.tmp .env
fi
if grep -qE '^[[:space:]]*#?[[:space:]]*TELEGRAM_PROXY_CHECK_MS=' .env; then
  grep -vE '^[[:space:]]*#?[[:space:]]*TELEGRAM_PROXY_CHECK_MS=' .env > .env.tmp
  mv .env.tmp .env
fi

{
  echo ""
  echo "# Пул прокси. Порядок = приоритет. Обновлено $(date +%Y-%m-%d)."
  echo "TELEGRAM_PROXY=\"$PROXIES\""
  echo "# Бесплатные адреса живут часы — перепроверяем каждую минуту."
  echo "TELEGRAM_PROXY_CHECK_MS=\"60000\""
} >> .env

echo "  ✓ Список записан в .env"
echo

# ШАГ 3. Перезапуск. Именно up -d, а не restart: restart НЕ перечитывает .env,
# и правка выглядела бы как проигнорированная.
echo "  Перезапускаю контейнеры (up -d, чтобы .env перечитался)..."
docker compose up -d --force-recreate hcg_app hcg_bot
echo

echo "  Жду 25 секунд, пока бот выберет маршрут..."
sleep 25
echo
echo "════════════════════════════════════════════════════════════"
echo "  ЛОГ БОТА"
echo "════════════════════════════════════════════════════════════"
docker compose logs --tail 40 hcg_bot
echo
echo "════════════════════════════════════════════════════════════"
if docker compose logs --tail 60 hcg_bot 2>&1 | grep -q "started successfully"; then
  echo "  ✓ БОТ ЗАПУСТИЛСЯ. Напишите ему /start в Telegram."
else
  echo "  ⚠ Строки «started successfully» пока нет."
  echo "    Посмотрите лог выше: там написано, какие адреса не прошли."
  echo "    Полная диагностика:  bash hcg-бот-молчит.sh"
fi
echo "════════════════════════════════════════════════════════════"
echo
