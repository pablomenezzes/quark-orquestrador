<#
  Backup local COMPLETO e CONFERIDO do banco da nuvem (Supabase).

    .\scripts\backup-local.ps1                  faz o backup e confere, tabela por tabela, com a nuvem
    .\scripts\backup-local.ps1 -Prune           depois do backup, apaga backups antigos pela regra de retencao (abaixo)
    .\scripts\backup-local.ps1 -Silencioso      sem mensagens na tela (para a tarefa agendada)

  O que entra: os schemas do projeto (core, orq, crm, raw, ops, analytics, public) e o historico de migrations
  (supabase_migrations). Os schemas internos do Supabase (auth, storage...) ficam de fora: o projeto nao os usa.
  Formato: pg_dump "custom" (comprimido), arquivo backups\nuvem-AAAAMMDD-HHMM.dump. Restaura com pg_restore.

  Conferencias: (1) o arquivo tem indice legivel (pg_restore --list); (2) as linhas de 23 tabelas DENTRO do arquivo sao
  contadas e comparadas com as da nuvem (scripts\verificar-backup.mjs); (3) tudo e anotado em backups\ULTIMO_BACKUP.json
  e backups\backup.log.

  Retencao do -Prune (so apaga arquivos nuvem-*.dump): mantem SEMPRE os 7 mais recentes, todos com menos de 30 dias e os do
  dia 1 de cada mes. Nunca toca nos dumps .sql feitos antes de cada db push (scripts\db-push.ps1).
  Segredos: a URL do banco vem do .env.local e nunca e impressa nem gravada no log.
#>
param([switch]$Prune, [switch]$Silencioso)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force backups | Out-Null
$logFile = 'backups\backup.log'
function Log($m) { $l = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m; Add-Content -Path $logFile -Value $l -Encoding UTF8; if (-not $Silencioso) { Write-Host $m } }

try {
  if (-not (Test-Path .env.local)) { throw '.env.local nao encontrado.' }
  foreach ($line in Get-Content .env.local) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$' -and -not $line.TrimStart().StartsWith('#')) { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim('"') }
  }
  if (-not $env:SUPABASE_DB_URL -or -not $env:SUPABASE_PROJECT_REF) { throw 'Defina SUPABASE_DB_URL e SUPABASE_PROJECT_REF no .env.local.' }
  if (-not $env:SUPABASE_DB_URL.Contains($env:SUPABASE_PROJECT_REF)) { throw 'SUPABASE_DB_URL nao contem SUPABASE_PROJECT_REF: recusando.' }
  $bin = $null
  $cmd = Get-Command pg_dump -ErrorAction SilentlyContinue
  if ($cmd) { $bin = Split-Path $cmd.Source } elseif (Test-Path 'C:\PostgreSQL17\bin\pg_dump.exe') { $bin = 'C:\PostgreSQL17\bin' }
  if (-not $bin) { throw 'pg_dump nao encontrado (esperado em C:\PostgreSQL17\bin).' }
  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if (-not $node) { $env:Path += ';C:\Program Files\nodejs' }

  $arquivo = Join-Path 'backups' ("nuvem-{0}.dump" -f (Get-Date -Format 'yyyyMMdd-HHmm'))
  $inicio = Get-Date
  Log 'Backup: baixando o banco da nuvem...'
  $schemas = @('core','orq','crm','raw','ops','analytics','public','supabase_migrations')
  $pgArgs = @("--dbname=$($env:SUPABASE_DB_URL)", '--format=custom', '--compress=6', '--no-owner', '--no-privileges', "--file=$arquivo")
  foreach ($s in $schemas) { $pgArgs += "--schema=$s" }
  & "$bin\pg_dump.exe" @pgArgs
  if ($LASTEXITCODE -ne 0) { throw "pg_dump falhou (codigo $LASTEXITCODE)." }
  $tam = (Get-Item $arquivo).Length
  if ($tam -lt 10240) { throw "Backup suspeito de vazio ($tam bytes): $arquivo" }

  $itens = @(& "$bin\pg_restore.exe" --list $arquivo)
  if ($LASTEXITCODE -ne 0 -or $itens.Count -lt 50) { throw 'O backup nao tem um indice legivel: nao confio nele.' }
  Log ("Backup ok: {0} ({1:N1} MB, {2} objetos, {3:N0} s)" -f (Split-Path $arquivo -Leaf), ($tam / 1MB), $itens.Count, ((Get-Date) - $inicio).TotalSeconds)

  $conf = node scripts/verificar-backup.mjs $arquivo
  $codigo = $LASTEXITCODE
  $resumo = ($conf | Select-Object -Last 1)
  $divergentes = @($conf | Where-Object { $_ -match 'DIVERGE' })
  if ($codigo -ne 0) { Log ("ATENCAO: o backup NAO bate com a nuvem: " + ($divergentes -join ' ; ')) } else { Log "Conferencia: $resumo" }

  $resultado = [ordered]@{
    arquivo = (Split-Path $arquivo -Leaf); tamanho_mb = [math]::Round($tam / 1MB, 1); feito_em = (Get-Date).ToString('o')
    conferido_com_a_nuvem = ($codigo -eq 0); resumo = "$resumo"; divergencias = $divergentes; commit = (git rev-parse --short HEAD 2>$null)
  }
  $resultado | ConvertTo-Json -Depth 4 | Set-Content -Path 'backups\ULTIMO_BACKUP.json' -Encoding UTF8

  if ($Prune) {
    $todos = @(Get-ChildItem backups -Filter 'nuvem-*.dump' | Sort-Object LastWriteTime -Descending)
    $apagar = @($todos | Select-Object -Skip 7 | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) -and $_.LastWriteTime.Day -ne 1 })
    foreach ($f in $apagar) { Remove-Item -LiteralPath $f.FullName; Log "Retencao: apaguei $($f.Name)" }
    if (-not $apagar.Count) { Log 'Retencao: nada a apagar.' }
  }
  if ($codigo -ne 0) { throw 'O backup foi feito mas nao bate com a nuvem.' }
  Log 'Tudo certo.'
}
catch {
  Log ("FALHOU: " + ($_.Exception.Message -replace 'postgres(ql)?://\S+', '<url>'))
  if (-not $Silencioso) { throw }
  exit 1
}
