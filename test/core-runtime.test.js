import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreRuntimeError, coreRequest, coreRuntimeEnabled } from '../api/_core.js';

test('runtime permanece desligado por padrao', () => {
  assert.equal(coreRuntimeEnabled({}), false);
  assert.equal(coreRuntimeEnabled({ SPY_CORE_RUNTIME_ENABLED: 'false' }), false);
  assert.equal(coreRuntimeEnabled({ SPY_CORE_RUNTIME_ENABLED: 'true' }), true);
});

test('adapter envia somente a chave dedicada para a Edge privada', async () => {
  let request;
  const data = await coreRequest('state', {}, {
    env: { NGV_CORE_SPY_RUNTIME_KEY: '1234567890123456' },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ data: { ofertas: [] } }), { status: 200 });
    }
  });
  assert.deepEqual(data, { ofertas: [] });
  assert.match(request.url, /^https:\/\/givqkglqwdizrpityafz\.supabase\.co\/functions\/v1\/spy-runtime$/);
  assert.equal(request.init.headers['x-ngv-core-spy-runtime-key'], '1234567890123456');
  assert.equal(request.init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(request.init.body), { op: 'state', payload: {} });
});

test('adapter falha fechado antes de rede sem chave dedicada', async () => {
  await assert.rejects(
    coreRequest('state', {}, { env: {}, fetchImpl: () => { throw new Error('nao deveria chamar'); } }),
    (error) => error instanceof CoreRuntimeError && error.status === 503
  );
});

test('adapter preserva somente conflitos e validacao para a borda autenticada', async () => {
  for (const status of [400, 409]) {
    await assert.rejects(
      coreRequest('state', {}, {
        env: { NGV_CORE_SPY_RUNTIME_KEY: '1234567890123456' },
        fetchImpl: async () => new Response('{}', { status })
      }),
      (error) => error instanceof CoreRuntimeError && error.status === status
    );
  }
  await assert.rejects(
    coreRequest('state', {}, {
      env: { NGV_CORE_SPY_RUNTIME_KEY: '1234567890123456' },
      fetchImpl: async () => new Response('{}', { status: 401 })
    }),
    (error) => error instanceof CoreRuntimeError && error.status === 502
  );
});
