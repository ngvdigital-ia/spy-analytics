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
// MUDANCA DE CONTRATO — 17/08/2026, decisao do operador (consolidacao de 6 bancos em 1):
// o payload passou a levar, ALEM do resumo, as LINHAS do Spy no campo `rows`. Antes ele
// mandava so 4 contagens de proposito, e por isso o schema ngv_spy do Core ficava vazio.
// O Spy vive num projeto Supabase COMPARTILHADO com o apps-ofertas; migrar as linhas pro
// Core e o que permite desligar aquele projeto sem derrubar dois sistemas.
//
// O que `rows` carrega: ofertas observadas (dominio/link publico do anunciante na Biblioteca
// de Anuncios do Meta), leituras de contagem de ads, e a config de pesos. NAO ha dado de
// cliente da NGV aqui — e pesquisa de concorrente, publica por natureza. A regra de nao
// vazar PII segue valendo; o que mudou e que dado individual DE PESQUISA agora trafega.
//
// Regras de seguranca:
//   - sem CRON_SECRET: recusa toda chamada (fail-closed);
//   - sem NGV_CORE_WRITER_KEY: responde "configuracao ausente" SEM consultar banco nem
//     rede (o check vem antes da query e do fetch);
//   - o POST nunca segue redirect e so aceita 2xx; rede/timeout/rejeicao vira 502 sanitizado;
//   - logs nunca imprimem a chave, o body do payload nem linha individual.
import crypto from 'node:crypto';
import { json, erro, tratarErroInesperado } from './_auth.js';
import { sql } from './_db.js';
import { coreRequest, coreRuntimeEnabled } from './_core.js';
import { montarResumo } from './resumo.js';

export const NGV_CORE_INGEST_URL =
  'https://givqkglqwdizrpityafz.supabase.co/functions/v1/spy-snapshot-ingest';
export const SYNC_TIMEOUT_MS = 10_000;

/**
 * Monta o bloco `rows` do payload. Funcao PURA de proposito: o handler consulta o banco e nao
 * da pra testar sem credencial, entao a regra de "o que vai no lote" mora aqui, onde da pra
 * provar. `config` ausente = campo omitido (o Core trata como "nao mexe na config").
 */
export function montarLinhas(ofertas, leituras, config) {
  return {
    ofertas,
    leituras,
    ...(config.length > 0 ? { config: config[0] } : {})
  };
}

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
        'x-ngv-core-key': apiKey
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

async function lerSnapshotLegado() {
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
  const [ofertas, leituras, config] = await Promise.all([
    sql`select id, nome, formato, nicho, idioma, link, criado_em, atualizado_em,
               cloaker, tipo_produto, pronta_pra_modelar, pronta_notificada_em
          from spy.ofertas`,
    sql`select id, oferta_id, data, periodo, ads, atualizado_em from spy.leituras`,
    sql`select pesos, tolerancia, atualizado_em from spy.config where id = 1`
  ]);

  snapshot.rows = montarLinhas(ofertas, leituras, config);
  if (ofertas.length > 4000 || leituras.length > 40000) {
    console.warn(
      `sync-ngv-core: lote perto do teto (${ofertas.length} ofertas, ${leituras.length} leituras)`
    );
  }
  return snapshot;
}

/**
 * Resolve a fonte do snapshot sem manter dois writers concorrentes. Depois do cutover, as
 * linhas já vivem no NGV Core: relê-las pela Edge privada e reenviá-las ao mesmo banco seria
 * redundante. O cron atualiza somente a projeção agregada. O leitor Postgres legado continua
 * disponível exclusivamente para rollback com o projeto antigo restaurado.
 */
export async function obterSnapshotParaEnvio({
  runtimeAtivo = coreRuntimeEnabled(),
  coreRequestImpl = coreRequest,
  lerLegadoImpl = lerSnapshotLegado
} = {}) {
  if (runtimeAtivo) {
    return montarResumo(await coreRequestImpl('summary', {}));
  }
  return lerLegadoImpl();
}

export function createSyncHandler({
  env = process.env,
  obterSnapshotImpl = obterSnapshotParaEnvio,
  postarSnapshotImpl = postarSnapshot
} = {}) {
  return {
    async fetch(request) {
    try {
      if (request.method !== 'GET') return erro(405, 'metodo nao permitido');
      if (!syncAutorizado(request, env.CRON_SECRET)) return erro(401, 'nao autorizado');

      const apiKey = env.NGV_CORE_WRITER_KEY;
      if (typeof apiKey !== 'string' || apiKey.length === 0) {
        return erro(503, 'configuracao ausente: NGV_CORE_WRITER_KEY nao definida');
      }

      const snapshot = await obterSnapshotImpl();

      let resultado;
      try {
        resultado = await postarSnapshotImpl(snapshot, { apiKey });
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
}

export default createSyncHandler();
