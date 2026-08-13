import assert from 'node:assert/strict';
import test from 'node:test';
import { montarResumo } from '../api/resumo.js';
import { syncAutorizado, postarSnapshot, NGV_CORE_INGEST_URL } from '../api/sync-ngv-core.js';

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

test('POST envia o contrato agregado exato, sem PII nem dados individuais', async () => {
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
  assert.equal(capturado.init.headers.apikey, 'ngv-secret-key');
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
