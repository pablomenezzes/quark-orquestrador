# Data Hub Meta Ads. Entrega 0 (plano, sem código)

Pedido do Pablo (2026-10-09): levar o BI a um nível mais profundo no **Meta Ads**: custo; métricas de performance (CPM, CPC, CTR, Connect Rate, e visualização e retenção dos vídeos); UTMs; IDs de campanha, criativo e conjunto de anúncios; e **relacionar tudo com a base do Pipedrive**, pelo **método principal** (IDs e "term" com campaign ID) e também **pelo nome** da campanha e do criativo.

Mesmas regras do Data Hub: **só leitura** na API da Meta, dado real permitido (de teste não), **nada descartado**, **ID e nome juntos**, documentação atual antes de cada entidade, **economia de espaço (D-40)**, KPIs de MRR em toda análise de negócios (D-48), marco "Reunião Agendada" (D-49), definição de pronto (testes, conferência com a Meta, tela, roteiro de até 5 passos, MD + commit + push) e **parar e aguardar o "conferido"**. Nada foi construído, nenhum SQL foi aplicado e nenhuma credencial foi tocada para escrever este plano.

## 1. O que a sondagem de hoje achou (somente leitura, nada gravado)

**O Pipedrive já tem os IDs da Meta.** Em cada negócio existem os campos **Meta Campaign_id**, **Meta Adset_id**, **Meta Ad_id**, **Meta Lead_id** e **Meta Form_id** (todos texto), além das 5 UTMs. Cobertura nos leads da fonte "Marketing [Meta ADS]":

| Campo | desde 2025-01-01 | só 2026 |
|---|---|---|
| Meta Campaign_id | 82,1% | **98,3%** |
| Meta Adset_id | 67,9% | **98,3%** |
| Meta Ad_id | 67,9% | **98,3%** |
| Meta Lead_id | 67,9% | **98,3%** |
| UTM Campaign | 98,2% | 98,8% |
| UTM Content | 96,4% | 98,8% |
| UTM Term | 93,6% | 98,9% |
| UTM Source | 43,6% | 49,6% |

Por mês, o **Meta Ad_id** só passa a vir de forma confiável a partir de **agosto de 2025** (jan a jun/2025: praticamente zero; jul/2025: 4%; ago/2025 em diante: 85% a 100%). O **Meta Campaign_id** vem em cerca de 40% dos leads de jan a jul/2025 e em 90%+ depois. Ou seja: **de ago/2025 em diante a ligação por ID é quase completa; antes disso, só a ligação por nome resolve**.

**As UTMs são NOMES, não IDs:** `UTM Campaign` = nome da campanha (ex.: "[Growth] [16] [Misto] [Form Nativo] [CBO] [Sistema Completo…"), `UTM Content` = nome do conjunto de anúncios/público (ex.: "[Growth] [Rmkt Geral 365D]", "[Growth] [Advantage+]") e `UTM Term` = nome do anúncio/criativo (ex.: "AD1 — Cópia", "[Growth] [47] [Vídeo] [CBO]…"). Os nomes **se repetem entre campanhas** ("AD1 — Cópia" aparece em 2.456 leads, em várias campanhas), por isso o termo sozinho **não identifica um anúncio**: é a combinação **Campaign ID + Term** que resolve (é o que você descreveu como método principal).

**Já existe acesso à Meta na sua máquina.** O projeto antigo (`QuarkRH-Dashboard`) tem `.secrets\meta.json` (token e conta de anúncios), scripts que leem insights por campanha e por anúncio (API v21.0) e uma tarefa diária do Windows ("QuarkRH-MetaAdsChangelog") que rodou **hoje às 20:22 com sucesso**, o que indica que o token ainda vale. Ele guarda ~1.800 anúncios na conta. **Não abri nem usei esse token** para este plano.

## 2. O que a documentação atual da Meta diz (consultada em 2026-10-09)

