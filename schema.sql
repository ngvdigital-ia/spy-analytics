-- Spy-Analytics — schema Postgres.
-- Decisao do operador: em vez de um projeto Neon novo e isolado, o Spy-Analytics passou a usar o
-- MESMO banco Postgres do banco-de-dados-ngv (Neon, store Banco_de_dados_NGV, projeto com dados
-- de receita do painel de marketing). O isolamento entre os dois produtos vem de duas camadas:
--   1) as 3 tabelas vivem num schema PROPRIO ("spy"), nunca em "public" (onde mora o painel NGV);
--   2) a app conecta com um ROLE restrito (spy_app, ver setup-role.sql) que nao enxerga "public".
-- Este arquivo so cria objetos NOVOS dentro do schema "spy" — nunca toca em "public" nem em
-- qualquer objeto existente do painel NGV.
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
