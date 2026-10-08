<#
  Cria (ou remove) a tarefa do Windows que faz o backup local todos os dias.

    .\scripts\agendar-backup.ps1            cria/atualiza a tarefa "QuarkDados-BackupLocal": todo dia as 03:00
    .\scripts\agendar-backup.ps1 -Remover   apaga a tarefa
    .\scripts\agendar-backup.ps1 -Status    mostra se a tarefa existe, o ultimo resultado e a proxima execucao

  Roda como o seu usuario (nao precisa de administrador), sem janela, e so quando ha rede. Se o computador estiver desligado as 03:00,
  a tarefa roda assim que ele ligar (StartWhenAvailable). Faz: scripts\backup-local.ps1 -Silencioso -Prune.
  Para ver o que aconteceu: backups\backup.log e backups\ULTIMO_BACKUP.json.
#>
param([switch]$Remover, [switch]$Status)
$ErrorActionPreference = 'Stop'
$nome = 'QuarkDados-BackupLocal'
$raiz = Split-Path $PSScriptRoot -Parent

if ($Status) {
  $t = Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "A tarefa ${nome} NAO existe (crie com: .\scripts\agendar-backup.ps1)."; return }
  $i = Get-ScheduledTaskInfo -TaskName $nome
  Write-Host "Tarefa ${nome}: estado $($t.State); ultima execucao $($i.LastRunTime) (resultado $($i.LastTaskResult)); proxima $($i.NextRunTime)."
  return
}
if ($Remover) {
  Unregister-ScheduledTask -TaskName $nome -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarefa ${nome} removida."
  return
}

$script = Join-Path $PSScriptRoot 'backup-local.ps1'
$acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Silencioso -Prune" -WorkingDirectory $raiz
$gatilho = New-ScheduledTaskTrigger -Daily -At 3am
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilho -Settings $config -Description 'Backup local conferido do banco Quark Data Hub (Supabase) para a pasta backups do projeto.' -Force | Out-Null
Write-Host "Tarefa ${nome} criada: todo dia as 03:00 (ou ao ligar o computador, se estava desligado)."
