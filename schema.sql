-- Spy-Analytics — schema Postgres (Supabase, projeto COMPARTILHADO "apps-ofertas").
--
-- Migracao Neon -> Supabase, e depois DE VOLTA pra banco compartilhado (decisao do operador):
-- criar um projeto Supabase dedicado custa US$ 10/mes na organizacao dele. Em vez de pagar, o
-- Spy-Analytics reusa o projeto "apps-ofertas" (project ref sqzdzhktknfpuaorehnh, sa-east-1) —
-- que TEM tabelas de compra/acesso de cliente real em "public" (confirmado antes desta migracao:
-- 116 compras, 110 acessos). Ha de novo "de quem isolar": a app NAO pode conectar com o role
-- "postgres" (dono do projeto, enxerga o banco inteiro) — conecta com um role novo, restrito,
-- criado em setup-role.sql (ver esse arquivo — volta a existir, foi removido quando o projeto
-- ainda seria dedicado). Ordem de execucao: este arquivo (schema.sql) primeiro, setup-role.sql
-- depois — setup-role.sql cria policies de RLS que exigem o role "spy_app" ja existir, entao a
-- ordem inversa quebra.
--
-- kiss: as 3 tabelas ficam no schema "spy" em vez de "public" — agora com motivo REAL de novo:
-- isolar do "public" do apps-ofertas, que tem as tabelas de compra. (Entre as duas migracoes,
-- quando o plano era projeto dedicado, o schema separado tinha virado so um namespace sem funcao
-- de seguranca — ver git log. Essa fase acabou.) O codigo ja tem 14 queries testadas e validadas
-- com o prefixo "spy." (api/*.js) — manter o schema evita reescrever tudo, e agora tem ganho real
-- de seguranca alem do zero-retrabalho.
--
-- Exposicao via Data API (PostgREST): por padrao o Supabase so serve, via API REST/GraphQL, os
-- schemas listados em "Exposed schemas" (Project Settings > API) — de fabrica so "public" e
-- "graphql_public". O apps-ofertas com certeza tem a API REST ativa (serve o app de ofertas em
-- producao). Manter as tabelas do Spy em "spy" e NUNCA adicionar "spy" a essa lista tira este
-- schema do alcance de quem so tem a chave anon/authenticated do apps-ofertas. Esta app nem usa
-- chave anon/service_role: as Vercel Functions conectam direto no Postgres via connection string
-- (ver api/_db.js), como o role "spy_app" — nunca pela Data API.
--
-- RLS abaixo: aqui e LINHA DE FRENTE, nao so defesa em profundidade (diferenca do periodo em que
-- o projeto seria dedicado). Motivo: spy_app NAO e dono das tabelas (quem roda este arquivo e o
-- role "postgres", que fica dono) — sem uma policy que autorize spy_app explicitamente, RLS
-- habilitada bloquearia a PROPRIA app, nao so um acesso indevido de fora. As policies que
-- autorizam spy_app ficam em setup-role.sql (nao aqui): "create policy ... to spy_app" exige que
-- o role "spy_app" ja exista, e este arquivo roda ANTES do role ser criado — por isso a
-- responsabilidade se divide: schema.sql habilita RLS (deny-all por padrao), setup-role.sql cria
-- o role e as policies que abrem excecao SO pra ele. Entre rodar este arquivo e rodar
-- setup-role.sql, as 3 tabelas ficam com RLS habilitada e ZERO policy — ninguem sem BYPASSRLS
-- consegue ler/escrever nelas, o que e seguro (nao ha app apontando pra ca ainda nesse intervalo).
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

-- RLS habilitada, SEM policy aqui — nega tudo, pra qualquer role, ate setup-role.sql criar a
-- policy que autoriza spy_app (ver nota longa no topo do arquivo pra por que a policy nao mora
-- aqui). Bloqueia anon/authenticated (Data API do apps-ofertas, caso "spy" entre por engano nos
-- "Exposed schemas") E bloqueia spy_app ate a policy dele existir — as duas coisas sao esperadas
-- e seguras nesse intervalo. ALTER ... ENABLE nao falha se ja estiver habilitada — idempotente
-- como o resto do arquivo.
alter table spy.ofertas enable row level security;
alter table spy.leituras enable row level security;
alter table spy.config enable row level security;
