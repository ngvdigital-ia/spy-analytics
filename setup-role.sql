-- Spy-Analytics — role restrito ao schema "spy", agora no projeto Supabase compartilhado
-- "apps-ofertas" (project ref sqzdzhktknfpuaorehnh, sa-east-1).
--
-- POR QUE ESTE ARQUIVO EXISTE (leia antes de rodar):
-- Criar um projeto Supabase novo custa US$ 10/mes na organizacao do operador. Decisao dele: em
-- vez de pagar por um banco dedicado, o Spy-Analytics reusa o projeto Supabase "apps-ofertas" —
-- que TEM tabelas de compra de cliente real em "public" (116 compras, 110 acessos, confirmado
-- antes desta migracao). Schema separado ("spy", ver schema.sql) NAO e isolamento por si so: se a
-- app conectar com o MESMO usuario que o apps-ofertas usa (o role "postgres", dono do projeto),
-- ela enxerga e pode apagar QUALQUER tabela do banco inteiro, compras inclusas. O isolamento real
-- vem deste arquivo: um role novo (spy_app) que so recebe grant dentro do schema "spy" — nunca em
-- "public". Como o Postgres nao concede privilegio de objeto automaticamente a role nova nenhuma,
-- isso ja bloqueia spy_app nas tabelas de "public" NA PRATICA. Ha UM caso de borda que este
-- arquivo NAO fecha sozinho — ver passo 7 no rodape: tabela de "public" com grant explicito pro
-- pseudo-role PUBLIC do Postgres. Leia o passo 7 e rode a checagem antes de considerar o
-- isolamento fechado.
--
-- SUPABASE TEM ROLES PROPRIOS — leia antes de mexer em qualquer GRANT/REVOKE aqui.
-- Um projeto Supabase ja vem com: `postgres` (dono do projeto, usado pelo Dashboard/SQL Editor e
-- por ferramentas externas), `anon`/`authenticated`/`service_role` (usados pela Data API/
-- PostgREST — sao os roles que a chave anon/service_role assume), `supabase_admin`,
-- `authenticator`, `supabase_auth_admin`, `supabase_storage_admin`, `supabase_replication_admin`
-- (internos dos servicos gerenciados). NENHUM desses e tocado por este arquivo — nem GRANT nem
-- REVOKE neles. "spy_app" e um role NOVO, sem relacao de heranca com nenhum deles (nunca usa
-- INHERIT/IN ROLE), pra nao herdar acidentalmente um privilegio de outro role no futuro.
--
-- CRIAR ROLE CUSTOM E PERMITIDO em projeto gerenciado Supabase — nao ha bloqueio. Confirmado na
-- doc oficial (blog "Postgres Roles and Privileges", supabase.com/blog/postgres-roles-and-privileges):
-- o proprio time da Supabase demonstra `create role junior_dev login password '...'` rodado como
-- o role "postgres" (o mesmo que o SQL Editor do Dashboard usa) num projeto gerenciado real. Este
-- arquivo faz exatamente isso pra "spy_app".
--
-- CONEXAO PELO POOLER COM ROLE CUSTOM — a pergunta que decidia se este plano funciona. RESPOSTA:
-- FUNCIONA. O Supavisor (pooler do Supabase, portas 5432 modo session / 6543 modo transaction)
-- roteia por TENANT usando o formato de usuario "<role>.<project-ref>" — nao existe restricao ao
-- role literal "postgres" nesse formato. A mesma doc oficial acima mostra, depois de criar
-- junior_dev, conectando com:
--   psql postgres://junior_dev.[YOUR-PROJECT-REF]:[SENHA]@[REGIAO].pooler.supabase.com:5432/postgres
-- Os docs gerais de connection string (supabase.com/docs/guides/database/connecting-to-postgres)
-- confirmam que o formato de usuario "<role>.<ref>" e o MESMO nos dois modos do Supavisor — a
-- unica diferenca entre modo session (5432) e transaction (6543) e a porta, nunca o formato do
-- usuario. Logo, pra este app (Vercel Functions, serverless — precisa do modo transaction), a
-- connection string do spy_app fica:
--   postgresql://spy_app.sqzdzhktknfpuaorehnh:<SENHA-DO-SPY_APP>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
-- (Region "aws-0-sa-east-1" a confirmar no Dashboard > Connect do projeto — o padrao da doc geral
-- e "aws-0-<regiao>", mas o numero exato do subdominio so o Dashboard do projeto real mostra.)
--
-- TUDO abaixo e ADITIVO — cria o role spy_app e concede/revoga permissoes SO PARA ELE. Nenhum
-- comando aqui toca em objeto existente de "public", em outro role do Supabase, ou em qualquer
-- coisa fora do schema "spy" e do role "spy_app". Nao ha REVOKE ... FROM PUBLIC (o pseudo-role
-- especial do Postgres que afetaria todo mundo, inclusive anon/authenticated da Data API) nem
-- ALTER DEFAULT PRIVILEGES global — so "IN SCHEMA spy".
--
-- QUEM RODA E QUANDO: um humano, manualmente, uma unica vez, conectado como o role "postgres" do
-- projeto apps-ofertas (Dashboard > SQL Editor, ou psql com a connection string do dono do
-- projeto) — NUNCA a IA (ver nao_fazer da task que gerou este arquivo: a IA nunca executa nada
-- contra o projeto Supabase real). Depois de rodar schema.sql (que cria o schema "spy", as
-- tabelas, e habilita RLS sem policy — as policies deste arquivo dependem do role "spy_app"
-- existir, por isso vem DEPOIS). Ordem: schema.sql primeiro, setup-role.sql depois.
--
-- SENHA: a linha abaixo tem um PLACEHOLDER obvio. Troque 'TROQUE_ESTA_SENHA_ANTES_DE_RODAR' por
-- uma senha forte gerada por voce (ex.: `openssl rand -base64 24`) ANTES de executar este arquivo.
-- Este arquivo nunca deve ser commitado com uma senha real.

