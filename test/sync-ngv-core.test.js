import assert from 'node:assert/strict';
import test from 'node:test';
import { montarResumo } from '../api/resumo.js';
import {
  syncAutorizado,
  postarSnapshot,
  montarLinhas,
  obterSnapshotParaEnvio,
  createSyncHandler,
  NGV_CORE_INGEST_URL
} from '../api/sync-ngv-core.js';

// ── o lote de linhas (contrato novo de 17/08/2026) ────────────────────────────────────────
// Estes testes existem porque o teste de transporte NAO cobre o que o handler monta — ele
// passou verde quando o payload mudou de agregado-only para agregado + linhas.

const OFERTA = {
  id: 'abc123', nome: 'CONCORRENTE.COM', formato: 'VSL', nicho: 'E.D', idioma: 'Ingles',
  link: 'https://www.facebook.com/ads/library/?q=concorrente.com',
  criado_em: '2026-08-01T14:36:44.959Z', atualizado_em: '2026-08-02T15:46:42.819Z',
  cloaker: 'nao', tipo_produto: 'infoproduto', pronta_pra_modelar: false,
  pronta_notificada_em: null
};
const LEITURA = {
  id: 'l1', oferta_id: 'abc123', data: '2026-08-02', periodo: 'manha', ads: 137,
  atualizado_em: '2026-08-02T15:46:42.819Z'
};
const CONFIG = { pesos: { vol: 30, estab: 45, tempo: 25 }, tolerancia: 20, atualizado_em: '2026-08-03T12:59:06.698Z' };

test('lote leva ofertas e leituras inteiras — o Core precisa da linha, nao da contagem', () => {
  const rows = montarLinhas([OFERTA], [LEITURA], [CONFIG]);
  assert.deepEqual(rows.ofertas, [OFERTA]);
  assert.deepEqual(rows.leituras, [LEITURA]);
  assert.deepEqual(rows.config, CONFIG);
  // config vem como OBJETO, nao array — o Core faz jsonb_to_record e um array quebraria.
  assert.ok(!Array.isArray(rows.config));
});

test('sem config na origem: o campo e OMITIDO, nunca null', () => {
  const rows = montarLinhas([OFERTA], [LEITURA], []);
  // Omitir e nao mandar sao coisas diferentes pro Core: `config: null` reprova a validacao
  // do bloco `rows` na edge function; ausente e aceito e significa "nao mexe na config".
  assert.equal('config' in rows, false);
  assert.deepEqual(Object.keys(rows), ['ofertas', 'leituras']);
});

test('lote vazio nao vira null nem undefined — arrays vazios sao validos', () => {
  const rows = montarLinhas([], [], []);
  assert.deepEqual(rows, { ofertas: [], leituras: [] });
});

test('cutover Core: cron lê summary privada e nunca chama o Postgres legado', async () => {
  let chamadasCore = 0;
  let chamadasLegado = 0;
  const snapshot = await obterSnapshotParaEnvio({
    runtimeAtivo: true,
    coreRequestImpl: async (op, payload) => {
      chamadasCore += 1;
      assert.equal(op, 'summary');
      assert.deepEqual(payload, {});
      return {
        offers_observed: 55,
        readings_observed: 381,
        distinct_reading_days: 30,
        ready_to_model: 2
      };
    },
    lerLegadoImpl: async () => {
      chamadasLegado += 1;
      throw new Error('Postgres legado nao pode ser consultado depois do cutover');
    }
  });

  assert.equal(chamadasCore, 1);
  assert.equal(chamadasLegado, 0);
  assert.equal(snapshot.source, 'spy-analytics');
  assert.equal(snapshot.offers_observed, 55);
  assert.equal(snapshot.readings_observed, 381);
  assert.equal('rows' in snapshot, false);
});

test('rollback explícito: runtime desligado preserva o leitor legado com linhas', async () => {
  const legado = { schema_version: 1, source: 'spy-analytics', rows: { ofertas: [], leituras: [] } };
  let chamadasCore = 0;
  let chamadasLegado = 0;
  const snapshot = await obterSnapshotParaEnvio({
    runtimeAtivo: false,
    coreRequestImpl: async () => { chamadasCore += 1; },
    lerLegadoImpl: async () => { chamadasLegado += 1; return legado; }
  });
  assert.equal(chamadasCore, 0);
  assert.equal(chamadasLegado, 1);
  assert.equal(snapshot, legado);
});

