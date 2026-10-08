<#
  Espelho local do banco da nuvem (PostgreSQL 17 do proprio computador, so para leitura e seguranca).

    .\scripts\espelho.ps1 -Status                 mostra se esta no ar e o que tem dentro
    .\scripts\espelho.ps1 -Iniciar                cria (na primeira vez) e liga o espelho
    .\scripts\espelho.ps1 -Parar                  desliga
    .\scripts\espelho.ps1 -Restaurar <arquivo>    APAGA o espelho e o refaz inteiro a partir de um backup .dump

  Regras que evitam conflito com a nuvem:
    - a NUVEM (Supabase) e a unica fonte da verdade; o espelho nunca recebe escrita manual nem volta para a nuvem;
    - a cada restauracao o espelho e refeito do zero a partir de um backup, nunca "atualizado aos poucos";
    - escuta so em 127.0.0.1 (porta 54329), sem senha, porque so este computador alcanca.
  Onde fica: %LOCALAPPDATA%\quark-espelho (fora da pasta do projeto e de qualquer sincronizacao de nuvem).
  Conexao: C:\PostgreSQL17\bin\psql -h 127.0.0.1 -p 54329 -U postgres quark_espelho
#>
param([switch]$Status, [switch]$Iniciar, [switch]$Parar, [string]$Restaurar)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$bin = $null
$cmd = Get-Command pg_ctl -ErrorAction SilentlyContinue
if ($cmd) { $bin = Split-Path $cmd.Source } elseif (Test-Path 'C:\PostgreSQL17\bin\pg_ctl.exe') { $bin = 'C:\PostgreSQL17\bin' }
if (-not $bin) { throw 'PostgreSQL 17 nao encontrado (esperado em C:\PostgreSQL17\bin).' }

if (-not (Test-Path (Join-Path (Split-Path $bin -Parent) 'share\postgres.bki'))) {
  throw "O PostgreSQL em $bin so tem as ferramentas de cliente (falta a pasta share do servidor). Para ter um banco espelho vivo e preciso instalar o PostgreSQL 17 completo (ex.: winget install PostgreSQL.PostgreSQL.17) ou apontar para uma instalacao completa. O backup conferido (scripts\backup-local.ps1) funciona sem isso."
}

$raiz = Join-Path $env:LOCALAPPDATA 'quark-espelho'
$data = Join-Path $raiz 'data'
$log = Join-Path $raiz 'postgres.log'
$porta = 54329
$db = 'quark_espelho'

function No-Ar { & "$bin\pg_ctl.exe" status -D $data *> $null; return ($LASTEXITCODE -eq 0) }

function Ligar {
  New-Item -ItemType Directory -Force $raiz | Out-Null
  if (-not (Test-Path (Join-Path $data 'PG_VERSION'))) {
    Write-Host 'Criando o espelho (primeira vez)...'
    & "$bin\initdb.exe" -D $data -U postgres --auth=trust -E UTF8 --locale=C *> $null
    if ($LASTEXITCODE -ne 0) { throw 'initdb falhou.' }
  }
  if (-not (No-Ar)) {
    & "$bin\pg_ctl.exe" start -w -D $data -l $log -o "-p $porta -c listen_addresses=127.0.0.1 -c fsync=off" *> $null
    if ($LASTEXITCODE -ne 0) { throw "Nao consegui ligar o espelho. Veja $log" }
  }
}

function Psql($banco, $sql) {
  & "$bin\psql.exe" -h 127.0.0.1 -p $porta -U postgres -d $banco -v ON_ERROR_STOP=1 -q -t -A -c $sql
  if ($LASTEXITCODE -ne 0) { throw "psql falhou: $sql" }
}

if ($Parar) {
  if (No-Ar) { & "$bin\pg_ctl.exe" stop -m fast -D $data *> $null; Write-Host 'Espelho desligado.' } else { Write-Host 'O espelho ja estava desligado.' }
  return
}

if ($Iniciar) { Ligar; Write-Host "Espelho no ar em 127.0.0.1:$porta (banco $db)."; return }

if ($Restaurar) {
  if (-not (Test-Path $Restaurar)) { throw "Backup nao encontrado: $Restaurar" }
  Ligar
  Write-Host "Refazendo o espelho a partir de $(Split-Path $Restaurar -Leaf) ..."
  Psql 'postgres' "drop database if exists $db with (force)"
  Psql 'postgres' "create database $db"
  # papeis que as politicas e permissoes do projeto citam (sem login e sem senha: so para o restore aceitar)
  $papeis = 'orq_ingest','orq_sync','orq_panel','orq_chat','anon','authenticated','service_role','supabase_admin'
  foreach ($p in $papeis) { Psql 'postgres' "do `$`$ begin if not exists (select 1 from pg_roles where rolname = '$p') then create role $p nologin; end if; end `$`$" }
  Psql $db 'create schema if not exists extensions'
  $err = Join-Path $raiz 'restauracao.err'
  $ErrorActionPreference = 'Continue'
  cmd /c "`"$bin\pg_restore.exe`" -h 127.0.0.1 -p $porta -U postgres -d $db --no-owner --no-privileges -j 4 `"$Restaurar`" 2> `"$err`""
  $ErrorActionPreference = 'Stop'
  $erros = @(Get-Content $err -ErrorAction SilentlyContinue | Where-Object { $_ -match 'error:' })
  if ($erros.Count) {
    Write-Host "Restauracao terminou com $($erros.Count) aviso(s)/erro(s). Primeiros:"
    $erros | Select-Object -First 5 | ForEach-Object { Write-Host "  $_" }
  } else { Write-Host 'Restauracao sem nenhum erro.' }
  return
}

# -Status (padrao)
if (No-Ar) {
  Write-Host "Espelho NO AR em 127.0.0.1:$porta."
  try { Psql 'postgres' "select 'banco $db existe: ' || exists(select 1 from pg_database where datname = '$db')" } catch { }
} else {
  Write-Host 'Espelho desligado (ligue com: .\scripts\espelho.ps1 -Iniciar).'
}
