// api/leituras.js
// POST grava um lote de leituras (upsert por chave de negocio) — PATCH ?id= corrige ads —
// DELETE ?id= remove uma leitura. ADR-001 secoes 3 e 4.
// Tabela qualificada com "spy." — ver nota de prefixo explicito vs search_path em api/estado.js.
import { sql, PostgresError } from './_db.js';
import { exigirAuth, json, erro, tratarErroInesperado } from './_auth.js';
import { CoreRuntimeError, coreRuntimeEnabled, coreRequest } from './_core.js';

const PERIODOS_VALIDOS = new Set(['manha', 'noite']);

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
      if (request.method === 'POST') return await gravarLote(request);
      if (request.method === 'PATCH') return await editar(request, id);
      if (request.method === 'DELETE') return await remover(id);
      return erro(405, 'metodo nao permitido');
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};

function validar(item) {
  if (!item || typeof item !== 'object') return 'item invalido';
  if (!item.id || !item.ofertaId) return 'id e ofertaId sao obrigatorios';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.data || '')) return 'data precisa ser YYYY-MM-DD';
  if (!PERIODOS_VALIDOS.has(item.periodo)) return 'periodo precisa ser manha ou noite';
  if (!Number.isInteger(item.ads) || item.ads < 0) return 'ads precisa ser inteiro >= 0';
  return null;
}

async function gravarLote(request) {
  let corpo;
  try { corpo = await request.json(); } catch { return erro(400, 'corpo invalido'); }
  const itens = corpo?.itens;
  if (!Array.isArray(itens) || itens.length === 0) return erro(400, 'itens precisa ser uma lista nao vazia');

  for (const item of itens) {
    const problema = validar(item);
    if (problema) return erro(400, problema);
  }

  if (coreRuntimeEnabled()) {
    try {
      return json(200, { leituras: await coreRequest('upsert_readings', { items: itens }) });
    } catch (e) {
      if (e instanceof CoreRuntimeError && e.status === 400) return erro(400, 'ofertaId inexistente');
      throw e;
    }
  }

  // upsert por chave de negocio (oferta_id, data, periodo), NAO pelo id gerado no client — e
  // essa restricao unica que resolve a corrida de Gabriel e Robert lancando a mesma leitura
  // quase ao mesmo tempo (ADR-001 secao 3): o ultimo valor de ads enviado vence, mesma linha do
  // banco, id original preservado.
  // sql.begin: equivalente ao sql.transaction([...]) do driver anterior (que recebia o array de
  // queries ja montado); aqui a mesma lista de queries roda em loop dentro de UMA transacao, na
  // MESMA conexao fisica que o pool reserva pro sql.begin inteiro — o SQL de cada insert e
  // identico ao de antes, so a forma de disparar em lote mudou.
  try {
    const leituras = await sql.begin(async (tx) => {
      const linhas = [];
      for (const item of itens) {
        const [linha] = await tx`
          insert into spy.leituras (id, oferta_id, data, periodo, ads)
          values (${item.id}, ${item.ofertaId}, ${item.data}, ${item.periodo}, ${item.ads})
          on conflict (oferta_id, data, periodo)
          do update set ads = excluded.ads, atualizado_em = now()
          returning id, oferta_id, to_char(data, 'YYYY-MM-DD') as data, periodo, ads
        `;
        linhas.push({ id: linha.id, ofertaId: linha.oferta_id, data: linha.data, periodo: linha.periodo, ads: linha.ads });
      }
      return linhas;
    });
    return json(200, { leituras });
  } catch (e) {
    if (e instanceof PostgresError && e.code === '23503') return erro(400, 'ofertaId inexistente');
    throw e;
  }
}

async function editar(request, id) {
  if (!id) return erro(400, 'query id e obrigatoria');
  let corpo;
  try { corpo = await request.json(); } catch { return erro(400, 'corpo invalido'); }
  const ads = corpo?.ads;
  if (!Number.isInteger(ads) || ads < 0) return erro(400, 'ads precisa ser inteiro >= 0');

  if (coreRuntimeEnabled()) {
    const linha = await coreRequest('patch_reading', { id, ads });
    if (!linha) return erro(404, 'leitura nao encontrada');
    return json(200, linha);
  }

  const linhas = await sql`
    update spy.leituras set ads = ${ads}, atualizado_em = now()
    where id = ${id}
    returning id, oferta_id, to_char(data, 'YYYY-MM-DD') as data, periodo, ads
  `;
  if (linhas.length === 0) return erro(404, 'leitura nao encontrada');
  const l = linhas[0];
  return json(200, { id: l.id, ofertaId: l.oferta_id, data: l.data, periodo: l.periodo, ads: l.ads });
}

async function remover(id) {
  if (!id) return erro(400, 'query id e obrigatoria');
  if (coreRuntimeEnabled()) {
    const ok = await coreRequest('delete_reading', { id });
    if (!ok) return erro(404, 'leitura nao encontrada');
    return json(200, { ok: true });
  }
  const linhas = await sql`delete from spy.leituras where id = ${id} returning id`;
  if (linhas.length === 0) return erro(404, 'leitura nao encontrada');
  return json(200, { ok: true });
}
