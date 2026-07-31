-- Spy-Analytics — role restrito ao schema "spy".
--
-- POR QUE ESTE ARQUIVO EXISTE (leia antes de rodar):
-- O Spy-Analytics agora roda no MESMO banco Postgres do banco-de-dados-ngv (Neon, store
-- Banco_de_dados_NGV — tem dados de receita do painel de marketing). Schema separado ("spy",
-- ver schema.sql) NAO e isolamento por si so: se a app conectar com o MESMO usuario que o painel
-- NGV usa, ela enxerga e pode apagar QUALQUER tabela do banco inteiro, painel incluso. O
-- isolamento real vem deste arquivo: um role novo (spy_app) que so recebe grant dentro do schema
-- "spy" — nunca em "public". Como o Postgres nao concede privilegio de objeto automaticamente a
-- role nova nenhuma, isso ja bloqueia spy_app nas tabelas do painel NA PRATICA (testado em
-- Postgres 16 local). Ha UM caso de borda que este arquivo NAO fecha sozinho — ver passo 6 no
-- rodape: tabela de "public" com grant explicito pro pseudo-role PUBLIC do Postgres. Leia o
-- passo 6 e rode a checagem antes de considerar o isolamento fechado.
--
-- TUDO abaixo e ADITIVO — cria o role spy_app e concede/revoga permissoes SO PARA ELE. Nenhum
-- comando aqui toca em objeto existente, em outro role, ou em qualquer coisa fora do schema "spy"
-- e do role "spy_app". Nao ha REVOKE ... FROM PUBLIC (o pseudo-role especial do Postgres que
-- afetaria todo mundo) nem ALTER DEFAULT PRIVILEGES global — so "IN SCHEMA spy".
--
-- QUEM RODA E QUANDO: um humano, manualmente, uma unica vez, conectado como o role ADMIN/DONO do
-- banco (o mesmo usado para rodar schema.sql) — NUNCA a IA. Depois de rodar schema.sql (que cria
-- o schema "spy" e as tabelas). Ordem: schema.sql primeiro, setup-role.sql depois.
--
-- SENHA: a linha abaixo tem um PLACEHOLDER obvio. Troque 'TROQUE_ESTA_SENHA_ANTES_DE_RODAR' por
-- uma senha forte gerada por voce (ex.: `openssl rand -base64 24`) ANTES de executar este arquivo.
-- Este arquivo nunca deve ser commitado com uma senha real.

-- 1) Cria o role, so se ainda nao existir (idempotente — rodar de novo nao quebra).
--    Se o role ja existe e voce quer TROCAR a senha, rode separadamente:
--      ALTER ROLE spy_app WITH PASSWORD 'nova-senha-aqui';
do $$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'spy_app') then
    create role spy_app with login password 'TROQUE_ESTA_SENHA_ANTES_DE_RODAR';
  end if;
end
$$;

-- 2) Acesso ao schema "spy": USAGE pra enxergar os objetos, CREATE pra a propria app poder
--    rodar migrações futuras (ex.: um novo schema.sql que adiciona tabela) sem precisar de um
--    role mais privilegiado.
grant usage, create on schema spy to spy_app;

-- 3) Acesso as tabelas que schema.sql ja criou. Sem grant em sequence porque nenhuma tabela do
--    Spy-Analytics usa coluna serial/identity hoje (ids sao gerados no client) — se isso mudar
--    no futuro, o ALTER DEFAULT PRIVILEGES abaixo ja cobre sequences novas.
grant select, insert, update, delete on all tables in schema spy to spy_app;

-- 4) Tabela nova que o ADMIN criar dentro de "spy" no futuro (rodando outro schema.sql, por
--    exemplo) ja nasce com o grant certo pro spy_app, sem precisar lembrar de rodar isto de novo.
--    Escopo e SO o schema spy — nao e global, nao afeta objeto em outro schema.
alter default privileges in schema spy grant select, insert, update, delete on tables to spy_app;
alter default privileges in schema spy grant usage, select on sequences to spy_app;

-- 5) Revoga de spy_app qualquer privilegio que TENHA SIDO CONCEDIDO DIRETAMENTE a ele no schema
--    "public" (defensivo — hoje nao existe nenhum, mas protege contra alguem um dia rodar um
--    GRANT solto pro spy_app em public por engano). IMPORTANTE, testado em Postgres 16 local:
--    isto NAO revoga o acesso que spy_app herda do pseudo-role PUBLIC do Postgres (o schema
--    "public" nasce com USAGE concedido a PUBLIC = "qualquer role, sempre") — REVOKE ... FROM
--    <role> so remove grant feito DIRETO pra aquele role, nunca subtrai o que vem de PUBLIC. Pra
--    tirar isso seria preciso "REVOKE ... FROM PUBLIC", que e proibido aqui por afetar TODOS os
--    roles do banco (efeito colateral fora do escopo deste arquivo) — ver aviso no passo 6.
revoke all on schema public from spy_app;

-- 6) CHECAGEM DE RISCO RESIDUAL (leitura apenas, zero efeito colateral — rode e leia o resultado
--    antes de considerar o isolamento fechado). Testado em Postgres 16 local: se ALGUMA tabela em
--    "public" tiver um GRANT explicito pro PUBLIC (comum em bancos configurados sem cuidado no
--    passado), spy_app CONSEGUE ler/escrever nela mesmo depois do REVOKE do passo 5 — porque esse
--    acesso vem do pseudo-role PUBLIC, nao de um grant direto ao spy_app, e este arquivo
--    deliberadamente NAO toca no pseudo-role PUBLIC (isso teria efeito em todo mundo no banco,
--    inclusive no proprio painel NGV — fora do escopo que este arquivo pode alterar sozinho).
--
--   select table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and grantee = 'PUBLIC';
--
--   Se essa query nao devolver nenhuma linha (caso comum e esperado): nao ha risco residual, o
--   isolamento por ausencia de grant (Postgres nao concede privilegio de objeto automaticamente
--   a role nova nenhuma) ja protege os dados do painel na pratica.
--
--   Se devolver alguma linha: e uma DECISAO SUA, nao da IA, com dois caminhos possiveis —
--     (a) escopado e mais seguro: `revoke <privilegio> on public.<essa_tabela> from public;`
--         (tira o grant so daquela tabela, nao mexe em mais nada);
--     (b) global: `revoke all on schema public from public;` (fecha USAGE ambiente pra todo
--         role do banco — pode quebrar algo que hoje depende desse acesso implicito; avalie com
--         cuidado antes, idealmente testando primeiro num banco de teste).

-- ---------------------------------------------------------------------------------------------
-- VERIFICACAO (rode manualmente depois, leitura apenas — nao faz parte do setup):
--
--   \du spy_app                    -- confirma que o role existe e NAO tem atributos extra (superuser, etc.)
--   \dn+ spy                       -- confirma os privilegios do schema spy
--   \dp spy.*                      -- confirma os grants tabela a tabela
--
-- TESTE NEGATIVO (prova que o isolamento funciona — troque <alguma_tabela_do_painel> pelo nome
-- real de uma tabela do painel NGV em "public"; espera-se erro de permissao):
--
--   set role spy_app;
--   select 1 from public.<alguma_tabela_do_painel> limit 1;   -- ESPERADO: permission denied
--   reset role;
--
-- TESTE POSITIVO (dentro do schema spy funciona normalmente):
--
--   set role spy_app;
--   select count(*) from spy.ofertas;                          -- ESPERADO: funciona (0 linhas se banco novo)
--   reset role;
-- ---------------------------------------------------------------------------------------------
