# =============================================================================
#  HCG — сборка приложения для Android, одной командой
# =============================================================================
#  Где запускать: Windows, PowerShell, в распакованной папке архива
#  Как:  .\deploy\3-APK.ps1
#
#  Что делает:
#    • проверяет Node.js, Java и Android SDK
#    • спрашивает адрес сервера (один раз, потом запоминает)
#    • собирает интерфейс, создаёт проект Android и APK
#    • показывает точный путь к готовому файлу
#
#  Первый запуск долгий: Gradle скачивает компоненты (5-15 минут).
# =============================================================================

$ErrorActionPreference = "Stop"

function Say([string]$t, [string]$c = "White") { Write-Host $t -ForegroundColor $c }
function Ok  ([string]$t) { Say "  [OK]  $t" Green }
function Bad ([string]$t) { Say "  [!!]  $t" Red }
function Warn([string]$t) { Say "  [ ! ] $t" Yellow }
function Hdr ([string]$t) { Write-Host ""; Say "> $t" Cyan }

Say "==============================================" White
Say "   HCG - сборка приложения для Android"        White
Say "==============================================" White

$Root = Split-Path -Parent $PSScriptRoot
$Apk  = Join-Path $Root "apk"
Set-Location $Apk
Say "  Папка сборки: $Apk"

# ---------------------------------------------------------------------------
Hdr "1/7  Что установлено"
# ---------------------------------------------------------------------------
$problems = @()

try {
    $node = node -v
    $major = [int](($node -replace '^v','') -split '\.')[0]
    if ($major -lt 20) { $problems += "Node.js $node - нужна версия 20 или новее"; Bad "Node.js $node (нужна 20+)" }
    else { Ok "Node.js $node" }
} catch {
    $problems += "Node.js не установлен"
    Bad "Node.js не найден"
}

try {
    $javaRaw = (java -version 2>&1 | Select-Object -First 1).ToString()
    if ($javaRaw -match '"(\d+)') {
        $jv = [int]$Matches[1]
        if ($jv -lt 17) { $problems += "Java $jv - нужна 17 или новее"; Bad "Java $jv (нужна 17+)" }
        else { Ok "Java $jv" }
    } else { Warn "версию Java определить не удалось" }
} catch {
    $problems += "Java (JDK 17+) не установлена"
    Bad "Java не найдена"
}

# Android SDK: Capacitor ищет его по ANDROID_HOME или в стандартном месте.
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA "Android\Sdk" }

if (Test-Path $sdk) {
    Ok "Android SDK: $sdk"
    if (-not $env:ANDROID_HOME) {
        $env:ANDROID_HOME = $sdk
        Warn "ANDROID_HOME не был задан - подставил на время этой сборки"
    }
} else {
    $problems += "Android SDK не найден"
    Bad "Android SDK не найден"
}

if ($problems.Count -gt 0) {
    Say ""
    Say "  Не хватает следующего:" Red
    $problems | ForEach-Object { Say "    - $_" Red }
    Say ""
    Say "  Что скачать:" Yellow
    Say "    Node.js 20 LTS  https://nodejs.org" Yellow
    Say "    Android Studio  https://developer.android.com/studio" Yellow
    Say "                    (при первом запуске согласитесь скачать SDK;" Yellow
    Say "                     JDK 17 ставится вместе с ним)" Yellow
    Say ""
    Say "  После установки закройте и откройте PowerShell заново." Yellow
    exit 1
}

# ---------------------------------------------------------------------------
Hdr "2/7  Адрес игрового сервера"
# ---------------------------------------------------------------------------
$envFile = Join-Path $Apk ".env"

if (Test-Path $envFile) {
    $line = (Get-Content $envFile | Where-Object { $_ -match '^VITE_API_BASE_URL=' } | Select-Object -First 1)
    $current = ($line -replace '^VITE_API_BASE_URL=', '').Trim().Trim('"').Trim("'")
    Ok "адрес уже задан: $current"
    $again = Read-Host "  Изменить? (введите новый адрес или Enter, чтобы оставить)"
    if ($again.Trim()) { $current = $again.Trim() }
} else {
    Say "  Это адрес, по которому открывается игра в браузере." Yellow
    Say "  Например: https://hcg.bez12.store" Yellow
    $current = (Read-Host "  Адрес сервера").Trim()
}

