/**
 * CORS por origem cadastrada em orq.sources.url.
 *
 * A coluna `url` aceita uma ou várias URLs (separadas por espaço, vírgula, ponto e vírgula ou quebra de linha);
 * só a ORIGEM (esquema + host + porta) importa. Isto protege contra uso do token por OUTROS SITES em navegadores;
 * não protege contra scripts fora do navegador (que podem omitir o cabeçalho Origin) — para isso existe o limite
 * de requisições.
 */
export function parseSourceOrigins(url: string | null | undefined): string[] {
  if (!url) return [];
  const out: string[] = [];
  for (const part of url.split(/[\s,;]+/)) {
    if (!part) continue;
    try {
      const u = new URL(part);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (!out.includes(u.origin)) out.push(u.origin);
    } catch {
      /* valor inválido: ignora */
    }
  }
  return out;
}

export function isOriginAllowed(origin: string | undefined | null, allowed: string[]): boolean {
  if (!origin || origin === 'null') return false;
  let normalized: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // Origin é só esquema+host+porta; qualquer caminho aqui indica valor adulterado.
    if (u.pathname !== '/' || u.search || u.hash) return false;
    normalized = u.origin;
  } catch {
    return false;
  }
  return allowed.includes(normalized);
}

/**
 * Guarda a lista de origens por um tempo para não consultar o banco a cada pré-requisição (OPTIONS).
 * Falha ao carregar: devolve a última lista boa; sem lista boa, devolve [] (fecha o navegador) e tenta de novo em 5s.
 */
export class OriginCache {
  private value: string[] | null = null;
  private expiresAt = 0;
  private inflight: Promise<string[]> | null = null;

  constructor(
    private readonly loader: () => Promise<string[]>,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly onError: (e: unknown) => void = () => {},
    private readonly retryMs = 5_000,
  ) {}

  async get(): Promise<string[]> {
    if (this.value && this.now() < this.expiresAt) return this.value;
    if (!this.inflight) {
      this.inflight = this.loader()
        .then((list) => {
          this.value = list;
          this.expiresAt = this.now() + this.ttlMs;
          return list;
        })
        .catch((e) => {
          this.onError(e);
          this.expiresAt = this.now() + this.retryMs;
          if (!this.value) this.value = [];
          return this.value;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }
}
