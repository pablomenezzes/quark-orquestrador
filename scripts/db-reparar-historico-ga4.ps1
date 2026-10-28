<#
  Corrige SO o historico de migrations do Supabase (nao altera nenhuma tabela nem dado):
  as migrations do GA4 foram aplicadas no banco com versao de data (20261026213618 e 20261026213626), mas no repositorio
  os arquivos se chamam 0026_ga4_uma_propriedade_por_marca.sql e 0027_ga4_propriedade_quarkclinic.sql. A CLI nao casa os dois
  e o db push para ("Remote migration versions not found in local migrations directory").
  Este script troca no historico as versoes de data pelos numeros 0026 e 0027, que e como os arquivos locais se chamam.
  Depois rode de novo: scripts/db-push.ps1 -Apply   (vai aplicar so as pendentes: 0028 e 0029).
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

foreach ($line in Get-Content .env.local) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$' -and -not $line.TrimStart().StartsWith('#')) {
    Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim('"')
  }
}
$dbUrl = if ($env:SUPABASE_DB_URL.Contains('sslmode=')) { $env:SUPABASE_DB_URL } else { $env:SUPABASE_DB_URL + '?sslmode=require' }

Write-Host '== Historico atual (remoto) =='
npx supabase migration list --db-url $dbUrl

Write-Host '== 1/2 Tirando do historico as versoes de data do GA4 =='
npx supabase migration repair --status reverted 20261026213618 20261026213626 --db-url $dbUrl
if ($LASTEXITCODE -ne 0) { throw 'repair (reverted) falhou.' }

Write-Host '== 2/2 Registrando 0026 e 0027 como aplicadas (ja estao no banco) =='
npx supabase migration repair --status applied 0026 0027 --db-url $dbUrl
if ($LASTEXITCODE -ne 0) { throw 'repair (applied) falhou.' }

Write-Host '== Historico depois =='
npx supabase migration list --db-url $dbUrl
Write-Host 'Pronto. Agora rode: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/db-push.ps1 -Apply'
