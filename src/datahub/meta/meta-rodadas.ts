/**
 * Rodadas da Meta por trimestre de calendario (protocolo do Pablo, 2026-10-13). Toda rodada nasce em SIMULACAO: le a Meta (so GET), compara com o
 * que ja esta no banco, reconcilia contra o total da conta e produz o CARTAO DA RODADA. Gravar so com a autorizacao do Pablo ("pode seguir") depois do
 * cartao, vale para UMA rodada (uma conta e um intervalo) e exige a simulacao previa da MESMA conta e do MESMO intervalo.
 * Fica so a versao mais recente de cada linha (decisao do Pablo); `revisao` conta quantas vezes a Meta mudou o numero.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { lerInsights, MetaCotaErro, type AdDia, type MetaClient, type MetaConta } from './meta.js';

type Q = Pick<pg.Pool, 'query'>;

/** Ordem combinada das rodadas. */
export const ORDEM_TRIMESTRES = ['2026-T3', '2026-T4', '2026-T2', '2026-T1', '2025-T4', '2025-T3', '2025-T2', '2025-T1'] as const;
/** Bytes por linha do diario (medido: 227 B com indices) e limite do plano gratuito. */
export const BYTES_POR_LINHA = 227;
export const LIMITE_BANCO_MB = 500;

