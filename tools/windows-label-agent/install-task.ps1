param(
  [string]$AgentDir = 'C:\FusionBikes\label-agent',
  [string]$TaskName = 'FusionBikes Label Agent'
)

$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$script = Join-Path $AgentDir 'agent.mjs'
$config = Join-Path $AgentDir 'config.json'
if (!(Test-Path $script) -or !(Test-Path $config)) {
  throw "Faltan agent.mjs o config.json en $AgentDir"
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --config `"$config`"" -WorkingDirectory $AgentDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "Tarea instalada: $TaskName"
