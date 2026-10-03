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
