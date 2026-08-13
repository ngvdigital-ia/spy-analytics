// GET /api/resumo — projeção interna read-only para consumidores server-to-server.
//
// Este endpoint fica fechado até SPY_PROJECTION_ENABLED=true. Quando aberto, aceita somente
// Bearer SPY_PROJECTION_SECRET; não reutiliza a sessão humana, cookies ou qualquer segredo do
// dashboard/cron. A resposta é deliberadamente agregada: não expõe IDs, URLs, chaves, PII,
// ofertas individuais ou leituras individuais.
import crypto from 'node:crypto';
import { sql } from './_db.js';
import { json, erro, tratarErroInesperado } from './_auth.js';

export const WINDOW_DAYS = 30;
export const SUMMARY_SCHEMA_VERSION = 1;

function flagAtiva() {
  return process.env.SPY_PROJECTION_ENABLED === 'true';
}

export function projecaoAutorizada(request, secret = process.env.SPY_PROJECTION_SECRET) {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const segredosDeOutrosFluxos = [
    process.env.DASHBOARD_PASSWORD,
    process.env.SESSION_SECRET,
    process.env.CRON_SECRET
  ];
  if (segredosDeOutrosFluxos.some((valor) => typeof valor === 'string' && valor.length > 0 && valor === secret)) {
    return false;
  }
  const recebido = request.headers.get('authorization') || '';
  const esperado = `Bearer ${secret}`;
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function montarResumo(row, generatedAt = new Date().toISOString()) {
  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    source: 'spy-analytics',
    status: 'ready',
    generated_at: generatedAt,
    window_days: WINDOW_DAYS,
    offers_observed: Number(row.offers_observed),
    readings_observed: Number(row.readings_observed),
    distinct_reading_days: Number(row.distinct_reading_days),
    ready_to_model: Number(row.ready_to_model)
  };
}

export default {
  async fetch(request) {
    try {
      if (request.method !== 'GET') return erro(405, 'metodo nao permitido');
      if (!flagAtiva()) return erro(404, 'endpoint nao encontrado');
      if (!projecaoAutorizada(request)) return erro(401, 'nao autorizado');

      const [row] = await sql`
        select
          count(distinct l.oferta_id)::int as offers_observed,
          count(*)::int as readings_observed,
          count(distinct l.data)::int as distinct_reading_days,
          (select count(*)::int from spy.ofertas_prontas_pra_modelar) as ready_to_model
        from spy.leituras l
        where l.data >= current_date - interval '29 days'
          and l.data <= current_date
      `;

      return json(200, montarResumo(row));
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};
