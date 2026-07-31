// api/ofertas.js
// POST cria, PATCH ?id= edita, DELETE ?id= remove (cascata apaga leituras) — ADR-001 secao 4.
import { neon, NeonDbError } from '@neondatabase/serverless';
import { exigirAuth, json, erro, tratarErroInesperado } from './_auth.js';

const sql = neon(process.env.DATABASE_URL);
const CAMPOS_EDITAVEIS = ['nome', 'formato', 'nicho', 'idioma', 'link'];
// so http/https podem virar href no client (index.html.html) — barra scheme perigoso
// (javascript:, data:, vbscript:...) direto na borda, porque o endpoint aceita POST/PATCH
// cru de qualquer um (repo publico), sem depender da validacao do client.
const LINK_HTTP_HTTPS = /^https?:\/\//i;

export default {
  async fetch(request) {
    try {
      const naoAutorizado = exigirAuth(request);
      if (naoAutorizado) return naoAutorizado;

      const url = new URL(request.url);
      const id = url.searchParams.get('id');

      if (request.method === 'POST') return criar(request);
      if (request.method === 'PATCH') return editar(request, id);
      if (request.method === 'DELETE') return remover(id);
      return erro(405, 'metodo nao permitido');
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};

async function criar(request) {
  let corpo;
  try { corpo = await request.json(); } catch { return erro(400, 'corpo invalido'); }
  const { id, nome, formato, nicho, idioma, link } = corpo || {};
  if (!id || !String(nome || '').trim()) return erro(400, 'id e nome sao obrigatorios');
  if (link && !LINK_HTTP_HTTPS.test(link)) return erro(400, 'link precisa comecar com http:// ou https://');

  try {
    // indice unico funcional em lower(nome) (correcao verificada pelo pvs-master ao ADR-001): o
    // app compara nomes de oferta em minusculas (index.html.html linhas 1097 e 1157), entao
    // "Protocolo X" e "protocolo x" tem que colidir aqui tambem — nao so um UNIQUE(nome) cru.
    const linhas = await sql`
      insert into ofertas (id, nome, formato, nicho, idioma, link)
      values (${id}, ${nome}, ${formato ?? null}, ${nicho ?? null}, ${idioma ?? null}, ${link ?? null})
      on conflict (lower(nome)) do nothing
      returning id, nome, formato, nicho, idioma, link
    `;
    if (linhas.length === 0) return erro(409, 'ja existe uma oferta com esse nome');
    return json(201, linhas[0]);
  } catch (e) {
    if (e instanceof NeonDbError && e.code === '23505') return erro(409, 'conflito ao criar a oferta');
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

  try {
    const linhas = await sql.query(
      `update ofertas set ${sets.join(', ')}, atualizado_em = now() where id = $${valores.length}
       returning id, nome, formato, nicho, idioma, link`,
      valores
    );
    if (linhas.length === 0) return erro(404, 'oferta nao encontrada');
    return json(200, linhas[0]);
  } catch (e) {
    if (e instanceof NeonDbError && e.code === '23505') return erro(409, 'ja existe uma oferta com esse nome');
    throw e;
  }
}

async function remover(id) {
  if (!id) return erro(400, 'query id e obrigatoria');
  const linhas = await sql`delete from ofertas where id = ${id} returning id`;
  if (linhas.length === 0) return erro(404, 'oferta nao encontrada');
  return json(200, { ok: true });
}
