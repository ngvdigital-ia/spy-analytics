# spy-analytics

Painel de vigília de escala de ofertas: duas leituras por dia da quantidade de
anúncios ativos, nota por estabilidade / volume / tempo, e ranking de quem está
pronta para traduzir.

O painel é um arquivo só — `index.html.html`. Pode ser aberto direto, publicado
no GitHub Pages, na Vercel, na Netlify ou em qualquer hospedagem estática.

## Os dados são da equipe, não do navegador

As ofertas, as leituras e os critérios ficam numa base compartilhada. Quem
registrar de qualquer navegador ou computador alimenta o mesmo painel, e o que
os outros registrarem aparece em alguns segundos.

Cada máquina também guarda uma cópia local. Isso significa que dá para
trabalhar sem internet: as leituras entram normalmente e sobem sozinhas quando
a conexão volta. Duas pessoas podem mexer ao mesmo tempo — as alterações são
juntadas registro a registro, pelo instante de cada uma, então ninguém
sobrescreve o trabalho do outro. Remoções também se propagam, e a mesma oferta
cadastrada em duas máquinas vira uma só.

O estado aparece no canto superior direito:

| Indicador | O que significa |
|---|---|
| **equipe em dia** (verde) | tudo sincronizado |
| **sincronizando** (laranja) | há alterações subindo |
| **fora do ar** (vermelho) | sem conexão com a nuvem; nada se perde, sobe depois |
| **só neste navegador** (cinza) | sincronização desligada |

Clicar no indicador abre as configurações, em **Dados e critérios ›
Sincronização da equipe**.

## Onde os dados podem ficar

### 1. Sala rápida (padrão, sem cadastro)

Já vem ligada — abrir o painel é o bastante para a equipe estar na mesma base.
Serve para começar hoje, com duas ressalvas: quem tiver o código da sala enxerga
os dados, e o servidor descarta salas que passem **24 h** sem ninguém abrir.
Como cada máquina mantém a cópia local, uma sala expirada é recriada e os dados
voltam — mas o código muda e precisa ser redistribuído.

Para uso de verdade, troque por uma das opções abaixo.

### 2. Supabase (recomendado)

Definitivo, privado e gratuito no plano inicial.

1. Crie um projeto em [supabase.com](https://supabase.com).
2. No **SQL Editor**, execute:

   ```sql
   create table if not exists spy_analytics (
     id            text primary key,
     dados         jsonb not null,
     atualizado_em timestamptz default now()
   );

   alter table spy_analytics enable row level security;

   create policy "equipe le"     on spy_analytics for select using (true);
   create policy "equipe cria"   on spy_analytics for insert with check (true);
   create policy "equipe altera" on spy_analytics for update using (true) with check (true);
   ```

3. Em **Project Settings › API**, copie a *Project URL* e a chave *anon public*.
4. No painel, escolha **Supabase**, cole os dois valores e clique em **Conectar**.

Estas políticas liberam leitura e escrita para quem tiver a chave anon — o mesmo
nível de confiança de compartilhar o link do painel. Para restringir de verdade,
coloque o projeto atrás de login e troque as condições `true` por
`auth.role() = 'authenticated'`.

### 3. Endpoint próprio

Qualquer endereço que responda `GET` devolvendo o JSON guardado e aceite `PUT`
gravando o JSON recebido, com CORS liberado para o domínio do painel.

O arquivo [`servidor/worker.js`](servidor/worker.js) é um Cloudflare Worker
pronto, com KV e token opcional — as instruções de publicação estão no
cabeçalho do arquivo.

### 4. Só neste navegador

Desliga a sincronização. Volta ao comportamento antigo: os dados não saem da
máquina.

## Colocar a equipe na mesma base

Depois de configurar, clique em **Copiar convite**. Quem abrir o link entra já
apontando para a mesma base, sem preencher nada. O convite carrega a
configuração de acesso, então mande pelo canal interno da equipe, não em
público.

## Backup

**Baixar backup** gera um `.json` com tudo. **Restaurar backup** substitui os
dados — e, com a sincronização ligada, o backup passa a valer para a equipe
inteira: o que não estiver nele sai do painel de todo mundo. O painel avisa
antes de aplicar.
