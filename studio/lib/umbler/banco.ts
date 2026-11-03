/**
 * Banco das informações importadas da Umbler (ops.umbler_*, migration 0035). Papel orq_panel; nenhum dado pessoal.
 */
import type pg from 'pg';
import type { CustoLinha, Parada, Sessao, TemplateCatalogo } from './normaliza.js';
import type { MensagemTemplate } from './mensagens.js';
import { minimizar } from './cache.js';

export type SessaoBanco = {
  id: string;
  criadaEm: string;
  dia: string;
  tipo: 'Template' | 'Bot' | null;
  canalId: string | null;
  canalNome: string | null;
  botId: string | null;
  botNome: string | null;
  modeloId: string | null;
  modeloNome: string | null;
  modeloCategoria: string | null;
  titulo: string | null;
  enviadas: number | null;
  lidas: number | null;
  falhas: number | null;
  creditos: number | null;
  custoSituacao: 'registrado' | 'sem_registro' | 'falhou' | 'nao_consultado';
  linhasCusto: CustoLinha[] | null;
  scanCursor: number;
  scanTotal: number | null;
  scanCompleto: boolean;
  scanEm: string | null;
  atualizadoEm: string;
};

export type MensagemBanco = { id: string; sessaoId: string; templateId: string | null; dia: string; respondeu: boolean; clicou: boolean; humano: boolean; canalId: string | null; cta: string | null };

export interface Banco {
  sessoes(desde: string): Promise<SessaoBanco[]>;
  gravarSessao(org: string, s: Sessao, canalNome: string | null, situacao: SessaoBanco['custoSituacao'], bruto: unknown): Promise<void>;
  gravarTemplates(t: TemplateCatalogo[]): Promise<void>;
  templatesEm(): Promise<string | null>;
  templates(): Promise<TemplateCatalogo[]>;
  gravarMensagens(sessaoId: string, canalId: string | null, botId: string | null, m: (MensagemTemplate & { dia: string })[]): Promise<void>;
  atualizarScan(id: string, cursor: number, total: number | null, completo: boolean): Promise<void>;
  reiniciarScan(id: string): Promise<void>;
  /** Marca todas as conversas do canal para serem lidas de novo (ex.: depois de passar a guardar o CTA). */
  reiniciarScanCanal(canalId: string, desde: string): Promise<number>;
  mensagens(canalId: string, de: string, ate: string): Promise<MensagemBanco[]>;
  registrarImportacao(desde: string, canalId: string | null, resumo: unknown, erro: string | null): Promise<void>;
  ultimaImportacao(): Promise<{ finalizadaEm: string; resumo: unknown } | null>;
}

const num = (x: unknown): number | null => (x == null ? null : Number(x));
const iso = (x: unknown): string => (x instanceof Date ? x.toISOString() : String(x));
const diaStr = (x: unknown): string => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x).slice(0, 10));

export class PgBanco implements Banco {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async sessoes(desde: string): Promise<SessaoBanco[]> {
    const r = await this.pool.query(
      `select id, criada_em, dia, tipo, canal_id, canal_nome, bot_id, bot_nome, modelo_id, modelo_nome, modelo_categoria, titulo, enviadas, lidas, falhas, creditos,
              custo_situacao, linhas_custo, scan_cursor, scan_total, scan_completo, scan_em, atualizado_em
         from ops.umbler_sessao where dia >= $1::date order by criada_em desc`,
      [desde],
    );
    return r.rows.map((x) => ({
      id: x.id, criadaEm: iso(x.criada_em), dia: diaStr(x.dia), tipo: x.tipo, canalId: x.canal_id, canalNome: x.canal_nome, botId: x.bot_id, botNome: x.bot_nome,
      modeloId: x.modelo_id, modeloNome: x.modelo_nome, modeloCategoria: x.modelo_categoria, titulo: x.titulo, enviadas: num(x.enviadas), lidas: num(x.lidas), falhas: num(x.falhas),
      creditos: num(x.creditos), custoSituacao: x.custo_situacao, linhasCusto: x.linhas_custo ?? null, scanCursor: Number(x.scan_cursor), scanTotal: num(x.scan_total),
      scanCompleto: !!x.scan_completo, scanEm: x.scan_em ? iso(x.scan_em) : null, atualizadoEm: iso(x.atualizado_em),
    }));
  }

