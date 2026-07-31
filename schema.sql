-- Spy-Analytics — schema Postgres (Supabase).
--
-- Migracao Neon -> Supabase (decisao do operador): o Spy-Analytics passou a ter projeto Supabase
-- PROPRIO, dedicado, nao mais compartilhado com o painel NGV. Nao ha mais "de quem isolar" —
-- a app conecta com o role padrao/dono do projeto (ver api/_db.js e README.md), que enxerga o
-- banco inteiro, porque o banco inteiro e deste produto.
--
-- kiss: as 3 tabelas continuam no schema "spy" em vez de "public". Isso sobrou da fase em que
-- este Postgres era compartilhado com o painel NGV (schema proprio + role restrito isolavam os
-- dois produtos no mesmo banco — ver git log anterior a esta migracao). Num projeto dedicado o
-- schema separado e dispensavel, mas o codigo ja tem 14 queries testadas e validadas com o
-- prefixo "spy." (api/*.js) — remover seria retrabalho puro, sem ganho de seguranca ou
-- performance. Upgrade futuro, se algum dia fizer sentido: migration `alter table spy.x set
-- schema public` + tirar o prefixo das queries.
--
-- Exposicao via Data API (PostgREST): por padrao o Supabase so serve, via API REST/GraphQL, os
-- schemas listados em "Exposed schemas" (Project Settings > API) — de fabrica so "public" e
-- "graphql_public". Manter as tabelas em "spy" e NUNCA adicionar "spy" a essa lista ja tira este
-- banco do alcance de quem so tem a anon key. Esta app nem tem anon key: as Vercel Functions
-- conectam direto no Postgres via connection string (ver api/_db.js) — nunca pela Data API. RLS
-- abaixo (sem nenhuma policy) e defesa em profundidade pro mesmo risco, caso "spy" algum dia
-- entre na lista de schemas expostos por engano: nega tudo pra role sem bypassrls (anon/
-- authenticated), e nao afeta esta app porque ela conecta com o role dono das tabelas (dono
-- ignora RLS por padrao no Postgres, a nao ser que a tabela tenha FORCE ROW LEVEL SECURITY, que
-- nao usamos aqui). Nao verificado contra um projeto Supabase real — a lista de "Exposed
-- schemas" e configuracao do dashboard, fora do alcance deste arquivo SQL.
--
-- Idempotente: seguro rodar de novo (IF NOT EXISTS / ON CONFLICT DO NOTHING em tudo).
-- Referencia: ADR-001 secao 3, COM a correcao verificada pelo pvs-master:
--   o UNIQUE de nome de oferta e case-insensitive (indice funcional em lower(nome)),
--   porque o app compara nomes em minusculas (index.html linhas 1097 e 1157) —
--   um UNIQUE(nome) cru do Postgres deixaria "Protocolo X" e "protocolo x" conviverem
--   no banco como duas ofertas diferentes, o que o app nunca permite.

create schema if not exists spy;

create table if not exists spy.ofertas (
  id text primary key,                 -- mantem o uid() ja gerado no client (Date.now().toString(36)+sufixo)
  nome text not null,
  formato text,
  nicho text,
  idioma text,
  link text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Unico case-insensitive — ver nota acima. Sem UNIQUE cru na coluna nome.
create unique index if not exists ofertas_nome_unico on spy.ofertas (lower(nome));

create table if not exists spy.leituras (
  id text primary key,                 -- idem: uid() gerado no client
  oferta_id text not null references spy.ofertas(id) on delete cascade,
  data date not null,
  periodo text not null check (periodo in ('manha', 'noite')),
  ads integer not null check (ads >= 0),
  atualizado_em timestamptz not null default now(),
  unique (oferta_id, data, periodo)    -- chave de negocio: resolve a corrida de 2 pessoas
                                        -- lancando a mesma leitura quase ao mesmo tempo (ADR-001 secao 3)
);

-- kiss: sem indice em (data) — paginar/indexar mais so se o volume de leituras crescer muito (ADR-001 secao 3).
create index if not exists leituras_oferta_id_idx on spy.leituras (oferta_id);

create table if not exists spy.config (
  id integer primary key default 1,
  pesos jsonb not null default '{"estab":45,"vol":30,"tempo":25}'::jsonb,
  tolerancia integer not null default 20,
  atualizado_em timestamptz not null default now(),
  check (id = 1)                        -- singleton: config do TIME inteiro, sempre uma unica linha
);

insert into spy.config (id, pesos, tolerancia)
values (1, '{"estab":45,"vol":30,"tempo":25}'::jsonb, 20)
on conflict (id) do nothing;

-- RLS sem nenhuma policy — nega tudo pra role sem bypassrls (anon/authenticated via Data API).
-- Ver nota no topo do arquivo: defesa em profundidade, nao afeta esta app (conecta com o role
-- dono das tabelas). ALTER ... ENABLE nao falha se ja estiver habilitada — idempotente como o
-- resto do arquivo.
alter table spy.ofertas enable row level security;
alter table spy.leituras enable row level security;
alter table spy.config enable row level security;
