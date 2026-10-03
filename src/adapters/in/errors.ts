export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

export type AdapterResult = {
  /** Objeto no formato do contrato (seção 7), ainda sem validação. */
  candidate: Record<string, unknown>;
  /** Valor do campo honeypot (website_hp). Vazio = humano. */
  honeypot: string;
};

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
