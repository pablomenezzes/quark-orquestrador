<#
  Restaura um backup (.dump) em um banco NOVO e VAZIO (recuperacao de desastre). NUNCA mexe no banco de producao.

    .\scripts\restaurar-backup.ps1 -Destino "<url do banco novo>"                       usa o backup mais recente
    .\scripts\restaurar-backup.ps1 -Destino "<url do banco novo>" -Arquivo backups\nuvem-20261008-1602.dump

  Quando usar: a nuvem foi perdida ou corrompida. Passos (o roteiro completo esta em backups\COMO-RESTAURAR.txt):
    1) crie um projeto Supabase novo (vazio) e pegue a URL de conexao dele;
    2) recrie a ESTRUTURA do projeto nele com as migrations:   npx supabase db push --db-url "<url do banco novo>"
       (as migrations recriam tabelas, regras de seguranca e os papeis orq_*; as senhas dos papeis voltam com scripts\set-role-password.mjs);
    3) rode ESTE script: ele carrega os DADOS do backup e confere, tabela por tabela, se o destino ficou igual ao arquivo.

  Travas (para nunca haver conflito nem perda):
    - recusa se o destino for o banco de producao do .env.local (o projeto SUPABASE_PROJECT_REF), sem excecao;
    - recusa se o destino ja tiver dados (nao mistura nem sobrescreve nada);
    - recusa se o destino ainda nao tiver a estrutura das migrations;
    - confere o arquivo (indice legivel) antes de comecar.
  Os dados restauram sem o schema supabase_migrations (o historico de migrations ja foi criado pelo passo 2).
#>
param([Parameter(Mandatory = $true)][string]$Destino, [string]$Arquivo)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (Test-Path .env.local) {
  foreach ($line in Get-Content .env.local) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$' -and -not $line.TrimStart().StartsWith('#')) { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2].Trim('"') }
  }
}
$refProducao = $env:SUPABASE_PROJECT_REF
if ($refProducao -and $Destino.Contains($refProducao)) { throw 'RECUSADO: o destino e o banco de PRODUCAO. Este script so restaura em um banco novo e vazio.' }
if ($env:SUPABASE_DB_URL -and $Destino -eq $env:SUPABASE_DB_URL) { throw 'RECUSADO: o destino e o banco de PRODUCAO. Este script so restaura em um banco novo e vazio.' }
if ($Destino -notmatch '^postgres(ql)?://') { throw 'O destino precisa ser uma URL de conexao PostgreSQL (postgresql://...).' }

$bin = $null
$cmd = Get-Command pg_restore -ErrorAction SilentlyContinue
if ($cmd) { $bin = Split-Path $cmd.Source } elseif (Test-Path 'C:\PostgreSQL17\bin\pg_restore.exe') { $bin = 'C:\PostgreSQL17\bin' }
if (-not $bin) { throw 'pg_restore nao encontrado (esperado em C:\PostgreSQL17\bin).' }

if (-not $Arquivo) {
  $ultimo = Get-ChildItem backups -Filter 'nuvem-*.dump' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $ultimo) { throw 'Nao ha nenhum backup nuvem-*.dump na pasta backups.' }
  $Arquivo = $ultimo.FullName
}
if (-not (Test-Path $Arquivo)) { throw "Backup nao encontrado: $Arquivo" }
$itens = @(& "$bin\pg_restore.exe" --list $Arquivo)
if ($LASTEXITCODE -ne 0 -or $itens.Count -lt 50) { throw 'O backup nao tem um indice legivel: nao vou restaurar.' }
Write-Host ("Backup: {0} ({1:N1} MB, {2} objetos)" -f (Split-Path $Arquivo -Leaf), ((Get-Item $Arquivo).Length / 1MB), $itens.Count)

# o destino precisa ter a estrutura (migrations) e estar VAZIO
$env:CONTAGENS_URL = $Destino
$antes = node scripts/contagens.mjs | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Nao consegui conectar no destino. Confira a URL.' }
$faltam = @($antes.PSObject.Properties | Where-Object { $null -eq $_.Value } | ForEach-Object { $_.Name })
if ($faltam.Count) { throw ("O destino ainda nao tem a estrutura do projeto (faltam: {0}). Rode antes: npx supabase db push --db-url <url do destino>" -f ($faltam -join ', ')) }
$comDados = @($antes.PSObject.Properties | Where-Object { $_.Value -gt 0 } | ForEach-Object { $_.Name })
if ($comDados.Count) { throw ("RECUSADO: o destino ja tem dados ({0}). Para nao misturar nem sobrescrever, use um banco novo e vazio." -f ($comDados -join ', ')) }

Write-Host 'Carregando os dados do backup no destino...'
$ErrorActionPreference = 'Continue'
& "$bin\pg_restore.exe" --data-only --no-owner --no-privileges --exclude-schema=supabase_migrations --dbname=$Destino $Arquivo
$codigo = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($codigo -ne 0) { Write-Host "ATENCAO: pg_restore terminou com codigo $codigo (veja as mensagens acima)." }

$esperado = node scripts/verificar-backup.mjs $Arquivo --so-contar | ConvertFrom-Json
$depois = node scripts/contagens.mjs | ConvertFrom-Json
$dif = @()
foreach ($p in $esperado.PSObject.Properties) {
  $obtido = $depois.($p.Name)
  if ($obtido -ne $p.Value) { $dif += ("{0}: backup {1} x destino {2}" -f $p.Name, $p.Value, $obtido) }
}
Remove-Item Env:CONTAGENS_URL -ErrorAction SilentlyContinue
if ($dif.Count) { throw ("O destino NAO ficou igual ao backup: " + ($dif -join '; ')) }
Write-Host ("RESTAURADO E CONFERIDO: {0} tabelas com a mesma quantidade de linhas do backup." -f @($esperado.PSObject.Properties).Count)
Write-Host 'Proximos passos: gerar as senhas dos papeis (node scripts\set-role-password.mjs --role orq_sync --apply, e orq_panel, orq_chat), atualizar o .env.local com a URL nova e rodar npm run sincronia.'
