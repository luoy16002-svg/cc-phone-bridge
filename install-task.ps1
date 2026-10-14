# Windows: registers a scheduled task for the current user that keeps the bridge running: started at logon,
# checked every 5 minutes (a second copy is never started), no console window.
#   pwsh -File install-task.ps1                       # task \CC-Phone-Bridge
#   pwsh -File install-task.ps1 -TaskPath '\tools\'   # put it in a task folder
#   pwsh -File install-task.ps1 -Remove               # stop and remove it
param([switch]$Remove, [string]$TaskPath = '\', [string]$Name = 'CC-Phone-Bridge')
$ErrorActionPreference = 'Stop'
if (-not $TaskPath.EndsWith('\')) { $TaskPath += '\' }
if ($Remove) {
  Stop-ScheduledTask -TaskName $Name -TaskPath $TaskPath -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
  $here = Split-Path -Parent $MyInvocation.MyCommand.Path
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$here*server.mjs*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host 'Removed.'
  return
}
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw 'Python 3 is needed for the windowless launcher (python.org or the Microsoft Store).' }
$pyw = Join-Path (Split-Path $python.Source) 'pythonw.exe'
if (-not (Test-Path $pyw)) { throw "pythonw.exe not found next to python ($pyw)" }
$action = New-ScheduledTaskAction -Execute $pyw -Argument "`"$here\launcher.pyw`"" -WorkingDirectory $here
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $Name -TaskPath $TaskPath -Action $action -Trigger @($atLogon, $every5) -Settings $settings `
  -Principal $principal -Description "cc-phone-bridge: Claude Code from your phone ($here)" -Force | Out-Null
Start-ScheduledTask -TaskName $Name -TaskPath $TaskPath
Write-Host "Registered $TaskPath$Name and started it."
