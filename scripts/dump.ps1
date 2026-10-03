<#
  Dump completo do banco para backups/ (regra 2 da secao 4). Obrigatorio antes de todo db push.
  Requer pg_dump (cliente PostgreSQL 17 ou superior) no PATH e SUPABASE_DB_URL no .env.local.
  Sai com erro se o dump falhar ou vier vazio.
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not (Test-Path .env.local)) { throw '.env.local nao encontrado.' }
foreach ($line in Get-Content .env.local) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$' -and -not $line.TrimStart().StartsWith('#')) {
    Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim('"')
  }
}
if (-not $env:SUPABASE_DB_URL -or -not $env:SUPABASE_PROJECT_REF) { throw 'Defina SUPABASE_DB_URL e SUPABASE_PROJECT_REF no .env.local.' }
if (-not $env:SUPABASE_DB_URL.Contains($env:SUPABASE_PROJECT_REF)) { throw 'SUPABASE_DB_URL nao contem SUPABASE_PROJECT_REF: recusando.' }
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  $fallback = 'C:\PostgreSQL17\bin'
  if (Test-Path "$fallback\pg_dump.exe") { $env:Path += ";$fallback" }
  else { throw 'pg_dump nao encontrado. Instale o cliente PostgreSQL 17+ (winget install PostgreSQL.PostgreSQL.17).' }
}

New-Item -ItemType Directory -Force backups | Out-Null
$file = Join-Path backups ("dump-{0}.sql" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
& pg_dump --dbname=$env:SUPABASE_DB_URL --format=plain --no-owner --no-privileges --file=$file
if ($LASTEXITCODE -ne 0) { throw "pg_dump falhou (codigo $LASTEXITCODE)." }
$size = (Get-Item $file).Length
if ($size -lt 1024) { throw "Dump suspeito de vazio ($size bytes): $file" }
Write-Host "Dump ok: $file ($size bytes)"
