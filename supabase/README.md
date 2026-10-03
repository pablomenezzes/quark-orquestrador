# Supabase

Projeto único "Orquestrador CRM Quark" (São Paulo). Regras em `orquestrador-marketing-quark.md`, seção 4.

## Regras

1. Nada no schema `public`.
2. Dump completo em `backups/` antes de todo `db push` (`scripts/dump.ps1`).
3. Migrations somente aditivas. `DROP`, `RENAME` ou mudança de tipo exigem aprovação explícita, com justificativa.
4. O SQL é mostrado e aprovado antes do `db push`.
5. Testes de integração rodam em transação com `ROLLBACK`.

## Migrations

| Arquivo | Conteúdo |
|---|---|
| `0001_schemas_core_orq_crm.sql` | Schemas `core`, `orq`, `crm`; tabelas das seções 8.1 e 8.2; triggers (`updated_at`, imutabilidade de `orq.events`); índices |
| `0002_rls_and_grants.sql` | RLS ativo em todas as tabelas, sem política para `anon`/`authenticated`; privilégios da `service_role` |

O linter `tests/migrations-lint.test.ts` roda em todo `npm test` e barra DROP, RENAME, mudança de tipo, TRUNCATE, DELETE, qualquer coisa no `public` e tabela sem RLS.

## Aplicar (somente após aprovação do SQL)

```powershell
# Simula: lint + dump + lista o que seria aplicado. Não altera o banco.
./scripts/db-push.ps1

# Aplica. Só depois de o Pablo aprovar o SQL.
./scripts/db-push.ps1 -Apply
```

Pré-requisitos: `.env.local` preenchido (ver `.env.example`) e `pg_dump` 17+ no PATH.

## Painel

Nada a configurar no painel: o endpoint fala direto com o Postgres (decisão D-13), então não é preciso expor os schemas na API.

## Testes de integração

`npm test` roda tudo. Os testes de `tests/integration/` só executam com `SUPABASE_DB_URL` e `SUPABASE_PROJECT_REF`
definidos e depois que as migrations foram aplicadas; caso contrário são pulados.
Cada um roda em `BEGIN ... ROLLBACK` e, ao final, a contagem de linhas de todas as tabelas tem de ser igual à do início.