  async gravarSessao(org: string, s: Sessao, canalNome: string | null, situacao: SessaoBanco['custoSituacao'], bruto: unknown): Promise<void> {
    await this.pool.query(
      `insert into ops.umbler_sessao (id, organizacao_id, criada_em, dia, titulo, tipo, canal_id, canal_nome, bot_id, bot_nome, gatilho, modelo_id, modelo_nome, modelo_categoria,
          enviadas, lidas, respondidas_formulario, falhas, creditos, custo_situacao, linhas_custo, paradas, bruto, atualizado_em)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23::jsonb, now())
       on conflict (id) do update set titulo=excluded.titulo, tipo=excluded.tipo, canal_id=excluded.canal_id, canal_nome=excluded.canal_nome, bot_id=excluded.bot_id, bot_nome=excluded.bot_nome,
          gatilho=excluded.gatilho, modelo_id=excluded.modelo_id, modelo_nome=excluded.modelo_nome, modelo_categoria=excluded.modelo_categoria, enviadas=excluded.enviadas, lidas=excluded.lidas,
          respondidas_formulario=excluded.respondidas_formulario, falhas=excluded.falhas, creditos=excluded.creditos, custo_situacao=excluded.custo_situacao, linhas_custo=excluded.linhas_custo,
          paradas=excluded.paradas, bruto=excluded.bruto, atualizado_em=now()`,
      [
        s.id, org, s.criadaEm, s.dia, s.titulo, s.tipo, s.canalId, canalNome, s.botId, s.botNome, s.gatilho, s.modeloId, s.modeloNome, s.modeloCategoria,
        s.enviadas.v, s.lidas.v, s.respondidas.v, s.falhas.v, s.creditos.v, situacao, s.custoLinhas ? JSON.stringify(s.custoLinhas) : null,
        s.paradas ? JSON.stringify(s.paradas as Parada[]) : null, JSON.stringify(minimizar(bruto ?? null)),
      ],
    );
  }

  async gravarTemplates(t: TemplateCatalogo[]): Promise<void> {
    if (!t.length) return;
    await this.pool.query(
      `insert into ops.umbler_template (id, nome, categoria, status, atualizado_em)
       select * , now() from unnest($1::text[], $2::text[], $3::text[], $4::text[])
       on conflict (id) do update set nome=excluded.nome, categoria=excluded.categoria, status=excluded.status, atualizado_em=now()`,
      [t.map((x) => x.id), t.map((x) => x.nome), t.map((x) => x.categoria), t.map((x) => x.status)],
    );
  }
  async templatesEm(): Promise<string | null> {
    const r = await this.pool.query(`select max(atualizado_em) as em from ops.umbler_template`);
    return r.rows[0]?.em ? iso(r.rows[0].em) : null;
  }
  async templates(): Promise<TemplateCatalogo[]> {
    const r = await this.pool.query(`select id, nome, categoria, status from ops.umbler_template`);
    return r.rows.map((x) => ({ id: x.id, nome: x.nome, categoria: x.categoria, status: x.status }));
  }

