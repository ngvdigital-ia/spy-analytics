// api/leituras.js
// POST grava um lote de leituras (upsert por chave de negocio) — PATCH ?id= corrige ads —
// DELETE ?id= remove uma leitura. ADR-001 secoes 3 e 4.
// Tabela qualificada com "spy." — ver nota de prefixo explicito vs search_path em api/estado.js.
import { neon, NeonDbError } from '@neondatabase/serverless';
import { exigirAuth, json, erro, tratarErroInesperado } from './_auth.js';

const sql = neon(process.env.DATABASE_URL);
const PERIODOS_VALIDOS = new Set(['manha', 'noite']);

export default {
  async fetch(request) {
    try {
      const naoAutorizado = exigirAuth(request);
      if (naoAutorizado) return naoAutorizado;

      const url = new URL(request.url);
      const id = url.searchParams.get('id');

      if (request.method === 'POST') return gravarLote(request);
      if (request.method === 'PATCH') return editar(request, id);
      if (request.method === 'DELETE') return remover(id);
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

  // upsert por chave de negocio (oferta_id, data, periodo), NAO pelo id gerado no client — e
  // essa restricao unica que resolve a corrida de Gabriel e Robert lancando a mesma leitura
  // quase ao mesmo tempo (ADR-001 secao 3): o ultimo valor de ads enviado vence, mesma linha do
  // banco, id original preservado.
  const queries = itens.map(item => sql`
    insert into spy.leituras (id, oferta_id, data, periodo, ads)
    values (${item.id}, ${item.ofertaId}, ${item.data}, ${item.periodo}, ${item.ads})
    on conflict (oferta_id, data, periodo)
    do update set ads = excluded.ads, atualizado_em = now()
    returning id, oferta_id, to_char(data, 'YYYY-MM-DD') as data, periodo, ads
  `);

  try {
    const resultados = await sql.transaction(queries);
    const leituras = resultados.map(([linha]) => ({
      id: linha.id, ofertaId: linha.oferta_id, data: linha.data, periodo: linha.periodo, ads: linha.ads
    }));
    return json(200, { leituras });
  } catch (e) {
    if (e instanceof NeonDbError && e.code === '23503') return erro(400, 'ofertaId inexistente');
    throw e;
  }
}

async function editar(request, id) {
  if (!id) return erro(400, 'query id e obrigatoria');
  let corpo;
  try { corpo = await request.json(); } catch { return erro(400, 'corpo invalido'); }
  const ads = corpo?.ads;
  if (!Number.isInteger(ads) || ads < 0) return erro(400, 'ads precisa ser inteiro >= 0');

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
  const linhas = await sql`delete from spy.leituras where id = ${id} returning id`;
  if (linhas.length === 0) return erro(404, 'leitura nao encontrada');
  return json(200, { ok: true });
}
