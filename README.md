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

- `DATABASE_URL` — connection string do projeto Supabase **compartilhado** `apps-ofertas` (ref
  `sqzdzhktknfpuaorehnh`, sa-east-1) onde ficam ofertas, leituras e config — ver seção abaixo.
  Use a connection string do **connection pooler** (Supavisor, modo transaction, porta 6543),
  não a conexão direta, e com o usuário `spy_app.<ref>` — **nunca** `postgres.<ref>` (ver abaixo
  por quê).
- `DASHBOARD_PASSWORD` — a senha única compartilhada pelo time, checada no login.
- `SESSION_SECRET` — chave dedicada só pra assinar o cookie de sessão (HMAC-SHA256). Não é a
  mesma coisa que `DASHBOARD_PASSWORD` e nunca deve reaproveitar o valor dela.

## Banco de dados — projeto Supabase COMPARTILHADO (`apps-ofertas`)

Criar um projeto Supabase novo custa US$ 10/mês na organização do operador. Decisão dele: em vez
de pagar, o Spy-Analytics reusa o projeto Supabase **`apps-ofertas`** — que já serve outro
produto em produção e tem tabelas de compra/acesso de **cliente real** em `public` (confirmado
antes desta configuração: 116 compras, 110 acessos). Isso volta a trazer a pergunta "de quem
isolar" — a resposta é: da própria tabela de compras do apps-ofertas.

**Você não precisa ser DBA pra entender o que protege o quê abaixo — mas precisa conferir os 3
itens marcados "CONFIRME" antes de considerar isto pronto. Nada aqui é garantia até você rodar a
checagem.**

### O que protege

- **Um role novo, restrito: `spy_app`.** A app nunca conecta com o role `postgres` (dono do
  projeto apps-ofertas, enxerga o banco inteiro — inclusive as tabelas de compra). Conecta com
  `spy_app`, criado por `setup-role.sql`, que só recebe `GRANT` dentro do schema `spy` — nunca em
  `public`. Como o Postgres não dá privilégio nenhum a um role novo por padrão, isso já bloqueia
  `spy_app` nas tabelas do apps-ofertas na prática (testado localmente — ver "O que eu testei"
  abaixo).
- **Schema `spy`.** As 3 tabelas (`ofertas`, `leituras`, `config`) ficam em `spy`, não em
  `public` — é o que separa este produto das tabelas de compra do apps-ofertas dentro do mesmo
  banco.
- **RLS como linha de frente, não só decoração.** As 3 tabelas têm Row Level Security habilitada,
  e só `spy_app` tem uma policy que autoriza (criada em `setup-role.sql`). Qualquer outro role
  (inclusive `anon`/`authenticated`, os que a API REST do Supabase usaria) fica bloqueado por
  padrão, mesmo que `spy` um dia entre por engano na lista de "Exposed schemas".
- **Nenhuma chave do Supabase no client.** O repo é público — `index.html` nunca recebe
  `SUPABASE_URL` nem `anon key`. Todo acesso ao banco é server-side, só dentro das Vercel
  Functions, lendo `DATABASE_URL` das env vars do projeto.

### O que isto NÃO protege (leia antes de assumir isolamento total)

- **`setup-role.sql` tem um passo de checagem (passo 7) que você precisa RODAR, não só ler.** Ele
  procura GRANT solto pra `PUBLIC` em function/sequence/tipo dentro de `public` — coisa que o
  Postgres concede sozinho em alguns casos (ex.: function nova ganha `EXECUTE` pra `PUBLIC`
  automaticamente) e que a checagem "óbvia" (só tabela/view) não enxerga. Testado localmente: a
  query acha esse tipo de grant de verdade quando existe — não é um check que sempre dá "limpo".
  Se o apps-ofertas tiver algum desses, é decisão sua (ver o próprio arquivo pra saber o que
  fazer em cada caso).
- **Se alguém no futuro der `GRANT` direto pra `spy_app` em alguma tabela de `public`** (por
  engano, num script solto), o isolamento por ausência de grant deixa de proteger aquela tabela
  específica. `setup-role.sql` revoga isso defensivamente (passo 6), mas só cobre o que já
  existia no momento em que você rodou o arquivo — rode de novo se desconfiar.
- **Isto não é multi-tenant dentro de `spy`.** A policy de RLS de `spy_app` é `USING (true)` — o
  isolamento é só entre `spy` e `public`, não entre linhas dentro de `spy`. Não há necessidade
  disso hoje (uso interno de 3 pessoas), mas não confunda com proteção linha-a-linha.

### CONFIRME estes 3 itens (você, manualmente — a IA nunca roda isto contra o projeto real)

1. **O role `spy_app` foi criado com senha forte própria**, diferente de qualquer outra senha do
   apps-ofertas — `setup-role.sql` vem com um placeholder óbvio que você troca antes de rodar.
