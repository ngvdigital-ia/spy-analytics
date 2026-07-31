// api/_auth.js
// Helper compartilhado de autenticacao (ADR-001 secao 6). Sessao = cookie assinado
// HMAC-SHA256, sem estado no servidor (nao precisa de tabela de sessao).
import crypto from 'node:crypto';

const COOKIE_NAME = 'spy_session';
// 30 dias: time interno de 3 pessoas, prioriza baixo atrito sobre re-login frequente (ADR-001 secao 6).
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET nao configurada nas env vars da Vercel');
  return secret;
}

function assinar(valor) {
  return crypto.createHmac('sha256', getSessionSecret()).update(valor).digest('base64url');
}

function parseCookies(cabecalho) {
  const saida = {};
  if (!cabecalho) return saida;
  for (const par of cabecalho.split(';')) {
    const i = par.indexOf('=');
    if (i === -1) continue;
    saida[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  }
  return saida;
}

/** Emite o cabecalho Set-Cookie da sessao (chame depois de validar a senha em /api/auth). */
export function cookieDeSessao() {
  const emitidoEm = Date.now().toString();
  const assinatura = assinar(emitidoEm);
  const valor = `${emitidoEm}.${assinatura}`;
  return `${COOKIE_NAME}=${valor}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

/** true se o request trouxer um cookie de sessao valido, assinado corretamente e dentro da validade. */
export function autenticado(request) {
  const bruto = parseCookies(request.headers.get('cookie'))[COOKIE_NAME];
  if (!bruto) return false;
  const ponto = bruto.lastIndexOf('.');
  if (ponto === -1) return false;
  const emitidoEm = bruto.slice(0, ponto);
  const assinaturaRecebida = bruto.slice(ponto + 1);
  const assinaturaEsperada = assinar(emitidoEm);
  const a = Buffer.from(assinaturaRecebida);
  const b = Buffer.from(assinaturaEsperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const idadeMs = Date.now() - Number(emitidoEm);
  return Number.isFinite(idadeMs) && idadeMs >= 0 && idadeMs <= SESSION_MAX_AGE_SECONDS * 1000;
}

/** Chame no topo de cada handler protegido; devolve a Response 401 pronta, ou null se autenticado. */
export function exigirAuth(request) {
  if (autenticado(request)) return null;
  return erro(401, 'sessao invalida ou expirada');
}

/**
 * Compara em tempo constante contra DASHBOARD_PASSWORD. Compara hashes de tamanho fixo (nao os
 * valores crus) pra nao vazar informacao pelo tamanho do buffer quando a senha recebida tem
 * tamanho diferente da esperada.
 */
export function senhaConfere(candidata) {
  const esperada = process.env.DASHBOARD_PASSWORD;
  if (!esperada) throw new Error('DASHBOARD_PASSWORD nao configurada nas env vars da Vercel');
  const hashCandidata = crypto.createHash('sha256').update(String(candidata ?? '')).digest();
  const hashEsperada = crypto.createHash('sha256').update(esperada).digest();
  return crypto.timingSafeEqual(hashCandidata, hashEsperada);
}

export function json(status, corpo, headersExtra) {
  return new Response(JSON.stringify(corpo), { status, headers: { ...JSON_HEADERS, ...headersExtra } });
}

export function erro(status, mensagem) {
  return json(status, { erro: mensagem });
}

/** Catch-all pra erro nao previsto: loga o real, devolve mensagem generica (nunca stack trace pro client). */
export function tratarErroInesperado(e) {
  console.error(e);
  return erro(500, 'erro interno');
}
