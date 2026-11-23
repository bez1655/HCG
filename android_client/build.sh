#!/usr/bin/env bash
# ==============================================================================
# HCG Android Client Build Pipeline (Автономный скрипт сборки под ключ)
# ==============================================================================
set -euo pipefail

# Инициализация окружения Android / AGY v2
export PATH="/data/user/0/com.agz/files/usr/bin:$PATH"
export HOME="/data/user/0/com.agz/files"
export GIT_CONFIG_NOSYSTEM=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$SCRIPT_DIR"
ROOT_DIR="$(cd "$CLIENT_DIR/.." && pwd)"
BUILD_DIR="$CLIENT_DIR/build"
SDK_DIR="$CLIENT_DIR/sdk"
KEYSTORE_DIR="$CLIENT_DIR/keystore"
SCRIPTS_DIR="$CLIENT_DIR/scripts"

SDK_JAR="$SDK_DIR/android.jar"
WEBKIT_JAR="$SDK_DIR/androidx-webkit.jar"
KEYSTORE="$KEYSTORE_DIR/hcg-release.keystore"
KEYSTORE_PASS="hcgpass123"
KEY_ALIAS="hcg"

# Порядок конвейера сборки: aapt2 -> javac -> d8 -> zipalign -> apksigner
echo "=== [1/7] Проверка окружения и сборочного тулчейна ==="
for tool in aapt2 javac d8 zip python3; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ОШИБКА: Утилита $tool не найдена в PATH!"
        exit 1
    fi
done

if ! command -v apksigner >/dev/null 2>&1; then
    echo "ОШИБКА: Утилита apksigner не найдена в PATH!"
    exit 1
fi
echo "Все инструменты (aapt2, javac, d8, zip, python3, zipalign, apksigner) доступны."

# Проверка/загрузка android.jar API 34
if [ ! -f "$SDK_JAR" ]; then
    echo "Загрузка android.jar (API 34)..."
    mkdir -p "$SDK_DIR"
    curl -fL -o "$SDK_JAR" "https://raw.githubusercontent.com/Sable/android-platforms/master/android-34/android.jar"
fi

# Проверка/загрузка androidx-webkit.jar
if [ ! -f "$WEBKIT_JAR" ]; then
    echo "Загрузка androidx-webkit.jar..."
    mkdir -p "$SDK_DIR"
    curl -fL -o "$SDK_DIR/webkit.aar" "https://dl.google.com/dl/android/maven2/androidx/webkit/webkit/1.8.0/webkit-1.8.0.aar"
    unzip -q -o "$SDK_DIR/webkit.aar" classes.jar -d "$SDK_DIR/"
    mv "$SDK_DIR/classes.jar" "$WEBKIT_JAR"
    rm -f "$SDK_DIR/webkit.aar"
fi

# Проверка/генерация release keystore
if [ ! -f "$KEYSTORE" ]; then
    echo "Генерация релизного хранилища ключей hcg-release.keystore..."
    mkdir -p "$KEYSTORE_DIR"
    keytool -genkeypair -v \
        -keystore "$KEYSTORE" \
        -alias "$KEY_ALIAS" \
        -keyalg RSA \
        -keysize 2048 \
        -validity 10000 \
        -storepass "$KEYSTORE_PASS" \
        -keypass "$KEYSTORE_PASS" \
        -dname "CN=HCG, OU=CyberGame, O=Hapstore, L=Moscow, ST=Moscow, C=RU"
fi

echo "=== [2/7] Сборка фронтенда HCG и наполнение assets/ ==="
mkdir -p "$CLIENT_DIR/assets"

# Синхронизация канонических медиафайлов из HCG-RELEASE в public/ если необходимо
if [ -d "$ROOT_DIR/05_ПРОЕКТ_ДЛЯ_РАБОТЫ/HCG-RELEASE/public" ]; then
    cp -u "$ROOT_DIR/05_ПРОЕКТ_ДЛЯ_РАБОТЫ/HCG-RELEASE/public/BoardHAP.png" "$ROOT_DIR/public/BoardHAP.png" 2>/dev/null || true
    cp -u "$ROOT_DIR/05_ПРОЕКТ_ДЛЯ_РАБОТЫ/HCG-RELEASE/public/BoardHAP.mp4" "$ROOT_DIR/public/BoardHAP.mp4" 2>/dev/null || true
