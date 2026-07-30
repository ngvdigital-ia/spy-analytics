/**
 * Spy-Analytics — servidor de sincronização (Cloudflare Worker)
 *
 * Guarda um único documento JSON com as ofertas, as leituras e os critérios da
 * equipe. O painel busca com GET e grava com PUT; o Worker só precisa devolver
 * o que recebeu por último.
 *
 * Como publicar
 * -------------
 * 1. Em dash.cloudflare.com, abra Workers & Pages e crie um Worker novo.
 * 2. Cole este arquivo no editor e publique.
 * 3. Em Settings › Bindings, crie um KV namespace e ligue com o nome DADOS.
 * 4. (Opcional, recomendado) Em Settings › Variables, crie a variável secreta
 *    TOKEN com uma senha à sua escolha. Sem ela qualquer pessoa que descobrir
 *    a URL consegue ler e gravar.
 * 5. No painel, aba "Dados e critérios" › "Sincronização da equipe", escolha
 *    "Endpoint próprio", cole a URL do Worker e o TOKEN, e clique em Conectar.
 * 6. Clique em "Copiar convite" e mande o link para a equipe.
 *
 * Alternativa sem KV: troque as chamadas de LEITURA/ESCRITA por um banco D1 ou
 * por R2. O contrato com o painel continua o mesmo.
 */

const CHAVE = 'spy-analytics';

/* Restringir a origem é o que impede outro site de usar este endpoint pelo
   navegador de quem estiver logado. Coloque aqui o domínio do painel; deixe
   '*' apenas enquanto estiver testando. */
const ORIGENS = ['*'];

function cabecalhos(req) {
  const origem = req.headers.get('Origin') || '';
  const liberada = ORIGENS.includes('*') ? '*' : (ORIGENS.includes(origem) ? origem : '');
  return {
    'Access-Control-Allow-Origin': liberada || 'null',
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store'
  };
}

function autorizado(req, env) {
  if (!env.TOKEN) return true;                       // sem token configurado, endpoint aberto
  const enviado = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (enviado.length !== env.TOKEN.length) return false;
  /* comparação de tempo constante: não vaza o token caractere a caractere */
  let dif = 0;
  for (let i = 0; i < enviado.length; i++) dif |= enviado.charCodeAt(i) ^ env.TOKEN.charCodeAt(i);
  return dif === 0;
}

const json = (corpo, status, req) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json', ...cabecalhos(req) }
  });

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cabecalhos(req) });

    if (!env.DADOS) return json({ erro: 'falta ligar o KV namespace com o nome DADOS' }, 500, req);
    if (!autorizado(req, env)) return json({ erro: 'token inválido' }, 401, req);

    if (req.method === 'GET') {
      const guardado = await env.DADOS.get(CHAVE);
      if (!guardado) return json({ erro: 'ainda não há dados' }, 404, req);
      return new Response(guardado, {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...cabecalhos(req) }
      });
    }

    if (req.method === 'PUT') {
      let corpo;
      try {
        corpo = await req.json();
      } catch (e) {
        return json({ erro: 'corpo não é JSON válido' }, 400, req);
      }
      if (!corpo || !Array.isArray(corpo.ofertas) || !Array.isArray(corpo.leituras)) {
        return json({ erro: 'esperava um objeto com as listas ofertas e leituras' }, 400, req);
      }
      await env.DADOS.put(CHAVE, JSON.stringify(corpo));
      return json({ ok: true, ofertas: corpo.ofertas.length, leituras: corpo.leituras.length }, 200, req);
    }

    return json({ erro: 'use GET para ler e PUT para gravar' }, 405, req);
  }
};
