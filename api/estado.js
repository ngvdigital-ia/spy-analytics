// api/estado.js
// GET /api/estado — devolve ofertas + leituras + pesos + tolerancia de uma vez (ADR-001 secao 4).
import { neon } from '@neondatabase/serverless';
import { exigirAuth, json, erro, tratarErroInesperado } from './_auth.js';

const sql = neon(process.env.DATABASE_URL);

const PESOS_PADRAO = { estab: 45, vol: 30, tempo: 25 };
const TOLERANCIA_PADRAO = 20;

export default {
  async fetch(request) {
    try {
      if (request.method !== 'GET') return erro(405, 'metodo nao permitido');
      const naoAutorizado = exigirAuth(request);
      if (naoAutorizado) return naoAutorizado;

      const [ofertas, leituraRows, configRows] = await Promise.all([
        sql`select id, nome, formato, nicho, idioma, link from ofertas order by criado_em asc`,
        // to_char forca 'YYYY-MM-DD' explicito: o driver por padrao parseia "date" como objeto
        // Date, e o front (index.html) compara l.data === 'YYYY-MM-DD' como string exata.
        sql`select id, oferta_id, to_char(data, 'YYYY-MM-DD') as data, periodo, ads
            from leituras order by data asc`,
        sql`select pesos, tolerancia from config where id = 1`
      ]);

      // banco usa oferta_id (snake_case); o front ja espera ofertaId (camelCase, ver
      // index.html). Conversao acontece so aqui, na borda — a API devolve exatamente o
      // shape que o app de hoje ja consome (ADR-001 secao 5), pra onda 2 ser cirurgica.
      const leituras = leituraRows.map(l => ({
        id: l.id, ofertaId: l.oferta_id, data: l.data, periodo: l.periodo, ads: l.ads
      }));

      const config = configRows[0];
      return json(200, {
        ofertas,
        leituras,
        pesos: config?.pesos ?? PESOS_PADRAO,
        tolerancia: config?.tolerancia ?? TOLERANCIA_PADRAO
      });
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};
