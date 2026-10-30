/**
 * Cache em arquivo (.cache/umbler/, ignorado pelo git). Guarda o JSON ORIGINAL da resposta (D-33) com a hora da gravação.
 * Telefone, e-mail, foto e afins são retirados antes de gravar (ver `minimizar`). Validade padrão de 15 minutos. Nunca recebe cabeçalhos: o token não tem como chegar aqui, e por garantia o texto é
 * recusado se contiver o token informado.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const VALIDADE_MS = 15 * 60_000;

/** Chaves com dado pessoal ou credencial: saem do JSON antes de ir para o disco (o resto do original é preservado). */
const CHAVE_PESSOAL = /phone|e-?mail|whatsappusername|picture|token|signature|displayname|password/i;
export function minimizar(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(minimizar);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([k]) => !CHAVE_PESSOAL.test(k)).map(([k, v]) => [k, minimizar(v)]));
  return x;
}

export class CacheUmbler {
  constructor(
    private readonly dir: string,
    private readonly agora: () => number = Date.now,
    private readonly validadeMs: number = VALIDADE_MS,
    private readonly token: string = '',
  ) {}

  private arquivo(chave: string): string {
    return join(this.dir, `${createHash('sha256').update(chave).digest('hex').slice(0, 40)}.json`);
  }

  /** Devolve o dado se ainda está válido (ou, com `qualquerIdade`, mesmo vencido). */
  ler<T>(chave: string, qualquerIdade = false): { dado: T; gravadoEm: number } | null {
    const f = this.arquivo(chave);
    if (!existsSync(f)) return null;
    try {
      const o = JSON.parse(readFileSync(f, 'utf8')) as { chave: string; gravadoEm: number; dado: T };
      if (o.chave !== chave || typeof o.gravadoEm !== 'number') return null;
      if (!qualquerIdade && this.agora() - o.gravadoEm > this.validadeMs) return null;
      return { dado: o.dado, gravadoEm: o.gravadoEm };
    } catch {
      return null;
    }
  }

  gravar(chave: string, dado: unknown): number {
    const texto = JSON.stringify({ chave, gravadoEm: this.agora(), dado: minimizar(dado) });
    if (this.token && texto.includes(this.token)) throw new Error('Recusado: o conteúdo do cache contém o token.');
    mkdirSync(this.dir, { recursive: true });
    const f = this.arquivo(chave);
    writeFileSync(`${f}.tmp`, texto, 'utf8');
    renameSync(`${f}.tmp`, f);
    return this.agora();
  }

  apagar(chave: string): void {
    rmSync(this.arquivo(chave), { force: true });
  }

  /** Apaga tudo (botão "Atualizar agora"). */
  limpar(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