2. **A connection string do Vercel usa `spy_app.<ref>` como usuário, não `postgres.<ref>`.** O
   dashboard do Supabase (Project Settings > Database > Connection string) sempre mostra
   `postgres.<ref>` por padrão — você precisa trocar manualmente a parte antes do `.` pra
   `spy_app`. É o erro mais fácil de cometer aqui: copiar a string do dashboard sem editar deixa
   a app conectando como o dono do projeto, com acesso a tudo.
3. **Rodou o passo 7 de `setup-role.sql`** (checagem de risco residual) e leu o resultado — não
   só confiou que "0 linhas de tabela/view" significa limpo (pode não olhar function/sequence).

### O que eu testei (evidência real, não afirmação)

Localmente, num Postgres 17 descartável (Docker) simulando o cenário — schema `public` com uma
tabela decoy de "compras" + schema `spy` com as 3 tabelas reais:

- **Teste negativo:** `spy_app` tentando `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`DROP` na tabela
  decoy de `public` → **permission denied** (ou "must be owner", pro `DROP`) nos 5 casos, exit
  code 1 em todos.
- **Teste positivo:** `spy_app` operando normalmente dentro de `spy` (`SELECT`/`INSERT`/
  `UPDATE`/`DELETE`) → funciona.
- **CRUD completo via `api/*.js` reais** (não SQL cru) — login, criar/editar/apagar oferta,
  gravar/editar/apagar leitura, atualizar config, ler `/api/estado` — tudo autenticado como
  `spy_app`, 12 de 12 passos passaram.
- `schema.sql` e `setup-role.sql` rodados 2× cada (idempotência) — sem erro.

A connection string real **foi testada** contra o `apps-ofertas` em 2026-07-31, conectando como
`spy_app` pelo pooler: leu `spy.ofertas` e `spy.config` (com `pesos` voltando como object, não
string), inseriu e apagou uma linha de teste em `spy.ofertas`, e levou `permission denied for
table purchases` ao tentar ler `public.purchases` — isolamento confirmado contra o banco real,
não por dedução.

**ATENÇÃO ao host do pooler — o valor certo foi descoberto testando, não lendo a doc.** Para o
`apps-ofertas` (`sqzdzhktknfpuaorehnh`, sa-east-1) o host é **`aws-1-sa-east-1`**, não
`aws-0-sa-east-1`. O `aws-0` resolve em DNS (então não falha de forma óbvia) mas o Supavisor
responde `(ENOTFOUND) tenant/user spy_app.<ref> not found` — mensagem que parece "role custom não
é suportado" e leva ao diagnóstico errado. O prefixo `aws-N` varia por projeto: **copie o host do
próprio dashboard** (Project Settings > Database > Connection string > Transaction pooler) em vez
de montar a URL por analogia com outro projeto.

### Passo a passo para rodar (você, manualmente — nunca a IA roda isso)

1. Rode `schema.sql` inteiro no SQL Editor do Supabase do projeto `apps-ofertas` (ou via
   `psql`/outro cliente, conectado como o role `postgres`, dono do projeto). Cria o schema `spy`,
   as 3 tabelas dentro dele, e habilita RLS sem policy ainda (a policy vem no próximo passo — ver
   nota no topo de `schema.sql` sobre por quê a ordem importa). Idempotente — rodar de novo não
   quebra nada.
2. Rode `setup-role.sql` inteiro, **depois** de trocar o placeholder de senha por uma senha forte
   seguindo suas instruções. Cria o role `spy_app`, os grants escopados a `spy`, e as policies de
   RLS que autorizam `spy_app`. Rode o passo 7 (checagem) e leia o resultado antes de seguir.
3. Em Project Settings > API, confirme que `spy` **não** está na lista de "Exposed schemas" —
   deve conter só o padrão (`public`, `graphql_public`). Isso não é automático a partir do SQL: é
   configuração do dashboard, e é o que garante a superfície REST fechada.
4. Pegue a connection string do **pooler** (Project Settings > Database > Connection string >
   "Transaction pooler", porta 6543), **troque `postgres` por `spy_app` no usuário** (item
   CONFIRME 2 acima), e defina como `DATABASE_URL` nas env vars do projeto Vercel do
   Spy-Analytics. Ver formato em `.env.example`.
5. Teste com `psql` antes de considerar pronto (comando no rodapé de `setup-role.sql`): conecte
   como `spy_app` pelo pooler e confirme `select current_role;` devolve `spy_app`.

## Onde ficam os dados

Os dados (ofertas, leituras, pesos e tolerância) ficam no servidor (Postgres/Supabase), não mais
no navegador de cada pessoa. Antes, cada um via só o que tinha salvo localmente
(`localStorage`); agora todo mundo lê e escreve o mesmo estado, e um F5 sempre traz a versão real
do servidor. Só preferência de tela (modo, tema, seleção) continua salva localmente, por pessoa,
e não é sincronizada entre Pedro, Gabriel e Robert.
