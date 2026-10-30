/**
 * Cliente da API da Umbler (UTalk) SOMENTE LEITURA.
 *
 * - Só existe `get`: nenhum método de escrita, e o teste lê este arquivo para provar isso.
 * - Só fala com o domínio da Umbler (app-utalk.umbler.com); qualquer outro host é recusado.
 * - O token vai no cabeçalho Authorization e nunca em URL, log, erro ou cache.
 * - Fila com no máximo 1 requisição por vez, janela de limite (a API aceita 100 req por 5 s) e espera com recuo quando responde 429.
 */

export const UMBLER_BASE = 'https://app-utalk.umbler.com/api';
const HOST_PERMITIDO = 'app-utalk.umbler.com';

export class UmblerErro extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly rota: string | null = null,
  ) {
    super(message);
  }
}

export type UmblerClienteOpts = {
  token: string;
  fetchFn?: typeof fetch;
  base?: string;
  /** Requisições por janela (padrão 90, abaixo das 100 que a API aceita). */
  limite?: number;
  janelaMs?: number;
  agora?: () => number;
  dorme?: (ms: number) => Promise<void>;
  tentativas429?: number;
  timeoutMs?: number;
};

export type Consulta = Record<string, string | number | boolean | readonly (string | number)[] | null | undefined>;

/** Troca qualquer ocorrência do token (e de "Bearer ...") por ***. Use em toda mensagem que possa ser mostrada. */
export function ocultarToken(texto: string, token: string): string {
  let t = texto;
  if (token) t = t.split(token).join('***');
  return t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer ***');
}

export class UmblerCliente {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  private readonly limite: number;
  private readonly janelaMs: number;
  private readonly agora: () => number;
  private readonly dorme: (ms: number) => Promise<void>;
  private readonly tentativas429: number;
  private readonly timeoutMs: number;
  private readonly marcas: number[] = [];
  private fila: Promise<unknown> = Promise.resolve();
  /** Quantas requisições este cliente já fez (para conferir o orçamento da descoberta). */
  total = 0;

  constructor(o: UmblerClienteOpts) {
    if (!o.token || /\s/.test(o.token)) throw new UmblerErro('Token da Umbler ausente ou inválido.');
    this.token = o.token;
    this.fetchFn = o.fetchFn ?? fetch;
    this.base = (o.base ?? UMBLER_BASE).replace(/\/+$/, '');
    if (new URL(this.base).host !== HOST_PERMITIDO && !o.fetchFn) throw new UmblerErro('Domínio não permitido.');
    this.limite = o.limite ?? 90;
    this.janelaMs = o.janelaMs ?? 5_000;
    this.agora = o.agora ?? Date.now;
    this.dorme = o.dorme ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tentativas429 = o.tentativas429 ?? 5;
    this.timeoutMs = o.timeoutMs ?? 30_000;
  }

  /** GET de uma rota da API (ex.: "/v1/channels/"). Devolve o JSON. */
  get(rota: string, consulta: Consulta = {}): Promise<unknown> {
    const run = () => this.executar(rota, consulta);
    const p = this.fila.then(run, run); // uma por vez, na ordem
    this.fila = p.catch(() => undefined);
    return p;
  }

  private url(rota: string, consulta: Consulta): string {
    if (!/^\/v1\/[A-Za-z0-9\-_/{}.]*$/.test(rota) || rota.includes('..')) throw new UmblerErro('Rota inválida.', null, rota);
    const u = new URL(this.base + rota);
    if (u.host !== HOST_PERMITIDO && this.base === UMBLER_BASE) throw new UmblerErro('Domínio não permitido.', null, rota);
    for (const [k, v] of Object.entries(consulta)) {
      if (v == null) continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private async esperarJanela(): Promise<void> {
    for (;;) {
      const t = this.agora();
      while (this.marcas.length && t - this.marcas[0]! >= this.janelaMs) this.marcas.shift();
      if (this.marcas.length < this.limite) {
        this.marcas.push(t);
        return;
      }
      await this.dorme(Math.max(50, this.janelaMs - (t - this.marcas[0]!)));
    }
  }

  private async executar(rota: string, consulta: Consulta): Promise<unknown> {
    const url = this.url(rota, consulta);
    for (let tentativa = 0; ; tentativa++) {
      await this.esperarJanela();
      this.total++;
      let resp: Response;
      try {
        resp = await this.fetchFn(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        throw new UmblerErro(ocultarToken(`Falha de rede ao consultar a Umbler: ${e instanceof Error ? e.message : String(e)}`, this.token), null, rota);
      }
      if (resp.status === 429) {
        if (tentativa >= this.tentativas429) throw new UmblerErro('A Umbler limitou as consultas (429) e não liberou depois de várias esperas.', 429, rota);
        const ra = Number(resp.headers.get('retry-after'));
        await this.dorme(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : Math.min(1000 * 2 ** tentativa, 30_000));
        continue;
      }
      if (resp.status === 401 || resp.status === 403) throw new UmblerErro(`A Umbler recusou o acesso (${resp.status}). Confira o token (UMBLER_TOKEN) e as permissões dele.`, resp.status, rota);
      if (!resp.ok) throw new UmblerErro(`A Umbler respondeu ${resp.status} em ${rota}.`, resp.status, rota);
      try {
        return await resp.json();
      } catch {
        throw new UmblerErro(`Resposta da Umbler em ${rota} não é JSON.`, resp.status, rota);
      }
    }
  }
}
