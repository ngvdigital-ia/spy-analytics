import assert from 'node:assert/strict';
import test from 'node:test';
import { montarResumo, projecaoAutorizada } from '../api/resumo.js';

const request = (authorization) => new Request('https://spy.example.test/api/resumo', {
  headers: authorization === undefined ? {} : { authorization }
});

test('endpoint permanece dormente sem flag e não consulta o banco', async () => {
  const anterior = process.env.SPY_PROJECTION_ENABLED;
  delete process.env.SPY_PROJECTION_ENABLED;
  try {
    const { default: endpoint } = await import('../api/resumo.js');
    const response = await endpoint.fetch(request('Bearer projection-secret'));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { erro: 'endpoint nao encontrado' });
  } finally {
    if (anterior === undefined) delete process.env.SPY_PROJECTION_ENABLED;
    else process.env.SPY_PROJECTION_ENABLED = anterior;
  }
});

test('Bearer dedicado usa comparação timing-safe e rejeita credenciais inválidas', () => {
  assert.equal(projecaoAutorizada(request('Bearer projection-secret'), 'projection-secret'), true);
  assert.equal(projecaoAutorizada(request('Bearer wrong-secret'), 'projection-secret'), false);
  assert.equal(projecaoAutorizada(request('Bearer projection-secret-extra'), 'projection-secret'), false);
  assert.equal(projecaoAutorizada(request(''), 'projection-secret'), false);
  assert.equal(projecaoAutorizada(request('Bearer projection-secret'), ''), false);
});

test('segredo da projeção falha fechado se coincidir com outro segredo do Spy', () => {
  const nomes = ['DASHBOARD_PASSWORD', 'SESSION_SECRET', 'CRON_SECRET'];
  const anterior = Object.fromEntries(nomes.map((nome) => [nome, process.env[nome]]));
  try {
    for (const nome of nomes) {
      for (const outro of nomes) delete process.env[outro];
      process.env[nome] = 'reused-secret';
      assert.equal(projecaoAutorizada(request('Bearer reused-secret')), false, nome);
    }
  } finally {
    for (const nome of nomes) {
      if (anterior[nome] === undefined) delete process.env[nome];
      else process.env[nome] = anterior[nome];
    }
  }
});

test('resposta tem somente o contrato agregado da janela de 30 dias', () => {
  const body = montarResumo({
    offers_observed: '3',
    readings_observed: '12',
    distinct_reading_days: '6',
    ready_to_model: '1'
  }, '2026-08-12T12:00:00.000Z');

  assert.deepEqual(body, {
    schema_version: 1,
    source: 'spy-analytics',
    status: 'ready',
    generated_at: '2026-08-12T12:00:00.000Z',
    window_days: 30,
    offers_observed: 3,
    readings_observed: 12,
    distinct_reading_days: 6,
    ready_to_model: 1
  });
  assert.deepEqual(Object.keys(body), [
    'schema_version', 'source', 'status', 'generated_at', 'window_days',
    'offers_observed', 'readings_observed', 'distinct_reading_days', 'ready_to_model'
  ]);
});
