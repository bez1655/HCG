#!/usr/bin/env bash
# ==============================================================================
# HCG Android Client Deployment Script (Установка и запуск на устройстве)
# ==============================================================================
set -euo pipefail

export PATH="/data/user/0/com.agz/files/usr/bin:$PATH"
export HOME="/data/user/0/com.agz/files"
export RISH_APPLICATION_ID="com.agz"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APK_PATH="$SCRIPT_DIR/build/hcg-release.apk"
TARGET_ACTIVITY="online.cybergame.hapstore/.MainActivity"
DOWNLOAD_APK="/storage/emulated/0/Download/hcg-release.apk"

if [ ! -f "$APK_PATH" ]; then
    echo "APK $APK_PATH не найден. Запуск сборщика build.sh..."
    bash "$SCRIPT_DIR/build.sh"
fi

echo "=== Развертывание HCG APK ($APK_PATH) ==="

# Проверяем доступность Shizuku через rish
SHIZUKU_READY=false
if command -v rish >/dev/null 2>&1; then
    echo "Проверка доступности Shizuku (rish)..."
    if timeout 2 rish -c "id" >/dev/null 2>&1; then
        SHIZUKU_READY=true
        echo "Служба Shizuku активна и отвечает."
    else
        echo "Служба Shizuku не ответила (или требует подтверждения прав в приложении Shizuku)."
    fi
fi

if [ "$SHIZUKU_READY" = true ]; then
    echo "Установка через Shizuku: pm install -r..."
    rish -c "pm install -r '$APK_PATH'"
    echo "Установка успешно завершена."
    
    echo "Запуск активности online.cybergame.hapstore/.MainActivity..."
    rish -c "am start -n online.cybergame.hapstore/.MainActivity"
    echo "Приложение запущено!"
else
    echo "------------------------------------------------------------------------------"
    echo "Резервный канал установки (fallback через системный установщик / termux-open):"
    echo "Копирование APK в папку Загрузки ($DOWNLOAD_APK)..."
    cp "$APK_PATH" "$DOWNLOAD_APK"
    echo "Файл успешно скопирован в: $DOWNLOAD_APK"
    
    # Попытка открытия через termux-open если доступно
    if command -v termux-open >/dev/null 2>&1; then
        termux-open --view "$DOWNLOAD_APK" 2>/dev/null || true
    fi
    echo "Откройте данный файл в любом файловом менеджере Android для завершения установки в один клик."
    echo "------------------------------------------------------------------------------"
fi

# Попытка запуска активности если приложение уже установлено
if command -v am >/dev/null 2>&1; then
    am start -n online.cybergame.hapstore/.MainActivity 2>/dev/null || true
fi

echo "Развертывание завершено."