-- 1) Cria o role, so se ainda nao existir (idempotente — rodar de novo nao quebra). LOGIN simples,
--    sem SUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS — o minimo pra app conectar e nada mais. Sem
--    INHERIT de nenhum role do Supabase (nao usa "IN ROLE"): spy_app nunca herda privilegio de
--    postgres, service_role ou qualquer outro role do projeto.
--    Se o role ja existe e voce quer TROCAR a senha, rode separadamente:
--      alter role spy_app with password 'nova-senha-aqui';
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

-- 5) Policies de RLS, escopadas SO pro spy_app — AQUI, diferente do banco dedicado antigo, RLS e
--    LINHA DE FRENTE, nao so defesa em profundidade. Motivo: no banco dedicado a app conectava
--    como o role DONO das tabelas (dono ignora RLS por padrao), entao "RLS habilitada sem
--    nenhuma policy" so servia pra bloquear anon/authenticated caso o schema fosse exposto por
--    engano — nunca afetava a propria app. Agora a app conecta como "spy_app", que NAO e dono
--    das tabelas (schema.sql cria as tabelas como "postgres") — sem uma policy que autorize
--    explicitamente spy_app, RLS habilitada bloquearia a PROPRIA app (nega tudo por padrao pra
--    quem nao e dono e nao tem BYPASSRLS, mesmo com GRANT de tabela). Por isso as policies vem
--    aqui, DEPOIS do role existir (CREATE POLICY ... TO <role> exige que o role ja exista — e por
--    isso este arquivo roda depois de schema.sql, nunca antes).
--    IF EXISTS/DROP antes de CREATE porque Postgres nao tem "CREATE POLICY IF NOT EXISTS" — assim
--    o arquivo continua idempotente (rodar de novo nao quebra, so recria a policy identica).
--    USING (true) / WITH CHECK (true): spy_app opera sem filtro de linha dentro de spy (o
--    isolamento e por SCHEMA/GRANT, nao por linha — nao ha multi-tenant dentro de "spy"). A
--    policy existe pra AUTORIZAR spy_app explicitamente, nao pra restringir quais linhas ele ve.
--    Qualquer outro role sem BYPASSRLS (anon, authenticated — os que a Data API usaria se "spy"
--    um dia entrasse por engano na lista de "Exposed schemas") continua sem nenhuma policy que o
--    autorize, logo continua bloqueado — essa e a linha de frente.
drop policy if exists spy_app_full_access on spy.ofertas;
create policy spy_app_full_access on spy.ofertas for all to spy_app using (true) with check (true);

