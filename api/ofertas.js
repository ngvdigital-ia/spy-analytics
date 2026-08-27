// api/ofertas.js
// POST cria, PATCH ?id= edita, DELETE ?id= remove (cascata apaga leituras) — ADR-001 secao 4.
// Tabela qualificada com "spy." — ver nota de prefixo explicito vs search_path em api/estado.js.
import { sql, PostgresError } from './_db.js';
import { exigirAuth, json, erro, tratarErroInesperado } from './_auth.js';
import { CoreRuntimeError, coreRuntimeEnabled, coreRequest } from './_core.js';

const CAMPOS_EDITAVEIS = ['nome', 'formato', 'nicho', 'idioma', 'link', 'cloaker', 'tipo_produto'];
// so http/https podem virar href no client (index.html) — barra scheme perigoso
// (javascript:, data:, vbscript:...) direto na borda, porque o endpoint aceita POST/PATCH
// cru de qualquer um (repo publico), sem depender da validacao do client.
const LINK_HTTP_HTTPS = /^https?:\/\//i;

// Listas fechadas (espelham o CHECK de migrations/001-cloaker-tipo-produto.sql) — validadas na
// borda porque o repo e publico: o endpoint aceita POST/PATCH cru de qualquer um, sem depender
// do <select> do client. tipo_produto e lista que o Diogo ja sinalizou que vai crescer (fisico,
// nutra...) — so os 2 valores de hoje entram aqui, nada inventado.
const CLOAKER_VALIDOS = new Set(['sim', 'nao', 'talvez']);
const TIPO_PRODUTO_VALIDOS = new Set(['infoproduto', 'nao_identificado']);

// Os dois campos sao opcionais: undefined/null/'' = "nao preenchido", sempre aceito. Só valor
// fora da lista fechada e rejeitado.
function valorValido(valor, validos) {
  if (valor === undefined || valor === null || valor === '') return true;
  return validos.has(valor);
}