fi

# Сборка через Vite с production API_BASE_URL
(
    cd "$ROOT_DIR"
    VITE_API_BASE_URL="https://hapstore.cyber-game.online" \
    ./node_modules/.bin/vite build --outDir "$CLIENT_DIR/assets" --emptyOutDir
)

# Проверка ключевых медиафайлов в assets/
for asset in index.html BoardHAP.png BoardHAP.mp4 Dice.png music/sound.mp3; do
    if [ ! -f "$CLIENT_DIR/assets/$asset" ]; then
        echo "ОШИБКА: Обязательный файл $asset отсутствует в $CLIENT_DIR/assets!"
        exit 1
    fi
done
echo "Ассеты успешно собраны (~$(du -sh "$CLIENT_DIR/assets" | cut -f1))."

echo "=== [3/7] Компиляция Android-ресурсов (aapt2 compile & link) ==="
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/gen" "$BUILD_DIR/obj" "$BUILD_DIR/dex"

aapt2 compile --dir "$CLIENT_DIR/res" -o "$BUILD_DIR/resources.zip"

aapt2 link -I "$SDK_JAR" \
    --manifest "$CLIENT_DIR/AndroidManifest.xml" \
    --min-sdk-version 24 \
    --target-sdk-version 34 \
    --version-code 1 \
    --version-name "1.0.0" \
    -o "$BUILD_DIR/unaligned.apk" \
    --java "$BUILD_DIR/gen" \
    -A "$CLIENT_DIR/assets" \
    "$BUILD_DIR/resources.zip"

echo "=== [4/7] Компиляция Java исходников (javac) ==="
javac -d "$BUILD_DIR/obj" \
    --release 8 \
    -cp "$SDK_JAR:$BUILD_DIR/gen" \
    "$BUILD_DIR/gen/online/cybergame/hapstore/R.java" \
    "$CLIENT_DIR/src/online/cybergame/hapstore/MainActivity.java"

echo "=== [5/7] Дексинг классов (d8) и компоновка APK ==="
d8 --output "$BUILD_DIR/dex" \
    --lib "$SDK_JAR" \
    "$BUILD_DIR/obj/online/cybergame/hapstore/"*.class

(
    cd "$BUILD_DIR/dex"
    zip -uj "$BUILD_DIR/unaligned.apk" classes.dex
)

echo "=== [6/7] 4-байтовое выравнивание (zipalign.py) ==="
python3 "$SCRIPTS_DIR/zipalign.py" "$BUILD_DIR/unaligned.apk" "$BUILD_DIR/aligned.apk"
python3 "$SCRIPTS_DIR/zipalign.py" -c "$BUILD_DIR/aligned.apk"

echo "=== [7/7] Криптографическая подпись (apksigner) ==="
apksigner sign \
    --ks "$KEYSTORE" \
    --ks-pass "pass:$KEYSTORE_PASS" \
    --ks-key-alias "$KEY_ALIAS" \
    --out "$BUILD_DIR/hcg-release.apk" \
    "$BUILD_DIR/aligned.apk"

echo "=== Верификация APK подписи ==="
apksigner verify --verbose "$BUILD_DIR/hcg-release.apk"

APK_SIZE=$(ls -lh "$BUILD_DIR/hcg-release.apk" | awk '{print $5}')
cp -f "$BUILD_DIR/hcg-release.apk" "/storage/emulated/0/Download/hcg-release.apk" 2>/dev/null || true

echo "=============================================================================="
echo "СБОРКА УСПЕШНО ЗАВЕРШЕНА!"
echo "Файл: $BUILD_DIR/hcg-release.apk"
echo "Размер: $APK_SIZE"
echo "Package: online.cybergame.hapstore"
echo "Activity: .MainActivity"
echo "Скопировано в Загрузки: /storage/emulated/0/Download/hcg-release.apk"
echo "=============================================================================="
