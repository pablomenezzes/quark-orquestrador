/** Refs de projetos Supabase que nunca podem ser usados (projetos que não existem mais). */
export const BLOCKED_REFS = ['igidjtfhqqezmuakprnw'];

/**
 * Trava de segurança: só deixa seguir se `target` (URL da API ou connection string)
 * apontar para o projeto esperado (SUPABASE_PROJECT_REF) e não para um ref bloqueado.
 */
export function assertSafeDbTarget(opts: { target: string; expectedRef: string; blockedRefs?: string[] }): void {
  const { target, expectedRef } = opts;
  const blocked = opts.blockedRefs ?? BLOCKED_REFS;
  if (!expectedRef) throw new Error('SUPABASE_PROJECT_REF não configurado: recusando conectar ao banco.');
  if (!target) throw new Error('URL do banco vazia: recusando conectar.');
  if (blocked.includes(expectedRef) || blocked.some((r) => target.includes(r))) {
    throw new Error('Ref de projeto antigo/bloqueado detectado: recusando conectar.');
  }
  if (!target.includes(expectedRef)) {
    throw new Error('O alvo não contém o ref do projeto esperado (SUPABASE_PROJECT_REF): recusando conectar.');
  }
}

/** Papel de banco do endpoint público (migration 0003). */
export const INGEST_ROLE = 'orq_ingest';

/**
 * O endpoint público só pode conectar com o papel de privilégio mínimo. Aceita `orq_ingest` (conexão direta)
 * e `orq_ingest.<ref>` (pooler do Supabase). Qualquer outro usuário (postgres, service_role...) é recusado.
 * A mensagem nunca inclui a URL nem a senha.
 */
export function assertLeastPrivilegeUser(url: string): void {
  let user = '';
  try {
    user = decodeURIComponent(new URL(url).username);
  } catch {
    throw new Error('INGEST_DB_URL ausente ou em formato inválido: o endpoint exige a conexão do papel de privilégio mínimo (orq_ingest).');
  }
  if (user !== INGEST_ROLE && !user.startsWith(`${INGEST_ROLE}.`)) {
    throw new Error(`O endpoint público só pode usar o papel de privilégio mínimo (${INGEST_ROLE}), não "${user || '(sem usuário)'}".`);
  }
}

/**
 * Garante que uma conexão usa o papel esperado (`orq_sync`, `orq_panel`...). Aceita `<papel>` e `<papel>.<ref>` (pooler).
 * Recusa postgres e qualquer outro. A mensagem nunca inclui a URL nem a senha.
 */
export function assertRoleUser(url: string, role: string): void {
  let user = '';
  try {
    user = decodeURIComponent(new URL(url).username);
  } catch {
    throw new Error(`URL de conexão do papel ${role} ausente ou em formato inválido.`);
  }
  if (user !== role && !user.startsWith(`${role}.`)) {
    throw new Error(`Esta conexão deve usar o papel ${role}, não "${user || '(sem usuário)'}".`);
  }
}
