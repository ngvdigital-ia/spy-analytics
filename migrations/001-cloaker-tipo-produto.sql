-- migrations/001-cloaker-tipo-produto.sql
-- Dois campos novos em spy.ofertas, pedido do Diogo (áudio Slack, 2026-07-31):
--
-- 1. cloaker — percepção do analista sobre a oferta ter cloaker ou não ('sim' / 'nao' /
--    'talvez'), NAO uma deteccao automatica. Opcional.
-- 2. tipo_produto — classificacao da oferta. Lista FECHADA por enquanto (so 'infoproduto' e
--    'nao_identificado'), mas o Diogo ja sinalizou que vai crescer (fisico, nutra...) — quando
--    isso vier, e so DROP + ADD CONSTRAINT com a lista nova (ver rodape). Opcional.
--
-- Aditivo e idempotente: ADD COLUMN IF NOT EXISTS nao falha se ja rodou antes; o par
-- DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT redefine o check sem erro na segunda execucao.
-- Ambas as colunas ficam sem NOT NULL e sem DEFAULT — oferta ja existente (id, nome, formato,
-- nicho, idioma, link, sem estas duas) continua valida: as colunas novas nascem NULL nela, e o
-- app (api/ofertas.js) trata ausencia como "nao preenchido", igual aos demais campos opcionais.
--
-- Valores permitidos incluem '' (string vazia) alem de NULL: index.html usa <select> com opcao
-- em branco value="", igual ja acontece com formato/nicho/idioma hoje — o app grava '' quando o
-- campo fica sem selecao, nao NULL (ver criar()/editar() em api/ofertas.js). O constraint aceita
-- os dois estados de "sem valor" pra nao rejeitar o que o proprio app grava.
--
-- Aplicar manualmente (Supabase MCP / SQL editor) — NAO rodar via este agente contra o banco
-- real. Rode depois de confirmar spy.ofertas ja existe (schema.sql).

alter table spy.ofertas add column if not exists cloaker text;
alter table spy.ofertas add column if not exists tipo_produto text;

alter table spy.ofertas drop constraint if exists ofertas_cloaker_check;
alter table spy.ofertas add constraint ofertas_cloaker_check
  check (cloaker is null or cloaker in ('', 'sim', 'nao', 'talvez'));

alter table spy.ofertas drop constraint if exists ofertas_tipo_produto_check;
alter table spy.ofertas add constraint ofertas_tipo_produto_check
  check (tipo_produto is null or tipo_produto in ('', 'infoproduto', 'nao_identificado'));

-- Quando a lista de tipo_produto crescer (ex.: 'fisico', 'nutra'), trocar so o segundo bloco:
--   alter table spy.ofertas drop constraint if exists ofertas_tipo_produto_check;
--   alter table spy.ofertas add constraint ofertas_tipo_produto_check
--     check (tipo_produto is null or tipo_produto in ('', 'infoproduto', 'nao_identificado', 'fisico', 'nutra'));
-- Constraint mais permissiva nunca invalida dado ja gravado com a lista antiga.
