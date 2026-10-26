import { describe, it, expect } from 'vitest';
import { dataBr, lerCsv, mapearFormulario, mapearLista2025 } from '../scripts/lib/experimentos-planilhas';
import { validarEntrada } from '../studio/lib/experimentos';

const CAB_FORM = 'Carimbo,Título,Início,Conclusão,Responsável,Categoria,Área,Hipótese,Impacto,Confiança,Facilidade,Evidências,Imagens,Pontua?,ICE,Controle,Avaliação,Aprendizados';
const CAB_2025 = 'COD,Categoria,Responsável,Status,Hipótese,I,C,E,SUM,PON,Data Início,Resultado,Aprendizados,Documentação';

describe('carga das planilhas antigas de experimentos', () => {
  it('lê CSV com aspas, aspas duplas e quebra de linha dentro do campo', () => {
    const l = lerCsv('a,"b, com vírgula","linha 1\nlinha 2","diz ""oi"""\r\nc,d,,\r\n');
    expect(l).toEqual([['a', 'b, com vírgula', 'linha 1\nlinha 2', 'diz "oi"'], ['c', 'd', '', '']]);
  });
  it('datas dd/mm/aaaa e dd/mm (com ano padrão); o que não for data vira nulo', () => {
    expect(dataBr('13/02/2026')).toBe('2026-02-13');
    expect(dataBr('15/06', 2025)).toBe('2025-06-15');
    expect(dataBr('15/06')).toBeNull();
    expect(dataBr('13 e 11/06', 2025)).toBeNull();
    expect(dataBr('31/02/2026')).toBeNull();
    expect(dataBr('13/02/2026 17:32:34')).toBe('2026-02-13');
  });
  it('formulário: mapeia tipo, status, ICE, avaliação e descarta linhas sem título', () => {
    const csv = [
      CAB_FORM,
      '13/02/2026 17:32:34,Monitor de MQLs,13/02/2026,15/02/2026,Dimitri Lima,ideia,Dados,Ajuda a ver a operação,5,3,2,confia,,TRUE,10,Bloqueado,,',
      ',Campanha Frequencia,,,,Experimento,Anúncio,,3,3,1,https://exemplo.com/doc,"16 leads, CPL 93",FALSE,7,Concluído,Falha,"Muitos leads inválidos."',
      '05/03/2026 18:08:47,Separação dos Squads,01/02/2026,01/02/2026,Pablo Menezes,Melhoria implementada,Estratégia,Mais produtividade,5,5,5,,,FALSE,15,,,',
      ',,,,,,,,,,,,,FALSE,0,Backlog,,',
      '09/04/2026 10:00:00,Data torta,10/04/2026,01/04/2026,,Documentação de processo,Dados,,0,,11,,,FALSE,0,,,',
    ].join('\n');
    const r = mapearFormulario(csv);
    expect(r.map((x) => x.entrada.titulo)).toEqual(['Monitor de MQLs', 'Campanha Frequencia', 'Separação dos Squads', 'Data torta']);
    expect(r[0]!.entrada).toMatchObject({ tipo: 'ideia', status: 'bloqueado', responsavel: 'Dimitri Lima', areaImpacto: 'Dados', inicio: '2026-02-13', fim: '2026-02-15', iceImpacto: 5, iceConfianca: 3, iceFacilidade: 2 });
    expect(r[1]!.entrada).toMatchObject({ tipo: 'experimento', status: 'concluido', avaliacao: 'falha', aprendizado: 'Muitos leads inválidos.', iceFacilidade: 1 });
    expect(r[1]!.entrada.evidencias).toContain('https://exemplo.com/doc');
    expect(r[1]!.entrada.evidencias).toContain('16 leads, CPL 93');
    expect(r[2]!.entrada).toMatchObject({ tipo: 'melhoria', status: 'concluido' }); // melhoria implementada sem status = concluída
    expect(r[3]!.entrada).toMatchObject({ tipo: 'documentacao', inicio: '2026-04-10' });
    expect(r[3]!.entrada.fim).toBeUndefined(); // fim antes do início é descartado
    expect(r[3]!.entrada.iceImpacto).toBeUndefined(); // 0 = não preenchido
    for (const x of r) expect(() => validarEntrada(x.entrada, 'criar')).not.toThrow();
    expect(new Set(r.map((x) => x.origem)).size).toBe(r.length);
  });
  it('lista 2025: título vem da hipótese ou da categoria, ano padrão 2025 e linhas vazias saem', () => {
    const csv = [
      'Experimentos Growth,,,,,,,,,,,,,', ',,,,,Pesos,,,,,,,,', CAB_2025,
      '18,Campanha de Mensagem p/ WhatsApp,João Santos,Concluído,Campanha de Mensagem p/ WhatsApp. A hipótese é baixar o CPL,5,5,5,15,5,15/06,Falha,"Volume bom, qualidade ruim.",',
      '3,Comercial,,Backlog,"Se alterarmos o fluxo, diminuiremos a taxa de lead sem contato. Mais texto.",0,0,0,0,0,,,,',
      '10,,,Ideia,Adicionar link da agenda para lead de remarketing,8,6,4,18,"6,6",,,,',
      '12,CRO,,Ideia,,,,,0,#VALUE!,,,,',
      '23,Material Rico,Anderson Santos,Execução,Checklist Crédito do Trabalhador,7,8,8,23,"7,5",24/11/2025,Sucesso,Gera interesse,https://exemplo.com/checklist',
      '73,,,,,,,,,,,,,',
    ].join('\n');
    const r = mapearLista2025(csv);
    expect(r.map((x) => x.entrada.titulo)).toEqual(['Campanha de Mensagem p/ WhatsApp', 'Se alterarmos o fluxo, diminuiremos a taxa de lead sem contato.', 'Adicionar link da agenda para lead de remarketing', 'Checklist Crédito do Trabalhador']);
    expect(r[0]!.entrada).toMatchObject({ status: 'concluido', avaliacao: 'falha', inicio: '2025-06-15', iceImpacto: 5 });
    expect(r[0]!.entrada.areaImpacto).toBeUndefined(); // a categoria já era o título
    expect(r[1]!.entrada).toMatchObject({ status: 'backlog', areaImpacto: 'Comercial' });
    expect(r[1]!.entrada.iceImpacto).toBeUndefined();
    expect(r[2]!.entrada).toMatchObject({ tipo: 'ideia', status: 'backlog', iceImpacto: 8, iceConfianca: 6, iceFacilidade: 4 });
    expect(r[3]!.entrada).toMatchObject({ status: 'rodando', avaliacao: 'sucesso', inicio: '2025-11-24', responsavel: 'Anderson Santos' });
    expect(r[3]!.entrada.evidencias).toBe('Documentação: https://exemplo.com/checklist');
    for (const x of r) expect(() => validarEntrada(x.entrada, 'criar')).not.toThrow();
  });
  it('rodar de novo gera as mesmas chaves de origem (a carga não duplica)', () => {
    const csv = [CAB_FORM, '13/02/2026 17:32:34,Monitor de MQLs,,,,ideia,,,,,,,,,,,,', '13/02/2026 17:40:00,Monitor de MQLs,,,,ideia,,,,,,,,,,,,'].join('\n');
    const a = mapearFormulario(csv).map((x) => x.origem), b = mapearFormulario(csv).map((x) => x.origem);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2); // mesmo título duas vezes não se confunde
  });
});
