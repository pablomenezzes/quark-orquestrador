import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { FormsStore, StoreError } from './lib/forms-store.js';
import { FORM_ID_RE } from './lib/form-schema.js';
import { MARCOS, PRODUTOS, STATUS_NEGOCIO, PainelNotFound, type Marco, type PainelRepo, type Produto, type StatusNegocio } from './lib/painel-repo.js';

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

    if (method === 'GET' && path === '/') return sendFile(res, join(opts.publicDir, 'index.html'));
    if (method === 'GET' && path === '/attribution.js') return sendFile(res, join(opts.trackingDir, 'attribution.js'));

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

    if (method === 'GET' && path === '/painel') return sendFile(res, join(opts.publicDir, 'painel.html'));
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
      if (method === 'GET' && path === '/api/painel/motivos-perda') return send(res, 200, await repo.motivosPerda());
      if (method === 'GET' && path === '/api/painel/status-contagem') return send(res, 200, await repo.statusContagem());

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
      if (e instanceof PainelNotFound) return send(res, 404, { error: 'nao_encontrado', detail: e.message });
      console.error('studio:', e instanceof Error ? e.message : e);
      send(res, 500, { error: 'internal_error' });
    });
  });
}
