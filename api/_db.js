// api/_db.js
// Cliente Postgres compartilhado — conecta direto no Supabase via connection pooler
// (Supavisor, modo transaction), sem @supabase/supabase-js e sem chave anon/service_role.
//
// kiss: esta app roda 100% server-side (Vercel Functions) e nunca fala com a Data API
// (PostgREST) do Supabase — so com o Postgres por baixo, com usuario/senha normais. Decisao de
// migracao (Neon -> Supabase): manter o driver de connection string (agora "postgres" em vez de
// "@neondatabase/serverless") preserva 100% do SQL ja escrito e validado (tagged template,
// ON CONFLICT, transacao) — reescrever no supabase-js exigiria portar tudo pro query builder,
// muito mais risco pro que e so uma troca de provedor de Postgres.
//
// Porta 6543 = pooler Supavisor em modo "transaction" (confirmado na doc do Supabase, Database >
// Connection Pooling: functions serverless devem usar o pooler, nunca a porta 5432 direta —
// cada invocacao pode abrir conexao nova e a 5432 tem teto baixo de conexoes simultaneas no
// Postgres). prepare:false e obrigatorio em modo transaction: o pooler pode trocar a conexao
// fisica entre statements da mesma sessao logica, e prepared statement nomeado fica preso a UMA
// conexao fisica — sem isso, quebra com "prepared statement ... does not exist" sob carga.
import postgres from 'postgres';

export const sql = postgres(process.env.DATABASE_URL, {
  prepare: false, // obrigatorio no pooler em modo transaction (porta 6543)
  ssl: 'require'  // Supabase exige TLS
});

// Classe de erro do driver (tem .code igual ao codigo de erro do Postgres, ex.: '23505' unique
// violation, '23503' foreign key violation) — reexportada daqui pra quem trata erro de
// constraint (ofertas.js, leituras.js) importar de um so lugar, igual ja fazia com NeonDbError.
export const PostgresError = postgres.PostgresError;
