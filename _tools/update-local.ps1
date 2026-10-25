<#
.SYNOPSIS
    Обновление расписания Берёзовки и публикация data.js на GitHub Pages.

.DESCRIPTION
    Скачивает табло с ticketbus.by, собирает data.js, проверяет его и коммитит
    в репозиторий, только если расписание реально изменилось (метка времени
    сбора в сравнении не участвует).

    Запускается планировщиком задач Windows (_tools\register-task.ps1)
    или вручную — двойным щелчком по _tools\update-local.cmd.

    Почему локально, а не в GitHub Actions: ticketbus.by (134.17.94.194)
    отвечает только белорусским адресам. С раннеров GitHub (Azure, США/ЕС)
    и ещё из 13 проверенных стран — таймаут соединения.

.PARAMETER DryRun
    Скачать, собрать и сравнить, но не коммитить и не пушить.
    Собранный файл сохраняется в _tools/live/data.js для просмотра.

.PARAMETER Attempts
    Сколько раз пытаться скачать табло (сайт иногда отвечает медленно).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File _tools\update-local.ps1 -DryRun
#>
param(
    [switch]$DryRun,
    [int]$Attempts = 3
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $PSScriptRoot "update-local.log"
$DataFile = Join-Path $Root "data.js"

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Invoke-NodeScript {
    param([string]$Script, [string]$Title)
    Write-Log $Title
    & node $Script 2>&1 | ForEach-Object { Write-Log ("  " + $_) }
    return $LASTEXITCODE
}

# лог не должен расти бесконечно
if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 512KB) {
    Move-Item $LogFile ($LogFile + ".1") -Force
}

try {
    Set-Location $Root
    Write-Log "=== обновление расписания ==="

    # 1. Синхронизация с GitHub, чтобы не коммитить поверх чужих правок.
    #    Если в проекте есть незакоммиченные изменения — не трогаем их.
    $dirty = @(git status --porcelain)
    if ($dirty.Count -gt 0) {
        Write-Log "в проекте есть незакоммиченные изменения — git pull пропущен"
    }
    else {
        Write-Log "git pull --ff-only"
        & git pull --ff-only --quiet 2>&1 | ForEach-Object { Write-Log ("  " + $_) }
        if ($LASTEXITCODE -ne 0) {
            throw "не удалось обновить репозиторий (git pull, код $LASTEXITCODE)"
        }
    }

    # 2. Табло с ticketbus.by — с повторами: сайт иногда отвечает медленно.
    $scraped = $false
    for ($i = 1; $i -le $Attempts; $i++) {
        $code = Invoke-NodeScript (Join-Path $PSScriptRoot "scrape_ticketbus.js") `
            "скачиваю табло (попытка $i из $Attempts)"
        if ($code -eq 0) { $scraped = $true; break }
        Write-Log "попытка $i не удалась (код $code)"
        if ($i -lt $Attempts) {
            Write-Log "жду 60 секунд"
            Start-Sleep -Seconds 60
        }
    }
    if (-not $scraped) { throw "не удалось скачать табло с ticketbus.by" }

    # 3. Сборка и проверка.
    $code = Invoke-NodeScript (Join-Path $PSScriptRoot "build_live_data.js") "собираю data.js"
    if ($code -ne 0) { throw "сборка data.js завершилась с кодом $code" }

    $code = Invoke-NodeScript (Join-Path $PSScriptRoot "check_data.js") "проверяю данные"
    if ($code -ne 0) { throw "проверка data.js не пройдена (код $code)" }

    # 4. Сравнение с версией в репозитории без метки времени сбора,
    #    иначе каждый день получался бы пустой коммит.
    $old = (git show HEAD:data.js) -join "`n"
    $new = Get-Content $DataFile -Raw -Encoding UTF8
    $pattern = '"updated":"[^"]*"'
    $changed = (($old -replace $pattern, '"updated":""') -ne ($new -replace $pattern, '"updated":""'))

    if (-not $changed) {
        Write-Log "расписание не изменилось — коммита не будет"
        Write-Log "=== готово ==="
        exit 0
    }

    if ($DryRun) {
        $preview = Join-Path $PSScriptRoot "live\data.js"
        Copy-Item $DataFile $preview -Force
        & git checkout -- data.js 2>&1 | ForEach-Object { Write-Log ("  " + $_) }
        Write-Log "расписание изменилось (dry-run: без коммита)"
        Write-Log "новый data.js сохранён: $preview"
        Write-Log "=== готово ==="
        exit 0
    }

    # 5. Коммит и пуш.
    $stamp = Get-Date -Format "dd.MM.yyyy HH:mm"
    & git add data.js 2>&1 | ForEach-Object { Write-Log ("  " + $_) }
    & git commit -m "расписание: $stamp" 2>&1 | ForEach-Object { Write-Log ("  " + $_) }
    if ($LASTEXITCODE -ne 0) { throw "git commit завершился с кодом $LASTEXITCODE" }

    & git push origin HEAD 2>&1 | ForEach-Object { Write-Log ("  " + $_) }
    if ($LASTEXITCODE -ne 0) { throw "git push завершился с кодом $LASTEXITCODE" }

    Write-Log "data.js обновлён и отправлен на GitHub"
    Write-Log "=== готово ==="
    exit 0
}
catch {
    Write-Log ("ОШИБКА: " + $_.Exception.Message)
    Write-Log "=== завершено с ошибкой ==="
    exit 1
}
