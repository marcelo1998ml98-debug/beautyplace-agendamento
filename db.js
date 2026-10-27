// Conexão com PostgreSQL (ex: banco gratuito do Supabase) — usada em vez do SQLite
// pra garantir que os dados (marcações, procedimentos) não se percam quando o
// servidor reinicia, já que planos gratuitos de hosting costumam ter disco
// temporário (mas um banco Postgres externo persiste normalmente).
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    '⚠️  A variável de ambiente DATABASE_URL não está definida. ' +
    'Configure a string de conexão do Postgres (ex: a do Supabase) antes de rodar o servidor.'
  );
}

// A maioria dos provedores gratuitos (Supabase incluso) exige SSL, mas usa
// certificado que o Node às vezes não reconhece como "autoridade confiável"
// por padrão. O ideal é validar de verdade (rejectUnauthorized: true) — sem
// isso, a conexão fica vulnerável a um ataque "man-in-the-middle" entre o
// servidor e o banco. Deixamos como opção porque ativar isso sem testar antes
// pode derrubar a conexão em alguns provedores; o padrão continua permissivo
// até confirmar que funciona com rejectUnauthorized ligado.
const strictSSL = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true';
const pool = new Pool({
  connectionString,
  ssl: connectionString ? { rejectUnauthorized: strictSSL } : false,
});

pool.on('error', (err) => {
  console.error('Erro inesperado na conexão com o Postgres:', err.message);
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS professionals (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      professional_id INTEGER REFERENCES professionals(id),
      name TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      price_cents INTEGER,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      professional_id INTEGER REFERENCES professionals(id),
      service_id INTEGER NOT NULL REFERENCES services(id),
      client_name TEXT NOT NULL,
      client_phone TEXT NOT NULL,
      client_email TEXT,
      booking_date TEXT NOT NULL,
      booking_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      notes TEXT,
      cancel_token TEXT,
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS business_hours (
      professional_id INTEGER NOT NULL REFERENCES professionals(id),
      weekday INTEGER NOT NULL,
      open_time TEXT,
      close_time TEXT,
      open_time2 TEXT,
      close_time2 TEXT,
      closed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (professional_id, weekday)
    );

    CREATE TABLE IF NOT EXISTS blocked_periods (
      id SERIAL PRIMARY KEY,
      professional_id INTEGER REFERENCES professionals(id),
      block_date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migrações pra bancos que já existiam antes desses campos serem adicionados
  // (ex: a base de produção no Supabase, que já tem marcações reais) — IF NOT
  // EXISTS garante que isso não dá erro em bancos novos nem duplica a coluna
  // em bancos que já rodaram essa migração antes.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS client_email TEXT;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_token TEXT;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_sent INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS professional_id INTEGER REFERENCES professionals(id);`);
  await pool.query(`ALTER TABLE business_hours ADD COLUMN IF NOT EXISTS open_time2 TEXT;`);
  await pool.query(`ALTER TABLE business_hours ADD COLUMN IF NOT EXISTS close_time2 TEXT;`);
  await pool.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS professional_id INTEGER REFERENCES professionals(id);`);
  await pool.query(`ALTER TABLE services ADD COLUMN IF NOT EXISTS price_cents INTEGER;`);
  await pool.query(`ALTER TABLE blocked_periods ADD COLUMN IF NOT EXISTS professional_id INTEGER REFERENCES professionals(id);`);

  // Marcações antigas (feitas antes do link de cancelamento existir) não têm
  // cancel_token — gera um pra cada uma que ainda estiver sem, pra que o link
  // de cancelamento funcione também pra elas se reenviarmos o e-mail no futuro.
  await pool.query(`
    UPDATE bookings SET cancel_token = gen_random_uuid()::text
    WHERE cancel_token IS NULL;
  `).catch(async () => {
    // gen_random_uuid() depende da extensão pgcrypto; se não estiver disponível
    // (alguns Postgres gerenciados não habilitam por padrão), tenta habilitar.
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
    await pool.query(`UPDATE bookings SET cancel_token = gen_random_uuid()::text WHERE cancel_token IS NULL;`);
  });

  // Marcações antigas sem professional_id: preenche a partir do serviço
  // associado (todo serviço deveria ter um profissional definido pelo seed).
  await pool.query(`
    UPDATE bookings b SET professional_id = s.professional_id
    FROM services s WHERE b.service_id = s.id AND b.professional_id IS NULL;
  `);
}

module.exports = { pool, initSchema };
