#!/usr/bin/env bash
# =============================================================================
#  HCG — собрать приложение для Android прямо на сервере
# =============================================================================
#  Где запускать: на сервере, в каталоге проекта
#  Как:  bash deploy/3-APK.sh
#
#  На сервере это проще, чем на телефоне: обычный Linux x86_64, официальные
#  инструменты Google работают без обходных путей, и понижать версию SDK не
#  требуется.
#
#  Что делает:
#    • ставит Java 17 и Android SDK (командные утилиты, без Android Studio)
#    • собирает интерфейс с адресом вашего сервера
#    • создаёт проект Android и собирает APK
#    • кладёт готовый файл в /var/www/hcg-apk/ и, если найдёт nginx,
#      подсказывает прямую ссылку для скачивания на телефон
#
#  Первая сборка: 10–20 минут, нужно ~4 ГБ свободного места.
# =============================================================================

set -uo pipefail

G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
ok()   { echo "  ${G}✓${N} $*"; }
bad()  { echo "  ${R}✗${N} $*"; }
warn() { echo "  ${Y}!${N} $*"; }
hdr()  { echo; echo "${B}${C}▸ $*${N}"; }
die()  { echo; echo "${R}${B}ОСТАНОВЛЕНО: $*${N}"; echo; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APK="$ROOT/apk"
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
OUTDIR="/var/www/hcg-apk"

echo "${B}╔════════════════════════════════════════════╗${N}"
echo "${B}║  HCG — сборка приложения на сервере        ║${N}"
echo "${B}╚════════════════════════════════════════════╝${N}"

[ -d "$APK" ] || die "не найдена папка apk/ — запускайте из каталога проекта"

# ---------------------------------------------------------------------------
hdr "1/8  Свободное место"
# ---------------------------------------------------------------------------
FREE_MB=$(df -m "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${FREE_MB:-}" ] && [ "$FREE_MB" -lt 4000 ]; then
  warn "свободно ${FREE_MB} МБ — для сборки нужно около 4 ГБ"
  printf "  Продолжить всё равно? [д/Н] "
  read -r go
  case "$go" in [дДyY]*) ;; *) die "остановлено пользователем" ;; esac
else
  ok "места достаточно (${FREE_MB:-?} МБ)"
fi

# ---------------------------------------------------------------------------
hdr "2/8  Java 17"
# ---------------------------------------------------------------------------
JAVA_OK=0
if command -v java >/dev/null 2>&1; then
  JV=$(java -version 2>&1 | head -1 | grep -oE '"[0-9]+' | tr -d '"')
  [ -n "$JV" ] && [ "$JV" -ge 17 ] && JAVA_OK=1
fi

if [ "$JAVA_OK" = 1 ]; then
  ok "Java $JV"
else
  echo "  Ставлю OpenJDK 17..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq openjdk-17-jdk-headless >/dev/null 2>&1 \
      || apt-get install -y -qq openjdk-17-jdk >/dev/null 2>&1
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q java-17-openjdk-devel >/dev/null 2>&1
  fi
  command -v java >/dev/null 2>&1 || die "не удалось установить Java 17"
  ok "Java установлена"
fi

# Gradle ищет JAVA_HOME; на серверах он часто не выставлен.
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_BIN="$(readlink -f "$(command -v java)")"
  export JAVA_HOME="${JAVA_BIN%/bin/java}"
fi
ok "JAVA_HOME=$JAVA_HOME"

# ---------------------------------------------------------------------------
hdr "3/8  Node.js"
# ---------------------------------------------------------------------------
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NV=$(node -v | tr -d 'v' | cut -d. -f1)
  [ "$NV" -ge 20 ] && NODE_OK=1
fi

if [ "$NODE_OK" = 1 ]; then
  ok "Node.js $(node -v)"
else
  echo "  Ставлю Node.js 20..."
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x 2>/dev/null | bash - >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null 2>&1
  fi
  command -v node >/dev/null 2>&1 || die "не удалось установить Node.js"
  ok "Node.js $(node -v)"
fi

command -v unzip >/dev/null 2>&1 || apt-get install -y -qq unzip >/dev/null 2>&1

# ---------------------------------------------------------------------------
hdr "4/8  Android SDK"
# ---------------------------------------------------------------------------
if [ -d "$SDK/platforms/android-35" ] || [ -d "$SDK/platforms/android-36" ]; then
  ok "SDK уже установлен"
else
  echo "  Ставлю Android SDK (~700 МБ, 3–8 минут)..."
  mkdir -p "$SDK/cmdline-tools"

  if [ ! -d "$SDK/cmdline-tools/latest" ]; then
    TMP="/tmp/cmdline-tools.zip"
    curl -fsSL -o "$TMP" \
      "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
      || die "не удалось скачать инструменты SDK"
    unzip -q -o "$TMP" -d "$SDK/cmdline-tools" || die "не удалось распаковать SDK"
    mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest" 2>/dev/null || true
    rm -f "$TMP"
  fi

  export ANDROID_HOME="$SDK"
  export PATH="$SDK/cmdline-tools/latest/bin:$PATH"

  yes 2>/dev/null | sdkmanager --licenses >/dev/null 2>&1 || true
  # Capacitor 8 просит SDK 36. На сервере x86_64 это доступно без обходов —
  # в отличие от Termux, где aapt2 не работает выше 34.
  sdkmanager "platform-tools" "platforms;android-36" "build-tools;34.0.0" >/dev/null 2>&1 \
    || sdkmanager "platform-tools" "platforms;android-35" "build-tools;34.0.0" >/dev/null 2>&1 \
    || warn "sdkmanager отработал с замечаниями — продолжаю"