export default {
  async fetch(request) {
    try {
      const naoAutorizado = exigirAuth(request);
      if (naoAutorizado) return naoAutorizado;

      const url = new URL(request.url);
      const id = url.searchParams.get('id');

      // `await` obrigatorio: `return promise` dentro de try devolve a promise ANTES de ela
      // rejeitar, entao o catch abaixo nunca ve o erro. Sem isto, todo erro Postgres que nao
      // seja tratado explicitamente aqui (23505/23503) vira rejeicao nao capturada em vez de
      // resposta 500 limpa — regra vale pra qualquer chamada async dentro de try/catch.
      if (request.method === 'POST') return await criar(request);
      if (request.method === 'PATCH') return await editar(request, id);
      if (request.method === 'DELETE') return await remover(id);
      return erro(405, 'metodo nao permitido');
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};

async function criar(request) {
  let corpo;
  try { corpo = await request.json(); } catch { return erro(400, 'corpo invalido'); }
  const { id, nome, formato, nicho, idioma, link, cloaker, tipo_produto } = corpo || {};
  if (!id || !String(nome || '').trim()) return erro(400, 'id e nome sao obrigatorios');
  if (link && !LINK_HTTP_HTTPS.test(link)) return erro(400, 'link precisa comecar com http:// ou https://');
  if (!valorValido(cloaker, CLOAKER_VALIDOS)) return erro(400, 'cloaker precisa ser sim, nao, talvez ou vazio');
  if (!valorValido(tipo_produto, TIPO_PRODUTO_VALIDOS)) {
    return erro(400, 'tipo_produto precisa ser infoproduto, nao_identificado ou vazio');
  }

  if (coreRuntimeEnabled()) {
    try {
      const linha = await coreRequest('create_offer', { offer: {
        id, nome, formato: formato ?? null, nicho: nicho ?? null, idioma: idioma ?? null,
        link: link ?? null, cloaker: cloaker ?? null, tipo_produto: tipo_produto ?? null
      } });
      return json(201, linha);
    } catch (e) {
      if (e instanceof CoreRuntimeError && e.status === 409) return erro(409, 'conflito ao criar a oferta');
      throw e;
    }
  }

  try {
    // indice unico funcional em lower(nome) (correcao verificada pelo pvs-master ao ADR-001): o
    // app compara nomes de oferta em minusculas (index.html linhas 1097 e 1157), entao
    // "Protocolo X" e "protocolo x" tem que colidir aqui tambem — nao so um UNIQUE(nome) cru.
    const linhas = await sql`
      insert into spy.ofertas (id, nome, formato, nicho, idioma, link, cloaker, tipo_produto)
      values (
        ${id}, ${nome}, ${formato ?? null}, ${nicho ?? null}, ${idioma ?? null}, ${link ?? null},
        ${cloaker ?? null}, ${tipo_produto ?? null}
      )
      on conflict (lower(nome)) do nothing
      returning id, nome, formato, nicho, idioma, link, cloaker, tipo_produto
    `;
    if (linhas.length === 0) return erro(409, 'ja existe uma oferta com esse nome');
    return json(201, linhas[0]);
  } catch (e) {
    if (e instanceof PostgresError && e.code === '23505') return erro(409, 'conflito ao criar a oferta');
    throw e;
  }
}

async function editar(request, id) {
  if (!id) return erro(400, 'query id e obrigatoria');
  let corpo;
  try { corpo = await request.json(); } catch { return erro(400, 'corpo invalido'); }
  if ('link' in (corpo || {}) && corpo.link && !LINK_HTTP_HTTPS.test(corpo.link)) {
    return erro(400, 'link precisa comecar com http:// ou https://');
  }
  if ('cloaker' in (corpo || {}) && !valorValido(corpo.cloaker, CLOAKER_VALIDOS)) {
    return erro(400, 'cloaker precisa ser sim, nao, talvez ou vazio');
  }
  if ('tipo_produto' in (corpo || {}) && !valorValido(corpo.tipo_produto, TIPO_PRODUTO_VALIDOS)) {
    return erro(400, 'tipo_produto precisa ser infoproduto, nao_identificado ou vazio');
  }

  // campo so entra na query se vier explicitamente no corpo — permite PATCH parcial (edita so o
  // link, por exemplo, sem precisar reenviar os outros campos).
  const sets = [];
  const valores = [];
  for (const campo of CAMPOS_EDITAVEIS) {
    if (campo in (corpo || {})) {
      valores.push(corpo[campo]);
      sets.push(`${campo} = $${valores.length}`); // campo vem so da whitelist acima, nunca de chave arbitraria do corpo
    }
  }
  if (sets.length === 0) return erro(400, 'nenhum campo valido para atualizar');
  valores.push(id);

  if (coreRuntimeEnabled()) {
    const patch = {};
    for (const campo of CAMPOS_EDITAVEIS) if (campo in (corpo || {})) patch[campo] = corpo[campo];
    try {
      const linha = await coreRequest('patch_offer', { id, patch });
      if (!linha) return erro(404, 'oferta nao encontrada');
      return json(200, linha);
    } catch (e) {
      if (e instanceof CoreRuntimeError && e.status === 409) return erro(409, 'ja existe uma oferta com esse nome');
      throw e;
    }
  }

  try {
    // sql.unsafe: SQL montado com posicoes de campo controladas (whitelist CAMPOS_EDITAVEIS
    // acima, nunca chave arbitraria do corpo) — os VALORES continuam parametrizados via $n,
    // equivalente ao sql.query(text, params) do driver anterior.
    const linhas = await sql.unsafe(
      `update spy.ofertas set ${sets.join(', ')}, atualizado_em = now() where id = $${valores.length}
       returning id, nome, formato, nicho, idioma, link, cloaker, tipo_produto`,
      valores
    );
    if (linhas.length === 0) return erro(404, 'oferta nao encontrada');
    return json(200, linhas[0]);
  } catch (e) {
    if (e instanceof PostgresError && e.code === '23505') return erro(409, 'ja existe uma oferta com esse nome');
    throw e;
  }
}

async function remover(id) {
  if (!id) return erro(400, 'query id e obrigatoria');
  if (coreRuntimeEnabled()) {
    const ok = await coreRequest('delete_offer', { id });
    if (!ok) return erro(404, 'oferta nao encontrada');
    return json(200, { ok: true });
  }
  const linhas = await sql`delete from spy.ofertas where id = ${id} returning id`;
  if (linhas.length === 0) return erro(404, 'oferta nao encontrada');
  return json(200, { ok: true });
}