test('handler consome o snapshot resolvido e confirma somente envio 2xx', async () => {
  const snapshot = montarResumo({
    offers_observed: 55,
    readings_observed: 381,
    distinct_reading_days: 30,
    ready_to_model: 2
  }, '2026-08-30T11:00:00.000Z');
  const chamadas = [];
  const endpoint = createSyncHandler({
    env: { CRON_SECRET: 'cron-secret', NGV_CORE_WRITER_KEY: 'writer-secret' },
    obterSnapshotImpl: async () => snapshot,
    postarSnapshotImpl: async (payload, options) => {
      chamadas.push({ payload, options });
      return { ok: true, status: 200 };
    }
  });

  const resposta = await endpoint.fetch(request('Bearer cron-secret'));
  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.statusRecebido, 200);
  assert.deepEqual(chamadas, [{ payload: snapshot, options: { apiKey: 'writer-secret' } }]);
});

test('o lote NAO carrega dado de cliente da NGV — so pesquisa de concorrente', () => {
  const serializado = JSON.stringify(montarLinhas([OFERTA], [LEITURA], [CONFIG]));
  // A regra que mudou foi "dado individual trafega"; a que NAO mudou e "PII de cliente nunca".
  // Coluna nova no schema `spy` que traga e-mail/telefone/documento quebra este teste.
  for (const proibido of ['email', 'e_mail', 'cpf', 'telefone', 'phone', 'senha', 'password', 'token']) {
    assert.ok(
      !serializado.toLowerCase().includes(proibido),
      `lote nao pode conter "${proibido}" — sinal de PII entrando no espelho`
    );
  }
});

const request = (authorization) => new Request('https://spy.example.test/api/sync-ngv-core', {
  method: 'GET',
  headers: authorization === undefined ? {} : { authorization }
});

function salvarEnv(nomes) {
  const anterior = Object.fromEntries(nomes.map((nome) => [nome, process.env[nome]]));
  return () => {
    for (const nome of nomes) {
      if (anterior[nome] === undefined) delete process.env[nome];
      else process.env[nome] = anterior[nome];
    }
  };
}

test('Bearer CRON_SECRET usa comparação timing-safe e falha fechado', () => {
  assert.equal(syncAutorizado(request('Bearer cron-secret'), 'cron-secret'), true);
  assert.equal(syncAutorizado(request('Bearer errado'), 'cron-secret'), false);
  assert.equal(syncAutorizado(request('Bearer cron-secret-com-sufixo'), 'cron-secret'), false);
  assert.equal(syncAutorizado(request(''), 'cron-secret'), false);
  assert.equal(syncAutorizado(request('Bearer cron-secret'), ''), false);
});

test('sem CRON_SECRET configurada: 401 fail-closed, sem banco nem rede', async () => {
  const restaurar = salvarEnv(['CRON_SECRET', 'NGV_CORE_WRITER_KEY']);
  delete process.env.CRON_SECRET;
  delete process.env.NGV_CORE_WRITER_KEY;
  const { default: endpoint } = await import('../api/sync-ngv-core.js');
  const chamadas = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (...args) => { chamadas.push(args); return Promise.reject(new Error('nao deveria chamar rede')); };
  try {
    for (const auth of ['Bearer qualquer-coisa', undefined]) {
      const resposta = await endpoint.fetch(request(auth));
      assert.equal(resposta.status, 401);
      assert.deepEqual(await resposta.json(), { erro: 'nao autorizado' });
    }
  } finally {
    globalThis.fetch = fetchOriginal;
    restaurar();
  }
  assert.equal(chamadas.length, 0);
});

test('auth inválida com CRON_SECRET válida: 401 antes de banco/rede', async () => {
  const restaurar = salvarEnv(['CRON_SECRET']);
  process.env.CRON_SECRET = 'cron-secret';
  const { default: endpoint } = await import('../api/sync-ngv-core.js');
  const chamadas = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (...args) => { chamadas.push(args); return Promise.reject(new Error('x')); };
  try {
    const resposta = await endpoint.fetch(request('Bearer senha-errada'));
    assert.equal(resposta.status, 401);
    assert.deepEqual(await resposta.json(), { erro: 'nao autorizado' });
  } finally {
    globalThis.fetch = fetchOriginal;
    restaurar();
  }
  assert.equal(chamadas.length, 0);
});

