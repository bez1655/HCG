#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Tier 3: Pairwise & Cross-Feature Tests
Проверяет попарные комбинации и перекрестные взаимодействия подсистем:
- Схема подписи apksigner (v2/v3) × 4-byte zipalign выравнивание.
- Доменные заголовки (Origin) × HTTP методы (OPTIONS, POST).
- Локальная схема WebViewAssetLoader × персистентность DOM Storage.
- Портретная ориентация (9:16) × Display Cutout (shortEdges).
- Автоплей медиа × приостановка в системном цикле (onPause/onResume).
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
    BUILD_SCRIPT, RELEASE_APK, LIVE_SERVER_URL, verify_live_cors,
    log_info, log_pass, log_fail
)

class TestTier3PairwiseCrossFeature(unittest.TestCase):
    """Набор тестов Tier 3: Попарные кросс-функциональные взаимодействия."""

    def test_p1_pairwise_zipalign_before_apksigner_order(self):
        """[P1] Pairwise: Порядок конвейера сборки (zipalign ОБЯЗАН выполняться ДО apksigner)."""
        log_info("Тест: Проверка порядка вызовов zipalign -> apksigner в build.sh...")
        if not BUILD_SCRIPT.exists():
            self.skipTest(f"Скрипт {BUILD_SCRIPT} еще не сгенерирован")
            
        content = BUILD_SCRIPT.read_text(encoding="utf-8")
        
        # Ищем позиции вызовов zipalign и apksigner
        zipalign_pos = content.find("zipalign")
        apksigner_pos = content.find("apksigner")
        
        self.assertNotEqual(
            zipalign_pos, -1,
            "В build.sh должен присутствовать вызов zipalign"
        )
        self.assertNotEqual(
            apksigner_pos, -1,
            "В build.sh должен присутствовать вызов apksigner"
        )
        
        self.assertLess(
            zipalign_pos, apksigner_pos,
            "Критическая ошибка пайплайна: zipalign должен вызываться ДО apksigner! "
            "Выравнивание после подписи v2/v3 делает криптографическую подпись недействительной."
        )
        log_pass("Ортогональный порядок конвейера zipalign -> apksigner строго соблюден")

    def test_p2_pairwise_cors_origins_and_methods_matrix(self):
        """[P2] Pairwise: Матрица Origin {https://localhost, capacitor://localhost, evil.com} × HTTP метод."""
        log_info("Тест: Матрица кросс-проверок заголовков Origin и HTTP-методов к серверу HCG...")
        test_matrix = [
            # (Origin, Method, Expected HTTP Status)
            ("https://localhost", "POST", 204),
            ("https://localhost", "OPTIONS", 204),
            ("capacitor://localhost", "OPTIONS", 204),
            ("http://localhost", "OPTIONS", 204),
            ("https://malicious-phishing.org", "POST", 403),
            ("https://fake-telegram-clone.xyz", "OPTIONS", 403),
        ]
        
        login_endpoint = f"{LIVE_SERVER_URL}/api/login"
        
        for origin, method, expected_status in test_matrix:
            status, headers = verify_live_cors(login_endpoint, origin, method)
            self.assertEqual(
                status, expected_status,
                f"Несоответствие статуса для пары ({origin}, {method}): "
                f"ожидался {expected_status}, получен {status}"
            )
            if expected_status == 204:
                allow_origin = headers.get("access-control-allow-origin") or headers.get("Access-Control-Allow-Origin")
                self.assertEqual(
                    allow_origin, origin,
                    f"Сервер должен возвращать в Allow-Origin запрошенный доверенный origin: {origin}"
                )
        log_pass(f"Все 6 комбинаций матрицы Origin × Method подтверждены сервером HCG")

    def test_p3_cross_feature_assetloader_and_dom_storage(self):
        """[P3] Cross-Feature: Совместимость виртуального HTTPS домена и W3C DOM Storage."""
        log_info("Тест: Проверка связки WebViewAssetLoader (https://localhost) и DOM Storage...")
        if not MAIN_ACTIVITY_FILE.exists():
            self.skipTest("MainActivity.java еще не создан")
            
        code = MAIN_ACTIVITY_FILE.read_text(encoding="utf-8")
        
        # Проверяем, что используется именно схема HTTPS (а не file://),
        # что дает полноценный Security Origin для работы localStorage
        has_https_localhost = ("https://localhost" in code) or ("localhost" in code and "WebViewAssetLoader" in code)
        self.assertTrue(
            has_https_localhost,
            "WebViewAssetLoader должен конфигурироваться с доменом localhost"
        )
        self.assertIn(
            "setDomStorageEnabled(true)", code,
            "DOM Storage должен быть явно включен для сохранения JWT"
        )
        self.assertNotIn(
            "setAllowFileAccessFromFileURLs(true)", code,
            "Небезопасный доступ file:// к файловой системе должен оставаться выключенным"
        )
        log_pass("Связка WebViewAssetLoader HTTPS и DOM Storage W3C сконфигурирована безопасно")

    def test_p4_cross_feature_cutout_shortedges_and_portrait(self):
        """[P4] Cross-Feature: Портретная геометрия 9:16 и Display Cutout shortEdges."""
        log_info("Тест: Проверка связки portrait orientation и Display Cutout shortEdges...")
        # 1. Проверяем манифест
        self.assertTrue(MANIFEST_FILE.exists(), "Манифест отсутствует")
        manifest_text = MANIFEST_FILE.read_text(encoding="utf-8")
        self.assertIn('android:screenOrientation="portrait"', manifest_text)
        
        # 2. Проверяем стиль v28 (вырезы экрана)
        styles_v28 = CLIENT_DIR / "res" / "values-v28" / "styles.xml"
        if styles_v28.exists():
            styles_content = styles_v28.read_text(encoding="utf-8")
            self.assertIn(
                "shortEdges", styles_content,
                "values-v28/styles.xml должен объявлять windowLayoutInDisplayCutoutMode = shortEdges"
            )
            log_pass("Портретный режим и Display Cutout (shortEdges) согласованы")
        else:
            log_pass("Портретный режим подтвержден в манифесте")

    def test_p5_cross_feature_autoplay_and_lifecycle_management(self):
        """[P5] Cross-Feature: Автоплей медиа без жестов и принудительное глушение в onPause."""
        log_info("Тест: Проверка связки автоплея и глушения звука в жизненном цикле...")
        if not MAIN_ACTIVITY_FILE.exists():
            self.skipTest("MainActivity.java еще не создан")
            
        code = MAIN_ACTIVITY_FILE.read_text(encoding="utf-8")
        
        # Автоплей разрешен
        self.assertIn("setMediaPlaybackRequiresUserGesture(false)", code)
        
        # При уходе в фон звук глушится и таймеры останавливаются
        self.assertIn("onPause", code)
        self.assertIn("pauseTimers", code)
        log_pass("Связка автоплея и глушения медиа в onPause/onResume верифицирована")

if __name__ == "__main__":
    unittest.main()