export function trimestreIntervalo(t: string): { de: string; ate: string } {
  const m = /^(20\d{2})-T([1-4])$/.exec(t);
  if (!m) throw new Error(`Trimestre invalido: ${t} (use AAAA-T1 a AAAA-T4)`);
  const ano = Number(m[1]);
  const q = Number(m[2]);
  const mesIni = (q - 1) * 3 + 1;
  const ultimo = new Date(Date.UTC(ano, mesIni + 2, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return { de: `${ano}-${p(mesIni)}-01`, ate: `${ano}-${p(mesIni + 2)}-${p(ultimo)}` };
}

/** corrente = o trimestre em curso; fechando = ate 30 dias depois do fim; fechado = depois disso (ou ja marcado como fechado). */
export function situacaoTrimestre(t: string, hoje: string): 'futuro' | 'corrente' | 'fechando' | 'fechado' {
  const { de, ate } = trimestreIntervalo(t);
  if (hoje < de) return 'futuro';
  if (hoje <= ate) return 'corrente';
  const dias = (Date.parse(hoje) - Date.parse(ate)) / 86_400_000;
  return dias <= 30 ? 'fechando' : 'fechado';
}

/** Blocos mensais (calendario) dentro do intervalo, para ler a Meta em partes pequenas. */
export function blocosMensais(de: string, ate: string): Array<{ inicio: string; fim: string }> {
  const out: Array<{ inicio: string; fim: string }> = [];
  let ini = de;
  while (ini <= ate) {
    const d = new Date(`${ini}T00:00:00Z`);
    const fimMes = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const fim = fimMes < ate ? fimMes : ate;
    out.push({ inicio: ini, fim });
    ini = new Date(Date.parse(fim) + 86_400_000).toISOString().slice(0, 10);
  }
  return out;
}

export interface Totais { gasto: number; impressoes: number; cliques: number; leads: number }
export const totaisDe = (rows: Array<Pick<AdDia, 'gasto' | 'impressoes' | 'cliques' | 'leads_meta'>>): Totais => ({
  gasto: Math.round(rows.reduce((s, r) => s + Number(r.gasto), 0) * 100) / 100,
  impressoes: rows.reduce((s, r) => s + Number(r.impressoes), 0),
  cliques: rows.reduce((s, r) => s + Number(r.cliques), 0),
  leads: rows.reduce((s, r) => s + Number(r.leads_meta), 0),
});

const CAMPOS_VALOR = ['gasto', 'impressoes', 'alcance', 'cliques', 'cliques_link', 'visitas_pagina', 'leads_meta', 'video_reproducoes', 'video_3s', 'video_p25', 'video_p50', 'video_p75', 'video_p95', 'video_p100', 'video_thruplay', 'video_tempo_medio'] as const;
/** Hash estavel dos valores de uma linha (numeric do banco chega como texto: tudo e normalizado antes). */
export function hashLinha(r: Record<string, unknown>): string {
  const partes = CAMPOS_VALOR.map((k) => {
    const v = r[k];
    if (v == null || v === '') return '';
    return k === 'gasto' || k === 'video_tempo_medio' ? Number(v).toFixed(2) : String(Math.round(Number(v)));
  });
  return createHash('sha256').update(`${String(r.anuncio_id)}|${String(r.dia).slice(0, 10)}|${partes.join('|')}`).digest('hex').slice(0, 32);
}

export interface Existente extends Record<string, unknown> { anuncio_id: string; dia: string }
export interface Comparacao { inserir: AdDia[]; atualizar: AdDia[]; manter: number; remover_na_meta: number }
/** Compara o que a Meta devolveu com o que esta no banco (por valor, nao pelo row_hash gravado: linhas antigas nao tem hash). */
export function compararLinhas(novas: AdDia[], existentes: Existente[]): Comparacao {
  const mapa = new Map(existentes.map((e) => [`${e.anuncio_id}|${String(e.dia).slice(0, 10)}`, hashLinha(e)]));
  const inserir: AdDia[] = [];
  const atualizar: AdDia[] = [];
  let manter = 0;
  const vistas = new Set<string>();
  for (const n of novas) {
    const k = `${n.anuncio_id}|${n.dia}`;
    vistas.add(k);
    const h = mapa.get(k);
    if (h === undefined) inserir.push(n);
    else if (h !== hashLinha(n as unknown as Record<string, unknown>)) atualizar.push(n);
    else manter++;
  }
  // linhas que estao no banco e a Meta nao devolve mais: nunca sao apagadas; so contadas e relatadas
  const remover_na_meta = [...mapa.keys()].filter((k) => !vistas.has(k)).length;
  return { inserir, atualizar, manter, remover_na_meta };
}

export interface Reconciliacao {
  conta: Totais; linhas: Totais; diferenca: Totais; explicada: boolean; observacao: string;
  por_mes?: Array<{ mes: string; conta: Totais; linhas: Totais; diferenca: Totais; explicada: boolean }>;
}
export function reconciliar(conta: Totais, linhas: Totais): Reconciliacao {
  const diferenca = {
    gasto: Math.round((linhas.gasto - conta.gasto) * 100) / 100, impressoes: linhas.impressoes - conta.impressoes,
    cliques: linhas.cliques - conta.cliques, leads: linhas.leads - conta.leads,
  };
  const zero = Math.abs(diferenca.gasto) <= 0.05 && diferenca.impressoes === 0 && diferenca.cliques === 0 && diferenca.leads === 0;
  return { conta, linhas, diferenca, explicada: zero, observacao: zero ? 'sem diferenca: a soma das linhas por anuncio e dia bate com o total da conta na Meta' : 'DIFERENCA NAO EXPLICADA: nao gravar ate entender' };
}

/** Total da conta no periodo (insights nivel conta, sem quebra por dia) para reconciliar com a soma das linhas. */
export async function lerTotaisConta(c: MetaClient, conta: MetaConta, de: string, ate: string): Promise<Totais> {
  const j = await c.get(`act_${conta.id}/insights`, { level: 'account', fields: 'spend,impressions,clicks,actions', time_range: JSON.stringify({ since: de, until: ate }) });
  const r = (j.data ?? [])[0] ?? {};
  const leads = Array.isArray(r.actions) ? r.actions.filter((a: any) => a.action_type === 'lead').reduce((s: number, a: any) => s + Math.round(Number(a.value ?? 0)), 0) : 0;
  return { gasto: Math.round(Number(r.spend ?? 0) * 100) / 100, impressoes: Math.round(Number(r.impressions ?? 0)), cliques: Math.round(Number(r.clicks ?? 0)), leads };
}

export interface CartaoRodada {
  trimestre: string; produto: string; conta_id: string; de: string; ate: string; situacao: string;
  chamadas: number; uso_cota_max_pct: number; nivel_acesso: string | null;
  linhas_lidas: number; inserir: number; atualizar: number; manter: number; ausentes_na_meta: number;
  mb_previsto: number; banco_antes_mb: number | null; banco_depois_pct: number | null;
  duracao_s: number; completude: Record<string, number>; reconciliacao: Reconciliacao; riscos: string[];
  completa: boolean; parou?: string;
}

export const CARTAO_TEXTO = (c: CartaoRodada): string => {
  const f = (n: number) => n.toLocaleString('pt-BR');
  const r = c.reconciliacao;
  const linhas = [
    `CARTAO DA RODADA ${c.completa ? '' : '(INCOMPLETO) '}- ${c.trimestre} - ${c.produto} (conta ${c.conta_id}) - ${c.de} a ${c.ate} - trimestre ${c.situacao}`,
    `Chamadas a Meta: ${c.chamadas}; uso maximo da cota: ${c.uso_cota_max_pct}% (parada em 75%); nivel de acesso: ${c.nivel_acesso ?? 'nao informado'}`,
    `Linhas lidas: ${f(c.linhas_lidas)} | a inserir: ${f(c.inserir)} | a atualizar: ${f(c.atualizar)} | a manter: ${f(c.manter)} | no banco e ausentes da Meta (nunca apagadas): ${f(c.ausentes_na_meta)}`,
    `Espaco: +${c.mb_previsto} MB${c.banco_antes_mb != null ? ` (banco hoje ${c.banco_antes_mb} MB; depois ${c.banco_depois_pct}% do limite de ${LIMITE_BANCO_MB} MB)` : ''}`,
    `Duracao da simulacao: ${c.duracao_s} s`,
    `Completude: ${Object.entries(c.completude).map(([k, v]) => `${k}: ${f(v)}`).join('; ') || 'sem lacunas'}`,
    `Reconciliacao (linhas x total da conta): gasto ${r.linhas.gasto.toFixed(2)} x ${r.conta.gasto.toFixed(2)} (dif ${r.diferenca.gasto.toFixed(2)}); impressoes ${f(r.linhas.impressoes)} x ${f(r.conta.impressoes)} (dif ${r.diferenca.impressoes}); cliques ${f(r.linhas.cliques)} x ${f(r.conta.cliques)} (dif ${r.diferenca.cliques}); leads ${f(r.linhas.leads)} x ${f(r.conta.leads)} (dif ${r.diferenca.leads}) - ${r.observacao}`,
    ...(r.por_mes ?? []).map((m) => `  mes ${m.mes}: linhas x conta: gasto ${m.linhas.gasto.toFixed(2)} x ${m.conta.gasto.toFixed(2)}; impressoes ${f(m.linhas.impressoes)} x ${f(m.conta.impressoes)}; cliques ${f(m.linhas.cliques)} x ${f(m.conta.cliques)}; leads ${f(m.linhas.leads)} x ${f(m.conta.leads)}${m.explicada ? '' : '  <- DIFERENCA'}`),
    `Riscos: ${c.riscos.join(' | ') || 'nenhum identificado'}`,
  ];
  if (c.parou) linhas.push(`PAROU: ${c.parou}`);
  return linhas.join('\n');
};

/* ---------- acesso ao banco ---------- */
export class RodadaStore {
  constructor(private readonly q: Q) {}

  /** A conta precisa estar na configuracao (ops.cfg_meta_conta); nunca se adivinha produto. */
  async contaConfigurada(contaId: string): Promise<string | null> {
    const r = await this.q.query(`select produto from ops.cfg_meta_conta where conta_id = $1::bigint and ativa`, [contaId]);
    return r.rows[0]?.produto ?? null;
  }
  async existentes(contaId: string, de: string, ate: string): Promise<Existente[]> {
    const r = await this.q.query(
      `select anuncio_id::text as anuncio_id, dia::text as dia, gasto, impressoes, alcance, cliques, cliques_link, visitas_pagina, leads_meta, video_reproducoes, video_3s,
              video_p25, video_p50, video_p75, video_p95, video_p100, video_thruplay, video_tempo_medio
       from mkt.meta_ads_dia where conta_id = $1::bigint and dia between $2::date and $3::date`, [contaId, de, ate]);
    return r.rows as Existente[];
  }
  async tamanhoBancoMb(): Promise<number | null> {
    try { return Math.round(Number((await this.q.query(`select pg_database_size(current_database()) as b`)).rows[0].b) / 1048576 * 10) / 10; } catch { return null; }
  }
  async criarRodada(r: { trimestre: string; conta_id: string; de: string; ate: string; modo: 'simulacao' | 'gravacao'; status: string; cartao: unknown; simulacao_de_origem?: number | null; autorizacao?: string | null; mb_previsto: number }): Promise<number> {
    const x = await this.q.query(
      `insert into mkt.meta_rodadas (trimestre, conta_id, de, ate, modo, status, cartao, simulacao_de_origem, autorizacao, mb_previsto)
       values ($1, $2::bigint, $3::date, $4::date, $5, $6, $7::jsonb, $8, $9, $10) returning rodada_id`,
      [r.trimestre, r.conta_id, r.de, r.ate, r.modo, r.status, JSON.stringify(r.cartao), r.simulacao_de_origem ?? null, r.autorizacao ?? null, r.mb_previsto]);
    return Number(x.rows[0].rodada_id);
  }
  async finalizarRodada(id: number, f: { status: 'concluida' | 'parcial' | 'falhou'; chamadas: number; inseridas: number; atualizadas: number; mantidas: number; erro?: string | null; cartao?: unknown }) {
    await this.q.query(
      `update mkt.meta_rodadas set status = $2, terminou_em = now(), chamadas = $3, linhas_inseridas = $4, linhas_atualizadas = $5, linhas_mantidas = $6, erro = $7, cartao = coalesce($8::jsonb, cartao) where rodada_id = $1`,
      [id, f.status, f.chamadas, f.inseridas, f.atualizadas, f.mantidas, f.erro ?? null, f.cartao ? JSON.stringify(f.cartao) : null]);
  }
  /** A simulacao mais recente, COMPLETA, da mesma conta e do mesmo intervalo (sem ela a gravacao e recusada). */
  async simulacaoPrevia(contaId: string, de: string, ate: string): Promise<{ rodada_id: number; cartao: CartaoRodada } | null> {
    const r = await this.q.query(
      `select rodada_id, cartao from mkt.meta_rodadas where modo = 'simulacao' and status = 'simulada' and conta_id = $1::bigint and de = $2::date and ate = $3::date
       order by rodada_id desc limit 1`, [contaId, de, ate]);
    const x = r.rows[0];
    return x && x.cartao?.completa === true ? { rodada_id: Number(x.rodada_id), cartao: x.cartao as CartaoRodada } : null;
  }
  /** So as linhas novas e as que mudaram; mudou = revisao + 1 (fica a versao mais recente). */
  async gravarLinhas(rows: AdDia[], rodadaId: number, hashes: Map<string, string>) {
    for (let i = 0; i < rows.length; i += 1000) {
      const c = rows.slice(i, i + 1000);
      const col = (k: keyof AdDia) => c.map((r) => r[k]);
      await this.q.query(
        `insert into mkt.meta_ads_dia (anuncio_id, dia, conta_id, conjunto_id, campanha_id, gasto, impressoes, alcance, cliques, cliques_link, visitas_pagina, leads_meta,
           video_reproducoes, video_3s, video_p25, video_p50, video_p75, video_p95, video_p100, video_thruplay, video_tempo_medio, row_hash, rodada_id, revisao)
         select *, $23::bigint, 0 from unnest($1::bigint[], $2::date[], $3::bigint[], $4::bigint[], $5::bigint[], $6::numeric[], $7::int[], $8::int[], $9::int[], $10::int[], $11::int[], $12::int[],
           $13::int[], $14::int[], $15::int[], $16::int[], $17::int[], $18::int[], $19::int[], $20::int[], $21::numeric[], $22::text[])
         on conflict (anuncio_id, dia) do update set conta_id = excluded.conta_id, conjunto_id = excluded.conjunto_id, campanha_id = excluded.campanha_id, gasto = excluded.gasto,
           impressoes = excluded.impressoes, alcance = excluded.alcance, cliques = excluded.cliques, cliques_link = excluded.cliques_link, visitas_pagina = excluded.visitas_pagina,
           leads_meta = excluded.leads_meta, video_reproducoes = excluded.video_reproducoes, video_3s = excluded.video_3s, video_p25 = excluded.video_p25, video_p50 = excluded.video_p50,
           video_p75 = excluded.video_p75, video_p95 = excluded.video_p95, video_p100 = excluded.video_p100, video_thruplay = excluded.video_thruplay,
           video_tempo_medio = excluded.video_tempo_medio, row_hash = excluded.row_hash, rodada_id = excluded.rodada_id, revisao = mkt.meta_ads_dia.revisao + 1, atualizado_em = now()`,
        [col('anuncio_id'), col('dia'), col('conta_id'), col('conjunto_id'), col('campanha_id'), col('gasto'), col('impressoes'), col('alcance'), col('cliques'), col('cliques_link'),
         col('visitas_pagina'), col('leads_meta'), col('video_reproducoes'), col('video_3s'), col('video_p25'), col('video_p50'), col('video_p75'), col('video_p95'), col('video_p100'),
         col('video_thruplay'), col('video_tempo_medio'), c.map((r) => hashes.get(`${r.anuncio_id}|${r.dia}`) ?? hashLinha(r as unknown as Record<string, unknown>)), rodadaId],
      );
    }
  }
  /** Marca d'agua e fechamento do trimestre (so avanca depois de gravar e reconciliar). */
  async marcarTrimestre(trimestre: string, contaId: string, marcaDagua: string, fechar: boolean) {
    await this.q.query(
      `insert into mkt.meta_trimestres (trimestre, conta_id, marca_dagua, fechado, fechado_em) values ($1, $2::bigint, $3::date, $4, case when $4 then now() end)
       on conflict (trimestre, conta_id) do update set marca_dagua = excluded.marca_dagua, fechado = mkt.meta_trimestres.fechado or excluded.fechado,
         fechado_em = coalesce(mkt.meta_trimestres.fechado_em, excluded.fechado_em), atualizado_em = now()`, [trimestre, contaId, marcaDagua, fechar]);
  }
  async trimestreFechado(trimestre: string, contaId: string): Promise<boolean> {
    return (await this.q.query(`select fechado from mkt.meta_trimestres where trimestre = $1 and conta_id = $2::bigint`, [trimestre, contaId])).rows[0]?.fechado === true;
  }
}

export type RodadaStoreLike = Pick<RodadaStore, 'contaConfigurada' | 'existentes' | 'tamanhoBancoMb' | 'criarRodada' | 'finalizarRodada' | 'simulacaoPrevia' | 'gravarLinhas' | 'marcarTrimestre' | 'trimestreFechado'>;

/** Le a Meta (uma conta e um trimestre), compara com o banco, reconcilia e monta o cartao. Nao grava dados; so registra a simulacao em meta_rodadas. */
export async function lerParaRodada(client: MetaClient, store: RodadaStoreLike, conta: MetaConta, trimestre: string, hoje: string) {
  const produto = await store.contaConfigurada(conta.id);
  if (!produto) throw new Error(`Conta ${conta.id} fora de ops.cfg_meta_conta: quarentena, nao ha rodada para ela.`);
  const { de, ate } = trimestreIntervalo(trimestre);
  const inicio = Date.now();
  const antesReq = client.requisicoes;
  const novas: AdDia[] = [];
  let parou: string | undefined;
  let conta_totais: Totais | null = null;
  const porMes: Array<{ mes: string; linhas: Totais; conta: Totais }> = [];
  try {
    const somaConta: Totais = { gasto: 0, impressoes: 0, cliques: 0, leads: 0 };
    for (const b of blocosMensais(de, ate)) {
      const doMes = await lerInsights(client, conta, b.inicio, b.fim);
      novas.push(...doMes);
      // total da conta no mesmo mes (insights nivel conta): a reconciliacao por mes localiza onde esta qualquer diferenca
      const totalMes = await lerTotaisConta(client, conta, b.inicio, b.fim);
      porMes.push({ mes: b.inicio.slice(0, 7), linhas: totaisDe(doMes), conta: totalMes });
      somaConta.gasto = Math.round((somaConta.gasto + totalMes.gasto) * 100) / 100;
      somaConta.impressoes += totalMes.impressoes; somaConta.cliques += totalMes.cliques; somaConta.leads += totalMes.leads;
    }
    conta_totais = somaConta;
  } catch (e) {
    if (e instanceof MetaCotaErro) parou = e.motivo;
    else throw e;
  }
  const existentes = await store.existentes(conta.id, de, ate);
  const cmp = compararLinhas(novas, existentes);
  const linhas = totaisDe(novas);
  const rec: Reconciliacao = conta_totais
    ? reconciliar(conta_totais, linhas)
    : { conta: { gasto: 0, impressoes: 0, cliques: 0, leads: 0 }, linhas, diferenca: { gasto: 0, impressoes: 0, cliques: 0, leads: 0 }, explicada: false, observacao: 'NAO REALIZADA: a leitura parou antes do fim' };
  rec.por_mes = porMes.map((m) => ({ mes: m.mes, ...reconciliar(m.conta, m.linhas) })).map(({ mes, conta: ct, linhas: ln, diferenca, explicada }) => ({ mes, conta: ct, linhas: ln, diferenca, explicada }));
  const sem = (f: (r: AdDia) => boolean) => novas.filter(f).length;
  const completude: Record<string, number> = {};
  const nVideo = sem((r) => r.video_tempo_medio == null);
  if (nVideo) completude['video_tempo_medio nulo (anuncio sem video ou sem reproducao)'] = nVideo;
  const nGastoZero = sem((r) => r.gasto === 0);
  if (nGastoZero) completude['linhas com gasto zero (impressao ou clique sem custo)'] = nGastoZero;
  const nVisita = sem((r) => r.visitas_pagina === 0 && r.cliques_link > 0);
  if (nVisita) completude['cliques no link sem visita a pagina (Pixel ou carregamento)'] = nVisita;
  const mb = Math.round(((cmp.inserir.length * BYTES_POR_LINHA) / 1048576) * 100) / 100;
  const bancoAntes = await store.tamanhoBancoMb();
  const situacao = situacaoTrimestre(trimestre, hoje);
  const riscos: string[] = [];
  if (parou) riscos.push(`leitura interrompida por cota: ${parou}; a simulacao esta INCOMPLETA e nao serve para gravar`);
  if (!rec.explicada && !parou) riscos.push(rec.observacao);
  if (situacao === 'fechando') riscos.push('trimestre recem-encerrado: a Meta ainda pode revisar numeros por ate 28 dias (nova releitura prevista antes de fechar)');
  if (situacao === 'corrente') riscos.push('trimestre em curso: a releitura dos ultimos 28 dias continua necessaria');
  if (situacao === 'fechado' && !cmp.inserir.length && !cmp.atualizar.length) riscos.push('trimestre fechado sem mudancas: nada a gravar');
  if (cmp.remover_na_meta) riscos.push(`${cmp.remover_na_meta} linhas no banco que a Meta nao devolve mais (mantidas, nunca apagadas)`);
  if (client.throttle.nivel === 'development_access') riscos.push('app em nivel de desenvolvimento (cota baixa, medida por tempo de uso): a leitura pode parar a 75%');
  const cartao: CartaoRodada = {
    trimestre, produto, conta_id: conta.id, de, ate, situacao, chamadas: client.requisicoes - antesReq, uso_cota_max_pct: Math.round(client.usoMaximoPct), nivel_acesso: client.throttle.nivel,
    linhas_lidas: novas.length, inserir: cmp.inserir.length, atualizar: cmp.atualizar.length, manter: cmp.manter, ausentes_na_meta: cmp.remover_na_meta,
    mb_previsto: mb, banco_antes_mb: bancoAntes, banco_depois_pct: bancoAntes == null ? null : Math.round(((bancoAntes + mb) / LIMITE_BANCO_MB) * 1000) / 10,
    duracao_s: Math.round((Date.now() - inicio) / 1000), completude, reconciliacao: rec, riscos, completa: !parou, ...(parou ? { parou } : {}),
  };
  return { cartao, cmp, novas, de, ate, produto };
}

/** SIMULACAO: registra a rodada (modo simulacao) e devolve o cartao. Nada de dados da Meta e gravado. */
export async function simularRodada(client: MetaClient, store: RodadaStoreLike, conta: MetaConta, trimestre: string, hoje: string) {
  const r = await lerParaRodada(client, store, conta, trimestre, hoje);
  const id = await store.criarRodada({ trimestre, conta_id: conta.id, de: r.de, ate: r.ate, modo: 'simulacao', status: 'simulada', cartao: r.cartao, mb_previsto: r.cartao.mb_previsto });
  return { rodada_id: id, ...r };
}

export class RodadaRecusada extends Error {
  constructor(motivo: string) { super(`Rodada recusada: ${motivo}`); this.name = 'RodadaRecusada'; }
}

/**
 * GRAVACAO de UMA rodada (uma conta e um intervalo). Recusa sem: (1) autorizacao escrita do Pablo, (2) simulacao previa COMPLETA da mesma conta e do
 * mesmo intervalo, (3) trimestre nao fechado (a menos que a autorizacao diga que reabre), (4) reconciliacao sem diferenca (a menos que explicada).
 */
export async function gravarRodada(
  client: MetaClient, store: RodadaStoreLike, conta: MetaConta, trimestre: string, hoje: string,
  opts: { autorizacao: string; diferencaExplicada?: string; reabrir?: string },
) {
  if (!opts.autorizacao?.trim()) throw new RodadaRecusada('falta a autorizacao do Pablo (--autorizacao "pode seguir ...").');
  const { de, ate } = trimestreIntervalo(trimestre);
  const previa = await store.simulacaoPrevia(conta.id, de, ate);
  if (!previa) throw new RodadaRecusada(`nao ha simulacao completa de ${trimestre} para a conta ${conta.id} (${de} a ${ate}). Rode a simulacao antes e mostre o cartao ao Pablo.`);
  if ((await store.trimestreFechado(trimestre, conta.id)) && !opts.reabrir) throw new RodadaRecusada(`${trimestre} esta FECHADO para a conta ${conta.id}; reabrir exige autorizacao explicita e motivo.`);
  const r = await lerParaRodada(client, store, conta, trimestre, hoje);
  if (!r.cartao.completa) throw new RodadaRecusada(`a leitura parou por cota (${r.cartao.parou}); nada foi gravado.`);
  if (!r.cartao.reconciliacao.explicada && !opts.diferencaExplicada) throw new RodadaRecusada(`${r.cartao.reconciliacao.observacao}. Nada foi gravado.`);
  const id = await store.criarRodada({ trimestre, conta_id: conta.id, de, ate, modo: 'gravacao', status: 'parcial', cartao: r.cartao, simulacao_de_origem: previa.rodada_id, autorizacao: opts.autorizacao, mb_previsto: r.cartao.mb_previsto });
  try {
    const aGravar = [...r.cmp.inserir, ...r.cmp.atualizar];
    await store.gravarLinhas(aGravar, id, new Map());
    const cartaoFinal = { ...r.cartao, diferenca_explicada: opts.diferencaExplicada ?? null, reaberto: opts.reabrir ?? null };
    await store.finalizarRodada(id, { status: 'concluida', chamadas: r.cartao.chamadas, inseridas: r.cmp.inserir.length, atualizadas: r.cmp.atualizar.length, mantidas: r.cmp.manter, cartao: cartaoFinal });
    const hojeNoTri = hoje < ate ? hoje : ate;
    await store.marcarTrimestre(trimestre, conta.id, hojeNoTri, situacaoTrimestre(trimestre, hoje) === 'fechado');
    return { rodada_id: id, ...r, cartao: cartaoFinal as CartaoRodada };
  } catch (e) {
    await store.finalizarRodada(id, { status: 'falhou', chamadas: r.cartao.chamadas, inseridas: 0, atualizadas: 0, mantidas: 0, erro: e instanceof Error ? e.message.slice(0, 500) : String(e) }).catch(() => undefined);
    throw e;
  }
}
