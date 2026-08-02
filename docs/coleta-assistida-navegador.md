# Coleta assistida pelo navegador

Instruções para automatizar a parte chata da rotina: abrir o link da Biblioteca de Anúncios de
cada oferta, ler quantos anúncios estão ativos e gravar no Spy-Analytics — usando um agente com
controle do navegador (Claude no Chrome ou equivalente), na máquina de quem opera.

**Isto não é um robô no servidor.** Roda no navegador de uma pessoa, disparado por ela. Essa
distinção não é detalhe: coletor hospedado na Vercel viola o Termo de Uso deles
(`vercel.com/legal/acceptable-use-policy` proíbe *"Scrape, proxy, act as a VPN"* e autoriza
encerrar a conta inteira — que hospeda também as landings e o sistema de vendas). No navegador
local, a Vercel não está no caminho.

Também **não existe caminho oficial pela API da Meta**: a `ads_archive` da Graph API só devolve
anúncio comercial na UE/Reino Unido — fora de lá, só político e tema social. `BR` é aceito sem
erro e responde vazio, o que parece bug de código e não é.

---

## O que o agente faz, em ordem

1. Abre `https://spy-analytics.vercel.app` e entra com a senha do time (a mesma de sempre).
2. Pega a lista de ofertas e os links da Biblioteca.
3. Para cada oferta: abre o link, lê a quantidade de anúncios ativos.
4. Grava tudo de uma vez no Spy-Analytics.

O passo 4 tem duas formas. **Prefira gravar pela API** (abaixo): preencher campo por campo na
tela é onde esse tipo de automação mais erra, e a API aceita a lista inteira numa chamada só.

---

## Instrução pronta para colar no agente

> Você tem controle do meu navegador. Faça a leitura diária de ofertas do Spy-Analytics.
>
> **Passo 1 — entrar no app.** Abra `https://spy-analytics.vercel.app`. Se pedir senha, use a
> senha do time que eu te passar. Não prossiga sem estar dentro.
>
> **Passo 2 — pegar a lista de ofertas.** Com a aba do Spy-Analytics aberta e logada, execute
> na página:
> ```js
> const r = await fetch('/api/estado', { credentials: 'same-origin' });
> const d = await r.json();
> console.log(JSON.stringify(d.ofertas.map(o => ({ id: o.id, nome: o.nome, link: o.link })), null, 2));
> ```
> Isso devolve a lista com o `id` e o `link` da Biblioteca de cada oferta. Guarde — você vai
> precisar do `id` exato na hora de gravar. Ofertas sem link, pule e me avise no fim.
>
> **Passo 3 — ler cada oferta.** Para cada link, abra numa aba, espere a página carregar por
> completo (ela é lenta e carrega o conteúdo depois) e localize o texto que informa a
> **quantidade de resultados/anúncios** — costuma aparecer perto do topo, acima da grade de
> anúncios. Anote só o número inteiro.
>
> Se em alguma oferta o número não aparecer, ou a página pedir login/verificação, ou vier
> zero: **não invente e não chute** — deixe essa oferta de fora e me diga quais ficaram de
> fora e por quê. É melhor faltar uma leitura do que gravar um número errado.
>
> Feche a aba antes de abrir a próxima.
>
> **Passo 4 — gravar.** De volta na aba do Spy-Analytics, monte a lista e envie de uma vez.
> Use `periodo: 'manha'` se for antes do meio-dia, `'noite'` se for depois (sem acento, exatamente
> assim). A data é a de hoje no formato `AAAA-MM-DD`.
> ```js
> const hoje = new Date().toISOString().slice(0, 10);
> const periodo = new Date().getHours() < 12 ? 'manha' : 'noite';
> const leituras = [
>   // uma linha por oferta lida — ofertaId é o id que veio do passo 2:
>   { ofertaId: 'COLE_O_ID_AQUI', ads: 123 },
>   // ...
> ];
> const itens = leituras.map((l, i) => ({
>   id: `auto-${hoje}-${periodo}-${i}`,
>   ofertaId: l.ofertaId,
>   data: hoje,
>   periodo,
>   ads: l.ads
> }));
> const r = await fetch('/api/leituras', {
>   method: 'POST',
>   headers: { 'content-type': 'application/json' },
>   credentials: 'same-origin',
>   body: JSON.stringify({ itens })
> });
> console.log(r.status, await r.text());
> ```
> `200` = gravou. Qualquer outro código, me mostre a resposta inteira em vez de tentar de novo.
>
> **Passo 5 — me relatar.** Liste o que gravou (oferta e número) e o que ficou de fora, com o
> motivo. Não resuma como "tudo certo" se alguma oferta ficou faltando.

---

## Por que gravar duas vezes não estraga nada

A gravação é *upsert* pela chave `(oferta_id, data, periodo)` — ver `api/leituras.js`. Se o
mesmo dia e período for gravado de novo, a linha existente é atualizada em vez de duplicar, e o
último valor vence.

Consequência prática: **dá para testar sem medo**. Se o agente errar um número, basta digitar
por cima na tela do app que fica certo. E se alguém já tiver digitado à mão antes do agente
rodar, o agente não cria linha duplicada.

---

## O que conferir nos primeiros dias

O risco real desse tipo de automação não é ela quebrar com erro na cara — é ela **devolver um
número menor sem avisar**, quando a Meta limita o acesso ou a página não terminou de carregar.
Num app que mede *evolução de contagem*, receber 40 onde o real é 120 não gera erro nenhum:
gera uma queda falsa, que faz descartar uma oferta que estava escalando.

Por isso, enquanto não houver confiança medida:

- Compare o que o agente gravou com o que aparece na tela em 2-3 ofertas por rodada.
- Desconfie de **queda brusca sem motivo** e de **zero** — os dois são o sintoma típico.
- Só considere automatizar o disparo (agendador da máquina, sem ninguém apertando nada) depois
  que os números baterem por alguns dias. Tirar a conferência humana antes disso é remover a
  única defesa contra o erro silencioso, justamente na fase em que ele é mais provável.

Quem dispara é quem olha — e é isso que torna a versão assistida mais segura que a totalmente
automática, não menos.