test('sem chave de writer do NGV Core: 503 configuracao ausente sem banco nem rede', async () => {
  const restaurar = salvarEnv(['CRON_SECRET', 'NGV_CORE_WRITER_KEY']);
  process.env.CRON_SECRET = 'cron-secret';
  delete process.env.NGV_CORE_WRITER_KEY;
  const { default: endpoint } = await import('../api/sync-ngv-core.js');
  const chamadas = [];
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (...args) => { chamadas.push(args); return Promise.reject(new Error('x')); };
  try {
    const resposta = await endpoint.fetch(request('Bearer cron-secret'));
    assert.equal(resposta.status, 503);
    assert.deepEqual(await resposta.json(), {
      erro: 'configuracao ausente: NGV_CORE_WRITER_KEY nao definida'
    });
  } finally {
    globalThis.fetch = fetchOriginal;
    restaurar();
  }
  assert.equal(chamadas.length, 0);
});

test('método inválido: 405', async () => {
  const { default: endpoint } = await import('../api/sync-ngv-core.js');
  const resposta = await endpoint.fetch(new Request('https://spy.example.test/api/sync-ngv-core', { method: 'POST' }));
  assert.equal(resposta.status, 405);
  assert.deepEqual(await resposta.json(), { erro: 'metodo nao permitido' });
});

// NOME CORRIGIDO em 17/08/2026. Ele dizia "sem PII nem dados individuais" e prometia uma
// garantia que nao dava: exercita `postarSnapshot()` isolado, com um snapshot montado por
// `montarResumo()` — que nunca teve `rows`. Nunca chegava perto do payload que o HANDLER
// constroi. Quando o handler passou a anexar as linhas, este teste continuou verde.
// O que ele de fato prova: o transporte nao inventa campo nem vaza a chave. So isso.
test('transporte: POST envia exatamente o objeto recebido, sem acrescentar campo', async () => {
  const snapshot = montarResumo({
    offers_observed: '3',
    readings_observed: '12',
    distinct_reading_days: '6',
    ready_to_model: '1'
  }, '2026-08-13T01:00:00.000Z');

  let capturado;
  const fetchImpl = async (url, init) => {
    capturado = { url, init };
    return new Response('ok', { status: 200 });
  };

  const resultado = await postarSnapshot(snapshot, {
    url: NGV_CORE_INGEST_URL,
    apiKey: 'ngv-secret-key',
    fetchImpl
  });

  assert.deepEqual(resultado, { ok: true, status: 200 });
  assert.equal(capturado.url, NGV_CORE_INGEST_URL);
  assert.equal(capturado.init.method, 'POST');
  assert.equal(capturado.init.headers['content-type'], 'application/json');
  assert.equal(capturado.init.headers['x-ngv-core-key'], 'ngv-secret-key');
  assert.equal(capturado.init.redirect, 'manual');
  assert.deepEqual(JSON.parse(capturado.init.body), snapshot);

  assert.deepEqual(Object.keys(snapshot), [
    'schema_version', 'source', 'status', 'generated_at', 'window_days',
    'offers_observed', 'readings_observed', 'distinct_reading_days', 'ready_to_model'
  ]);
  for (const termo of ['oferta_id', 'link', 'nome', 'http']) {
    assert.ok(!capturado.init.body.includes(termo), `payload nao deve conter ${termo}`);
  }
});

test('target: 2xx = sucesso; nao-2xx/redirect = falha; erro de rede lanca', async () => {
  const payload = montarResumo({
    offers_observed: '1',
    readings_observed: '2',
    distinct_reading_days: '1',
    ready_to_model: '0'
  });

  assert.deepEqual(
    await postarSnapshot(payload, {
      apiKey: 'k',
      fetchImpl: async () => new Response('ok', { status: 201 })
    }),
    { ok: true, status: 201 }
  );

  assert.deepEqual(
    await postarSnapshot(payload, {
      apiKey: 'k',
      fetchImpl: async () => new Response('erro', { status: 500 })
    }),
    { ok: false, status: 500 }
  );

  // redirect nao e seguido (redirect: manual) nem aceito
  assert.deepEqual(
    await postarSnapshot(payload, {
      apiKey: 'k',
      fetchImpl: async () => new Response('moved', { status: 302 })
    }),
    { ok: false, status: 302 }
  );

  await assert.rejects(
    postarSnapshot(payload, {
      apiKey: 'k',
      fetchImpl: async () => { throw new TypeError('fetch failed'); }
    }),
    /fetch failed/
  );
});

test('timeout: AbortController aborta o fetch pendente', async () => {
  const payload = montarResumo({
    offers_observed: '1',
    readings_observed: '2',
    distinct_reading_days: '1',
    ready_to_model: '0'
  });
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  await assert.rejects(
    postarSnapshot(payload, { apiKey: 'k', fetchImpl, timeoutMs: 20 }),
    /aborted/
  );
});
