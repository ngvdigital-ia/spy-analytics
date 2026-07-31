-- migrations/002-prontas-pra-modelar.sql
-- ADR-002 — aba "Prontas pra modelar" + notificação Slack.
--
-- Regra (Diogo, confirmada verbatim): oferta entra na aba/notificação quando, olhando o
-- histórico inteiro de spy.leituras dela:
--   (a) tem leituras em >= 7 dias DISTINTOS (dia com leitura conta, não par manhã+noite —
--       oferta com leitura só de manhã em todos os dias também qualifica);
--   (b) a última leitura (mais recente no tempo, noite desempata sobre manhã no mesmo dia)
--       tem MAIS de 100 anúncios (estrito: 100 não entra, 101 entra);
--   (c) a última leitura é MAIS que a metade da primeira leitura (estrito: exatamente metade
--       não entra) — usamos "ultima*2 > primeira" em vez de "ultima > primeira/2" pra nunca
--       depender de arredondamento/divisão inteira do Postgres (ambos os lados são inteiros).
-- A régua atual do app (traduzir / candidata forte / observar / descartar + escalando/saiu de
-- escala) fica INTOCADA — mora só no client (index.html) e não é tocada por esta migration. A
-- regra nova é outra coisa, calculada aqui, e alimenta só a aba nova e o cron de notificação.
--
-- ONDE A REGRA MORA: só nesta view (spy.ofertas_prontas_pra_modelar). GET /api/estado (aba) e
-- api/cron-prontas.js (notificação) consomem a MESMA view — nenhum dos dois reimplementa a
-- regra em JS. A view já devolve as colunas que o cron precisa pra montar a mensagem do Slack
-- (dias_distintos, ads/data da primeira e da última leitura), então uma 2ª query no cron não
-- duplica a lógica de filtro, só usa o resultado.
--
-- MEMÓRIA DE "JÁ NOTIFIQUEI": 2 colunas 1:1 em spy.ofertas (não tabela separada — não há
-- histórico multi-linha pedido, YAGNI).
--   pronta_pra_modelar   snapshot da última execução do cron — usado pra detectar TRANSIÇÃO de
--                        entrada (estava false, entrou na view = notifica). Sair da view zera
--                        pra false SEM notificar (saída não foi pedida). Requalificar depois de
--                        sair é nova transição de entrada = notifica de novo (intencional).
--   pronta_notificada_em quando a notificação foi enviada com sucesso. Fica NULL se nunca
--                        notificou, ou se a última tentativa falhou (falha de envio ou
--                        SLACK_WEBHOOK_URL ausente NUNCA marca pronta_pra_modelar=true — ver
--                        api/cron-prontas.js — fica pendente pro próximo cron).
--
-- Aditivo e idempotente (mesmo padrão de migrations/001-cloaker-tipo-produto.sql):
-- ADD COLUMN IF NOT EXISTS não falha se já rodou antes; CREATE OR REPLACE VIEW idem.
-- NOT NULL DEFAULT false em pronta_pra_modelar é seguro pra oferta já existente: nasce "não
-- pronta", e o próximo cron corrige pro estado real na primeira execução.
--
-- GRANT: NENHUM PASSO MANUAL É NECESSÁRIO — medido no apps-ofertas real em 2026-07-31, DEPOIS
-- de aplicar esta migration:
--   has_table_privilege('spy_app','spy.ofertas_prontas_pra_modelar','SELECT') = true
--   e, conectado de fato como spy_app pelo pooler: leu a view, leu e ESCREVEU nas 2 colunas novas.
--
-- Correção de uma premissa que este arquivo afirmava antes: "ALTER DEFAULT PRIVILEGES ... ON
-- TABLES" do setup-role.sql **cobre VIEW também**, não só tabela — no Postgres, "TABLES" nesse
-- comando abrange table, view, materialized view e foreign table. Como a view é criada pelo mesmo
-- role que rodou o ALTER DEFAULT PRIVILEGES (postgres), spy_app recebe SELECT automaticamente.
--
-- O que NÃO seria coberto (pra quem vier depois): view criada por OUTRO role que não o que
-- executou o ALTER DEFAULT PRIVILEGES. Nesse caso — e só nesse — seria preciso o grant explícito.
-- Não invente o passo manual "por segurança": rodar GRANT desnecessário confunde quem lê depois e
-- sugere que o isolamento depende de alguém lembrar, quando não depende.
--
-- Aplicar manualmente (Supabase MCP / SQL editor), depois de 001 já ter rodado — NAO rodar via
-- este agente contra o banco real.

alter table spy.ofertas add column if not exists pronta_pra_modelar boolean not null default false;
alter table spy.ofertas add column if not exists pronta_notificada_em timestamptz;

create or replace view spy.ofertas_prontas_pra_modelar as
with leituras_ordenadas as (
  select
    oferta_id, data, periodo, ads,
    -- ordem cronológica: no mesmo dia, manhã (false) vem antes de noite (true) — mesmo
    -- critério do client (index.html, ordemLeitura: data + 'A'/'B').
    row_number() over (partition by oferta_id order by data asc, (periodo = 'noite') asc) as rn_primeira,
    row_number() over (partition by oferta_id order by data desc, (periodo = 'noite') desc) as rn_ultima
  from spy.leituras
),
primeira as (
  select oferta_id, data as data_primeira, ads as ads_primeira
  from leituras_ordenadas where rn_primeira = 1
),
ultima as (
  select oferta_id, data as data_ultima, ads as ads_ultima
  from leituras_ordenadas where rn_ultima = 1
),
dias as (
  -- dia com leitura conta, não par manhã+noite — count(distinct data) ignora quantas leituras
  -- teve naquele dia.
  select oferta_id, count(distinct data) as dias_distintos
  from spy.leituras
  group by oferta_id
)
select
  o.id as oferta_id, o.nome, o.formato, o.nicho, o.idioma, o.link,
  d.dias_distintos, p.data_primeira, p.ads_primeira, u.data_ultima, u.ads_ultima
from spy.ofertas o
join dias d on d.oferta_id = o.id       -- inner join: oferta sem leitura nenhuma some da view,
join primeira p on p.oferta_id = o.id   -- não quebra (não há linha em leituras_ordenadas pra ela
join ultima u on u.oferta_id = o.id     -- em nenhuma das 3 CTEs).
where d.dias_distintos >= 7
  and u.ads_ultima > 100
  and u.ads_ultima * 2 > p.ads_primeira; -- "ultima > primeira/2" sem divisão (ambos inteiros)

-- NÃO há passo manual depois desta migration. O GRANT que este rodapé mandava rodar mostrou-se
-- desnecessário quando medido no banco real (ver nota longa no topo do arquivo): o
-- "ALTER DEFAULT PRIVILEGES ... ON TABLES" de setup-role.sql já cobre a view, e spy_app leu e
-- escreveu de fato, conectado pelo pooler, logo após aplicar isto.