  async gravarMensagens(sessaoId: string, canalId: string | null, botId: string | null, m: (MensagemTemplate & { dia: string })[]): Promise<void> {
    if (!m.length) return;
    // a mesma mensagem pode vir duas vezes no lote (conversa em duas sessões): junta antes, senão o upsert recusa
    const un = new Map<string, MensagemTemplate & { dia: string }>();
    for (const x of m) {
      const ex = un.get(x.id);
      un.set(x.id, ex ? { ...ex, respondeu: ex.respondeu || x.respondeu, clicou: ex.clicou || x.clicou, humano: ex.humano || x.humano, cta: ex.cta ?? x.cta } : x);
    }
    m = [...un.values()];
    await this.pool.query(
      `insert into ops.umbler_mensagem (id, sessao_id, canal_id, bot_id, template_id, enviado_em, dia, respondeu_24h, clicou_24h, humano_24h, cta, atualizado_em)
       select u.id, $2, $3, $4, u.tpl, u.em, u.dia, u.resp, u.clic, u.hum, u.cta, now()
         from unnest($1::text[], $5::text[], $6::timestamptz[], $7::date[], $8::bool[], $9::bool[], $10::bool[], $11::text[]) as u(id, tpl, em, dia, resp, clic, hum, cta)
       on conflict (id) do update set respondeu_24h = ops.umbler_mensagem.respondeu_24h or excluded.respondeu_24h,
          clicou_24h = ops.umbler_mensagem.clicou_24h or excluded.clicou_24h, humano_24h = ops.umbler_mensagem.humano_24h or excluded.humano_24h, cta = coalesce(ops.umbler_mensagem.cta, excluded.cta), atualizado_em = now()`,
      [m.map((x) => x.id), sessaoId, canalId, botId, m.map((x) => x.templateId), m.map((x) => x.enviadoEm), m.map((x) => x.dia), m.map((x) => x.respondeu), m.map((x) => x.clicou), m.map((x) => x.humano), m.map((x) => x.cta)],
    );
  }

  async atualizarScan(id: string, cursor: number, total: number | null, completo: boolean): Promise<void> {
    await this.pool.query(
      `update ops.umbler_sessao set scan_cursor=$2, scan_total=coalesce($3, scan_total), scan_completo=$4, scan_em = case when $4 then now() else scan_em end, atualizado_em=now() where id=$1`,
      [id, cursor, total, completo],
    );
  }
  async reiniciarScan(id: string): Promise<void> {
    await this.pool.query(`update ops.umbler_sessao set scan_cursor=0, scan_completo=false where id=$1`, [id]);
  }

  async reiniciarScanCanal(canalId: string, desde: string): Promise<number> {
    const r = await this.pool.query(`update ops.umbler_sessao set scan_cursor=0, scan_completo=false where canal_id=$1 and dia >= $2::date`, [canalId, desde]);
    return (r as { rowCount?: number | null }).rowCount ?? 0;
  }

  async mensagens(canalId: string, de: string, ate: string): Promise<MensagemBanco[]> {
    const r = await this.pool.query(
      `select id, sessao_id, template_id, dia, respondeu_24h, clicou_24h, humano_24h, canal_id, cta from ops.umbler_mensagem where canal_id = $1 and dia between $2::date and $3::date`,
      [canalId, de, ate],
    );
    return r.rows.map((x) => ({ id: x.id, sessaoId: x.sessao_id, templateId: x.template_id, dia: diaStr(x.dia), respondeu: x.respondeu_24h, clicou: x.clicou_24h, humano: x.humano_24h, canalId: x.canal_id, cta: x.cta ?? null }));
  }

  async registrarImportacao(desde: string, canalId: string | null, resumo: unknown, erro: string | null): Promise<void> {
    await this.pool.query(`insert into ops.umbler_importacao (desde, canal_id, resumo, erro, finalizada_em) values ($1::date, $2, $3::jsonb, $4, now())`, [desde, canalId, JSON.stringify(resumo ?? null), erro]);
  }
  async ultimaImportacao(): Promise<{ finalizadaEm: string; resumo: unknown } | null> {
    const r = await this.pool.query(`select finalizada_em, resumo from ops.umbler_importacao where erro is null order by id desc limit 1`);
    return r.rows[0] ? { finalizadaEm: iso(r.rows[0].finalizada_em), resumo: r.rows[0].resumo } : null;
  }
}
