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

- `DATABASE_URL` — connection string do banco Postgres onde ficam ofertas, leituras e config.
  **O banco é o mesmo do `banco-de-dados-ngv`** (Neon, store `Banco_de_dados_NGV`) — decisão do
  operador, ver seção abaixo — e a string precisa autenticar como o role `spy_app`, não como o
  usuário do painel NGV.
- `DASHBOARD_PASSWORD` — a senha única compartilhada pelo time, checada no login.
- `SESSION_SECRET` — chave dedicada só pra assinar o cookie de sessão (HMAC-SHA256). Não é a
  mesma coisa que `DASHBOARD_PASSWORD` e nunca deve reaproveitar o valor dela.

## Banco de dados — por que é compartilhado com o painel NGV, e o que garante o isolamento

O Spy-Analytics roda no mesmo banco Postgres do `banco-de-dados-ngv` (Neon, store
`Banco_de_dados_NGV`, plano Free — 0.5 GB por projeto) em vez de um projeto Neon próprio. Essa
troca economiza um segundo banco, mas esse banco tem **dados de receita do painel de marketing**,
então a separação real vem de duas camadas — nenhuma delas é opcional:

1. **Schema próprio.** As 3 tabelas (`ofertas`, `leituras`, `config`) vivem no schema `spy`,
   nunca em `public` (onde está o painel NGV). Ver `schema.sql`.
2. **Usuário restrito.** A app conecta com um role novo, `spy_app`, e `setup-role.sql` nunca
   concede nada a ele em `public` — isso já vale assim que você roda o arquivo. **O que ainda não
   está garantido só por isso:** `public` pode ter sobras de configuração antiga que `spy_app`
   herdaria sem ninguém ter liberado nada pra ele especificamente — ex.: um grant solto pro
   pseudo-role `PUBLIC` do Postgres, ou o `EXECUTE` que toda function nova em `public` ganha
   automaticamente, sempre, mesmo sem grant nenhum. Isso só fica confirmado depois que você roda
   a checagem do passo 6 do `setup-role.sql` (passo 5 do roteiro abaixo) **e ela volta limpa** —
   se ela achar algo, o próprio arquivo te dá os dois jeitos de fechar. Sem essa segunda camada
   (role restrito + checagem confirmada), schema separado sozinho não protege nada: se o
   Spy-Analytics usasse o mesmo usuário do painel, qualquer bug no Spy-Analytics poderia ler ou
   apagar tabela do painel. Ver `setup-role.sql`.

### Passo a passo para rodar (você, manualmente — nunca a IA roda isso)

Os dois arquivos abaixo são aditivos: só criam objetos novos dentro do schema `spy` e permissões
novas para o role `spy_app`. Nenhum dos dois toca em `public` nem em objeto existente do painel.

1. Conecte no banco `Banco_de_dados_NGV` como o role administrador/dono (o mesmo que você já usa
   para o `banco-de-dados-ngv` hoje) — via `psql`, o SQL Editor do console do Neon, ou outro
   cliente Postgres.
2. Rode `schema.sql` inteiro. Cria o schema `spy` e as 3 tabelas dentro dele. Idempotente — rodar
   de novo não quebra nada.
3. Abra `setup-role.sql`, troque o placeholder `TROQUE_ESTA_SENHA_ANTES_DE_RODAR` por uma senha
   forte seguindo o comando sugerido no próprio arquivo. Rode o arquivo inteiro. Cria o role
   `spy_app`, concede acesso só ao schema `spy`, e revoga defensivamente qualquer acesso que algum
   dia tenha sido dado direto a ele em `public` (hoje não existe nenhum — é proteção contra erro
   futuro, não o mecanismo principal). A garantia real de isolamento vem de outro lugar: o
   Postgres não concede privilégio de objeto automaticamente a role nova nenhuma, então `spy_app`
   nasce sem acesso a `public` na prática. Isso **não** cobre grant que já estava solto pro
   pseudo-role `PUBLIC` antes deste script rodar — por isso o passo 5 abaixo é obrigatório, não
   opcional.
4. O próprio `setup-role.sql` traz, no rodapé, os comandos de verificação: um teste negativo
   (`spy_app` tentando ler uma tabela do painel em `public` — precisa dar erro de permissão) e um
   teste positivo (`spy_app` lendo `spy.ofertas` — precisa funcionar). Rode os dois manualmente
   depois e confirme o resultado antes de seguir.
5. **Rode também a checagem do passo 6 do `setup-role.sql`** (três `SELECT`s, leitura pura, zero
   risco) — ela cobre tabela/view, function/procedure e sequence/tipo em `public` com acesso pro
   pseudo-role `PUBLIC` do Postgres. Testei localmente com um decoy real: uma function nova em
   `public` já nasce com `EXECUTE` liberado pra `PUBLIC` **sem nenhum grant explícito** (é o
   default do Postgres) e `spy_app` conseguiu chamar e ler o retorno; uma sequence com grant
   explícito a `PUBLIC` também ficou acessível (`nextval` funcionou). Nos dois casos o acesso vem
   do pseudo-role `PUBLIC` (herdado por qualquer role do banco, `spy_app` incluso), não de um
   grant direto a ele, e `setup-role.sql` deliberadamente não mexe nesse pseudo-role (afetaria
   todo mundo no banco, painel incluído — fora do que um script aditivo pode decidir sozinho).
   **Enquanto você não roda essa checagem e ela não volta limpa, a garantia da seção acima
   (`setup-role.sql` não concede nada a `spy_app` em `public`) é só o que o script garante
   sozinho — não é o estado confirmado do banco.** Se ela não devolver nenhuma linha (caso
   comum), não há risco residual nesses tipos de objeto. **Se devolver alguma linha, aja** — não
   deixe a linha "aí parada": o próprio arquivo
   (passo 6) explica o caminho pra cada tipo de objeto (revogar só daquele objeto, mais seguro e
   escopado, ou revogar do `PUBLIC` globalmente, mais radical — teste antes). Até você revogar, o
   painel NGV segue exposto naquele objeto.
6. Monte a `DATABASE_URL` com o usuário `spy_app` e a senha que você escolheu no passo 3, mesmo
   host/nome de banco do projeto Neon (`postgresql://spy_app:<senha>@<host>/<banco>?sslmode=require`),
   e defina essa variável só no projeto Vercel do Spy-Analytics — nunca reaproveite a env var
   `DATABASE_URL` já ligada ao `banco-de-dados-ngv` (essa aponta pro usuário com acesso total).

## Onde ficam os dados

Os dados (ofertas, leituras, pesos e tolerância) ficam no servidor compartilhado (Postgres/Neon),
não mais no navegador de cada pessoa. Antes, cada um via só o que tinha salvo localmente
(`localStorage`); agora todo mundo lê e escreve o mesmo estado, e um F5 sempre traz a versão real
do servidor. Só preferência de tela (modo, tema, seleção) continua salva localmente, por pessoa,
e não é sincronizada entre Pedro, Gabriel e Robert.
