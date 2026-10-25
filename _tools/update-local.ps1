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
$DataChanged = Join-Path $PSScriptRoot "data_changed.js"

# Без этого в скрытой задаче русский вывод node/git может прийти в OEM-кодировке.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

# Запуск внешней программы: stderr пишется в файл, поэтому PowerShell 5.1
# не превращает сообщения git/node в исключения (иначе успешный push
# выглядел бы как ошибка). Возвращает код возврата и строки stdout.
function Invoke-Native {
    param(
        [string]$Title,
        [string]$FilePath,
        [string[]]$Arguments = @(),
        [switch]$Quiet
    )
    Write-Log $Title
    $errFile = [System.IO.Path]::GetTempFileName()
    $out = @()
    $code = -1
    $prevEap = $ErrorActionPreference

    try {
        # PowerShell 5.1 считает любой stderr внешней программы ошибкой.
        # На время вызова отключаем Stop, код возврата проверяем сами.
        $ErrorActionPreference = "Continue"
        $out = @(& $FilePath @Arguments 2> $errFile)
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevEap
    }

    if (-not $Quiet) {
        $out | ForEach-Object { Write-Log ("  " + $_) }
    }

    $err = @(Get-Content $errFile -Encoding UTF8 -ErrorAction SilentlyContinue)
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue
    if ($err.Count -gt 0) {
        $err | ForEach-Object { Write-Log ("  " + $_) }
    }

    return [pscustomobject]@{ Code = $code; Output = $out }
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
    $status = Invoke-Native "проверяю рабочую копию" "git" @("status", "--porcelain") -Quiet
    if ($status.Code -ne 0) { throw "git status завершился с кодом $($status.Code)" }

    if ($status.Output.Count -gt 0) {
        Write-Log "в проекте есть незакоммиченные изменения — git pull пропущен"
    }
    else {
        $pull = Invoke-Native "git pull --ff-only" "git" @("pull", "--ff-only", "--quiet")
        if ($pull.Code -ne 0) { throw "не удалось обновить репозиторий (git pull, код $($pull.Code))" }
    }

    # 2. Табло с ticketbus.by — с повторами: сайт иногда отвечает медленно.
    $scraped = $false
    for ($i = 1; $i -le $Attempts; $i++) {
        $r = Invoke-Native "скачиваю табло (попытка $i из $Attempts)" "node" @((Join-Path $PSScriptRoot "scrape_ticketbus.js"))
        if ($r.Code -eq 0) { $scraped = $true; break }
        Write-Log "попытка $i не удалась (код $($r.Code))"
        if ($i -lt $Attempts) {
            Write-Log "жду 60 секунд"
            Start-Sleep -Seconds 60
        }
    }
    if (-not $scraped) { throw "не удалось скачать табло с ticketbus.by" }

    # 3. Сборка и проверка.
    $build = Invoke-Native "собираю data.js" "node" @((Join-Path $PSScriptRoot "build_live_data.js"))
    if ($build.Code -ne 0) { throw "сборка data.js завершилась с кодом $($build.Code)" }

    $check = Invoke-Native "проверяю данные" "node" @((Join-Path $PSScriptRoot "check_data.js"))
    if ($check.Code -ne 0) { throw "проверка data.js не пройдена (код $($check.Code))" }

    # 4. Сравнение с версией в репозитории без метки времени сбора.
    $diff = Invoke-Native "сравниваю расписание с версией в репозитории" "node" @($DataChanged, "--head", $DataFile)
    if ($diff.Code -eq 2) { throw "не удалось сравнить data.js" }
    $changed = ($diff.Code -eq 1)

    if (-not $changed) {
        # Пересборка всегда меняет метку времени сбора — возвращаем файл,
        # чтобы рабочая копия оставалась чистой и следующий запуск сделал git pull.
        $restore = Invoke-Native "возвращаю data.js (изменилась только метка сбора)" "git" @("checkout", "--", "data.js")
        if ($restore.Code -ne 0) { throw "не удалось вернуть data.js (код $($restore.Code))" }
        Write-Log "расписание не изменилось — коммита не будет"
        Write-Log "=== готово ==="
        exit 0
    }

    if ($DryRun) {
        $preview = Join-Path $PSScriptRoot "live\data.js"
        Copy-Item $DataFile $preview -Force
        $restore = Invoke-Native "возвращаю data.js в исходное состояние" "git" @("checkout", "--", "data.js")
        if ($restore.Code -ne 0) { throw "не удалось вернуть data.js (код $($restore.Code))" }
        Write-Log "расписание изменилось (dry-run: без коммита)"
        Write-Log "новый data.js сохранён: $preview"
        Write-Log "=== готово ==="
        exit 0
    }

    # 5. Коммит и пуш.
    $add = Invoke-Native "git add data.js" "git" @("add", "data.js")
    if ($add.Code -ne 0) { throw "git add завершился с кодом $($add.Code)" }

    $stamp = Get-Date -Format "dd.MM.yyyy HH:mm"
    $commit = Invoke-Native "git commit" "git" @("commit", "-m", "расписание: $stamp")
    if ($commit.Code -ne 0) { throw "git commit завершился с кодом $($commit.Code)" }

    $push = Invoke-Native "git push" "git" @("push", "--quiet", "origin", "HEAD")
    if ($push.Code -ne 0) { throw "git push завершился с кодом $($push.Code)" }

    Write-Log "data.js обновлён и отправлен на GitHub"
    Write-Log "=== готово ==="
    exit 0
}
catch {
    Write-Log ("ОШИБКА: " + $_.Exception.Message)
    Write-Log "=== завершено с ошибкой ==="
    exit 1
}
