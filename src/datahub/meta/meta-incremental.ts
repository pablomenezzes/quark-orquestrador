/**
 * Atualizacao INCREMENTAL do desempenho da Meta (pedido do Pablo, 2026-10-21): so os ultimos dias, nunca a carga toda.
 *  - de hora em hora: so HOJE (1 dia);
 *  - uma vez por dia (06 UTC): so as ultimas 48h (ontem e hoje), para fechar o dia anterior.
 * Nunca mais que isso: o historico ja gravado nao e relido (as rodadas por trimestre, com simulacao e cartao, sao o caminho para reler um periodo).
 * Mesmas regras das rodadas: so GET, 7 dias por vez, para a 75% da cota (espera e relê o MESMO bloco), compara com o banco por valor e grava so
 * linhas novas ou alteradas (mudou = revisao + 1; fica a versao mais recente). Trimestres FECHADOS nunca sao tocados. A diferenca entre a soma das
 * linhas e o total da conta nos dias recentes e esperada (a Meta ainda esta fechando o dia): fica no log, nao trava a atualizacao.
 */
import { lerInsights, MetaCotaErro, type AdDia, type MetaClient, type MetaConta } from './meta.js';
import { blocosDeDias, compararLinhas, lerTotaisConta, reconciliar, totaisDe, type Existente, type Totais } from './meta-rodadas.js';

export const DIAS_HORA = 1;
export const DIAS_DIARIA = 2;

export interface IncStore {
  existentes(contaId: string, de: string, ate: string): Promise<Existente[]>;
  gravarLinhas(rows: AdDia[], rodadaId: number | null, hashes: Map<string, string>): Promise<void>;
  /** O trimestre (AAAA-Tn) desta data esta FECHADO para a conta? */
  trimestreFechado(trimestre: string, contaId: string): Promise<boolean>;
}

const somaDias = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
export const trimestreDe = (d: string) => `${d.slice(0, 4)}-T${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
/** 2 dias (48h) as 06 UTC, uma vez por dia; nas outras horas, so hoje. */
export const diasDaExecucao = (agora: Date) => (agora.getUTCHours() === 6 ? DIAS_DIARIA : DIAS_HORA);

export interface ResultadoIncremental {
  produto: string; de: string; ate: string; blocos: number; ignorados_fechados: number; linhas_lidas: number; inseridas: number; atualizadas: number; mantidas: number;
  diferencas: string[]; chamadas: number; uso_cota_pct: number; parou?: string;
}

/** Le a janela [hoje - dias + 1, hoje] da conta e grava so o que e novo ou mudou. */
export async function atualizarIncremental(
  client: MetaClient, store: IncStore, conta: MetaConta, hoje: string, dias: number,
  opts: { esfriar?: () => Promise<void>; log?: (s: string) => void } = {},
): Promise<ResultadoIncremental> {
  if (!Number.isInteger(dias) || dias < 1 || dias > DIAS_DIARIA) throw new Error(`Incremental: de 1 a ${DIAS_DIARIA} dias (nunca a carga toda).`);
  const de = somaDias(hoje, -(dias - 1));
  const r: ResultadoIncremental = { produto: conta.produto, de, ate: hoje, blocos: 0, ignorados_fechados: 0, linhas_lidas: 0, inseridas: 0, atualizadas: 0, mantidas: 0, diferencas: [], chamadas: 0, uso_cota_pct: 0 };
  const antes = client.requisicoes;
  try {
    for (const b of blocosDeDias(de, hoje)) {
      if ((await store.trimestreFechado(trimestreDe(b.inicio), conta.id)) && (await store.trimestreFechado(trimestreDe(b.fim), conta.id))) {
        r.ignorados_fechados++;
        continue;
      }
      let novas: AdDia[] = [];
      let totalConta: Totais | null = null;
      for (let tentativa = 1; ; tentativa++) {
        try {
          novas = await lerInsights(client, conta, b.inicio, b.fim);
          totalConta = await lerTotaisConta(client, conta, b.inicio, b.fim);
          break;
        } catch (e) {
          if (!(e instanceof MetaCotaErro) || tentativa >= 3 || !opts.esfriar) throw e;
          await opts.esfriar(); // espera a cota esfriar e relê SO este bloco de 7 dias
          client.liberarParada();
        }
      }
      const cmp = compararLinhas(novas, await store.existentes(conta.id, b.inicio, b.fim));
      const aGravar = [...cmp.inserir, ...cmp.atualizar];
      if (aGravar.length) await store.gravarLinhas(aGravar, null, new Map());
      r.blocos++;
      r.linhas_lidas += novas.length;
      r.inseridas += cmp.inserir.length;
      r.atualizadas += cmp.atualizar.length;
      r.mantidas += cmp.manter;
      const rec = reconciliar(totalConta!, totaisDe(novas));
      if (!rec.explicada) r.diferencas.push(`${b.inicio} a ${b.fim}: gasto ${rec.diferenca.gasto.toFixed(2)}, impressoes ${rec.diferenca.impressoes}, cliques ${rec.diferenca.cliques}, leads ${rec.diferenca.leads}`);
      opts.log?.(`${conta.produto} ${b.inicio} a ${b.fim}: ${novas.length} lidas, ${cmp.inserir.length} novas, ${cmp.atualizar.length} alteradas, ${cmp.manter} iguais`);
    }
  } catch (e) {
    if (!(e instanceof MetaCotaErro)) throw e;
    r.parou = e.motivo; // cota: para sem falhar; a proxima hora continua do que faltar (nada do bloco interrompido foi gravado)
  }
  r.chamadas = client.requisicoes - antes;
  r.uso_cota_pct = Math.round(client.usoMaximoPct);
  return r;
}