if (-not $current.StartsWith("https://")) {
    Bad "Адрес должен начинаться с https://"
    Say "  Android блокирует незашифрованные соединения, а по ним идёт пароль." Yellow
    exit 1
}

"VITE_API_BASE_URL=$current" | Set-Content -Path $envFile -Encoding UTF8 -NoNewline
Ok "адрес сохранён: $current"

# ---------------------------------------------------------------------------
Hdr "3/7  Зависимости"
# ---------------------------------------------------------------------------
if (Test-Path (Join-Path $Apk "node_modules")) {
    Ok "уже установлены"
} else {
    Say "  Устанавливаю (1-3 минуты)..."
    npm install --silent
    if ($LASTEXITCODE -ne 0) { Bad "не удалось установить зависимости"; exit 1 }
    Ok "установлены"
}

# ---------------------------------------------------------------------------
Hdr "4/7  Сборка интерфейса"
# ---------------------------------------------------------------------------
npm run build:web
if ($LASTEXITCODE -ne 0) {
    Bad "сборка интерфейса не удалась"
    exit 1
}

# ---------------------------------------------------------------------------
Hdr "5/7  Проект Android"
# ---------------------------------------------------------------------------
if (Test-Path (Join-Path $Apk "android")) {
    Ok "проект уже создан"
} else {
    Say "  Создаю проект Android..."
    npx cap add android
    if ($LASTEXITCODE -ne 0) { Bad "не удалось создать проект"; exit 1 }
    Ok "проект создан"
}

npx cap sync android
if ($LASTEXITCODE -ne 0) { Bad "не удалось перенести файлы в проект"; exit 1 }
Ok "файлы перенесены"

# ---------------------------------------------------------------------------
Hdr "6/7  Сборка APK"
# ---------------------------------------------------------------------------
Say "  Первая сборка идёт долго: Gradle скачивает компоненты (5-15 минут)."
Say "  Не прерывайте."
Say ""

Set-Location (Join-Path $Apk "android")
.\gradlew.bat assembleDebug
$gradleCode = $LASTEXITCODE
Set-Location $Apk

if ($gradleCode -ne 0) {
    Say ""
    Bad "Gradle не смог собрать APK."
    Say ""
    Say "  Частые причины:" Yellow
    Say "    SDK location not found  - запустите Android Studio, дайте скачать SDK" Yellow
    Say "    Unsupported Java        - нужен JDK 17 или новее" Yellow
    Say "    нет интернета           - Gradle скачивает компоненты при первой сборке" Yellow
    exit 1
}

# ---------------------------------------------------------------------------
Hdr "7/7  Готово"
# ---------------------------------------------------------------------------
$apkPath = Join-Path $Apk "android\app\build\outputs\apk\debug\app-debug.apk"

if (Test-Path $apkPath) {
    $size = [math]::Round((Get-Item $apkPath).Length / 1MB, 1)
    Say ""
    Say "==============================================" Green
    Say "   ГОТОВО. Приложение собрано."               Green
    Say "==============================================" Green
    Say ""
    Say "  Файл:   $apkPath"
    Say "  Размер: $size МБ"
    Say "  Сервер: $current"
    Say ""
    Say "  Как установить:"
    Say "    1. Скопируйте файл на телефон (кабель, облако или мессенджер)"
    Say "    2. Откройте его на телефоне"
    Say "    3. Разрешите установку из неизвестного источника"
    Say "    4. Войдите: логин admin и пароль администратора"
    Say ""

    # Открываем папку с файлом - искать вручную неудобно.
    explorer.exe "/select,`"$apkPath`""
} else {
    Bad "Gradle отработал, но файл не найден по ожидаемому пути:"
    Say "      $apkPath" Yellow
}
