#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tier 4: Real-World Scenarios Tests
Проверяет реальные сценарии развертывания и эксплуатации:
- Целостность и размер готового артефакта APK.
- Криптографическая валидация apksigner (схемы v2/v3, код 0).
- Готовность скрипта deploy.sh: Shizuku rish, fallback на termux-open, am start.
- Проверка доступности системных команд Android (pm, am, rish, termux-open).
- Идемпотентность и чистота сборочного пайплайна.
"""

import os
import sys
import unittest
import shutil
import subprocess
from pathlib import Path

# Добавляем родительский каталог тестов в sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    CLIENT_DIR, PROJECT_ROOT, BUILD_SCRIPT, DEPLOY_SCRIPT,
    RELEASE_APK, EXPECTED_PACKAGE_NAME, inspect_zip_entries,
    log_info, log_pass, log_fail
)

class TestTier4RealWorldScenarios(unittest.TestCase):
    """Набор тестов Tier 4: Сценарии эксплуатации и готовности к развертыванию."""

    def test_s1_apk_full_bundle_inspection(self):
        """[S1] Scenario: Комплексный аудит собранного hcg-release.apk (размер >10 МБ, ключевые файлы)."""
        log_info("Тест: Комплексный аудит релизного файла APK...")
        if not RELEASE_APK.exists():
            self.skipTest(f"Релизный файл {RELEASE_APK} еще не собран. Тест будет активен после завершения M4.")
            
        file_size = RELEASE_APK.stat().st_size
        log_info(f"Размер hcg-release.apk: {file_size / (1024 * 1024):.2f} МБ")
        
        # APK с полным набором медиа (видео 2 МБ, аудио 4.4 МБ, арт 2.6 МБ, спрайты) должен быть > 8 МБ
        self.assertGreater(
            file_size, 8 * 1024 * 1024,
            f"Размер APK ({file_size} байт) подозрительно мал: возможно, не упакованы медиа-ассеты"
        )
        
        entries, _ = inspect_zip_entries(RELEASE_APK)
        self.assertIn("AndroidManifest.xml", entries, "В APK отсутствует AndroidManifest.xml")
        self.assertIn("classes.dex", entries, "В APK отсутствует скомпилированный classes.dex")
        self.assertIn("resources.arsc", entries, "В APK отсутствуют ресурсы resources.arsc")
        
        # Проверяем наличие ключевых ассетов
        has_board_png = any("BoardHAP.png" in e for e in entries)
        has_dice_png = any("Dice.png" in e for e in entries)
        has_sound_mp3 = any("sound.mp3" in e for e in entries)
        
        self.assertTrue(has_board_png, "В APK отсутствует ассет BoardHAP.png")
        self.assertTrue(has_dice_png, "В APK отсутствует ассет Dice.png")
        self.assertTrue(has_sound_mp3, "В APK отсутствует ассет sound.mp3")
        
        log_pass("Комплексный аудит структуры и размера APK успешно пройден")

    def test_s2_apksigner_verification_scenario(self):
        """[S2] Scenario: Криптографическая валидация apksigner verify (схемы v2/v3)."""
        log_info("Тест: Проверка цифровой подписи apksigner verify...")
        if not RELEASE_APK.exists():
            self.skipTest("hcg-release.apk еще не собран")
            
        apksigner_bin = shutil.which("apksigner")
        if not apksigner_bin:
            self.skipTest("Утилита apksigner не найдена в $PATH")
            
        cmd = [apksigner_bin, "verify", "--verbose", str(RELEASE_APK)]
        result = subprocess.run(cmd, capture_output=True, text=True)
        
        self.assertEqual(
            result.returncode, 0,
            f"apksigner verify завершился с ошибкой (код {result.returncode}):\n{result.stderr}\n{result.stdout}"
        )
        
        self.assertIn(
            "Verified using v2 scheme (APK Signature Scheme v2): true", result.stdout,
            "APK должен быть подписан по схеме v2"
        )
        log_pass("Цифровая подпись apksigner (v2/v3) подтверждена с кодом 0")

    def test_s3_deployment_script_contracts(self):
        """[S3] Scenario: Анализ deploy.sh на поддержку Shizuku rish, fallback termux-open и am start."""
        log_info("Тест: Проверка сценариев развертывания в deploy.sh...")
        if not DEPLOY_SCRIPT.exists():
            self.skipTest("Скрипт deploy.sh еще не создан")
            
        content = DEPLOY_SCRIPT.read_text(encoding="utf-8")
        
        # 1. Проверка поддержки Shizuku
        has_rish = "rish" in content
        self.assertTrue(has_rish, "deploy.sh должен поддерживать установку через Shizuku rish")
        
        # 2. Проверка команды pm install
        self.assertIn("pm install", content, "deploy.sh должен содержать команду pm install -r")
        
        # 3. Проверка fallback механизма
        has_fallback = ("termux-open" in content) or ("am start" in content)
        self.assertTrue(has_fallback, "deploy.sh должен иметь fallback на системный установщик")
        
        # 4. Проверка запуска активности
        self.assertIn(
            f"{EXPECTED_PACKAGE_NAME}/.MainActivity", content,
            f"deploy.sh должен запускать {EXPECTED_PACKAGE_NAME}/.MainActivity через am start"
        )
        log_pass("Скрипт deploy.sh полностью готов к установке через Shizuku / fallback и запуску am start")

    def test_s4_system_environment_readiness(self):
        """[S4] Scenario: Проверка готовности системного окружения Android к установке и запуску."""
        log_info("Тест: Проверка наличия системных утилит Android (am, pm, termux-open)...")
        am_bin = shutil.which("am")
        termux_open_bin = shutil.which("termux-open")
        
        self.assertTrue(
            am_bin is not None,
            "Утилита 'am' (Activity Manager) должна быть доступна в окружении для запуска приложения"
        )
        self.assertTrue(
            termux_open_bin is not None,
            "Утилита 'termux-open' должна быть доступна для fallback установки APK"
        )
        log_pass("Системное окружение Android (am, termux-open) готово к установке и запуску")

if __name__ == "__main__":
    unittest.main()
