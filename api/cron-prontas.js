// api/cron-prontas.js
// GET /api/cron-prontas — chamado pelo Vercel Cron (vercel.json), 2x/dia (~1h depois de cada
// janela de lançamento do time — 8h e 20h BRT = 11h e 23h UTC, Brasília é UTC-3 fixo, sem
// horário de verão desde 2019; ver README seção "Cron de notificação"). Vercel manda
// "Authorization: Bearer $CRON_SECRET" nessa chamada (confirmado na doc oficial,
// vercel.com/docs/cron-jobs) — validamos contra CRON_SECRET, nunca contra o cookie de sessão
// (cron não é browser, não tem cookie).
//
// A regra de quem está "pronta pra modelar" mora só em spy.ofertas_prontas_pra_modelar
// (migrations/002) — este arquivo NUNCA reimplementa o filtro, só reage à TRANSIÇÃO de estado:
//   - entrou na view agora (estava pronta_pra_modelar=false) -> tenta notificar o Slack; só
//     marca pronta_pra_modelar=true e grava pronta_notificada_em SE o POST ao Slack teve
//     sucesso. Sem sucesso (webhook ausente OU envio falhou), fica pendente pro próximo cron —
//     mesmo tratamento pros dois casos, de propósito (ver README).
//   - saiu da view (estava pronta_pra_modelar=true e não está mais) -> só zera a flag, NUNCA
//     notifica (saída não foi pedida pelo Diogo).
//   - continua dentro (já estava true e ainda está na view) -> não faz nada, não notifica de
//     novo (é isso que garante "3 execuções seguidas com a mesma oferta qualificada = 1
//     notificação só" — a 2ª e 3ª execução não encontram transição de entrada).
// Sair e voltar a qualificar NOTIFICA de novo, intencional (é informação nova pro time) — ver
// ADR-002 seção 5.
//
// Não mexe na régua existente do app (traduzir/candidata forte/observar/descartar) — essa régua
// mora 100% no client (index.html) e não depende de nada aqui.
import crypto from 'node:crypto';
import { sql } from './_db.js';
import { json, erro, tratarErroInesperado } from './_auth.js';

function cronAutorizado(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // sem CRON_SECRET configurada: fail-closed, nunca autoriza
  const cabecalho = request.headers.get('authorization') || '';
  const esperado = `Bearer ${secret}`;
  const a = Buffer.from(cabecalho);
  const b = Buffer.from(esperado);
  // tamanhos diferentes: nao compara com timingSafeEqual (lançaria), so' reprova direto.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function montarMensagem(o) {
  const linhas = [
    `*${o.nome}* está pronta pra modelar`,
    o.formato ? `Formato: ${o.formato}` : null,
    o.nicho ? `Nicho: ${o.nicho}` : null,
    o.idioma ? `Idioma: ${o.idioma}` : null,
    `Última leitura: ${o.ads_ultima} anúncios (${o.data_ultima})`,
    `Primeira leitura: ${o.ads_primeira} anúncios (${o.data_primeira})`,
    `${o.dias_distintos} dias distintos monitorados`,
    o.link ? `Link: ${o.link}` : null
  ];
  return linhas.filter(Boolean).join('\n');
}

// true = Slack aceitou (200 da API de Incoming Webhook); false = qualquer outra coisa (erro de
// rede, timeout, status != 2xx) — chamador nunca marca como notificada nesse caso.
async function notificarSlack(webhookUrl, oferta) {
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: montarMensagem(oferta) })
    });
    return r.ok;
  } catch (e) {
    console.error('cron-prontas: erro de rede notificando Slack', oferta.oferta_id, e);
    return false;
  }
}

export default {
  async fetch(request) {
    try {
      if (request.method !== 'GET') return erro(405, 'metodo nao permitido');
      if (!cronAutorizado(request)) return erro(401, 'nao autorizado');

      // to_char forca 'YYYY-MM-DD' explicito — mesmo motivo do api/estado.js (driver parseia
      // "date" como objeto Date por padrao).
      const [entradas, saidas] = await Promise.all([
        sql`
          select v.oferta_id, v.nome, v.formato, v.nicho, v.idioma, v.link,
                 v.dias_distintos, to_char(v.data_primeira, 'YYYY-MM-DD') as data_primeira,
                 v.ads_primeira, to_char(v.data_ultima, 'YYYY-MM-DD') as data_ultima, v.ads_ultima
          from spy.ofertas_prontas_pra_modelar v
          join spy.ofertas o on o.id = v.oferta_id
          where o.pronta_pra_modelar = false
        `,
        sql`
          select o.id
          from spy.ofertas o
          where o.pronta_pra_modelar = true
            and not exists (
              select 1 from spy.ofertas_prontas_pra_modelar v where v.oferta_id = o.id
            )
        `
      ]);

      if (saidas.length) {
        const idsSairam = saidas.map(s => s.id);
        await sql`update spy.ofertas set pronta_pra_modelar = false where id = any(${idsSairam})`;
      }

      const webhookUrl = process.env.SLACK_WEBHOOK_URL;
      let notificadas = 0;
      let falhas = 0;

      if (!webhookUrl) {
        if (entradas.length) {
          console.warn(
            `cron-prontas: SLACK_WEBHOOK_URL nao configurada — ${entradas.length} oferta(s) ` +
            'pronta(s) NAO notificada(s), ficam pendentes pro proximo cron'
          );
        }
      } else {
        for (const oferta of entradas) {
          const ok = await notificarSlack(webhookUrl, oferta);
          if (ok) {
            await sql`
              update spy.ofertas set pronta_pra_modelar = true, pronta_notificada_em = now()
              where id = ${oferta.oferta_id}
            `;
            notificadas++;
          } else {
            falhas++;
            console.error(
              `cron-prontas: falha ao notificar Slack pra oferta ${oferta.oferta_id} — ` +
              'fica pendente pro proximo cron'
            );
          }
        }
      }

      return json(200, {
        ok: true,
        entradasDetectadas: entradas.length,
        notificadas,
        falhas,
        semWebhook: !webhookUrl,
        saidas: saidas.length
      });
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};
