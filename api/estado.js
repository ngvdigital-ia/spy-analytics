// api/estado.js
// GET /api/estado — devolve ofertas + leituras + pesos + tolerancia de uma vez (ADR-001 secao 4).
//
// Tabelas qualificadas com o prefixo "spy." em vez de `SET search_path`: as 3 queries abaixo
// rodam em paralelo via Promise.all, sem ordem garantida, e um pool de conexoes (Supabase
// Supavisor, modo transaction) pode servir cada query numa conexao fisica diferente — um `SET
// search_path` numa delas nao teria como garantir efeito nas outras. Prefixo explicito e mais
// chato de ler, mas nunca depende de estado de sessao/conexao compartilhado.
// O schema "spy" isola este produto do "public" do projeto Supabase "apps-ofertas"
// (compartilhado — tem tabelas de compra de cliente real). A app conecta com um role restrito
// (spy_app, ver setup-role.sql) que so enxerga "spy" — nunca "public". Ver README.md.
import { sql } from './_db.js';
import { exigirAuth, json, erro, tratarErroInesperado } from './_auth.js';

const PESOS_PADRAO = { estab: 45, vol: 30, tempo: 25 };
const TOLERANCIA_PADRAO = 20;

export default {
  async fetch(request) {
    try {
      if (request.method !== 'GET') return erro(405, 'metodo nao permitido');
      const naoAutorizado = exigirAuth(request);
      if (naoAutorizado) return naoAutorizado;

      const [ofertas, leituraRows, configRows, prontasRows] = await Promise.all([
        sql`select id, nome, formato, nicho, idioma, link, cloaker, tipo_produto from spy.ofertas order by criado_em asc`,
        // to_char forca 'YYYY-MM-DD' explicito: o driver por padrao parseia "date" como objeto
        // Date, e o front (index.html) compara l.data === 'YYYY-MM-DD' como string exata.
        sql`select id, oferta_id, to_char(data, 'YYYY-MM-DD') as data, periodo, ads
            from spy.leituras order by data asc`,
        sql`select pesos, tolerancia from spy.config where id = 1`,
        // Aba "Prontas pra modelar" (ADR-002) — a regra mora só na view
        // spy.ofertas_prontas_pra_modelar (migrations/002), nunca reimplementada aqui. Mesma
        // view que api/cron-prontas.js consulta pra notificar o Slack — fonte única. Não toca
        // na régua existente (traduzir/candidata forte/observar/descartar), que é calculada
        // 100% no client a partir de ofertas+leituras.
        sql`select oferta_id from spy.ofertas_prontas_pra_modelar`
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
        tolerancia: config?.tolerancia ?? TOLERANCIA_PADRAO,
        prontasParaModelar: prontasRows.map(r => r.oferta_id)
      });
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};
