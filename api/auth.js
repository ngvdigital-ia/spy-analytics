// api/auth.js
// POST /api/auth — valida a senha do time e emite o cookie de sessao (ADR-001 secao 6).
import { cookieDeSessao, senhaConfere, json, erro, tratarErroInesperado } from './_auth.js';

// Rate-limit best-effort: memoria do proprio processo da function. E efemera (reinicia a cada
// cold start) e NAO compartilhada entre instancias/regioes — nao segura contra um atacante
// distribuido. Aceito assim mesmo (correcao do pvs-master ao ADR-001, que aceitava zero
// protecao): o repo e PUBLICO, entao a existencia deste endpoint e conhecida por qualquer um, e
// a unica protecao e uma senha compartilhada — vale o degrau minimo em vez de nenhum. Servico
// externo de rate-limit seria over-engineering pra 3 usuarios internos.
const tentativasPorIp = new Map(); // ip -> { falhas: number, bloqueadoAte: number }
const FALHAS_ATE_BLOQUEAR = 5;
const BLOQUEIO_TETO_SEGUNDOS = 300;

function ipDoRequest(request) {
  const encaminhado = request.headers.get('x-forwarded-for');
  return encaminhado ? encaminhado.split(',')[0].trim() : 'desconhecido';
}

function esperaRestanteMs(ip) {
  const registro = tentativasPorIp.get(ip);
  if (!registro || !registro.bloqueadoAte) return 0;
  const restante = registro.bloqueadoAte - Date.now();
  return restante > 0 ? restante : 0;
}

function registrarFalha(ip) {
  const registro = tentativasPorIp.get(ip) || { falhas: 0, bloqueadoAte: 0 };
  registro.falhas += 1;
  if (registro.falhas >= FALHAS_ATE_BLOQUEAR) {
    const excedente = registro.falhas - FALHAS_ATE_BLOQUEAR + 1;
    const esperaSegundos = Math.min(2 ** excedente, BLOQUEIO_TETO_SEGUNDOS); // atraso progressivo, com teto
    registro.bloqueadoAte = Date.now() + esperaSegundos * 1000;
  }
  tentativasPorIp.set(ip, registro);
}

function limparFalhas(ip) {
  tentativasPorIp.delete(ip);
}

export default {
  async fetch(request) {
    try {
      if (request.method !== 'POST') return erro(405, 'metodo nao permitido');

      const ip = ipDoRequest(request);
      const esperaMs = esperaRestanteMs(ip);
      if (esperaMs > 0) {
        return json(429, { erro: 'muitas tentativas, aguarde e tente novamente' }, {
          'retry-after': String(Math.ceil(esperaMs / 1000))
        });
      }

      let corpo;
      try {
        corpo = await request.json();
      } catch {
        return erro(400, 'corpo invalido, envie { senha }');
      }

      if (!senhaConfere(corpo?.senha)) {
        registrarFalha(ip);
        return erro(401, 'senha incorreta');
      }

      limparFalhas(ip);
      return json(200, { ok: true }, { 'set-cookie': cookieDeSessao() });
    } catch (e) {
      return tratarErroInesperado(e);
    }
  }
};
