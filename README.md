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

- `DATABASE_URL` — connection string do banco Postgres (Neon) onde ficam ofertas, leituras e config.
- `DASHBOARD_PASSWORD` — a senha única compartilhada pelo time, checada no login.
- `SESSION_SECRET` — chave dedicada só pra assinar o cookie de sessão (HMAC-SHA256). Não é a
  mesma coisa que `DASHBOARD_PASSWORD` e nunca deve reaproveitar o valor dela.

## Banco de dados — rodando o schema.sql num banco novo

`schema.sql` cria as tabelas `ofertas`, `leituras` e `config` (com um índice único
case-insensitive no nome da oferta e a config padrão inicial). É idempotente — usa
`IF NOT EXISTS` e `ON CONFLICT DO NOTHING` em tudo, então rodar de novo num banco que já tem as
tabelas não quebra nada.

Não verifiquei o passo exato de execução nesta máquina (ex.: se é `psql`, o SQL Editor do console
do Neon, ou outra ferramenta) — qualquer cliente Postgres que rode o arquivo inteiro contra a
`DATABASE_URL` do projeto novo resolve.

## Onde ficam os dados

Os dados (ofertas, leituras, pesos e tolerância) ficam no servidor compartilhado (Postgres/Neon),
não mais no navegador de cada pessoa. Antes, cada um via só o que tinha salvo localmente
(`localStorage`); agora todo mundo lê e escreve o mesmo estado, e um F5 sempre traz a versão real
do servidor. Só preferência de tela (modo, tema, seleção) continua salva localmente, por pessoa,
e não é sincronizada entre Pedro, Gabriel e Robert.
