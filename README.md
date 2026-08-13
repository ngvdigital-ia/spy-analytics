# Spy-Analytics

Painel interno pra acompanhar ofertas de concorrentes: registra a contagem de anúncios ativos
de cada oferta ao longo do tempo e calcula uma nota (estabilidade / volume / tempo em escala)
que ajuda a decidir quais ofertas valem traduzir. Uso da equipe (Pedro, Gabriel e Robert),
protegido por senha única compartilhada.

A contagem de anúncios é **digitada por uma pessoa**, 2×/dia. Existe um caminho opcional pra
automatizar só esse passo com um agente de navegador na máquina de quem opera:
[`docs/coleta-assistida-navegador.md`](docs/coleta-assistida-navegador.md) — que também registra
por que os dois caminhos alternativos estão fechados (a AUP da Vercel proíbe coletor hospedado e
pune a conta inteira; a API oficial da Meta não devolve anúncio comercial fora da UE/UK).

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
- `CRON_SECRET` — autoriza o Vercel Cron a chamar `GET /api/cron-prontas` (ver seção "Aba
  'Prontas pra modelar'" abaixo). Sem essa variável, o endpoint recusa toda chamada.
- `SLACK_WEBHOOK_URL` — Incoming Webhook do canal que recebe o aviso de oferta pronta pra
  modelar. **Opcional** — sem ela, o cron roda normalmente e só não notifica ninguém (ver seção
  abaixo).
- `NGV_CORE_WRITER_KEY` — secret API key nomeada `spy_writer` do projeto Supabase do
  **NGV Core**, usada pelo cron diário `GET /api/sync-ngv-core` pra autenticar o POST do snapshot
  agregado no `spy-snapshot-ingest` (ver seção "Sincronização diária com o NGV Core" abaixo).
  Sem ela, o cron responde "configuração ausente" sem consultar banco nem rede. Nunca é logada
  nem devolvida em resposta.

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

## Aba "Prontas pra modelar" e notificação no Slack

Regra própria (pedido do Diogo), **separada** da nota de tradução do painel principal (que
continua igual — traduzir / candidata forte / observar / descartar). Uma oferta entra na aba e
dispara aviso no Slack quando, olhando o histórico inteiro dela:

1. tem leitura em **7 dias distintos ou mais** (dia com leitura conta — uma oferta só lida de
   manhã em todos os dias também qualifica, não precisa do par manhã+noite);
2. a **última leitura** (a mais recente no tempo) tem **mais de 100 anúncios** ativos;
3. a última leitura é **estritamente maior que a metade** da primeira leitura
   registrada (não pode ter caído pela metade ou mais).

A regra mora inteira em uma view no banco (`spy.ofertas_prontas_pra_modelar`,
`migrations/002-prontas-pra-modelar.sql`) — tanto a aba quanto o cron de notificação leem essa
mesma view, nunca duas implementações que podem divergir com o tempo.

### Cron de notificação — 2×/dia

`GET /api/cron-prontas` roda pelo Vercel Cron (`vercel.json`), agendado pra **11h e 23h UTC**,
que corresponde a **8h e 20h no horário de Brasília** — cerca de 1h depois de cada janela de
lançamento do time (7h e 19h BRT). Brasília é UTC-3 **fixo** (sem horário de verão desde 2019),
então essa conversão não muda ao longo do ano. Se o horário de lançamento do time mudar, ajuste
o array `schedule` em `vercel.json` e atualize este parágrafo junto — o JSON do cron não aceita
comentário, esta seção do README é a documentação do "por quê" desse horário.

O plano do projeto na Vercel é **Pro** (confirmado na API da Vercel, não é Hobby) — não há limite
de "1× por dia" no agendamento de cron.

Cada execução do cron:
- compara quem está na view **agora** contra quem já estava marcado como notificado
  (`spy.ofertas.pronta_pra_modelar`) — só notifica quem **entrou agora** (transição), nunca quem
  já estava lá desde a execução anterior;
- quem **sai** da view (deixou de bater os 3 critérios) só tem a marcação zerada, **sem**
  notificação — o Diogo só pediu aviso de entrada;
- se a oferta sair e voltar a qualificar depois, notifica **de novo** (informação nova pro
  time) — não há "lembrar que já avisei uma vez" além da entrada mais recente.

### Sem `SLACK_WEBHOOK_URL` configurada

Esta seção descreve o comportamento quando a variável está **ausente ou vazia** — que é
exatamente o que `api/cron-prontas.js` testa (`if (!webhookUrl)`). Não descreve um estado do
mundo ("o canal não existe"), justamente pra não envelhecer quando o canal ou o webhook mudarem.

> Estado medido em **2026-08-02**: o canal `#Spy` **existe** na workspace; o que falta é o
> Incoming Webhook — ninguém gerou a URL ainda, então `SLACK_WEBHOOK_URL` não está configurada
> na Vercel. Ou seja, o caminho abaixo é o que roda hoje. Isto é uma foto datada; a fonte da
> verdade é `vercel env ls production`.

Enquanto a variável não estiver configurada:

- **a aba "Prontas pra modelar" funciona normalmente** — ela só lê a view, nunca depende do
  Slack;
- **o cron não quebra.** Ele roda, detecta as ofertas que entraram, loga um aviso
  (`console.warn`, visível em Vercel Dashboard > Logs) e **não marca ninguém como notificado**;
- na primeira execução **depois** que `SLACK_WEBHOOK_URL` for configurada, essas ofertas
  pendentes são notificadas normalmente — nada se perde, só fica atrasado.

O mesmo vale se o Slack aceitar a chamada mas devolver erro (webhook antigo, canal apagado,
etc.): a oferta fica pendente e a tentativa se repete no próximo cron, sem intervenção manual.

## Sincronização diária com o NGV Core

`GET /api/sync-ngv-core` roda pelo Vercel Cron (`vercel.json`), agendado pra **01h UTC**
(22h no horário de Brasília), **1×/dia** — depois da última janela de coleta do time (19h BRT)
e sem colidir com as 11h/23h UTC do cron de notificação. São **2 crons no total** no projeto
(`cron-prontas` + `sync-ngv-core`), dentro do teto de 2 do plano Hobby.

Cada execução:
- valida `Authorization: Bearer $CRON_SECRET` (a Vercel manda isso automaticamente em chamadas
  de cron) com comparação timing-safe — sem CRON_SECRET configurada, recusa toda chamada
  (fail-closed). Não usa cookie nem sessão;
- se `NGV_CORE_WRITER_KEY` estiver **ausente ou vazia**, responde **"configuração
  ausente"** **sem consultar o banco nem a rede** — o check vem antes da query e do fetch;
- lê direto do banco a **mesma query agregada** que o `api/resumo.js` usa (janela de 30 dias) e
  POSTa o **mesmo contrato sanitizado de 9 campos** no endpoint de ingestão do NGV Core:
  `https://givqkglqwdizrpityafz.supabase.co/functions/v1/spy-snapshot-ingest` — **não** chama
  `/api/resumo` via HTTP e **não** depende da flag `SPY_PROJECTION_ENABLED`;
- o POST vai com `apikey: $NGV_CORE_WRITER_KEY` (a secret API key server-side do NGV
  Core), `Content-Type: application/json`, timeout via `AbortController`, **sem seguir
  redirect**, e só aceita **2xx**. Falha de rede/timeout ou rejeição do NGV Core vira **502
  sanitizado**; os logs nunca imprimem a chave, o body do payload nem dados individuais.

O snapshot enviado é deliberadamente agregado: só os 9 campos (contagens de ofertas/leituras/
dias distintos/prontas pra modelar), sem IDs, URLs, links ou linhas individuais.

## Onde ficam os dados

Os dados (ofertas, leituras, pesos e tolerância) ficam no servidor (Postgres/Supabase), não mais
no navegador de cada pessoa. Antes, cada um via só o que tinha salvo localmente
(`localStorage`); agora todo mundo lê e escreve o mesmo estado, e um F5 sempre traz a versão real
do servidor. Só preferência de tela (modo, tema, seleção) continua salva localmente, por pessoa,
e não é sincronizada entre Pedro, Gabriel e Robert.
