// Private adapter for the opt-in NGV Core Spy runtime. Browser requests never
// receive this key; the existing cookie-authenticated Vercel routes remain the
// public boundary and retain their JSON/status contract.
const DEFAULT_RUNTIME_URL = 'https://givqkglqwdizrpityafz.supabase.co/functions/v1/spy-runtime';
const TIMEOUT_MS = 10_000;

export function coreRuntimeEnabled(env = process.env) {
  return env.SPY_CORE_RUNTIME_ENABLED === 'true';
}

export class CoreRuntimeError extends Error {
  constructor(status = 502) { super('core runtime indisponivel'); this.status = status; }
}

function runtimeUrl(env) {
  const value = env.NGV_CORE_SPY_RUNTIME_URL || DEFAULT_RUNTIME_URL;
  let parsed;
  try { parsed = new URL(value); } catch { throw new CoreRuntimeError(503); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CoreRuntimeError(503);
  }
  return parsed.toString();
}

export async function coreRequest(op, payload, {
  env = process.env, fetchImpl = fetch, timeoutMs = TIMEOUT_MS
} = {}) {
  const key = env.NGV_CORE_SPY_RUNTIME_KEY;
  if (typeof key !== 'string' || key.length < 16) throw new CoreRuntimeError(503);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(runtimeUrl(env), {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-ngv-core-spy-runtime-key': key },
      body: JSON.stringify({ op, payload })
    });
    if (!response.ok) {
      // Only validation/conflict statuses are translated by the cookie routes;
      // authentication failures from the private hop stay opaque to callers.
      throw new CoreRuntimeError(response.status === 400 || response.status === 409 ? response.status : 502);
    }
    const body = await response.json();
    if (!body || !Object.prototype.hasOwnProperty.call(body, 'data')) throw new CoreRuntimeError(502);
    return body.data;
  } catch (error) {
    if (error instanceof CoreRuntimeError) throw error;
    throw new CoreRuntimeError(502);
  } finally { clearTimeout(timer); }
}
