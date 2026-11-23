#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tier 1: Feature Coverage Tests
Проверяет покрытие всех базовых фичей (F1–F14) согласно PROJECT.md:
- Манифест, package name, permissions, portrait orientation, hardware acceleration.
- Конфигурация сетевой безопасности (network_security_config).
- Настройки WebView (DOM storage, autoplay, asset loader).
- Наличие всех обязательных игровых ассетов (BoardHAP, Dice, sound, chips).
- Реальный CORS-контракт сервера HCG с Origin: https://localhost.
"""

import os
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

# Добавляем родительский каталог тестов в sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    CLIENT_DIR, PROJECT_ROOT, MANIFEST_FILE, MAIN_ACTIVITY_FILE,
    ASSETS_DIR, RELEASE_APK, CANONICAL_PUBLIC_DIR, LIVE_SERVER_URL,
    EXPECTED_PACKAGE_NAME, inspect_zip_entries, verify_live_cors,
    get_assets_dir, log_info, log_pass, log_fail
)

class TestTier1FeatureCoverage(unittest.TestCase):
    """Набор тестов Tier 1: Покрытие ключевых фичей."""

    def test_f1_f2_manifest_package_identity(self):
        """[F1, F2] Проверка имени пакета и структуры манифеста."""
        log_info("Тест: Проверка package name в AndroidManifest.xml...")
        self.assertTrue(MANIFEST_FILE.exists(), f"Файл манифеста не найден: {MANIFEST_FILE}")
        
        tree = ET.parse(MANIFEST_FILE)
        root = tree.getroot()
        package_name = root.attrib.get("package")
        self.assertEqual(
            package_name, EXPECTED_PACKAGE_NAME,
            f"Неверный package: ожидался {EXPECTED_PACKAGE_NAME}, получен {package_name}"
        )
        log_pass(f"Package name корректен: {package_name}")

    def test_f8_manifest_permissions(self):
        """[F8] Проверка обязательных сетевых разрешений (INTERNET, ACCESS_NETWORK_STATE)."""
        log_info("Тест: Проверка permissions в AndroidManifest.xml...")
        self.assertTrue(MANIFEST_FILE.exists(), "Файл манифеста отсутствует")
        
        tree = ET.parse(MANIFEST_FILE)
        root = tree.getroot()
        permissions = set()
        for elem in root.findall("uses-permission"):
            name = elem.attrib.get("{http://schemas.android.com/apk/res/android}name")
            if name:
                permissions.add(name)
        
        self.assertIn(
            "android.permission.INTERNET", permissions,
            "Разрешение android.permission.INTERNET обязательно для связи с сервером HCG"
        )
        self.assertIn(
            "android.permission.ACCESS_NETWORK_STATE", permissions,
            "Разрешение android.permission.ACCESS_NETWORK_STATE обязательно для мониторинга сети"
        )
        log_pass("Обязательные сетевые разрешения INTERNET и ACCESS_NETWORK_STATE присутствуют")

    def test_f9_f11_orientation_and_hardware_acceleration(self):
        """[F9, F11] Проверка portrait orientation и аппаратного ускорения (GPU)."""
        log_info("Тест: Проверка screenOrientation=portrait и hardwareAccelerated=true...")
        self.assertTrue(MANIFEST_FILE.exists(), "Файл манифеста отсутствует")
        
        tree = ET.parse(MANIFEST_FILE)
        root = tree.getroot()
        app_elem = root.find("application")
        self.assertIsNotNone(app_elem, "Тег <application> не найден в манифесте")
        
        # Проверка hardwareAccelerated
        hw_accel_app = app_elem.attrib.get("{http://schemas.android.com/apk/res/android}hardwareAccelerated")
        
        # Ищем активность MainActivity
        activity_elem = None
        for act in app_elem.findall("activity"):
            act_name = act.attrib.get("{http://schemas.android.com/apk/res/android}name")
            if act_name and ("MainActivity" in act_name or act_name == ".MainActivity"):
                activity_elem = act
                break
        
        self.assertIsNotNone(activity_elem, "Активность MainActivity не найдена в манифесте")
        
        orientation = activity_elem.attrib.get("{http://schemas.android.com/apk/res/android}screenOrientation")
        hw_accel_act = activity_elem.attrib.get("{http://schemas.android.com/apk/res/android}hardwareAccelerated")
        
        self.assertEqual(
            orientation, "portrait",
            f"Ориентация должна быть жестко зафиксирована на portrait (получено: {orientation})"
        )
        
        # Аппаратное ускорение может быть включено либо на уровне application, либо на уровне activity
        is_hw_enabled = (hw_accel_app == "true") or (hw_accel_act == "true")
        self.assertTrue(
            is_hw_enabled,
            "Аппаратное ускорение hardwareAccelerated должно быть явно установлено в 'true'"
        )
        log_pass("Портретная ориентация (9:16) и аппаратное ускорение подтверждены")

    def test_f8_network_security_config(self):
        """[F8] Проверка XML-конфигурации сетевой безопасности (запрет cleartext traffic)."""
        log_info("Тест: Проверка network_security_config.xml...")
        net_cfg_file = CLIENT_DIR / "res" / "xml" / "network_security_config.xml"
        self.assertTrue(net_cfg_file.exists(), f"Файл {net_cfg_file} не найден")
        
        content = net_cfg_file.read_text(encoding="utf-8")
        self.assertIn(
            'cleartextTrafficPermitted="false"', content,
            "Cleartext traffic должен быть строго запрещен (cleartextTrafficPermitted=false)"
        )
        self.assertIn(
            "certificates", content,
            "Конфигурация сети должна содержать декларацию доверенных сертификатов"
        )
        log_pass("Запрет незашифрованного HTTP трафика и доверие системным сертификатам подтверждены")

    def test_f4_game_assets_integrity(self):
        """[F4] Проверка наличия и структуры канонических медиа-ассетов HCG."""
        log_info("Тест: Проверка наличия канонических ассетов (BoardHAP, Dice, sound, chips)...")
        # Проверяем либо assets/ клиента, либо public/ канона
        target_dir = get_assets_dir()
        self.assertTrue(target_dir.exists(), f"Каталог ассетов не найден: {target_dir}")
        
        required_files = [
            "BoardHAP.png",
            "BoardHAP.mp4",
            "Dice.png",
            "music/sound.mp3",
        ]
        
        for rel_path in required_files:
            asset_path = target_dir / rel_path
            self.assertTrue(
                asset_path.exists(),
                f"Критический игровой ассет отсутствует: {rel_path} в {target_dir}"
            )
            self.assertGreater(
                asset_path.stat().st_size, 0,
                f"Файл ассета пуст (размер 0 байт): {rel_path}"
            )
        
        # Проверка фишек chips/
        chips_dir = target_dir / "chips"
        self.assertTrue(chips_dir.exists() and chips_dir.is_dir(), "Каталог chips/ отсутствует")
        chip_files = list(chips_dir.glob("chip_*.svg"))
        self.assertGreaterEqual(
            len(chip_files), 13,
            f"Ожидалось не менее 13 векторных фишек игроков, найдено: {len(chip_files)}"
        )
        log_pass(f"Канонические медиафайлы HCG и {len(chip_files)} фишек успешно верифицированы")

    def test_f2_f6_live_server_cors_contract(self):
        """[F2, F6] Проверка боевого CORS-контракта сервера HCG с Origin https://localhost."""
        log_info("Тест: Проверка живого сервера HCG на принятие Origin: https://localhost...")
        login_url = f"{LIVE_SERVER_URL}/api/login"
        
        # 1. Валидный Origin https://localhost
        status, headers = verify_live_cors(login_url, "https://localhost", "POST")
        self.assertEqual(
            status, 204,
            f"Сервер должен возвращать HTTP 204 No Content на preflight c Origin: https://localhost, получен {status}"
        )
        allow_origin = headers.get("access-control-allow-origin") or headers.get("Access-Control-Allow-Origin")
        self.assertEqual(
            allow_origin, "https://localhost",
            f"Заголовок Access-Control-Allow-Origin должен быть 'https://localhost', получен '{allow_origin}'"
        )
        
        # 2. Недоверенный Origin https://untrusted-hacker.com
        status_bad, _ = verify_live_cors(login_url, "https://untrusted-hacker.com", "POST")
        self.assertEqual(
            status_bad, 403,
            f"Сервер должен отклонять недоверенный origin со статусом 403 Forbidden, получен {status_bad}"
        )
        log_pass("Живой CORS-контракт HCG подтвержден: https://localhost разрешен, внешние домены отклонены (403)")

    def test_f1_f3_f5_f12_main_activity_contracts(self):
        """[F1, F3, F5, F12] Проверка контрактов WebView, автоплея, DOM storage и жизненного цикла."""
        log_info("Тест: Проверка контрактов в исходном коде MainActivity.java...")
        if not MAIN_ACTIVITY_FILE.exists():
            self.skipTest(f"Файл {MAIN_ACTIVITY_FILE} еще не сгенерирован worker'ом")
            
        code = MAIN_ACTIVITY_FILE.read_text(encoding="utf-8")
        
        # F1, F2: WebViewAssetLoader и localhost
        self.assertIn("WebViewAssetLoader", code, "MainActivity должна использовать WebViewAssetLoader")
        self.assertIn("localhost", code, "WebViewAssetLoader должен настраивать домен localhost")
        
        # F3: Autoplay медиа без жестов
        self.assertIn(
            "setMediaPlaybackRequiresUserGesture(false)", code,
            "Должно быть отключено требование жеста для автовоспроизведения медиа"
        )
        
        # F5: DOM storage для сохранения токена авторизации
        self.assertIn("setDomStorageEnabled(true)", code, "DOM Storage должен быть включен")
        self.assertIn("setJavaScriptEnabled(true)", code, "JavaScript должен быть включен")
        
        # F12: Управление жизненным циклом (pause/resume timers)
        self.assertIn("pauseTimers", code, "MainActivity должна вызывать pauseTimers в onPause")
        self.assertIn("resumeTimers", code, "MainActivity должна вызывать resumeTimers в onResume")
        
        # F14: Уничтожение WebView при завершении
        self.assertIn("destroy", code, "MainActivity должна вызывать webView.destroy в onDestroy")
        log_pass("Все ключевые контракты WebView, DOM Storage, автоплея и жизненного цикла в MainActivity подтверждены")

if __name__ == "__main__":
    unittest.main()
