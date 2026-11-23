#!/usr/bin/env bash
# =============================================================================
#  HCG — импорт исторических логов доступа (Caddy / Nginx / Docker) в журнал IP
# =============================================================================
#  Запуск на сервере (PuTTY, root):
#      bash /var/www/hcg/scripts/import-past-logs.sh
#  Или через главное меню:
#      bash deploy/ВСЁ-НА-VPS.sh import-logs
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }

echo
echo "${B}╔══════════════════════════════════════════════════════╗${N}"
echo "${B}║  HCG: Импорт исторических логов за прошедший период  ║${N}"
echo "${B}╚══════════════════════════════════════════════════════╝${N}"
echo

# Check if hcg_app container is running
if ! docker ps --format '{{.Names}}' | grep -q '^hcg_app$'; then
  bad "Контейнер hcg_app не запущен — сначала запустите сервер игры"
  exit 1
fi

TMP_LOG="/tmp/hcg-past-logs-combined.log"
rm -f "$TMP_LOG"
touch "$TMP_LOG"

hdr "1. Поиск логов веб-сервера на хосте VPS"

FOUND_SOURCES=0

# A. Caddy logs via journalctl
if command -v journalctl >/dev/null 2>&1; then
  echo "  Проверяю журнал Caddy (journalctl)..."
  if journalctl -u caddy --no-pager -n 5000 2>/dev/null | grep -E 'GET|POST' >> "$TMP_LOG"; then
    COUNT=$(wc -l < "$TMP_LOG")
    ok "Caddy journalctl: собрано записей (${COUNT})"
    FOUND_SOURCES=$((FOUND_SOURCES + 1))
  fi
fi

# B. Caddy log files
for f in /var/log/caddy/*.log /var/log/caddy/*access*; do
  if [ -f "$f" ]; then
    echo "  Найден лог Caddy: $f"
    grep -E 'GET|POST' "$f" >> "$TMP_LOG" || true
    FOUND_SOURCES=$((FOUND_SOURCES + 1))
  fi
done

# C. Nginx access logs
for f in /var/log/nginx/*access*.log /var/log/nginx/*cyber-game*.log /var/log/nginx/*hapstore*.log; do
  if [ -f "$f" ]; then
    echo "  Найден лог Nginx: $f"
    grep -E 'GET|POST' "$f" >> "$TMP_LOG" || true
    FOUND_SOURCES=$((FOUND_SOURCES + 1))
  fi
done

# D. Gzipped Nginx logs
for f in /var/log/nginx/*access*.log*.gz; do
  if [ -f "$f" ]; then
    echo "  Найден архив лога Nginx: $f"
    zgrep -E 'GET|POST' "$f" >> "$TMP_LOG" || true
    FOUND_SOURCES=$((FOUND_SOURCES + 1))
  fi
done

TOTAL_LINES=$(wc -l < "$TMP_LOG" || echo 0)
echo
ok "Всего собрано строк для анализа: $TOTAL_LINES (источников: $FOUND_SOURCES)"

if [ "$TOTAL_LINES" -eq 0 ]; then
  warn "Внешних файлов логов не найдено. Проверяю логи Docker контейнеров..."
  docker logs --tail 2000 hcg_app 2>&1 | grep -E 'GET|POST|auth' >> "$TMP_LOG" || true
  TOTAL_LINES=$(wc -l < "$TMP_LOG" || echo 0)
fi

hdr "2. Передача строк в систему контроля HCG"

RESULT=$(docker exec -i hcg_app node -e '
  const fs = require("fs");
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", async () => {
    try {
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const secret = process.env.INTERNAL_API_SECRET || "";
      
      const res = await fetch("http://127.0.0.1:3000/api/admin/ip-import-logs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Token": secret,
        },
        body: JSON.stringify({ lines }),
      });
      
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        console.log("FAIL " + (data.error || ("HTTP " + res.status)));
        return;
      }
      console.log("OK " + (data.imported ?? 0) + " " + (data.skipped ?? 0) + " " + (data.totalNow ?? 0));
    } catch (e) {
      console.log("FAIL " + e.message);
    }
  });
' < "$TMP_LOG")

rm -f "$TMP_LOG"

case "$RESULT" in
  OK*)
    read -r _ok imported skipped totalNow <<< "$RESULT"
    echo
    ok "УСПЕШНО ИМПОРТИРОВАНО В ЖУРНАЛ: ${imported} записей"
    echo "  Пропущено (служебные/статика): ${skipped}"
    echo "  Всего записей в журнале сейчас: ${totalNow}"
    echo
    echo "  ${B}Теперь в боте можно выполнить:${N}"
    echo "    /multis     — просмотр мультиаккаунтов и совпадений"
    echo "    /whois <IP> — проверка конкретного IP или игрока"
    echo "    /export_ips — скачать файлы журнала"
    echo
    ;;
  *)
    bad "Импорт завершился с ошибкой: ${RESULT#FAIL }"
    exit 1
    ;;
esac