drop policy if exists spy_app_full_access on spy.leituras;
create policy spy_app_full_access on spy.leituras for all to spy_app using (true) with check (true);

drop policy if exists spy_app_full_access on spy.config;
create policy spy_app_full_access on spy.config for all to spy_app using (true) with check (true);

-- 6) Revoga de spy_app qualquer privilegio que TENHA SIDO CONCEDIDO DIRETAMENTE a ele no schema
--    "public" (defensivo — hoje nao existe nenhum, mas protege contra alguem um dia rodar um
--    GRANT solto pro spy_app em public por engano). IMPORTANTE, testado em Postgres local (ver
--    gate de prova desta task): isto NAO revoga o acesso que spy_app herda do pseudo-role PUBLIC
--    do Postgres (o schema "public" nasce com USAGE concedido a PUBLIC = "qualquer role,
--    sempre") — REVOKE ... FROM <role> so remove grant feito DIRETO pra aquele role, nunca
--    subtrai o que vem de PUBLIC. Pra tirar isso seria preciso "REVOKE ... FROM PUBLIC", que e
--    proibido aqui por afetar TODOS os roles do banco — incluindo anon/authenticated/
--    service_role e qualquer outro role do apps-ofertas — efeito colateral bem fora do escopo
--    deste arquivo (ver aviso no passo 7).
revoke all on schema public from spy_app;

-- 7) CHECAGEM DE RISCO RESIDUAL (leitura apenas, zero efeito colateral — rode e leia o resultado
--    antes de considerar o isolamento fechado). Testado em Postgres 17 local, com decoy real: uma
--    FUNCTION nova em "public" recebe EXECUTE para o pseudo-role PUBLIC AUTOMATICAMENTE, sem
--    nenhum GRANT explicito (spy_app chamou a function e leu o retorno so por ela existir) — e uma
--    SEQUENCE com GRANT explicito a PUBLIC (erro de configuracao comum) tambem fica acessivel
--    (nextval funcionou). NENHUM dos dois aparece em information_schema.role_table_grants — essa
--    view so cobre tabela/view, e e cega a function/sequence/tipo. Por isso uma checagem que olhe
--    so essa view devolve "0 linhas" com os dois furos abertos: um zero que significa "procurei no
--    lugar errado", nao "esta limpo". A query abaixo une TRES fontes pra fechar esse ponto cego:
--
--   select table_schema as schema, table_name as objeto, 'tabela/view' as tipo,
--          privilege_type as privilegio
--   from information_schema.role_table_grants
--   where table_schema = 'public' and grantee = 'PUBLIC'
--   union all
--   select specific_schema, routine_name, 'function/procedure',
--          privilege_type
--   from information_schema.role_routine_grants
--   where specific_schema = 'public' and grantee = 'PUBLIC'
--   union all
--   select object_schema, object_name, 'sequence/tipo/dominio (' || object_type || ')',
--          privilege_type
--   from information_schema.role_usage_grants
--   where object_schema = 'public' and grantee = 'PUBLIC';
--
--   No apps-ofertas especificamente: essa checagem e MAIS importante que era no banco dedicado,
--   porque "public" ja tem tabelas de compra/acesso REAIS com meses de uso — a chance de existir
--   algum GRANT solto acumulado ao longo do tempo e maior que num banco recem-criado. Rode antes
--   de considerar o isolamento fechado, nao pule por analogia com o banco dedicado.
--
--   Se essa query nao devolver nenhuma linha (caso comum e esperado): nao ha risco residual nesses
--   tipos de objeto — o isolamento por ausencia de grant (Postgres nao concede privilegio de
--   objeto automaticamente a role nova nenhuma) ja protege as tabelas de compra na pratica.
--
--   O QUE ESSA CHECAGEM NAO COBRE (fora do alcance desta query — nao fica implicito, fica escrito):
--   large objects, extensions, foreign data wrappers/servers, e qualquer privilegio que spy_app
--   herdasse por ser MEMBRO de outro role (este script nunca faz isso — spy_app so herda do
--   pseudo-role PUBLIC, nunca de outro role, nem dos roles internos do Supabase). Se "public"
--   tiver outro tipo de objeto customizado fora tabela/view/function/procedure/sequence/tipo/
--   dominio, audite-o manualmente.
--
--   Se devolver alguma linha: e uma DECISAO SUA, nao da IA. Depende do tipo na coluna "tipo":
--     - tabela/view ou sequence/tipo/dominio: o acesso veio de um GRANT EXPLICITO que alguem rodou
--       no passado -> dois caminhos possiveis:
--       (a) escopado e mais seguro: `revoke <privilegio> on <tipo_do_objeto> public.<objeto> from
--           public;` (tira o grant so daquele objeto, nao mexe em mais nada);
--       (b) global: `revoke all on schema public from public;` (fecha o acesso ambiente pra todo
--           role do banco, INCLUINDO anon/authenticated/service_role — pode quebrar a Data API do
--           apps-ofertas, que serve o app de ofertas em producao com clientes reais. NAO rode isso
--           sem entender o blast radius completo — avalie com cuidado, idealmente num projeto de
--           teste primeiro).
--     - function/procedure: o EXECUTE pode ser so o DEFAULT do Postgres, sem GRANT explicito
--       nenhum -> revoga so daquela function, sem afetar as demais:
--       `revoke execute on function public.<nome>(<tipos_dos_argumentos>) from public;`
--       Pra travar TODA function nova que alguem criar em public dai pra frente (ADMIN, uma vez):
--       `alter default privileges in schema public revoke execute on functions from public;`
--       (isso tambem e global — mesma cautela do item (b) acima antes de rodar em apps-ofertas.)

