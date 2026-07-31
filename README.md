# Spy-Analytics

Painel interno pra acompanhar ofertas de concorrentes: registra a contagem de anúncios ativos
de cada oferta ao longo do tempo e calcula uma nota (estabilidade / volume / tempo em escala)
que ajuda a decidir quais ofertas valem traduzir. Uso da equipe (Pedro, Gabriel e Robert),
protegido por senha única compartilhada.

## Como tirar o acesso de alguém

O login é uma senha única compartilhada pelo time (`DASHBOARD_PASSWORD`). Trocar essa senha
**não** desloga quem já está logado — o cookie de sessão de quem já entrou continua valendo por
até 30 dias, mesmo depois da senha mudar. Isso é assim porque a sessão é assinada com uma chave
separada (`SESSION_SECRET`), independente da senha, e o cookie não guarda a senha em si.

Pra tirar o acesso de alguém de verdade (ex.: alguém saiu do time), os dois passos são
obrigatórios, nessa ordem:

1. Trocar `DASHBOARD_PASSWORD` nas env vars do projeto na Vercel.
2. Rotacionar `SESSION_SECRET` nas env vars do projeto na Vercel (trocar por um valor novo).

O passo 2 é o que de fato derruba todo mundo: como o cookie é assinado com `SESSION_SECRET`,
trocar essa chave invalida IMEDIATAMENTE todas as sessões já abertas — inclusive a da pessoa que
você quer tirar. Todo mundo (inclusive quem deveria continuar com acesso) precisa logar de novo
com a senha nova. Só trocar a senha, sem rotacionar `SESSION_SECRET`, deixa quem já tinha cookie
válido continuando a entrar normalmente.

Não verifiquei o passo exato de "gerar um valor novo" pro `SESSION_SECRET` na prática (ex.: um
comando específico) — qualquer string aleatória longa serve, já que ela só é usada para assinar o
cookie via HMAC-SHA256.

## Variáveis de ambiente

Definidas em `.env.example` (sem valores — nunca versione valor real, o repo é público):

- `DATABASE_URL` — connection string do projeto Supabase (Postgres) onde ficam ofertas, leituras
  e config. Projeto **dedicado ao Spy-Analytics** — ver seção abaixo. Use a connection string do
  **connection pooler** (Supavisor, modo transaction, porta 6543), não a conexão direta.
- `DASHBOARD_PASSWORD` — a senha única compartilhada pelo time, checada no login.
- `SESSION_SECRET` — chave dedicada só pra assinar o cookie de sessão (HMAC-SHA256). Não é a
  mesma coisa que `DASHBOARD_PASSWORD` e nunca deve reaproveitar o valor dela.

## Banco de dados — projeto Supabase dedicado

O Spy-Analytics roda num projeto Supabase **próprio, dedicado a este produto** — não é mais
compartilhado com o painel NGV nem com nenhum outro produto (migração Neon → Supabase, decisão do
operador). Sem banco compartilhado, não há "de quem isolar": a app conecta com o role
administrador/dono do próprio projeto Supabase e enxerga o banco inteiro, porque o banco inteiro
é deste produto.

- **Schema `spy`.** As 3 tabelas (`ofertas`, `leituras`, `config`) continuam no schema `spy` em
  vez de `public` — isso sobrou da fase em que o banco era compartilhado com o painel NGV (era o
  que isolava os dois produtos no mesmo Postgres). Num projeto dedicado o schema separado é
  dispensável, mas o código já tem 14 queries testadas com o prefixo `spy.` — manter é kiss
  (retrabalho zero, sem custo real). Ver comentário no topo de `schema.sql`.
- **Superfície nova que o Neon não tinha: a Data API (PostgREST) do Supabase.** Todo projeto
  Supabase novo vem com uma API REST/GraphQL pública ligada por padrão, autenticável com a chave
  `anon`. Essa API só serve os schemas listados em "Exposed schemas" (Project Settings > API) —
  de fábrica só `public` e `graphql_public`. Como as tabelas do Spy vivem em `spy`, e você **nunca
  deve adicionar `spy` a essa lista**, elas ficam fora do alcance da Data API. Esta app nem tem
  chave `anon`/`SUPABASE_URL` em lugar nenhum — as Vercel Functions falam com o Postgres direto,
  via connection string (`api/_db.js`), nunca pela Data API. Além disso `schema.sql` habilita Row
  Level Security (sem nenhuma policy) nas 3 tabelas — defesa em profundidade caso `spy` algum dia
  entre na lista de schemas expostos por engano: nega tudo pra qualquer role sem `bypassrls`
  (é o caso de `anon`/`authenticated`, os roles que a Data API usa). Não afeta esta app: ela
  conecta com o role dono das tabelas, que ignora RLS por padrão.
- **Nenhuma chave do Supabase no client.** O repo é público — `index.html` nunca recebe
  `SUPABASE_URL` nem `anon key`. Todo acesso ao banco é server-side, só dentro das Vercel
  Functions, lendo `DATABASE_URL` das env vars do projeto.

### Passo a passo para rodar (você, manualmente — nunca a IA roda isso)

1. Crie um projeto Supabase novo, dedicado ao Spy-Analytics (não reaproveite um projeto que já
   sirva outro produto).
2. Rode `schema.sql` inteiro no SQL Editor do Supabase (ou via `psql`/outro cliente, conectado
   como o role admin do projeto). Cria o schema `spy`, as 3 tabelas dentro dele, e habilita RLS
   sem policy (ver nota acima). Idempotente — rodar de novo não quebra nada.
3. Em Project Settings > API, confirme que `spy` **não** está na lista de "Exposed schemas" —
   deve conter só o padrão (`public`, `graphql_public`). Isso não é automático a partir do
   `schema.sql`: é configuração do dashboard, e é o que garante a superfície REST fechada.
4. Pegue a connection string do **pooler** (Project Settings > Database > Connection string >
   "Transaction pooler", porta 6543) e defina como `DATABASE_URL` nas env vars do projeto Vercel
   do Spy-Analytics. Ver formato em `.env.example`.

## Onde ficam os dados

Os dados (ofertas, leituras, pesos e tolerância) ficam no servidor (Postgres/Supabase), não mais
no navegador de cada pessoa. Antes, cada um via só o que tinha salvo localmente
(`localStorage`); agora todo mundo lê e escreve o mesmo estado, e um F5 sempre traz a versão real
do servidor. Só preferência de tela (modo, tema, seleção) continua salva localmente, por pessoa,
e não é sincronizada entre Pedro, Gabriel e Robert.
