#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
#  HCG — собрать приложение для Android прямо в Termux
# =============================================================================
#  Где запускать: Termux на телефоне
#  Как:  bash termux/3-APK.sh
#
#  ВАЖНО про Termux: сборка APK здесь возможна, но с оговорками.
#
#  1. Нужен Termux из F-Droid, НЕ из Google Play. В версии из Play нет
#     openjdk-17 и части пакетов — она заброшена.
#     https://f-droid.org/packages/com.termux/
#
#  2. Инструмент aapt2 в Termux собран под ARM и поддерживает Android SDK
#     не выше 34. Capacitor по умолчанию просит 36 — скрипт понижает версии
#     до 34 автоматически. На работу приложения это не влияет.
#
#  3. Gradle скачивает свой aapt2 под x86-64, который на телефоне не
#     запускается. Скрипт подменяет его на местный.
#
#  Первая сборка: 20–60 минут и ~4 ГБ свободного места.
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
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SDK="$HOME/android-sdk"

echo "${B}╔════════════════════════════════════════════╗${N}"
echo "${B}║  HCG — сборка приложения в Termux          ║${N}"
echo "${B}╚════════════════════════════════════════════╝${N}"

[ -d "$APK" ] || die "не найдена папка apk/ — запускайте из архива проекта"

# ---------------------------------------------------------------------------
hdr "1/8  Проверка Termux"
# ---------------------------------------------------------------------------
[ -d "/data/data/com.termux" ] || die "это не Termux"

# Версия из Google Play заброшена и не содержит нужных пакетов.
if ! pkg list-all 2>/dev/null | grep -q "openjdk-17"; then
  warn "пакет openjdk-17 недоступен"
  echo "      Скорее всего установлен Termux из Google Play — он заброшен."
  echo "      Нужен из F-Droid: https://f-droid.org/packages/com.termux/"
fi

FREE_MB=$(df -m "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${FREE_MB:-}" ] && [ "$FREE_MB" -lt 4000 ]; then
  warn "свободно ${FREE_MB} МБ — для сборки нужно около 4 ГБ"
else
  ok "места достаточно (${FREE_MB:-?} МБ)"
fi

# ---------------------------------------------------------------------------
hdr "2/8  Установка пакетов"
# ---------------------------------------------------------------------------
NEED=""
for p in nodejs openjdk-17 gradle aapt aapt2 apksigner d8 wget unzip; do
  command -v "${p%%-*}" >/dev/null 2>&1 || NEED="$NEED $p"
done

# Проверяем точнее: имя пакета не всегда совпадает с именем команды.
command -v node    >/dev/null 2>&1 || NEED="$NEED nodejs"
command -v java    >/dev/null 2>&1 || NEED="$NEED openjdk-17"
command -v gradle  >/dev/null 2>&1 || NEED="$NEED gradle"
command -v aapt2   >/dev/null 2>&1 || NEED="$NEED aapt2"
command -v apksigner >/dev/null 2>&1 || NEED="$NEED apksigner"

NEED="$(echo "$NEED" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/^ *//')"

if [ -n "$NEED" ]; then
  echo "  Ставлю: $NEED"
  echo "  ${Y}Это займёт несколько минут.${N}"
  # shellcheck disable=SC2086
  pkg install -y $NEED || die "не удалось установить пакеты"
fi

command -v node   >/dev/null 2>&1 || die "node не установился"
command -v java   >/dev/null 2>&1 || die "java не установилась"
command -v aapt2  >/dev/null 2>&1 || die "aapt2 не установился"
ok "node $(node -v), java $(java -version 2>&1 | head -1 | grep -oE '[0-9]+' | head -1), aapt2 на месте"

# ---------------------------------------------------------------------------
hdr "3/8  Android SDK"
# ---------------------------------------------------------------------------
if [ -d "$SDK/platforms/android-34" ]; then
  ok "SDK уже установлен"
else
  echo "  Ставлю Android SDK (командные утилиты, ~500 МБ)..."
  mkdir -p "$SDK/cmdline-tools"

  if [ ! -d "$SDK/cmdline-tools/latest" ]; then
    TMP="$HOME/cmdline-tools.zip"
    wget -q -O "$TMP" \
      "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" \
      || die "не удалось скачать командные утилиты SDK"
    unzip -q -o "$TMP" -d "$SDK/cmdline-tools" || die "не удалось распаковать SDK"
    mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest" 2>/dev/null || true
    rm -f "$TMP"
  fi

  export ANDROID_HOME="$SDK"
  export PATH="$SDK/cmdline-tools/latest/bin:$PATH"

  # SDK 34, не выше: aapt2 из Termux с 35+ не работает.
  yes 2>/dev/null | sdkmanager --licenses >/dev/null 2>&1 || true
  sdkmanager "platforms;android-34" "build-tools;34.0.0" >/dev/null 2>&1 \
    || warn "sdkmanager отработал с замечаниями — продолжаю"
fi

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$PATH"
ok "ANDROID_HOME=$SDK"

# ---------------------------------------------------------------------------
hdr "4/8  Обход ограничения aapt2"
# ---------------------------------------------------------------------------
# Gradle тянет свой aapt2, собранный под x86-64. На телефоне он не запустится,
# поэтому указываем на местный, собранный под ARM.
mkdir -p "$HOME/.gradle"
GP="$HOME/.gradle/gradle.properties"
LOCAL_AAPT2="$(command -v aapt2)"

