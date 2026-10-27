import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { FormsStore, StoreError } from './lib/forms-store.js';
import { FORM_ID_RE } from './lib/form-schema.js';
import { AuthErro, LimiteLogin, VigenciaCache, assinar, cookieLimpo, cookieSessao, emailValido, lerCookie, PAPEIS, SESSAO_SEGUNDOS, senhaValida, verificar, type AuthService, type Papel, type Sessao } from './lib/auth.js';
import { IntegracaoErro, type Integracoes } from './lib/integracoes.js';
import type { SincroniaManual } from './lib/sincronia-manual.js';
import { timingSafeEqual } from 'node:crypto';
import { PRODUTOS_MONITOR, type MonitorRepo, type ProdutoMonitor } from './lib/monitor.js';
import type { ExperimentosRepo } from './lib/experimentos.js';
import { BI_PRODUTOS, BiNotFound, type BiFiltros, type BiProduto, type BiRepo } from './lib/bi.js';
import { CONVERSAO_ORIGENS, CONVERSAO_TIPOS, MARCOS, PRODUTOS, REGRA_TIPOS, REGRA_URL_MODOS, STATUS_NEGOCIO, PainelInvalido, PainelNotFound, type ConversaoOrigem, type CriativoItem, type CriativoMapaPatch, type Marco, type NegociosFiltro, type PainelRepo, type Produto, type StatusNegocio } from './lib/painel-repo.js';

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
  /** Monitor diário (hoje x ontem, semana, mês; total e por canal). */
  monitor?: MonitorRepo | null;
  /** Experimentos de growth: cadastro e acompanhamento automático pelas visões de analytics. */
  experimentos?: ExperimentosRepo | null;
  /**
   * Modo publicado: exige login (cookie assinado), separa admin de editor, desliga o Studio de testes (formulários e envio) e libera qualquer Host.
   * Sem isto, o servidor é o local de sempre (só 127.0.0.1, sem login).
   */
  /** Google Sheets e ClickUp (opcionais: sem credenciais as rotas respondem 503 com o que falta). */
  integracoes?: Integracoes | null;
  /** Gatilho manual da sincronização (dispara o workflow do GitHub Actions). Sem token, o estado diz que não está configurado e o disparo responde 503. */
  sincronia?: SincroniaManual | null;
  acesso?: { servico: AuthService; segredo: string; seguro?: boolean; agora?: () => number } | null;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const MAX_BODY = 1_000_000;