fi

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$PATH"
ok "ANDROID_HOME=$SDK"

# ---------------------------------------------------------------------------
hdr "5/8  Адрес игрового сервера"
# ---------------------------------------------------------------------------
cd "$APK" || die "нет каталога apk/"

CURRENT=""
if [ -f .env ]; then
  CURRENT="$(grep '^VITE_API_BASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
fi

# Адрес уже есть в основном .env проекта — предлагаем его по умолчанию.
if [ -z "$CURRENT" ] && [ -f "$ROOT/.env" ]; then
  CURRENT="$(grep '^WEB_APP_URL=' "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
  [ -n "$CURRENT" ] && ok "взял адрес из настроек сервера: $CURRENT"
fi

if [ -n "$CURRENT" ]; then
  printf "  Адрес [%s], Enter — оставить: " "$CURRENT"
  read -r NEW
  [ -n "$NEW" ] && CURRENT="$NEW"
else
  printf "  Адрес игры (https://...): "
  read -r CURRENT
fi

case "$CURRENT" in
  https://*) ;;
  *) die "адрес должен начинаться с https:// — Android блокирует незашифрованные соединения" ;;
esac

echo "VITE_API_BASE_URL=$CURRENT" > .env
ok "адрес сохранён"

# ---------------------------------------------------------------------------
hdr "6/8  Сборка интерфейса"
# ---------------------------------------------------------------------------
if [ ! -d node_modules ]; then
  echo "  Ставлю зависимости..."
  npm install --no-audit --no-fund --silent 2>&1 | tail -2
fi

npm run build:web || die "не удалось собрать интерфейс"

# ---------------------------------------------------------------------------
hdr "7/8  Проект Android"
# ---------------------------------------------------------------------------
if [ ! -d android ]; then
  npx cap add android || die "не удалось создать проект Android"
fi
npx cap sync android || die "не удалось перенести файлы"

echo "sdk.dir=$SDK" > android/local.properties
ok "проект настроен"

# ---------------------------------------------------------------------------
hdr "8/8  Сборка APK"
# ---------------------------------------------------------------------------
echo "  Первая сборка: 10–20 минут (Gradle скачивает зависимости)."
echo

cd android || die "нет каталога android"
chmod +x gradlew 2>/dev/null || true

if ./gradlew assembleDebug --no-daemon; then
  BUILT=1
else
  BUILT=0
fi

APK_FILE="$APK/android/app/build/outputs/apk/debug/app-debug.apk"

if [ "$BUILT" = 1 ] && [ -f "$APK_FILE" ]; then
  SIZE=$(du -h "$APK_FILE" | cut -f1)

  mkdir -p "$OUTDIR"
  cp "$APK_FILE" "$OUTDIR/HCG-Admin.apk"
  chmod 644 "$OUTDIR/HCG-Admin.apk"

  echo
  echo "${G}${B}╔════════════════════════════════════════════╗${N}"
  echo "${G}${B}║  ГОТОВО. Приложение собрано.               ║${N}"
  echo "${G}${B}╚════════════════════════════════════════════╝${N}"
  echo
  echo "  Файл:   ${B}$OUTDIR/HCG-Admin.apk${N}"
  echo "  Размер: $SIZE"
  echo "  Сервер: $CURRENT"
  echo
  echo "  ${B}Как перенести на телефон${N}"
  echo
  echo "  Вариант 1 — скачать с компьютера, затем передать на телефон:"
  echo "      scp root@$(hostname):$OUTDIR/HCG-Admin.apk ."
  echo
  echo "  Вариант 2 — раздать по ссылке (быстро, но временно):"
  echo "      cd $OUTDIR && python3 -m http.server 8899"
  echo "    затем на телефоне открыть:  http://IP-СЕРВЕРА:8899/HCG-Admin.apk"
  echo "    после скачивания остановить сервер клавишами Ctrl+C"
  echo
  if command -v nginx >/dev/null 2>&1; then
    echo "  Вариант 3 — через nginx, если хотите постоянную ссылку:"
    echo "      добавьте в конфиг сайта:"
    echo "          location /app.apk { alias $OUTDIR/HCG-Admin.apk; }"
    echo "      затем: nginx -t && systemctl reload nginx"
    echo "      ссылка: $CURRENT/app.apk"
    echo
  fi
  echo "  На телефоне: открыть файл → разрешить установку из неизвестного"
  echo "  источника → войти под логином admin и паролем администратора."
  echo
else
  echo
  bad "собрать APK не удалось"
  echo
  echo "  Что проверить:"
  echo "    • свободно ли 4 ГБ:            df -h"
  echo "    • версия Java (нужна 17+):     java -version"
  echo "    • есть ли доступ в интернет:   curl -I https://dl.google.com"
  echo
  echo "  Повторить только сборку, не переустанавливая SDK:"
  echo "      cd $APK/android && ./gradlew assembleDebug --no-daemon"
  exit 1
fi
