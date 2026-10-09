import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { FormsStore, StoreError } from './lib/forms-store.js';
import { FORM_ID_RE } from './lib/form-schema.js';
import { BI_PRODUTOS, BiNotFound, type BiFiltros, type BiProduto, type BiRepo } from './lib/bi.js';
import { MARCOS, PRODUTOS, REGRA_TIPOS, REGRA_URL_MODOS, STATUS_NEGOCIO, PainelInvalido, PainelNotFound, type CriativoItem, type CriativoMapaPatch, type Marco, type NegociosFiltro, type PainelRepo, type Produto, type StatusNegocio } from './lib/painel-repo.js';

export type SubmitFn = (formId: string, mode: 'dry' | 'real', payload: unknown, ctx: { userAgent: string | null }) => Promise<{ status: number; body: unknown }>;

export type StudioOptions = {
  formsDir: string;
  publicDir: string;
  trackingDir: string;
  /** Fontes com token disponível (slug). */
  sources: string[];
  dbInfo: () => { connected: boolean; note?: string };
  submit: SubmitFn;
  /** Painel de Dados (Data Hub). Sem isto, as rotas do Painel respondem 503 com a explicação. */
  painel?: PainelRepo | null;
  /** BI (análises e KPIs sobre as visões de analytics). Sem isto, as rotas do BI respondem 503 com a explicação. */
  bi?: BiRepo | null;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const MAX_BODY = 1_000_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/**
 * Servidor local do Studio. Só escuta em 127.0.0.1, confere Host (anti DNS-rebinding)
 * e Origin/Content-Type nas escritas (anti CSRF). Não é para ser exposto na internet.
 */
export function createStudioServer(opts: StudioOptions): Server {
  const store = new FormsStore(opts.formsDir);
  const publicRoot = resolve(opts.publicDir);

  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(data);
  };

  const sendFile = (res: ServerResponse, path: string) => {
    if (!existsSync(path) || !statSync(path).isFile()) return send(res, 404, { error: 'not_found' });
    send(res, 200, readFileSync(path), MIME[extname(path)] ?? 'application/octet-stream');
  };

  const readJson = (req: IncomingMessage): Promise<any> =>
    new Promise((resolveBody, reject) => {
      let size = 0;
      let tooBig = false;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        if (tooBig) return; // descarta o resto sem guardar
        size += c.length;
        if (size > MAX_BODY) {
          tooBig = true;
          chunks.length = 0;
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return reject(new HttpError(413, 'payload_too_large'));
        try {
          resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new HttpError(400, 'invalid_json'));
        }
      });
      req.on('error', reject);
    });

  const guard = (req: IncomingMessage) => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) throw new HttpError(403, 'forbidden_host');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'forbidden_origin');
      if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'content_type_must_be_json');
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    guard(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/') return sendFile(res, join(opts.publicDir, 'inicio.html'));    if (method === 'GET' && path === '/attribution.js') return sendFile(res, join(opts.trackingDir, 'attribution.js'));

    const page = /^\/f\/([^/]+)$/.exec(path);
    if (method === 'GET' && page) {
      if (!FORM_ID_RE.test(decodeURIComponent(page[1]!))) return send(res, 404, { error: 'not_found' });
      return sendFile(res, join(opts.publicDir, 'form.html'));
    }

    if (method === 'GET' && path.startsWith('/s/')) {
      let rel: string;
      try {
        rel = decodeURIComponent(path.slice(3));
      } catch {
        return send(res, 404, { error: 'not_found' });
      }
      const abs = resolve(publicRoot, normalize(rel));
      if (abs !== publicRoot && !abs.startsWith(publicRoot + sep)) return send(res, 404, { error: 'not_found' });
      if (rel.includes('\\') || rel.includes('..')) return send(res, 404, { error: 'not_found' });
      return sendFile(res, abs);
    }

    // Menu único: Início (última atualização), BI, Painel de Dados e, por último, Studio (testes).
    if (method === 'GET' && path === '/studio') return sendFile(res, join(opts.publicDir, 'index.html'));
    if (method === 'GET' && path === '/painel') return sendFile(res, join(opts.publicDir, 'painel.html'));

    // BI: só leitura. O navegador escolhe a análise e os filtros; nunca manda SQL.
    if (method === 'GET' && path === '/bi') return sendFile(res, join(opts.publicDir, 'bi.html'));
    if (path.startsWith('/api/bi/')) {
      const bi = opts.bi;
      if (!bi) {
        return send(res, 503, {
          error: 'bi_nao_configurado',
          detail: 'Falta PANEL_DB_URL no .env.local. Peça para gerar com: node scripts/set-role-password.mjs --role orq_panel --apply',
        });
      }
      if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      if (path === '/api/bi/catalogo') return send(res, 200, { analises: bi.catalogo(), ...(await bi.opcoes()) });
      const one = /^\/api\/bi\/analise\/([a-z0-9-]{1,60})$/.exec(path);
      if (one) {
        const q = url.searchParams;
        const data = (v: string | null, nome: string): string => {
          if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new HttpError(400, `${nome}_invalida`, { esperado: 'AAAA-MM-DD' });
          return v;
        };
        const f: BiFiltros = { de: data(q.get('de'), 'de'), ate: data(q.get('ate'), 'ate') };
        if (f.de > f.ate) throw new HttpError(400, 'periodo_invertido');
        const produto = q.get('produto');
        if (produto) {
          if (!(BI_PRODUTOS as readonly string[]).includes(produto)) throw new HttpError(400, 'produto_invalido', { validos: [...BI_PRODUTOS] });
          f.produto = produto as BiProduto;
        }
        const pipeline = q.get('pipeline');
        if (pipeline) {
          if (!/^\d{1,15}$/.test(pipeline)) throw new HttpError(400, 'pipeline_invalido');
          f.pipeline_id = Number(pipeline);
        }
        // Fonte e Tipo do Lead: lista de IDs de opção (dígitos) e/ou "branco" (campo não preenchido), separados por vírgula.
        const lista = (nome: 'fonte' | 'tipo'): string[] | undefined => {
          const v = q.get(nome);
          if (!v) return undefined;
          const toks = v.split(',');
          if (toks.length > 40 || toks.some((t) => !/^(\d{1,9}|branco)$/.test(t))) throw new HttpError(400, `${nome}_invalido`);
          return [...new Set(toks)];
        };
        const fontes = lista('fonte');
        const tipos = lista('tipo');
        if (fontes) f.fontes = fontes;
        if (tipos) f.tipos = tipos;
        return send(res, 200, await bi.rodar(one[1]!, f));
      }
      return send(res, 404, { error: 'not_found' });
    }
    if (path.startsWith('/api/painel/')) {
      const repo = opts.painel;
      if (!repo) {
        return send(res, 503, {
          error: 'painel_nao_configurado',
          detail: 'Falta PANEL_DB_URL no .env.local. Peça para gerar com: node scripts/set-role-password.mjs --role orq_panel --apply',
        });
      }
      if (method === 'GET' && path === '/api/painel/saude') return send(res, 200, await repo.saude());
      if (method === 'GET' && path === '/api/painel/config') return send(res, 200, await repo.config());
      if (method === 'GET' && path === '/api/painel/usuarios') return send(res, 200, await repo.usuarios());
      if (method === 'GET' && path === '/api/painel/campos') return send(res, 200, await repo.campos());
      if (method === 'GET' && path === '/api/painel/historico/progresso') return send(res, 200, await repo.historicoProgresso());
      if (method === 'GET' && path === '/api/painel/funil') {
        const ano = url.searchParams.get('ano') ?? '';
        if (!/^20\d{2}$/.test(ano)) throw new HttpError(400, 'ano_invalido');
        return send(res, 200, await repo.funilMarcos(Number(ano)));
      }
      if (method === 'GET' && path === '/api/painel/negocios/resumo') return send(res, 200, await repo.negociosResumo());
      if (method === 'GET' && path === '/api/painel/negocios') {
        const q = url.searchParams;
        const f: NegociosFiltro = {};
        const pipeline = q.get('pipeline');
        if (pipeline) {
          if (!/^\d{1,15}$/.test(pipeline)) throw new HttpError(400, 'pipeline_invalido');
          f.pipeline_id = Number(pipeline);
        }
        const status = q.get('status');
        if (status) {
          if (!(STATUS_NEGOCIO as readonly string[]).includes(status)) throw new HttpError(400, 'status_invalido', { validos: [...STATUS_NEGOCIO] });
          f.status = status as StatusNegocio;
        }
        if (q.get('mql') === 'sim') f.mql = true;
        const mes = q.get('mes');
        if (mes) {
          if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new HttpError(400, 'mes_invalido');
          f.mes = mes;
        }
        const busca = q.get('q');
        if (busca) {
          if (busca.length > 100) throw new HttpError(400, 'busca_longa_demais');
          f.q = busca;
        }
        const pagina = q.get('pagina');
        if (pagina) {
          if (!/^\d{1,6}$/.test(pagina) || Number(pagina) < 1) throw new HttpError(400, 'pagina_invalida');
          f.pagina = Number(pagina);
        }
        return send(res, 200, await repo.negocios(f));
      }
      const neg = /^\/api\/painel\/negocios\/([^/]+)$/.exec(path);
      if (neg && method === 'GET') {
        const rawId = decodeURIComponent(neg[1]!);
        if (!/^\d{1,15}$/.test(rawId)) throw new HttpError(400, 'id_invalido');
        return send(res, 200, await repo.negocio(Number(rawId)));
      }
      if (method === 'GET' && path === '/api/painel/motivos-perda') return send(res, 200, await repo.motivosPerda());
      if (method === 'GET' && path === '/api/painel/status-contagem') return send(res, 200, await repo.statusContagem());

      // Conversões do site (GA4): eventos, URLs onde aparecem e regras (evento + URL) que o Painel grava.
      const diasConv = (): number => {
        const d = url.searchParams.get('dias');
        if (d == null) return 30;
        if (!/^\d{1,3}$/.test(d) || Number(d) < 1 || Number(d) > 730) throw new HttpError(400, 'dias_invalido');
        return Number(d);
      };
      if (method === 'GET' && path === '/api/painel/conversoes/eventos') return send(res, 200, await repo.conversaoEventos(diasConv()));
      if (method === 'GET' && path === '/api/painel/conversoes/eventos/urls') {
        const ev = url.searchParams.get('evento') ?? '';
        if (!ev || ev.length > 200) throw new HttpError(400, 'evento_invalido');
        return send(res, 200, await repo.conversaoEventoUrls(ev, diasConv()));
      }
      if (method === 'GET' && path === '/api/painel/conversoes/regras') return send(res, 200, await repo.conversaoRegras());
      const regraId = /^\/api\/painel\/conversoes\/regras\/([^/]+)$/.exec(path);
      if ((method === 'POST' && path === '/api/painel/conversoes/regras') || (method === 'PUT' && regraId)) {
        const b = await readJson(req);
        const parcial = method === 'PUT' && b && Object.keys(b).length === 1 && 'ativo' in b; // ligar/desligar
        if (parcial) {
          if (typeof b.ativo !== 'boolean') throw new HttpError(400, 'ativo_invalido', { validos: [true, false] });
        } else {
          if (typeof b?.nome !== 'string' || !b.nome.trim() || b.nome.length > 80) throw new HttpError(400, 'nome_invalido');
          if (!(REGRA_TIPOS as readonly unknown[]).includes(b?.tipo)) throw new HttpError(400, 'tipo_invalido', { validos: [...REGRA_TIPOS] });
          if (typeof b?.evento !== 'string' || !b.evento.trim() || b.evento.length > 200) throw new HttpError(400, 'evento_invalido');
          if (!(REGRA_URL_MODOS as readonly unknown[]).includes(b?.url_modo)) throw new HttpError(400, 'url_modo_invalido', { validos: [...REGRA_URL_MODOS] });
          if (b.url_modo !== 'qualquer' && (typeof b.url_valor !== 'string' || !b.url_valor.trim() || b.url_valor.length > 300)) throw new HttpError(400, 'url_valor_invalido');
          if (b.ativo !== undefined && typeof b.ativo !== 'boolean') throw new HttpError(400, 'ativo_invalido', { validos: [true, false] });
        }
        if (method === 'POST') {
          const nova = await repo.criarConversaoRegra({ nome: b.nome.trim(), tipo: b.tipo, evento: b.evento.trim(), url_modo: b.url_modo, url_valor: b.url_modo === 'qualquer' ? null : b.url_valor.trim() });
          return send(res, 201, nova);
        }
        const rid = decodeURIComponent(regraId![1]!);
        if (!/^\d{1,15}$/.test(rid)) throw new HttpError(400, 'id_invalido');
        await repo.atualizarConversaoRegra(
          Number(rid),
          parcial
            ? { ativo: b.ativo }
            : { nome: b.nome.trim(), tipo: b.tipo, evento: b.evento.trim(), url_modo: b.url_modo, url_valor: b.url_modo === 'qualquer' ? null : b.url_valor.trim(), ...(b.ativo !== undefined ? { ativo: b.ativo } : {}) },
        );
        return send(res, 200, { ok: true });
      }

      // Criativos do Meta Ads (UTM Term) agrupados em DOR > Mensagem e Módulo de Interesse (campos virtuais, só neste banco).
      if (method === 'GET' && path === '/api/painel/criativos/config') return send(res, 200, await repo.criativosConfig());
      if (method === 'GET' && path === '/api/painel/criativos') return send(res, 200, await repo.criativos());
      const itemPlural: Record<string, CriativoItem> = { dores: 'dor', mensagens: 'mensagem', modulos: 'modulo' };
      const itemRota = /^\/api\/painel\/criativos\/(dores|mensagens|modulos)(?:\/([^/]+))?$/.exec(path);
      if (itemRota) {
        const tipo = itemPlural[itemRota[1]!]!;
        const maxNome = tipo === 'mensagem' ? 160 : 120;
        const idParam = (s: string | undefined): number => {
          if (!s || !/^\d{1,15}$/.test(decodeURIComponent(s))) throw new HttpError(400, 'id_invalido');
          return Number(decodeURIComponent(s));
        };
        const nomeOk = (v: unknown): string => {
          if (typeof v !== 'string' || !v.trim() || v.trim().length > maxNome) throw new HttpError(400, 'nome_invalido', { maximo: maxNome });
          return v;
        };
        if (method === 'POST' && !itemRota[2]) {
          const b = await readJson(req);
          const nome = nomeOk(b?.nome);
          let pai: number | undefined;
          if (tipo === 'mensagem') {
            if (!Number.isInteger(b?.dor_id) || b.dor_id < 1) throw new HttpError(400, 'dor_id_invalido');
            pai = b.dor_id as number;
          }
          return send(res, 201, await repo.criarCriativoItem(tipo, nome, pai));
        }
        if (method === 'PUT' && itemRota[2]) {
          const b = await readJson(req);
          const patch: { nome?: string; ativo?: boolean } = {};
          if (b && 'nome' in b) patch.nome = nomeOk(b.nome);
          if (b && 'ativo' in b) {
            if (typeof b.ativo !== 'boolean') throw new HttpError(400, 'ativo_invalido', { validos: [true, false] });
            patch.ativo = b.ativo;
          }
          if (!Object.keys(patch).length) throw new HttpError(400, 'nada_para_gravar');
          await repo.atualizarCriativoItem(tipo, idParam(itemRota[2]), patch);
          return send(res, 200, { ok: true });
        }
        return send(res, 405, { error: 'method_not_allowed' }); // não há DELETE: remover é desativar
      }
      if (path === '/api/painel/criativos/mapa') {
        if (method !== 'PUT') return send(res, 405, { error: 'method_not_allowed' });
        const b = await readJson(req);
        if (!Array.isArray(b?.termos) || !b.termos.length || b.termos.length > 1000 || !b.termos.every((t: unknown) => typeof t === 'string' && t.length > 0 && t.length <= 500)) throw new HttpError(400, 'termos_invalidos', { maximo: 1000 });
        const patch: CriativoMapaPatch = {};
        for (const k of ['dor_id', 'mensagem_id', 'modulo_id'] as const) {
          if (k in b) {
            if (b[k] !== null && !(Number.isInteger(b[k]) && b[k] > 0)) throw new HttpError(400, `${k}_invalido`, { validos: ['número', null] });
            patch[k] = b[k];
          }
        }
        if (!Object.keys(patch).length) throw new HttpError(400, 'nada_para_gravar');
        return send(res, 200, await repo.mapearCriativos(b.termos, patch));
      }

      // Regras de contagem: motivo de perda que tira do MQL, e status que conta (ou não) como lead.
      const motivo = /^\/api\/painel\/config\/motivo-perda\/([^/]+)$/.exec(path);
      const status = /^\/api\/painel\/config\/status\/([^/]+)$/.exec(path);
      if (motivo || status) {
        if (method !== 'PUT') return send(res, 405, { error: 'method_not_allowed' });
        const key = decodeURIComponent((motivo ?? status)![1]!);
        const body = await readJson(req);
        if (motivo) {
          if (!/^\d{1,15}$/.test(key)) throw new HttpError(400, 'id_invalido');
          if (typeof body?.exclui_mql !== 'boolean') throw new HttpError(400, 'exclui_mql_invalido', { validos: [true, false] });
          await repo.setMotivoExcluiMql(Number(key), body.exclui_mql);
        } else {
          if (!(STATUS_NEGOCIO as readonly string[]).includes(key)) throw new HttpError(400, 'status_invalido', { validos: [...STATUS_NEGOCIO] });
          if (typeof body?.conta_como_lead !== 'boolean') throw new HttpError(400, 'conta_como_lead_invalido', { validos: [true, false] });
          await repo.setStatusContaComoLead(key as StatusNegocio, body.conta_como_lead);
        }
        return send(res, 200, { ok: true });
      }

      // As únicas escritas do Painel: a configuração (pipeline -> produto, etapa -> marco, e as regras acima).
      const pipe = /^\/api\/painel\/config\/pipeline\/([^/]+)$/.exec(path);
      const stage = /^\/api\/painel\/config\/stage\/([^/]+)$/.exec(path);
      if (pipe || stage) {
        if (method !== 'PUT') return send(res, 405, { error: 'method_not_allowed' });
        const rawId = decodeURIComponent((pipe ?? stage)![1]!);
        if (!/^\d{1,15}$/.test(rawId)) throw new HttpError(400, 'id_invalido');
        const id = Number(rawId);
        const body = await readJson(req);
        if (pipe) {
          const v = body?.produto;
          if (!body || !('produto' in body) || !(v === null || (PRODUTOS as readonly unknown[]).includes(v))) throw new HttpError(400, 'produto_invalido', { validos: [...PRODUTOS, null] });
          await repo.setPipelineProduto(id, v as Produto | null);
        } else {
          const v = body?.marco;
          if (!body || !('marco' in body) || !(v === null || (MARCOS as readonly unknown[]).includes(v))) throw new HttpError(400, 'marco_invalido', { validos: [...MARCOS, null] });
          await repo.setStageMarco(id, v as Marco | null);
        }
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not_found' });
    }
    if (method === 'GET' && path === '/api/meta') return send(res, 200, { sources: opts.sources, db: opts.dbInfo() });
    if (method === 'GET' && path === '/api/forms') return send(res, 200, store.list());

    const one = /^\/api\/forms\/([^/]+)$/.exec(path);
    if (one) {
      const id = decodeURIComponent(one[1]!);
      if (method === 'GET') {
        const f = store.get(id);
        return f ? send(res, 200, f) : send(res, 404, { error: 'not_found' });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        const saved = store.save({ ...body, id });
        return send(res, 200, saved);
      }
      if (method === 'DELETE') {
        store.remove(id);
        return send(res, 200, { ok: true });
      }
    }

    const sub = /^\/api\/submit\/([^/]+)$/.exec(path);
    if (method === 'POST' && sub) {
      const id = decodeURIComponent(sub[1]!);
      const form = store.get(id);
      if (!form) return send(res, 404, { error: 'not_found' });
      const body = await readJson(req);
      // Gravar de verdade só com mode:"real" explícito; qualquer outra coisa é simulação.
      const mode = body?.mode === 'real' ? 'real' : 'dry';
      const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
      const out = await opts.submit(id, mode, body?.payload ?? {}, { userAgent: ua });
      return send(res, out.status, out.body);
    }

    return send(res, 404, { error: 'not_found' });
  };

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      if (e instanceof StoreError) return send(res, 400, { error: e.message, issues: e.issues });
      if (e instanceof PainelNotFound || e instanceof BiNotFound) return send(res, 404, { error: 'nao_encontrado', detail: e.message });
      if (e instanceof PainelInvalido) return send(res, 400, { error: 'invalido', detail: e.message });
      console.error('studio:', e instanceof Error ? e.message : e);
      send(res, 500, { error: 'internal_error' });
    });
  });
}
