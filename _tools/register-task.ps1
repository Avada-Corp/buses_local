<#
.SYNOPSIS
    Регистрирует ежедневное обновление расписания в планировщике задач Windows.

.DESCRIPTION
    Создаёт задачу BusesScheduleUpdate, которая запускает _tools\update-local.ps1.
    Задача работает от текущего пользователя (доступ к сохранённым учётным данным
    git есть), поэтому пароль вводить не нужно.

    Если компьютер был выключен в назначенное время, задача выполнится при
    следующем включении (StartWhenAvailable).

.PARAMETER At
    Время ежедневного запуска, по умолчанию 09:00.

.PARAMETER TaskName
    Имя задачи в планировщике.

.PARAMETER Remove
    Удалить задачу вместо создания.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File _tools\register-task.ps1 -At "07:30"

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File _tools\register-task.ps1 -Remove
#>
param(
    [string]$At = "09:00",
    [string]$TaskName = "BusesScheduleUpdate",
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $PSScriptRoot "update-local.ps1"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Задача «$TaskName» удалена."
    exit 0
}

if (-not (Test-Path $Script)) { throw "не найден $Script" }

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $Script) `
    -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -Daily -At $At

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Обновление расписания Берёзовки с ticketbus.by и пуш data.js на GitHub Pages" `
    -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host "Задача «$TaskName» создана."
Write-Host "Запуск: ежедневно в $At (если ПК был выключен — при следующем включении)."
Write-Host "Следующий запуск: $($info.NextRunTime)"
Write-Host "Скачать и обновить прямо сейчас: _tools\update-local.cmd"
Write-Host "Лог: $(Join-Path $PSScriptRoot 'update-local.log')"