- **Versão:** a mais nova é a **Marketing API v26.0 (29/07/2026)**. Em 27/10/2026 várias remoções valem para todas as versões, mas nenhuma atinge a leitura de insights. A v21.0 (a do projeto antigo) vai até ~jan/2027 (data de fontes secundárias; conferir). **Vamos fixar a versão numa constante, com teste e aviso**, como no Google Ads.
- **Insights API:** relatório por **conta, campanha, conjunto ou anúncio** (`level`), por dia (`time_increment=1`). Campos usados: gasto (`spend`), `impressions`, `reach`, `frequency`, `clicks`, `inline_link_clicks` (cliques no link), `cpm`, `cpc`, `ctr`, `inline_link_click_ctr`, `cost_per_inline_link_click`, `actions` (inclui `link_click`, `landing_page_view` e `lead`) e os de vídeo: `video_play_actions`, `video_p25/p50/p75/p95/p100_watched_actions`, `video_thruplay_watched_actions`, `video_avg_time_watched_actions`. Restrições: os campos de vídeo **não podem ser pedidos com breakdown por hora**; combinações de breakdown têm limites. Os nomes exatos serão **confirmados na própria conta antes de cada relatório** (a página do esquema veio parcial na consulta de hoje).
- **Não existem na Meta como métricas prontas** (viram colunas calculadas, com fórmula escrita na tela): **Connect Rate** = `landing_page_view ÷ inline_link_clicks` (exige o Pixel); **Hook rate** = visualizações de 3 segundos ÷ impressões; **Hold rate** = ThruPlays ÷ visualizações de 3 segundos; **Retenção** = parte de quem começou o vídeo que chegou a 25%, 50%, 75%, 95% e 100% (`p25…p100 ÷ video_play`). "View rate" e "retention rate" têm mais de uma definição no mercado: **a tela mostrará a fórmula usada** e você escolhe.
- **Limites:** vale a cota por conta de anúncios ("Business Use Case", o balde `ads_insights`, medida por hora e devolvida nos cabeçalhos `X-Business-Use-Case-Usage` e `X-Ad-Account-Usage`; erros 80000, 80003, 80004 e 80014 indicam limite). Apps no nível "desenvolvimento" têm cota bem menor que no "padrão". Plano: poucas requisições por rodada, **espera crescente e parada limpa** ao chegar perto do limite (mesma lógica da trava de 40% do Pipedrive).
- **Retenção dos dados na Meta:** os insights detalhados têm janela limitada (cerca de 37 meses), então **2025-01-01 em diante cabe**. Conversões atribuídas (leads) podem ser reajustadas por até 28 dias: a sincronização **relê os últimos 28 dias** de cada rodada.

## 3. O que vamos trazer

**Estrutura (mudou pouco, 1 linha por item):** campanhas (ID, nome, objetivo, status, orçamento), conjuntos de anúncios (ID, nome, campanha, status, orçamento, **público/otimização**) e anúncios (ID, nome, conjunto, campanha, status, **ID do criativo**, miniatura, **`url_tags` (as UTMs que o anúncio manda)**).

**Desempenho por anúncio e por dia** (campanha e conjunto saem por soma, sem guardar de novo): gasto, impressões, alcance, cliques, cliques no link, CPM, CPC, CTR, visitas à página (landing page views), leads da Meta, reproduções de vídeo, 3 segundos, 25/50/75/95/100%, ThruPlay e tempo médio assistido. Calculados na tela: **CPM, CPC, CTR, Connect Rate, Hook rate, Hold rate, retenção por quartil, custo por lead da Meta e custo por etapa do CRM** (lead, MQL, SQL, Reunião Agendada, proposta e ganho).

## 4. Como ligar à base do Pipedrive (3 métodos, em ordem)

| # | Método | Chave | Cobertura esperada |
|---|---|---|---|
| 1 | **Principal: IDs** | `Meta Ad_id` do negócio = ID do anúncio na Meta | ~98% (2026); 85 a 100% de ago/2025 em diante |
| 2 | **Campaign ID + Term** | `Meta Campaign_id` + `UTM Term` (nome do anúncio) = anúncio **dentro daquela campanha** | complementa onde falta o Ad_id e o Campaign_id existe (jan a jul/2025: ~40%) |
| 3 | **Por nome** | `UTM Campaign` = nome da campanha, `UTM Content` = nome do conjunto, `UTM Term` = nome do anúncio (comparação sem diferenciar maiúsculas/espaços) | o que sobra; ambíguo quando o nome se repete |

Cada negócio guarda **qual método o ligou** (`ad_id`, `campanha_id+term`, `nome`, ou `sem_ligacao`) e um **grau de certeza**; quando o nome bate com mais de um anúncio, a ligação é marcada como **ambígua** e **não** entra na soma de um anúncio só (em vez de chutar). A tela de **cobertura** mostra, por mês, quantos leads ligaram por cada método e quantos ficaram sem ligação, e por quê. Os leads "Form Nativo" têm também o `Meta Lead_id` e o `Meta Form_id` guardados (úteis para conferir o formulário).

## 5. Tabelas propostas (nada aplicado)

Seguem o padrão do `mkt`: papel `orq_sync` grava, `orq_panel` e `orq_chat` só leem **visões**; RLS em tudo; sem DELETE.

