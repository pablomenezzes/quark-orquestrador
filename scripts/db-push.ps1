<#
  Fluxo seguro de db push (secao 4):
    1. lint das migrations (testes)
    2. dump completo em backups/        (regra 2)
    3. mostra o que seria aplicado      (regra 4) -- dry-run
    4. aplica SOMENTE com -Apply, e so depois da aprovacao do Pablo
  Sem -Apply, nada e alterado no banco.
#>
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host '== 1/4 Lint das migrations =='
npx vitest run tests/migrations-lint.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Lint das migrations falhou.' }

Write-Host '== 2/4 Dump completo =='
& "$PSScriptRoot\dump.ps1"

foreach ($line in Get-Content .env.local) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$' -and -not $line.TrimStart().StartsWith('#')) {
    Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim('"')
  }
}

# A CLI do Supabase exige SSL explicito no pooler (sem isso: 'Connection terminated unexpectedly').
$dbUrl = if ($env:SUPABASE_DB_URL.Contains('sslmode=')) { $env:SUPABASE_DB_URL } else { $env:SUPABASE_DB_URL + '?sslmode=require' }

Write-Host '== 3/4 Dry-run: migrations pendentes =='
npx supabase db push --dry-run --db-url $dbUrl
if ($LASTEXITCODE -ne 0) { throw 'dry-run falhou.' }

if (-not $Apply) {
  Write-Host '== 4/4 Nada aplicado (use -Apply apos aprovar o SQL) =='
  exit 0
}
Write-Host '== 4/4 Aplicando =='
npx supabase db push --db-url $dbUrl

