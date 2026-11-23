#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Общие утилиты и хелперы для E2E тест-сьюта HCG Android APK.
Обеспечивает независимую проверку ZIP-архивов, ELF/DEX/APK-структур,
магических байтов, 4-байтового выравнивания и сетевых CORS-контрактов.
"""

import os
import sys
import struct
import zipfile
import urllib.request
import urllib.error
import subprocess
from pathlib import Path

# Цветовое оформление консоли
GREEN = "\033[1;32m"
RED = "\033[1;31m"
YELLOW = "\033[1;33m"
CYAN = "\033[1;36m"
BOLD = "\033[1m"
RESET = "\033[0m"

# Пути проекта
TESTS_DIR = Path(__file__).resolve().parent
CLIENT_DIR = TESTS_DIR.parent
PROJECT_ROOT = CLIENT_DIR.parent
APK_BUILD_DIR = CLIENT_DIR / "build"
RELEASE_APK = APK_BUILD_DIR / "hcg-release.apk"
MANIFEST_FILE = CLIENT_DIR / "AndroidManifest.xml"
MAIN_ACTIVITY_FILE = CLIENT_DIR / "src" / "online" / "cybergame" / "hapstore" / "MainActivity.java"
ASSETS_DIR = CLIENT_DIR / "assets"
ZIPALIGN_SCRIPT = CLIENT_DIR / "scripts" / "zipalign.py"
BUILD_SCRIPT = CLIENT_DIR / "build.sh"
DEPLOY_SCRIPT = CLIENT_DIR / "deploy.sh"
CANONICAL_PUBLIC_DIR = PROJECT_ROOT / "public"

# Константы форматов файлов
MAGIC_PNG = b"\x89PNG\r\n\x1a\n"
MAGIC_ZIP = b"PK\x03\x04"
MAGIC_ID3 = b"ID3"
LIVE_SERVER_URL = "https://hapstore.cyber-game.online"
EXPECTED_PACKAGE_NAME = "online.cybergame.hapstore"

def log_info(msg: str):
    print(f"{CYAN}[INFO]{RESET} {msg}")

def log_pass(msg: str):
    print(f"{GREEN}[PASS]{RESET} {msg}")

def log_fail(msg: str):
    print(f"{RED}[FAIL]{RESET} {msg}")

def log_skip(msg: str):
    print(f"{YELLOW}[SKIP]{RESET} {msg}")

def get_assets_dir() -> Path:
    """
    Возвращает директорию с игровыми ассетами.
    Если в android_client/assets уже скопирован BoardHAP.png, возвращает ее.
    Иначе возвращает канонический источник public/ проекта HCG.
    """
    if ASSETS_DIR.exists() and (ASSETS_DIR / "BoardHAP.png").exists():
        return ASSETS_DIR
    return CANONICAL_PUBLIC_DIR

def check_png_header(data: bytes) -> bool:
    """Проверка сигнатуры PNG (8 байт)."""
    return data.startswith(MAGIC_PNG)

def check_mp4_header(data: bytes) -> bool:
    """Проверка наличия box ftyp в MP4 контейнере."""
    if len(data) < 12:
        return False
    # В MP4 первые 4 байта - размер box, следующие 4 байта - тип 'ftyp'
    box_type = data[4:8]
    return box_type == b"ftyp"

def check_mp3_header(data: bytes) -> bool:
    """Проверка заголовка MP3 (ID3v2 или MPEG sync frame 0xFF 0xFB/0xF3/0xF2)."""
    if len(data) < 4:
        return False
    if data.startswith(MAGIC_ID3):
        return True
    return data[0] == 0xFF and (data[1] & 0xE0) == 0xE0

def inspect_zip_entries(zip_path: Path):
    """Возвращает список имен записей и словарь со свойствами внутри ZIP/APK."""
    if not zip_path.exists():
        return [], {}
    entries = []
    metadata = {}
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            entries.append(info.filename)
            metadata[info.filename] = {
                "file_size": info.file_size,
                "compress_size": info.compress_size,
                "compress_type": info.compress_type,
                "header_offset": info.header_offset,
            }
    return entries, metadata

def check_4byte_zipalign(apk_path: Path) -> tuple[bool, list[str]]:
    """
    Проверяет 4-байтовое выравнивание uncompressed (compress_type == 0) файлов.
    Согласно Android zipalign: для uncompressed файлов смещение данных в архиве
    должно быть кратно 4 байтам (DataOffset % 4 == 0).
    """
    if not apk_path.exists():
        return False, ["APK файл не найден"]
    
    unaligned_files = []
    with open(apk_path, "rb") as f:
        with zipfile.ZipFile(f, "r") as zf:
            for info in zf.infolist():
                if info.compress_type == 0 and info.file_size > 0:
                    # Вычисляем точное смещение данных
                    f.seek(info.header_offset)
                    header_bytes = f.read(30)
                    if len(header_bytes) < 30 or not header_bytes.startswith(b"PK\x03\x04"):
                        unaligned_files.append(f"{info.filename}: поврежден локальный заголовок")
                        continue
                    
                    filename_len = struct.unpack("<H", header_bytes[26:28])[0]
                    extra_len = struct.unpack("<H", header_bytes[28:30])[0]
                    data_offset = info.header_offset + 30 + filename_len + extra_len
                    
                    if data_offset % 4 != 0:
                        unaligned_files.append(
                            f"{info.filename}: смещение {data_offset} не кратно 4 (остаток {data_offset % 4})"
                        )
    
    return len(unaligned_files) == 0, unaligned_files

def verify_live_cors(url: str, origin: str, method: str = "POST") -> tuple[int, dict]:
    """
    Отправляет реальный OPTIONS preflight запрос к серверу и возвращает статус и заголовки.
    """
    req = urllib.request.Request(url, method="OPTIONS")
    req.add_header("Origin", origin)
    req.add_header("Access-Control-Request-Method", method)
    req.add_header("User-Agent", "HCG-E2E-Test-Runner/1.0")
    
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            headers = dict(response.headers)
            return response.status, headers
    except urllib.error.HTTPError as e:
        headers = dict(e.headers)
        return e.code, headers
    except Exception as e:
        return 0, {"error": str(e)}
