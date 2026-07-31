// api/config.js
// PUT /api/config — atualiza pesos e tolerancia do time (singleton id=1) — ADR-001 secoes 3-5.
// Tabela qualificada com "spy." — ver nota de prefixo explicito vs search_path em api/estado.js.
import { sql } from './_db.js';
import { exigirAuth, json, erro, tratarErroInesperado } from './_auth.js';

const CHAVES_PESO = ['estab', 'vol', 'tempo'];

function validar(corpo) {
  const pesos = corpo?.pesos;
  const tolerancia = corpo?.tolerancia;
  if (!pesos || typeof pesos !== 'object') return 'pesos e obrigatorio';
  for (const chave of CHAVES_PESO) {
    if (!Number.isFinite(pesos[chave])) return `pesos.${chave} precisa ser numero`;
  }
  if (!Number.isFinite(tolerancia)) return 'tolerancia precisa ser numero';
  return null;
}

export default {
  async fetch(request) {
    try {
      if (request.method !== 'PUT') return erro(405, 'metodo nao permitido');
      const naoAutorizado = exigirAuth(request);
      if (naoAutorizado) return naoAutorizado;

      let corpo;
      try { corpo = await request.json(); } catch { return erro(400, 'corpo invalido'); }
      const problema = validar(corpo);
      if (problema) return erro(400, problema);

      const pesos = { estab: corpo.pesos.estab, vol: corpo.pesos.vol, tempo: corpo.pesos.tempo };
      // ATENCAO driver novo: passar o objeto DIRETO (nao JSON.stringify(pesos)) pro parametro
      // com cast ::jsonb. O driver anterior (@neondatabase/serverless) aceitava a string
      // pre-serializada sem problema; o "postgres" (postgres.js) serializa o valor de novo ao
      // ver o cast ::jsonb no texto da query — passar uma string ja serializada faz dupla
      // serializacao e grava um jsonb do tipo STRING (ex.: '"{\"estab\":50}"') em vez de OBJECT
      // (confirmado local: sql\`...${JSON.stringify(x)}::jsonb\` grava jsonb_typeof = 'string';
      // sql\`...${x}::jsonb\` grava jsonb_typeof = 'object', que e o que /api/estado espera ler).
      const linhas = await sql`
        update spy.config set pesos = ${pesos}::jsonb, tolerancia = ${corpo.tolerancia}, atualizado_em = now()
        where id = 1
        returning pesos, tolerancia
      `;
      if (linhas.length === 0) return erro(404, 'config nao inicializada — rode schema.sql');
      return json(200, linhas[0]);
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};