/** Só no modo publicado: sem iframe, sem script de terceiros; fontes do Google e estilos embutidos das páginas. */
const CABECALHOS_PUBLICO = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'strict-transport-security': 'max-age=31536000',
};

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
export function createStudioHandler(opts: StudioOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const store = new FormsStore(opts.formsDir);
  const publicRoot = resolve(opts.publicDir);

  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(opts.acesso ? CABECALHOS_PUBLICO : {}) });
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
    if (opts.acesso) {
      // publicado: o Host é o do domínio; nas escritas a Origin precisa ser a própria página (anti CSRF) e o corpo, JSON
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin;
        if (!origin || !/^https?:\/\//.test(origin) || new URL(origin).host !== (req.headers.host ?? '')) throw new HttpError(403, 'forbidden_origin');
        if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'content_type_must_be_json');
      }
      return;
    }
    const host = (req.headers.host ?? '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) throw new HttpError(403, 'forbidden_host');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'forbidden_origin');
      if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'content_type_must_be_json');
    }
  };

  const acesso = opts.acesso ?? null;
  const agora = acesso?.agora ?? Date.now;
  const vigencia = acesso ? new VigenciaCache(acesso.servico, 5 * 60_000, agora) : null;
  const limite = new LimiteLogin(5, 15 * 60_000, agora);
  const ip = (req: IncomingMessage) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]!.trim();
  const sessaoDe = async (req: IncomingMessage): Promise<Sessao | null> => {
    if (!acesso || !vigencia) return null;
    const s = verificar(lerCookie(req.headers.cookie), acesso.segredo, agora());
    if (!s) return null;
    const papel = await vigencia.papel(s.id); // o papel vale o de agora, não o do dia do login
    return papel ? { ...s, papel } : null;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    guard(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    let sessao: Sessao | null = null;
    if (acesso) {
      const ativos = ['/login', '/s/login.js', '/s/studio.css', '/api/login', '/api/logout'];
      if (method === 'GET' && path === '/login') return sendFile(res, join(opts.publicDir, 'login.html'));
      if (method === 'POST' && path === '/api/login') {
        const b = await readJson(req);
        const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : '';
        const chave = `${ip(req)}|${email}`;
        if (limite.bloqueado(chave)) { res.setHeader('retry-after', '900'); throw new HttpError(429, 'muitas_tentativas', { detail: 'Muitas tentativas. Aguarde 15 minutos e tente de novo.' }); }
        const u = emailValido(email) && typeof b?.senha === 'string' && b.senha.length <= 200 ? await acesso.servico.entrar(email, b.senha) : null;
        if (!u) { limite.falhou(chave); throw new HttpError(401, 'credenciais_invalidas', { detail: 'E-mail ou senha incorretos, ou o acesso foi desativado.' }); }
        limite.limpar(chave);
        const exp = Math.floor(agora() / 1000) + SESSAO_SEGUNDOS;
        res.setHeader('set-cookie', cookieSessao(assinar({ id: u.id, email: u.email, nome: u.nome, papel: u.papel, exp }, acesso.segredo), acesso.seguro !== false));
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && path === '/api/logout') {
        res.setHeader('set-cookie', cookieLimpo(acesso.seguro !== false));
        return send(res, 200, { ok: true });
      }
      // Tarefa agendada da Vercel (cron): sem sessão, só com o segredo no cabeçalho Authorization
      if (method === 'GET' && path === '/api/cron/experimentos') {
        const seg = opts.integracoes?.cronSecret;
        const recebido = String(req.headers.authorization ?? '');
        const esperado = seg ? `Bearer ${seg}` : null;
        if (!esperado || recebido.length !== esperado.length || !timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))) return send(res, 401, { error: 'nao_autenticado' });
        return send(res, 200, await opts.integracoes!.sincronizarPlanilha());
      }
      sessao = await sessaoDe(req);
      if (!sessao && !(method === 'GET' && ativos.includes(path))) {
        if (path.startsWith('/api/')) return send(res, 401, { error: 'nao_autenticado' });
        res.writeHead(302, { location: `/login?voltar=${encodeURIComponent(path)}`, 'cache-control': 'no-store' });
        return res.end();
      }
      // O Studio de testes (formulários e envio ao pipeline) só existe na máquina local.
      if (path === '/studio' || path === '/attribution.js' || path.startsWith('/f/') || path.startsWith('/api/forms') || path.startsWith('/api/submit') || path === '/api/meta') return send(res, 404, { error: 'not_found' });
      if (sessao) {
        const soAdmin = path === '/usuarios' || path.startsWith('/api/usuarios') || (path.startsWith('/api/painel/') && method !== 'GET');
        if (soAdmin && sessao.papel !== 'admin') {
          if (path.startsWith('/api/')) return send(res, 403, { error: 'sem_permissao', detail: 'Só o admin pode fazer isso.' });
          res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
          return res.end();
        }
        if (method === 'GET' && path === '/api/me') return send(res, 200, { publico: true, id: sessao.id, nome: sessao.nome, email: sessao.email, papel: sessao.papel });
        if (method === 'GET' && path === '/usuarios') return sendFile(res, join(opts.publicDir, 'usuarios.html'));
        if (method === 'GET' && path === '/conta') return sendFile(res, join(opts.publicDir, 'conta.html'));
        if (method === 'POST' && path === '/api/senha') {
          const b = await readJson(req);
          if (typeof b?.atual !== 'string' || !(await acesso.servico.entrar(sessao.email, b.atual))) throw new HttpError(403, 'senha_atual_incorreta', { detail: 'A senha atual não confere.' });
          await acesso.servico.atualizar(sessao.id, { senha: senhaValida(b?.nova) });
          return send(res, 200, { ok: true });
        }
        if (path === '/api/usuarios' || path.startsWith('/api/usuarios/')) {
          const svc = acesso.servico;
          if (path === '/api/usuarios') {
            if (method === 'GET') return send(res, 200, await svc.listar());
            if (method === 'POST') {
              const b = await readJson(req);
              const email = typeof b?.email === 'string' ? b.email.trim().toLowerCase() : '';
              if (!emailValido(email)) throw new HttpError(400, 'email_invalido', { detail: 'Informe um e-mail válido.' });
              if (!(PAPEIS as readonly unknown[]).includes(b?.papel)) throw new HttpError(400, 'papel_invalido', { validos: [...PAPEIS] });
              const nome = typeof b?.nome === 'string' && b.nome.trim() ? b.nome.trim().slice(0, 120) : null;
              return send(res, 201, await svc.criar({ email, nome, papel: b.papel as Papel, senha: senhaValida(b?.senha) }));
            }
            return send(res, 405, { error: 'method_not_allowed' });
          }
          const uid = /^\/api\/usuarios\/([0-9a-f-]{36})$/.exec(path)?.[1];
          if (!uid) return send(res, 404, { error: 'not_found' });
          const eu = uid === sessao.id;
          if (method === 'DELETE') {
            if (eu) throw new HttpError(400, 'nao_pode_em_si_mesmo', { detail: 'Você não pode remover o próprio usuário.' });
            await svc.remover(uid);
            vigencia!.esquecer(uid);
            return send(res, 200, { ok: true });
          }
          if (method === 'PUT') {
            const b = await readJson(req);
            const e: { papel?: Papel; nome?: string | null; bloqueado?: boolean; senha?: string } = {};
            if ('papel' in (b ?? {})) { if (!(PAPEIS as readonly unknown[]).includes(b.papel)) throw new HttpError(400, 'papel_invalido', { validos: [...PAPEIS] }); e.papel = b.papel; }
            if ('nome' in (b ?? {})) e.nome = typeof b.nome === 'string' && b.nome.trim() ? b.nome.trim().slice(0, 120) : null;
            if ('bloqueado' in (b ?? {})) { if (typeof b.bloqueado !== 'boolean') throw new HttpError(400, 'bloqueado_invalido'); e.bloqueado = b.bloqueado; }
            if ('senha' in (b ?? {})) e.senha = senhaValida(b.senha);
            if (!Object.keys(e).length) throw new HttpError(400, 'nada_para_gravar');
            if (eu && (e.papel === 'editor' || e.bloqueado)) throw new HttpError(400, 'nao_pode_em_si_mesmo', { detail: 'Você não pode rebaixar nem bloquear o próprio usuário.' });
            const r = await svc.atualizar(uid, e);
            vigencia!.esquecer(uid);
            return send(res, 200, r);
          }
          return send(res, 405, { error: 'method_not_allowed' });
        }
      }
    } else if (method === 'GET' && path === '/api/me') {
      return send(res, 200, { publico: false, papel: 'admin' });
    }

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

    // Monitor diário (e Canais): hoje x ontem, semana e mês contra o mesmo trecho anterior, total e por canal. Só leitura.
    if (method === 'GET' && path === '/monitor') return sendFile(res, join(opts.publicDir, 'monitor.html'));
    if (path === '/api/monitor') {
      if (!opts.monitor) return send(res, 503, { error: 'monitor_nao_configurado', detail: 'Falta PANEL_DB_URL no .env.local. Peça para gerar com: node scripts/set-role-password.mjs --role orq_panel --apply' });
      if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      const produto = url.searchParams.get('produto');
      if (produto && !(PRODUTOS_MONITOR as readonly string[]).includes(produto)) throw new HttpError(400, 'produto_invalido', { validos: [...PRODUTOS_MONITOR] });
      return send(res, 200, await opts.monitor.monitor((produto || undefined) as ProdutoMonitor | undefined));
    }

    // Saúde da sincronização: estado do gatilho manual, últimas execuções no GitHub e o disparo (só admin, pela regra de /api/painel/ não-GET)
    if (method === 'GET' && path === '/api/painel/sincronia') {
      const sinc = opts.sincronia;
      if (!sinc) return send(res, 200, { configurado: false, repo: null, workflows: [], execucoes: [] });
      const st = sinc.status();
      return send(res, 200, { ...st, execucoes: await sinc.execucoes().catch(() => []) });
    }
    if (method === 'POST' && path === '/api/painel/sincronia/disparar') {
      if (!opts.sincronia) return send(res, 503, { error: 'integracao_nao_configurada', detail: 'Gatilho manual não configurado: falta GITHUB_DISPATCH_TOKEN (token do GitHub com permissão Actions: leitura e escrita neste repositório).' });
      const b = await readJson(req);
      return send(res, 202, await opts.sincronia.disparar(b?.workflow));
    }
    // Integrações: estado (o que está configurado) e as ações de sincronizar a planilha e enviar ao ClickUp
    if (method === 'GET' && path === '/api/integracoes') return send(res, 200, opts.integracoes?.status() ?? { sheets: { configurado: false }, clickup: { configurado: false }, cron: false });
    if (method === 'POST' && path === '/api/experimentos/sincronizar') {
      if (!opts.integracoes) return send(res, 503, { error: 'integracao_nao_configurada', detail: 'Google Sheets não configurado: faltam GOOGLE_SA_CLIENT_EMAIL, GOOGLE_SA_PRIVATE_KEY e SHEETS_PLANILHA_ID.' });
      return send(res, 200, await opts.integracoes.sincronizarPlanilha());
    }
    const clickupRota = /^\/api\/experimentos\/(\d{1,15})\/clickup$/.exec(path);
    if (method === 'POST' && clickupRota) {
      if (!opts.integracoes) return send(res, 503, { error: 'integracao_nao_configurada', detail: 'ClickUp não configurado: faltam CLICKUP_TOKEN, CLICKUP_WORKSPACE_ID e CLICKUP_DOC_ID.' });
      return send(res, 200, await opts.integracoes.enviarClickUp(Number(clickupRota[1])));
    }
    // Experimentos de growth: o cadastro é a única escrita (mkt.experimentos); o resultado vem sozinho das visões de analytics. Sem DELETE: remover é cancelar.
    if (method === 'GET' && path === '/experimentos') return sendFile(res, join(opts.publicDir, 'experimentos.html'));
    if (path === '/api/experimentos' || path.startsWith('/api/experimentos/')) {
      const repo = opts.experimentos;
      if (!repo) return send(res, 503, { error: 'experimentos_nao_configurado', detail: 'Falta PANEL_DB_URL no .env.local. Peça para gerar com: node scripts/set-role-password.mjs --role orq_panel --apply' });
      if (path === '/api/experimentos') {
        if (method === 'GET') {
          // ?rapido=1: só o cadastro (a página pede os resultados em seguida, em /progresso); sem o parâmetro, tudo junto como sempre
          if (url.searchParams.get('rapido') === '1' && repo.listarBasico) return send(res, 200, await repo.listarBasico());
          return send(res, 200, await repo.listar());
        }
        if (method === 'POST') return send(res, 201, await repo.criar(await readJson(req)));
        return send(res, 405, { error: 'method_not_allowed' });
      }
      if (path === '/api/experimentos/progresso') {
        if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
        if (!repo.progressos) return send(res, 404, { error: 'not_found' });
        return send(res, 200, await repo.progressos(url.searchParams.get('fresh') === '1'));
      }
      if (path === '/api/experimentos/valores') {
        if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
        const campo = url.searchParams.get('campo') ?? '';
        if (!campo.trim() || campo.length > 100) throw new HttpError(400, 'campo_invalido');
        return send(res, 200, await repo.valores(campo, url.searchParams.get('produto') || undefined, url.searchParams.get('q') || undefined));
      }
      if (path === '/api/experimentos/opcoes') {
        if (method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
        return send(res, 200, await repo.opcoes(url.searchParams.get('produto') || undefined));
      }
      // Documentação: relatório (diário, semanal e geral) + o HTML do editor, gravado à parte para a lista não carregar texto grande.
      const sub = /^\/api\/experimentos\/(\d{1,15})\/(relatorio|documentacao)$/.exec(path);
      if (sub) {
        if (sub[2] === 'relatorio') return method === 'GET' ? send(res, 200, await repo.relatorio(Number(sub[1]))) : send(res, 405, { error: 'method_not_allowed' });
        return method === 'PUT' ? send(res, 200, await repo.salvarDocumentacao(Number(sub[1]), await readJson(req))) : send(res, 405, { error: 'method_not_allowed' });
      }
      const eid = /^\/api\/experimentos\/(\d{1,15})$/.exec(path);
      if (!eid) return send(res, 404, { error: 'not_found' });
      if (method !== 'PUT') return send(res, 405, { error: 'method_not_allowed' });
      return send(res, 200, await repo.atualizar(Number(eid[1]), await readJson(req)));
    }

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
      // Campanhas da Meta com gasto no período, para o filtro temporário "Campanhas Meta fora do CPL"
      if (path === '/api/bi/campanhas') {
        if (!bi.campanhasMeta) return send(res, 404, { error: 'not_found' });
        const q = url.searchParams;
        const dia = (v: string | null, nome: string): string => {
          if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new HttpError(400, `${nome}_invalida`, { esperado: 'AAAA-MM-DD' });
          return v;
        };
        const de = dia(q.get('de'), 'de'), ate = dia(q.get('ate'), 'ate');
        if (de > ate) throw new HttpError(400, 'periodo_invertido');
        const produto = q.get('produto');
        if (produto && !(BI_PRODUTOS as readonly string[]).includes(produto)) throw new HttpError(400, 'produto_invalido', { validos: [...BI_PRODUTOS] });
        return send(res, 200, await bi.campanhasMeta({ de, ate, ...(produto ? { produto: produto as BiProduto } : {}) }));
      }
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
        // campanhas da Meta fora da análise (temporário): IDs de campanha, só dígitos
        const excl = q.get('excluir_campanhas');
        if (excl) {
          const toks = excl.split(',');
          if (toks.length > 200 || toks.some((t) => !/^\d{1,20}$/.test(t))) throw new HttpError(400, 'excluir_campanhas_invalido');
          f.excluirCampanhas = [...new Set(toks)];
        }
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
        if (!ev || ev.length > 300) throw new HttpError(400, 'evento_invalido');
        const origemQ = url.searchParams.get('origem') ?? 'site';
        if (!(CONVERSAO_ORIGENS as readonly string[]).includes(origemQ)) throw new HttpError(400, 'origem_invalida', { validas: [...CONVERSAO_ORIGENS] });
        return send(res, 200, await repo.conversaoEventoUrls(ev, diasConv(), origemQ as ConversaoOrigem));
      }
      // Conversões Globais: site (GA4), RD (evento) e Pipedrive (Identificador de Conversão RD), com tipo de conversão e pontos de leadscoring.
      if (method === 'GET' && path === '/api/painel/conversoes/globais') return send(res, 200, await repo.conversoesGlobais(diasConv()));
      if (method === 'PUT' && path === '/api/painel/conversoes/catalogo') {
        const b = await readJson(req);
        if (!(CONVERSAO_ORIGENS as readonly unknown[]).includes(b?.origem)) throw new HttpError(400, 'origem_invalida', { validas: [...CONVERSAO_ORIGENS] });
        if (typeof b?.evento !== 'string' || !b.evento.trim() || b.evento.length > 300) throw new HttpError(400, 'evento_invalido');
        if (b.tipo_conversao !== null && !(CONVERSAO_TIPOS as readonly unknown[]).includes(b.tipo_conversao)) throw new HttpError(400, 'tipo_conversao_invalido', { validos: [...CONVERSAO_TIPOS] });
        if (b.pontos !== null && !(Number.isInteger(b.pontos) && b.pontos >= -1000 && b.pontos <= 1000)) throw new HttpError(400, 'pontos_invalidos', { faixa: [-1000, 1000] });
        await repo.salvarConversaoCatalogo({ origem: b.origem, evento: b.evento.trim(), tipo_conversao: b.tipo_conversao, pontos: b.pontos });
        return send(res, 200, { ok: true });
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

  return (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      if (e instanceof StoreError) return send(res, 400, { error: e.message, issues: e.issues });
      if (e instanceof PainelNotFound || e instanceof BiNotFound) return send(res, 404, { error: 'nao_encontrado', detail: e.message });
      if (e instanceof PainelInvalido) return send(res, 400, { error: 'invalido', detail: e.message });
      if (e instanceof AuthErro) return send(res, e.status, { error: 'auth', detail: e.message });
      if (e instanceof IntegracaoErro) return send(res, e.status === 503 ? 503 : e.status === 404 ? 502 : e.status, { error: e.status === 503 ? 'integracao_nao_configurada' : 'integracao', detail: e.message });
      console.error('studio:', e instanceof Error ? e.message : e);
      // limite de conexões do papel do painel estourado (código 53300 do Postgres): é passageiro, então diz o que fazer em vez de "erro interno"
      if ((e as { code?: string } | null)?.code === '53300') return send(res, 503, { error: 'banco_ocupado', detail: 'O banco está com todas as conexões do painel em uso. Aguarde alguns segundos e tente de novo.' });
      send(res, 500, { error: 'internal_error' });
    });
  };
}

export function createStudioServer(opts: StudioOptions): Server {
  return createServer(createStudioHandler(opts));
}
