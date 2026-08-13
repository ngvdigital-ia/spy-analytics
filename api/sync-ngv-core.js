// api/sync-ngv-core.js
// GET /api/sync-ngv-core — emissor automatico Spy -> NGV Core (cron diario, vercel.json).
//
// Uma vez por dia, agrega o resumo sanitizado do Spy e POSTa no endpoint de ingestao do NGV
// Core (spy-snapshot-ingest). Reusa o MESMO contrato do api/resumo.js (os 9 campos agregados,
// janela de 30 dias) e a MESMA query agregada — mas NAO chama /api/resumo via HTTP e NAO
// depende da flag SPY_PROJECTION_ENABLED: a leitura do banco acontece direto aqui, server-side.
//
// Autorizacao: Bearer CRON_SECRET (mesma regra do /api/cron-prontas) — cron nao tem cookie, e
// o endpoint nao usa sessao/cookie de jeito nenhum. A secret API key do NGV Core fica SO no
// server e nunca vai pra log nem pra resposta.
//
// Regras de seguranca:
//   - sem CRON_SECRET: recusa toda chamada (fail-closed);
//   - sem NGV_CORE_WRITER_KEY: responde "configuracao ausente" SEM consultar banco nem
//     rede (o check vem antes da query e do fetch);
//   - o POST nunca segue redirect e so aceita 2xx; rede/timeout/rejeicao vira 502 sanitizado;
//   - logs nunca imprimem a chave, o body do payload nem dados individuais.
import crypto from 'node:crypto';
import { sql } from './_db.js';
import { json, erro, tratarErroInesperado } from './_auth.js';
import { montarResumo } from './resumo.js';

export const NGV_CORE_INGEST_URL =
  'https://givqkglqwdizrpityafz.supabase.co/functions/v1/spy-snapshot-ingest';
export const SYNC_TIMEOUT_MS = 10_000;

export function syncAutorizado(request, secret = process.env.CRON_SECRET) {
  if (typeof secret !== 'string' || secret.length === 0) return false; // fail-closed
  const cabecalho = request.headers.get('authorization') || '';
  const esperado = `Bearer ${secret}`;
  const a = Buffer.from(cabecalho);
  const b = Buffer.from(esperado);
  // tamanhos diferentes: nao compara com timingSafeEqual (lançaria), so' reprova direto.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * POSTa o snapshot agregado no NGV Core. Retorna { ok, status }. Lanca se a rede falhar ou
 * estourar o timeout (AbortController) — o chamador converte em 502 sanitizado. NAO segue
 * redirect (redirect: 'manual') e considera 2xx como sucesso (response.ok).
 */
export async function postarSnapshot(
  payload,
  { url = NGV_CORE_INGEST_URL, apiKey, fetchImpl = fetch, timeoutMs = SYNC_TIMEOUT_MS }
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: apiKey
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request) {
    try {
      if (request.method !== 'GET') return erro(405, 'metodo nao permitido');
      if (!syncAutorizado(request)) return erro(401, 'nao autorizado');

      const apiKey = process.env.NGV_CORE_WRITER_KEY;
      if (typeof apiKey !== 'string' || apiKey.length === 0) {
        return erro(503, 'configuracao ausente: NGV_CORE_WRITER_KEY nao definida');
      }

      // MESMA query agregada do api/resumo.js (fonte unica do contrato) — se o resumo mudar,
      // esta query tem que acompanhar junto. Unica consulta do fluxo, sem IDs/URLs/linhas
      // individuais na resposta.
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

      const snapshot = montarResumo(row);

      let resultado;
      try {
        resultado = await postarSnapshot(snapshot, { apiKey });
      } catch (e) {
        // rede/timeout: loga so nome+mensagem do erro (nunca a chave nem o body).
        console.error('sync-ngv-core: falha de rede/timeout no POST para o NGV Core', e.name, e.message);
        return erro(502, 'falha ao enviar snapshot para o NGV Core');
      }

      if (!resultado.ok) {
        console.error(`sync-ngv-core: NGV Core rejeitou o snapshot (status ${resultado.status})`);
        return erro(502, 'falha ao enviar snapshot para o NGV Core');
      }

      return json(200, { ok: true, enviadoEm: snapshot.generated_at, statusRecebido: resultado.status });
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};
