/**
 * Onde a configuração do painel Umbler mora.
 * - Arquivo (studio/config/umbler-marketing.json): modo local sem banco.
 * - Supabase (ops.cfg_umbler, uma linha com o JSON): usado na Vercel, onde não há disco permanente, e também no Studio local
 *   quando existe PANEL_DB_URL, para o local e o publicado enxergarem a MESMA configuração.
 * O conteúdo é só ID, nome, limite e preço: nenhum segredo.
 */
import type pg from 'pg';
import { lerConfig, salvarConfig, configVazia, type ConfigUmbler } from './config.js';

export interface ConfigStore {
  ler(): Promise<ConfigUmbler>;
  salvar(c: ConfigUmbler): Promise<void>;
  /** De onde vem (aparece na tela da Configuração). */
  readonly origem: 'arquivo' | 'banco';
}

export class ArquivoConfigStore implements ConfigStore {
  readonly origem = 'arquivo' as const;
  constructor(private readonly caminho: string) {}
  async ler() { return lerConfig(this.caminho); }
  async salvar(c: ConfigUmbler) { salvarConfig(this.caminho, c); }
}

export class PgConfigStore implements ConfigStore {
  readonly origem = 'banco' as const;
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}
  async ler(): Promise<ConfigUmbler> {
    const r = await this.pool.query<{ config: unknown }>(`select config from ops.cfg_umbler where chave = 'marketing'`);
    if (!r.rows[0]) return configVazia();
    // passa pela mesma validação do arquivo: lixo no banco nunca quebra a tela
    return lerConfig(JSON.stringify(r.rows[0].config), true);
  }
  async salvar(c: ConfigUmbler): Promise<void> {
    await this.pool.query(
      `insert into ops.cfg_umbler (chave, config, atualizado_em) values ('marketing', $1::jsonb, now())
       on conflict (chave) do update set config = excluded.config, atualizado_em = now()`,
      [JSON.stringify(c)],
    );
  }
}