-- ---------------------------------------------------------------------------------------------
-- VERIFICACAO (rode manualmente depois, leitura apenas — nao faz parte do setup):
--
--   \du spy_app                    -- confirma que o role existe e NAO tem atributos extra (superuser, etc.)
--   \dn+ spy                       -- confirma os privilegios do schema spy
--   \dp spy.*                      -- confirma os grants tabela a tabela
--   select * from pg_policies where schemaname = 'spy';   -- confirma as 3 policies deste arquivo
--
-- TESTE NEGATIVO (prova que o isolamento funciona — troque <tabela_real_de_compra> pelo nome real
-- de uma tabela de compra do apps-ofertas em "public"; espera-se erro de permissao em TODOS):
--
--   set role spy_app;
--   select 1 from public.<tabela_real_de_compra> limit 1;   -- ESPERADO: permission denied
--   insert into public.<tabela_real_de_compra> default values; -- ESPERADO: permission denied
--   reset role;
--
-- TESTE POSITIVO (dentro do schema spy funciona normalmente):
--
--   set role spy_app;
--   select count(*) from spy.ofertas;                          -- ESPERADO: funciona (0 linhas se banco novo)
--   reset role;
--
-- CONEXAO VIA POOLER (depois de rodar este arquivo, teste a connection string real que vai pro
-- DATABASE_URL da Vercel — troque <SENHA> pela senha real que voce usou no passo 1, e confirme a
-- regiao exata em Dashboard > Connect > Transaction pooler do projeto apps-ofertas):
--
--   psql "postgresql://spy_app.sqzdzhktknfpuaorehnh:<SENHA>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"
--   select current_role;   -- ESPERADO: spy_app
-- ---------------------------------------------------------------------------------------------
