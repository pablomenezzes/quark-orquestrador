<#
  Guarda no GitHub (Actions > Secrets) os segredos da sincronia automatica, lendo do .env.local.
  Os valores NUNCA aparecem na tela nem na linha de comando: vao pela entrada padrao para o GitHub CLI (gh).
  Pre-requisito: gh instalado e logado (gh auth login). Uso:
    powershell -ExecutionPolicy Bypass -File scripts\github-segredos.ps1            -> mostra o que seria guardado (so os nomes)
    powershell -ExecutionPolicy Bypass -File scripts\github-segredos.ps1 -Apply     -> guarda de verdade
#>
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$nomes = @('PIPEDRIVE_DOMAIN', 'PIPEDRIVE_API_TOKEN', 'SYNC_DB_URL', 'SUPABASE_PROJECT_REF', 'GOOGLE_SA_CLIENT_EMAIL', 'GOOGLE_SA_PRIVATE_KEY', 'GA4_PROPERTY_ID')
$env_ = @{}
foreach ($line in Get-Content .env.local) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$' -and -not $line.TrimStart().StartsWith('#')) { $env_[$Matches[1]] = $Matches[2].Trim('"') }
}
$faltam = $nomes | Where-Object { -not $env_[$_] }
if ($faltam) { throw "Faltam no .env.local: $($faltam -join ', ')" }
if ($env_['SYNC_DB_URL'] -notmatch '//orq_sync[.:]') { throw 'SYNC_DB_URL nao e do papel orq_sync: recusando (so o papel de menor privilegio vai para o GitHub).' }

$repo = 'pablomenezzes/quark-orquestrador'
Write-Host "Repositorio: $repo"
Write-Host "Segredos: $($nomes -join ', ')"
if (-not $Apply) { Write-Host 'Nada guardado (use -Apply).'; exit 0 }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh nao instalado.' }
foreach ($n in $nomes) {
  $env_[$n] | gh secret set $n --repo $repo
  if ($LASTEXITCODE -ne 0) { throw "Falhou ao guardar $n" }
  Write-Host "  guardado: $n"
}
gh secret list --repo $repo
