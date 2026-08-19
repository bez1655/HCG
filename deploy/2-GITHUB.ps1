# =============================================================================
#  HCG — отправка в репозиторий GitHub, одной командой
# =============================================================================
#  Где запускать: Windows, PowerShell, в распакованной папке архива
#  Как:  .\deploy\2-GITHUB.ps1
#
#  Что делает:
#    • проверяет, что установлен Git
#    • создаёт чистый репозиторий (история начинается с нуля — в старой
#      лежали утёкшие токен бота и ключ Firebase)
#    • спрашивает адрес репозитория и отправляет код
#
#  Ничего не удаляет и не трогает сервер.
# =============================================================================

$ErrorActionPreference = "Stop"

function Say([string]$t, [string]$c = "White") { Write-Host $t -ForegroundColor $c }
function Ok  ([string]$t) { Say "  [OK]  $t" Green }
function Bad ([string]$t) { Say "  [!!]  $t" Red }
function Hdr ([string]$t) { Write-Host ""; Say "> $t" Cyan }

Say "==============================================" White
Say "   HCG - отправка в GitHub"                    White
Say "==============================================" White

# Работаем из корня архива, а не из папки deploy.
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
Say "  Папка проекта: $Root"

# ---------------------------------------------------------------------------
Hdr "1/5  Проверка Git"
# ---------------------------------------------------------------------------
try {
    $v = git --version
    Ok "$v"
} catch {
    Bad "Git не установлен."
    Say ""
    Say "  Скачайте и установите: https://git-scm.com/download/win" Yellow
    Say "  Затем ЗАКРОЙТЕ и откройте PowerShell заново." Yellow
    exit 1
}

if (-not (Test-Path "package.json")) {
    Bad "Здесь нет package.json - вы не в папке проекта."
    exit 1
}
Ok "файлы проекта на месте"

# ---------------------------------------------------------------------------
Hdr "2/5  Адрес репозитория"
# ---------------------------------------------------------------------------
Say "  Если репозитория ещё нет - создайте его:" Yellow
Say "      https://github.com/new" Yellow
Say "      имя: HCG-Production, видимость: Private," Yellow
Say "      три галочки (README, .gitignore, license) НЕ ставить" Yellow
Say ""

$RepoUrl = Read-Host "  Вставьте адрес репозитория (https://github.com/ЛОГИН/HCG-Production.git)"
$RepoUrl = $RepoUrl.Trim()

if ($RepoUrl -notmatch '^https://github\.com/.+/.+\.git$') {
    if ($RepoUrl -match '^https://github\.com/.+/.+$') {
        $RepoUrl = "$RepoUrl.git"
        Ok "добавил .git в конец: $RepoUrl"
    } else {
        Bad "Адрес не похож на репозиторий GitHub."
        Say "  Ожидается: https://github.com/ваш-логин/HCG-Production.git" Yellow
        exit 1
    }
}

# ---------------------------------------------------------------------------
Hdr "3/5  Подготовка репозитория"
# ---------------------------------------------------------------------------
if (Test-Path ".git") {
    Ok "репозиторий уже создан"
} else {
    git init -q -b main
    Ok "создан новый репозиторий (ветка main)"
}

# Имя и почта нужны git для подписи коммита; глобальных может не быть.
$who = git config user.name 2>$null
if (-not $who) {
    git config user.name  "HCG"
    git config user.email "hcg@localhost"
    Ok "подпись коммитов настроена"
}

# Хук проверки секретов. Без этого GitHub - последняя линия обороны.
git config core.hooksPath .githooks 2>$null
Ok "включена проверка секретов перед коммитом"

# ---------------------------------------------------------------------------
Hdr "4/5  Коммит"
# ---------------------------------------------------------------------------
git add -A

$staged = git diff --cached --name-only
if (-not $staged) {
    Ok "изменений нет - всё уже сохранено"
} else {
    $count = ($staged | Measure-Object).Count
    Say "  файлов к отправке: $count"

    # Секреты в коммит попасть не должны: проверяем до отправки.
    $danger = $staged | Where-Object { $_ -match '(^|/)\.env$|serviceAccount|credentials|\.pem$|\.key$' }
    if ($danger) {
        Bad "В коммит попали файлы с секретами:"
        $danger | ForEach-Object { Say "        $_" Red }
        Say "  Проверьте .gitignore и повторите." Yellow
        exit 1
    }
    Ok "секретных файлов среди них нет"

    $msg = "HCG Production - Hapstore Cyberpunk Board Quest"
    if (git rev-parse HEAD 2>$null) { $msg = "update: " + (Get-Date -Format "yyyy-MM-dd HH:mm") }

    git commit -q -m $msg
    Ok "коммит создан"
}

# ---------------------------------------------------------------------------
Hdr "5/5  Отправка на GitHub"
# ---------------------------------------------------------------------------
$existing = git remote get-url origin 2>$null
if ($existing) {
    if ($existing -ne $RepoUrl) {
        git remote set-url origin $RepoUrl
        Ok "адрес репозитория обновлён"
    } else {
        Ok "адрес уже настроен"
    }
} else {
    git remote add origin $RepoUrl
    Ok "адрес репозитория добавлен"
}

Say ""
Say "  Сейчас GitHub попросит войти." Yellow
Say "  ВАЖНО: в поле пароля вводится НЕ пароль от аккаунта," Yellow
Say "  а токен доступа. Где взять - в файле ИНСТРУКЦИЯ.md, шаг 2." Yellow
Say ""

git push -u origin main
if ($LASTEXITCODE -ne 0) {
    Say ""
    Bad "Отправка не удалась."
    Say ""
    Say "  Частые причины:" Yellow
    Say "    - вместо токена введён пароль от аккаунта" Yellow
    Say "    - репозиторий создан с README (тогда удалите его и создайте пустой)" Yellow
    Say "    - у токена нет права Contents: Read and write" Yellow
    exit 1
}

Say ""
Say "==============================================" Green
Say "   ГОТОВО. Код на GitHub."                     Green
Say "==============================================" Green
Say ""
Say "  Дальше включите защиту (один раз):"
Say "    Settings -> Code security -> Secret scanning: Enable"
Say "                              -> Push protection:  Enable"
Say ""
Say "  Следующие отправки - той же командой."
Say ""
