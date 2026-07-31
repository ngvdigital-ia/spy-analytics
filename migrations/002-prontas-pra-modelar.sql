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
-- GRANT: nenhum necessário. setup-role.sql já concede
-- "alter default privileges in schema spy grant select, insert, update, delete on tables to
-- spy_app" — cobre a coluna nova automaticamente (é grant de tabela, não de coluna). A view é
-- objeto novo dentro de "spy", mas SELECT em view exige que o dono da view (postgres, quem roda
-- este arquivo) tenha USAGE nas tabelas de base — que ele tem (é dono). spy_app só precisa de
-- SELECT na própria view: como a view não existia quando "alter default privileges" rodou em
-- setup-role.sql, o grant automático não a cobre — roda-se manualmente uma vez:
--   grant select on spy.ofertas_prontas_pra_modelar to spy_app;
-- (ver rodapé deste arquivo — não faz parte do bloco idempotente acima porque GRANT em view não
-- tem "IF NOT EXISTS"; rodar de novo não quebra, só reconcede o mesmo privilégio.)
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

-- Rodar manualmente, uma vez, depois de criar a view acima (não é parte do bloco idempotente
-- porque GRANT em view não tem sintaxe "IF NOT EXISTS" — reexecutar não quebra, só reconcede):
--   grant select on spy.ofertas_prontas_pra_modelar to spy_app;