- `mkt.meta_campanhas`, `mkt.meta_conjuntos`, `mkt.meta_anuncios` (estrutura, com o nome e o nome normalizado, ID do criativo e `url_tags`).
- `mkt.meta_ads_dia` (por anúncio e dia: as métricas acima como colunas numéricas; só dias com impressões).
- Visões em `analytics`: `meta_desempenho_dia` (já com CPM, CPC, CTR, Connect, hook, hold e retenção), `negocios_meta` (cada negócio com anúncio, conjunto, campanha, método e certeza da ligação), `meta_cobertura`.
- Os mapeamentos **DOR, Mensagem e Módulo** (D-51) passam a poder ser aplicados também por **ID de anúncio** (hoje é pelo nome do termo), o que resolve os nomes repetidos.

**Espaço (o banco está em ~225 MB de 500 MB):** estimativa **de 35 a 60 MB** (~150 a 300 mil linhas de anúncio por dia). **Vamos medir antes de fechar**: se passar de 60 MB, os anúncios mais antigos que 12 meses ficam por **semana** (com a sua aprovação). Sem JSON repetido: guardam-se só as colunas que usamos.

## 6. Credenciais e segurança (sem segredo no chat)

- Precisamos de um **token de leitura** (`ads_read`) e do **ID da conta de anúncios** (`act_…`; se a QuarkClinic tiver outra conta, o ID dela também). O ideal é um **usuário de sistema** do Business Manager (o token não expira como o de usuário comum, que dura ~60 dias). **Reaproveitar o do projeto antigo é possível:** um script copia `.secrets\meta.json` para o `.env.local` **sem mostrar nada na tela**, e testamos a leitura. Se ele for de usuário comum, ele expira e a automação de 4 em 4 horas pararia: aí criamos o de usuário de sistema (roteiro de 5 cliques).
- O token fica só no `.env.local` e (com a sua autorização) nos segredos do GitHub, como o do Pipedrive. A sincronia só lê.

## 7. Entregas (compactas; cada uma só termina com a definição de pronto e o "conferido")

| # | Entrega | Esforço |
|---|---|---|
| M1 | **Conexão e estrutura:** credencial, leitura de campanhas, conjuntos e anúncios, medição de volume | ~0,5 dia |
| M2 | **Insights por anúncio e dia desde 2025-01-01** (custo e desempenho) com conferência contra o Gerenciador de Anúncios | ~1 dia |
| M3 | **Métricas de vídeo** (3s, quartis, ThruPlay, tempo médio) e as taxas calculadas | ~0,5 dia |
| M4 | **Ligação com o Pipedrive** pelos 3 métodos, certeza, ambiguidade e tela de cobertura | ~1 dia |
| M5 | **Página "Meta Ads" no BI:** visão geral, mês a mês, por campanha, conjunto e criativo, funil e custo por etapa, vídeo e retenção, com os KPIs de MRR e com DOR/Mensagem/Módulo | ~1 dia |
| M6 | **Entra na sincronia de 4 em 4 horas** (releitura de 28 dias) e no conector do Claude | ~0,5 dia |

Total: **cerca de 4 dias de trabalho** depois de ter a credencial. O que mais atrasa é a credencial e as suas confirmações.

## 8. O que preciso do Pablo

1. **Aprovar o plano** e a ordem M1 a M6.
2. **Autorizar reaproveitar o token do projeto antigo** (eu o copio para o `.env.local` por script, sem mostrar, e testo a leitura) **ou** criar um de usuário de sistema.
3. O(s) **ID(s) da conta de anúncios** (QuarkRH e QuarkClinic são a mesma conta?).
4. **Período:** desde 2025-01-01, como no resto? (os leads de 2024 têm UTMs, mas quase nenhum ID)
5. **Definições** das taxas, se quiser trocar: Connect Rate = visitas à página ÷ cliques no link; Hook rate = 3 s ÷ impressões; Hold rate = ThruPlay ÷ 3 s; retenção por quartil ÷ reproduções.
6. **Quebras** (plataforma/posicionamento, idade, gênero): por padrão **não**, porque multiplicam as linhas; digo o volume antes se você quiser.

## 9. Riscos

- **Ligação por nome é ambígua** (nomes repetidos, nomes que mudam depois do clique): por isso marcamos método e certeza e não somamos ambíguos.
- **Antes de ago/2025** não há ID do anúncio no Pipedrive: o histórico de 2025 dependerá da ligação por nome.
- **Conversões da Meta mudam por até 28 dias**; **Connect Rate depende do Pixel**.
- **Versão da API** muda: constante fixa e aviso. **Cota por conta**: poucas requisições e parada limpa.
- **Token de usuário comum expira** (~60 dias): preferir usuário de sistema.
- **Espaço:** medir antes; semanalizar o antigo se preciso.
