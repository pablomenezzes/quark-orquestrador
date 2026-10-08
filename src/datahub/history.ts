import { toIso } from './parse.js';

/**
 * Histórico de etapas de um negócio (Entrega 5). Funções puras, sem rede nem banco.
 *
 * Fonte: GET /v1/deals/{id}/flow?items=dealChange. Cada mudança de etapa é um item com
 * data.field_key = "stage_id", old_value, new_value e log_time (UTC, "AAAA-MM-DD HH:MM:SS").
 * Regras (D-41):
 *  - a etapa INICIAL do negócio é o old_value da primeira mudança, desde a criação do negócio;
 *  - negócio sem nenhuma mudança de etapa: uma linha só, na etapa atual, desde a criação;
 *  - cada mudança abre uma linha e fecha a anterior (saiu_em = momento da mudança seguinte).
 */

export type FlowItem = {
  id?: number | null;
  field_key: string;
  old_value: unknown;
  new_value: unknown;
  log_time: string | null;
  user_id: number | null;
  change_source?: string | null;
  is_bulk_update_flag?: boolean | null;
};

export type StageHistoryRow = {
  stage_id: number;
  entrou_em: string;
  saiu_em: string | null;
  user_id: number | null;
  origem_dado: 'flow' | 'criacao';
};

const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);

/**
 * Do JSON do flow guarda só as mudanças de ETAPA e só os campos essenciais (economia de espaço, D-40/D-41).
 * Itens que não são mudança de negócio (atividades, notas) ou de outro campo ficam de fora.
 */
export function trimFlowItems(raw: unknown[]): FlowItem[] {
  const out: FlowItem[] = [];
  for (const it of raw) {
    const o = it as { object?: unknown; data?: Record<string, unknown>; timestamp?: unknown };
    if (!o || o.object !== 'dealChange' || !o.data || o.data.field_key !== 'stage_id') continue;
    const d = o.data;
    out.push({
      id: intOrNull(d.id),
      field_key: 'stage_id',
      old_value: d.old_value ?? null,
      new_value: d.new_value ?? null,
      log_time: toIso(typeof d.log_time === 'string' ? d.log_time : typeof o.timestamp === 'string' ? o.timestamp : null),
      user_id: intOrNull(d.user_id),
      change_source: typeof d.change_source === 'string' ? d.change_source : null,
      is_bulk_update_flag: typeof d.is_bulk_update_flag === 'boolean' ? d.is_bulk_update_flag : null,
    });
  }
  return out;
}

export type BuiltHistory = { rows: StageHistoryRow[]; avisos: string[] };

/** Monta a linha do tempo. `createdAt` e `currentStageId` vêm do negócio (crm.deals). */
export function buildStageHistory(createdAt: string | null, currentStageId: number | null, items: FlowItem[]): BuiltHistory {
  const avisos: string[] = [];
  const sorted = items
    .filter((i) => i.field_key === 'stage_id' && i.log_time && intOrNull(i.new_value) !== null)
    .sort((a, b) => Date.parse(a.log_time!) - Date.parse(b.log_time!) || (a.id ?? 0) - (b.id ?? 0));
  // O Pipedrive às vezes registra a MESMA mudança duas vezes no mesmo segundo (visto em integrações via API: dois itens
  // 1 -> 3 com o mesmo log_time). Itens idênticos em origem, destino e momento viram um só; o JSON original em raw guarda os dois.
  const vistos = new Set<string>();
  const changes = sorted.filter((i) => {
    const k = `${intOrNull(i.old_value)}|${intOrNull(i.new_value)}|${i.log_time}`;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });

  if (!changes.length) {
    if (!createdAt || currentStageId === null) return { rows: [], avisos: ['sem data de criação ou sem etapa atual: nada a registrar'] };
    return { rows: [{ stage_id: currentStageId, entrou_em: createdAt, saiu_em: null, user_id: null, origem_dado: 'criacao' }], avisos };
  }

  const rows: StageHistoryRow[] = [];
  const initial = intOrNull(changes[0]!.old_value);
  if (initial !== null && createdAt) {
    rows.push({ stage_id: initial, entrou_em: createdAt, saiu_em: changes[0]!.log_time, user_id: null, origem_dado: 'criacao' });
  } else if (initial === null) {
    avisos.push('a primeira mudança de etapa não informa a etapa de origem: o trecho inicial ficou sem linha');
  }
  changes.forEach((c, i) => {
    rows.push({
      stage_id: intOrNull(c.new_value)!,
      entrou_em: c.log_time!,
      saiu_em: changes[i + 1]?.log_time ?? null,
      user_id: c.user_id,
      origem_dado: 'flow',
    });
  });
  // Trava final: o banco exige (negócio, etapa, momento) único. Se ainda restar repetição (ex.: duas mudanças para a mesma etapa
  // no mesmo segundo, vindas de etapas de origem diferentes), fica a última e o fato é avisado; o JSON original em raw guarda tudo.
  const porChave = new Map<string, StageHistoryRow>();
  for (const r of rows) porChave.set(`${r.stage_id}|${r.entrou_em}`, r);
  if (porChave.size !== rows.length) {
    avisos.push(`${rows.length - porChave.size} linha(s) repetida(s) na mesma etapa e no mesmo segundo foram unidas`);
    rows.length = 0;
    rows.push(...porChave.values());
  }
  const last = rows.at(-1)!;
  if (currentStageId !== null && last.stage_id !== currentStageId) {
    avisos.push(`o histórico termina na etapa ${last.stage_id}, mas o negócio está hoje na etapa ${currentStageId}`);
  }
  return { rows, avisos };
}
