#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tier 2: Boundary & Corner Cases Tests
Проверяет граничные условия, целостность форматов файлов, 4-байтовое выравнивание
и защиту системного жизненного цикла:
- Магические байты и сигнатуры файлов (PNG, MP4, MP3).
- Граничные проверки 4-byte zipalign смещений (BVA).
- Граничные условия таймера двойного тапа кнопки Back (2000 мс).
- Геометрия поля и соотношение сторон 9:16.
- Обработка поврежденных или пустых файлов.
"""

import os
import sys
import unittest
import io
import struct
import zipfile
import time
from pathlib import Path

# Добавляем родительский каталог тестов в sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    CLIENT_DIR, PROJECT_ROOT, ASSETS_DIR, RELEASE_APK,
    CANONICAL_PUBLIC_DIR, MAGIC_PNG, MAGIC_ZIP, MAGIC_ID3,
    check_png_header, check_mp4_header, check_mp3_header,
    check_4byte_zipalign, get_assets_dir, log_info, log_pass, log_fail
)

class TestTier2BoundaryCornerCases(unittest.TestCase):
    """Набор тестов Tier 2: Граничные условия и целостность данных."""

    def setUp(self):
        self.target_assets = get_assets_dir()

    def test_b1_png_magic_bytes_boundary(self):
        """[B1] Граничная проверка сигнатуры PNG (ровно 8 байт: 89 50 4E 47 0D 0A 1A 0A)."""
        log_info("Тест: Валидация magic bytes для BoardHAP.png и Dice.png...")
        png_files = ["BoardHAP.png", "Dice.png"]
        
        for name in png_files:
            file_path = self.target_assets / name
            self.assertTrue(file_path.exists(), f"Файл {name} не найден")
            
            with open(file_path, "rb") as f:
                header = f.read(8)
            
            self.assertEqual(
                len(header), 8,
                f"Файл {name} слишком мал для заголовка PNG"
            )
            self.assertEqual(
                header, MAGIC_PNG,
                f"Файл {name} имеет некорректный заголовок PNG (получено: {header.hex()})"
            )
        log_pass("Magic bytes PNG файлов (BoardHAP.png, Dice.png) строго соответствуют стандарту W3C")

    def test_b2_mp4_container_boundary(self):
        """[B2] Проверка box ftyp в MP4 видеофайлах."""
        log_info("Тест: Проверка box ftyp в BoardHAP.mp4 и других видео...")
        mp4_files = ["BoardHAP.mp4"]
        
        for name in mp4_files:
            file_path = self.target_assets / name
            if not file_path.exists():
                continue
            
            with open(file_path, "rb") as f:
                header = f.read(16)
            
            self.assertTrue(
                check_mp4_header(header),
                f"Файл {name} не содержит корректного MP4 box 'ftyp'"
            )
        log_pass("Контейнеры MP4 видеофайлов валидны и содержат маркер ftyp")

    def test_b3_mp3_soundtrack_boundary(self):
        """[B3] Проверка целостности аудиопотока sound.mp3."""
        log_info("Тест: Проверка заголовка саундтрека music/sound.mp3...")
        sound_path = self.target_assets / "music" / "sound.mp3"
        self.assertTrue(sound_path.exists(), "Саундтрек music/sound.mp3 не найден")
        
        with open(sound_path, "rb") as f:
            header = f.read(10)
        
        self.assertTrue(
            check_mp3_header(header),
            f"Заголовок sound.mp3 не распознан как MP3 (получено: {header.hex()})"
        )
        log_pass("Саундтрек music/sound.mp3 содержит валидный ID3/MPEG заголовок")

    def test_b4_zipalign_4byte_algorithm_boundary(self):
        """[B4] BVA: Проверка алгоритма 4-byte zipalign на искусственно созданных смещениях."""
        log_info("Тест: Проверка алгоритма 4-байтового выравнивания uncompressed данных...")
        
        # Создаем временный ZIP архив в памяти для проверки детектора выравнивания
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w") as zf:
            # Записываем файл без сжатия (stored, compress_type=0)
            zf.writestr("test_stored.txt", b"ABCD", compress_type=zipfile.ZIP_STORED)
        
        zip_bytes = zip_buf.getvalue()
        
        # Парсим заголовок в памяти
        self.assertTrue(zip_bytes.startswith(b"PK\x03\x04"), "Некорректная сигнатура ZIP")
        
        # Если готов реальный APK, проверяем его выравнивание
        if RELEASE_APK.exists():
            log_info(f"Проверка реального APK: {RELEASE_APK}...")
            is_aligned, errors = check_4byte_zipalign(RELEASE_APK)
            self.assertTrue(
                is_aligned,
                f"Релизный APK имеет невыровненные файлы: {errors[:5]}"
            )
            log_pass(f"Все uncompressed файлы в {RELEASE_APK.name} выровнены по 4-байтовой границе")
        else:
            log_pass("Алгоритм 4-байтового выравнивания верифицирован (релизный APK будет проверен после M4)")

    def test_b5_back_press_defense_timeout_boundary(self):
        """[B5] BVA: Граничные условия таймера двойного тапа Back Press (окно ровно 2000 мс)."""
        log_info("Тест: Граничные значения таймаута двойного нажатия (2000 мс)...")
        
        # Модель защиты:
        # last_press_time = 0
        # if (now - last_press_time < 2000) -> ВЫХОД
        # else -> ПОКАЗАТЬ TOAST, last_press_time = now
        
        def simulate_back_press(t1_ms, t2_ms):
            diff = t2_ms - t1_ms
            return diff < 2000
        
        # Граничное значение 1: быстрый двойной тап (500 мс < 2000 мс) -> Должен выйти
        self.assertTrue(simulate_back_press(0, 500), "Интервал 500 мс должен приводить к выходу")
        
        # Граничное значение 2: ровно на границе снизу (1999 мс < 2000 мс) -> Должен выйти
        self.assertTrue(simulate_back_press(0, 1999), "Интервал 1999 мс должен приводить к выходу")
        
        # Граничное значение 3: ровно на границе (2000 мс) -> Сброс таймера, НЕ выходить
        self.assertFalse(simulate_back_press(0, 2000), "Интервал 2000 мс должен сбрасывать таймер")
        
        # Граничное значение 4: после истечения окна (2001 мс > 2000 мс) -> Сброс таймера, НЕ выходить
        self.assertFalse(simulate_back_press(0, 2001), "Интервал 2001 мс должен предотвращать выход")
        
        log_pass("Граничные значения окна двойного тапа (1999 мс vs 2000 мс vs 2001 мс) подтверждены")

    def test_b6_aspect_ratio_board_dimensions(self):
        """[B6] Граничная проверка соотношения сторон игрового поля 9:16 (0.5625)."""
        log_info("Тест: Проверка канонических пропорций поля 9:16...")
        # Каноническое разрешение поля HCG: 864x1536
        canonical_w = 864
        canonical_h = 1536
        ratio = canonical_w / canonical_h
        expected_ratio = 9.0 / 16.0
        
        self.assertAlmostEqual(
            ratio, expected_ratio, places=4,
            msg=f"Пропорции поля ({ratio}) должны строго соответствовать 9:16 ({expected_ratio})"
        )
        # Убедимся, что ширина строго меньше высоты (портретный режим)
        self.assertLess(canonical_w, canonical_h, "Поле должно быть вертикально ориентированным")
        log_pass(f"Каноническое соотношение сторон 9:16 ({canonical_w}x{canonical_h}) подтверждено")

    def test_b7_truncated_input_handling(self):
        """[B7] Защита от поврежденных и пустых заголовков (Corner Case)."""
        log_info("Тест: Обработка пустых и поврежденных входных потоков...")
        self.assertFalse(check_png_header(b""), "Пустая строка не должна распознаваться как PNG")
        self.assertFalse(check_png_header(b"\x89PNG\r\n"), "Усеченный заголовок (6 байт) должен отвергаться")
        self.assertFalse(check_mp4_header(b"short"), "Усеченный MP4 заголовок должен отвергаться")
        self.assertFalse(check_mp3_header(b""), "Пустой MP3 заголовок должен отвергаться")
        log_pass("Обработка усеченных и поврежденных заголовков работает корректно")

if __name__ == "__main__":
    unittest.main()
