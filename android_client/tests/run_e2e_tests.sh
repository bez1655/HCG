#!/usr/bin/env bash
# ==============================================================================
# HCG Android APK — Главный раннер сквозного E2E тест-сьюта
# Версия: 1.0.0
# Среда: Android ARM64 / Bionic (Python 3.14 + Bash)
# ==============================================================================

set -eo pipefail

export PATH="/data/user/0/com.agz/files/usr/bin:$PATH"
export HOME="/data/user/0/com.agz/files"

# Определение цветов консоли
GREEN='\033[1;32m'
RED='\033[1;31m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
CYAN='\033[1;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_ROOT="$(cd "${CLIENT_DIR}/.." && pwd)"

echo -e "${BLUE}==============================================================================${NC}"
echo -e "${BOLD}${CYAN}          HCG ANDROID APK — END-TO-END (E2E) TEST RUNNER              ${NC}"
echo -e "${BLUE}==============================================================================${NC}"
echo -e "Директория тестов:   ${SCRIPT_DIR}"
echo -e "Директория клиента:  ${CLIENT_DIR}"
echo -e "Корень репозитория:  ${PROJECT_ROOT}"
echo -e "Интерпретатор:       $(which python3) ($(python3 --version 2>&1))"
echo -e "${BLUE}------------------------------------------------------------------------------${NC}"

START_TIME=$(date +%s)
FAILED_TIERS=0
TOTAL_TESTS=0

run_tier() {
    local tier_num="$1"
    local tier_name="$2"
    local test_script="$3"

    echo -e "\n${BOLD}${YELLOW}>>> Запуск Tier ${tier_num}: ${tier_name}...${NC}"
    
    if [ ! -f "${SCRIPT_DIR}/${test_script}" ]; then
        echo -e "${RED}[ERROR] Тестовый скрипт не найден: ${test_script}${NC}"
        FAILED_TIERS=$((FAILED_TIERS + 1))
        return 1
    fi

    if python3 "${SCRIPT_DIR}/${test_script}"; then
        echo -e "${GREEN}[OK] Tier ${tier_num} (${tier_name}) успешно завершен.${NC}"
    else
        echo -e "${RED}[FAIL] Ошибки при выполнении Tier ${tier_num} (${tier_name})!${NC}"
        FAILED_TIERS=$((FAILED_TIERS + 1))
        return 1
    fi
}

# Обработка аргументов командной строки
TARGET_TIER="${1:-all}"

case "$TARGET_TIER" in
    1|tier1)
        run_tier "1" "Feature Coverage" "test_tier1_feature_coverage.py"
        ;;
    2|tier2)
        run_tier "2" "Boundary & Corner Cases" "test_tier2_boundary_corner.py"
        ;;
    3|tier3)
        run_tier "3" "Pairwise & Cross-Feature" "test_tier3_pairwise_cross_feature.py"
        ;;
    4|tier4)
        run_tier "4" "Real-World Scenarios" "test_tier4_real_world_scenarios.py"
        ;;
    all|*)
        run_tier "1" "Feature Coverage (F1-F14)" "test_tier1_feature_coverage.py"
        run_tier "2" "Boundary & Corner Cases" "test_tier2_boundary_corner.py"
        run_tier "3" "Pairwise & Cross-Feature" "test_tier3_pairwise_cross_feature.py"
        run_tier "4" "Real-World Scenarios" "test_tier4_real_world_scenarios.py"
        ;;
esac

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo -e "\n${BLUE}==============================================================================${NC}"
if [ $FAILED_TIERS -eq 0 ]; then
    echo -e "${BOLD}${GREEN}               ВСЕ E2E ТЕСТЫ УСПЕШНО ПРОЙДЕНЫ (PASS)!                 ${NC}"
    echo -e "${GREEN}Время выполнения сьюта: ${DURATION} сек.${NC}"
    echo -e "${BLUE}==============================================================================${NC}"
    exit 0
else
    echo -e "${BOLD}${RED}           ОБНАРУЖЕНЫ ОШИБКИ В СЬЮТЕ! УПАВШИХ УРОВНЕЙ: ${FAILED_TIERS}             ${NC}"
    echo -e "${RED}Время выполнения: ${DURATION} сек.${NC}"
    echo -e "${BLUE}==============================================================================${NC}"
    exit 1
fi