if ! grep -q "aapt2FromMavenOverride" "$GP" 2>/dev/null; then
  echo "android.aapt2FromMavenOverride=$LOCAL_AAPT2" >> "$GP"
  ok "Gradle направлен на местный aapt2"
else
  ok "Gradle уже настроен"
fi

# Памяти на телефоне мало: без ограничения Gradle её исчерпает.
grep -q "org.gradle.jvmargs" "$GP" 2>/dev/null \
  || echo "org.gradle.jvmargs=-Xmx1536m" >> "$GP"

# ---------------------------------------------------------------------------
hdr "5/8  Адрес игрового сервера"
# ---------------------------------------------------------------------------
cd "$APK" || die "нет каталога apk/"

if [ -f .env ]; then
  CURRENT="$(grep '^VITE_API_BASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  ok "адрес уже задан: $CURRENT"
  printf "  Изменить? (новый адрес или Enter — оставить): "
  read -r NEW
  [ -n "$NEW" ] && CURRENT="$NEW"
else
  echo "  Это адрес, по которому игра открывается в браузере."
  printf "  Адрес сервера (https://...): "
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
  echo "  Ставлю зависимости (3–10 минут на телефоне)..."
  npm install --no-audit --no-fund 2>&1 | tail -3
fi

npm run build:web || die "не удалось собрать интерфейс"

# ---------------------------------------------------------------------------
hdr "7/8  Проект Android"
# ---------------------------------------------------------------------------
if [ ! -d android ]; then
  npx cap add android || die "не удалось создать проект Android"
fi
npx cap sync android || die "не удалось перенести файлы"

# Понижаем SDK до 34: aapt2 из Termux с 35+ не работает.
VARS="android/variables.gradle"
if [ -f "$VARS" ]; then
  sed -i -E 's/(compileSdkVersion[[:space:]]*=[[:space:]]*)[0-9]+/\134/; s/(targetSdkVersion[[:space:]]*=[[:space:]]*)[0-9]+/\134/' "$VARS"
  ok "SDK понижен до 34 (ограничение Termux)"
fi

echo "sdk.dir=$SDK" > android/local.properties
ok "проект настроен"

# ---------------------------------------------------------------------------
hdr "8/8  Сборка APK"
# ---------------------------------------------------------------------------
echo "  ${Y}Это самая долгая часть: 20–60 минут при первом запуске.${N}"
echo "  ${Y}Не сворачивайте Termux — Android может выгрузить процесс.${N}"
echo "  Подсказка: включите блокировку пробуждения в уведомлении Termux."
echo

cd android || die "нет каталога android"
chmod +x gradlew 2>/dev/null || true

# --no-daemon: демон Gradle съедает память и переживает выход из Termux.
if ./gradlew assembleDebug --no-daemon; then
  BUILT=1
else
  # Типичный сценарий: Gradle успел скачать свой aapt2 и подменил наш.
  warn "первая попытка не удалась — заменяю aapt2 в кеше Gradle и пробую снова"
  find "$HOME/.gradle" -name 'aapt2-*-linux.jar' -type f 2>/dev/null \
    | while read -r jar; do
        jar -u -f "$jar" -C "$(dirname "$LOCAL_AAPT2")" aapt2 2>/dev/null || true
      done
  ./gradlew clean assembleDebug --no-daemon && BUILT=1 || BUILT=0
fi

APK_FILE="$APK/android/app/build/outputs/apk/debug/app-debug.apk"

if [ "${BUILT:-0}" = 1 ] && [ -f "$APK_FILE" ]; then
  SIZE=$(du -h "$APK_FILE" | cut -f1)

  # Кладём в Загрузки, чтобы файл был виден обычному файловому менеджеру.
  DEST=""
  if [ -d "$HOME/storage/downloads" ]; then
    cp "$APK_FILE" "$HOME/storage/downloads/HCG-Admin.apk" 2>/dev/null && \
      DEST="$HOME/storage/downloads/HCG-Admin.apk"
  elif [ -d "/storage/emulated/0/Download" ]; then
    cp "$APK_FILE" "/storage/emulated/0/Download/HCG-Admin.apk" 2>/dev/null && \
      DEST="/storage/emulated/0/Download/HCG-Admin.apk"
  fi

  echo
  echo "${G}${B}╔════════════════════════════════════════════╗${N}"
  echo "${G}${B}║  ГОТОВО. Приложение собрано.               ║${N}"
  echo "${G}${B}╚════════════════════════════════════════════╝${N}"
  echo
  echo "  Размер: $SIZE"
  echo "  Сервер: $CURRENT"
  echo
  if [ -n "$DEST" ]; then
    echo "  Файл в Загрузках: ${B}HCG-Admin.apk${N}"
    echo "  Откройте его через файловый менеджер и установите."
  else
    echo "  Файл: $APK_FILE"
    echo "  Чтобы он появился в Загрузках, выполните:"
    echo "      termux-setup-storage"
    echo "      cp \"$APK_FILE\" ~/storage/downloads/HCG-Admin.apk"
  fi
  echo
  echo "  Вход: логин admin и пароль администратора."
  echo
else
  echo
  bad "собрать APK не удалось"
  echo
  echo "  Что проверить:"
  echo "    • Termux из F-Droid, а не из Google Play;"
  echo "    • свободно хотя бы 4 ГБ;"
  echo "    • Termux не сворачивался во время сборки;"
  echo "    • есть стабильный интернет (Gradle качает зависимости)."
  echo
  echo "  Если не выходит — соберите на компьютере: deploy/3-APK.ps1"
  exit 1
fi
