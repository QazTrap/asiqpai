import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

export async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      language_code TEXT,
      gp BIGINT NOT NULL DEFAULT 0 CHECK (gp >= 0),
      gold_license BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id UUID PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      wallet_address TEXT NOT NULL,
      comment TEXT UNIQUE NOT NULL,
      amount_nano NUMERIC(30,0) NOT NULL,
      gp_reward INTEGER NOT NULL CHECK (gp_reward > 0),
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT UNIQUE,
      tx_lt TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      credited_at TIMESTAMPTZ
    )
  `);

  // Безопасное обновление старой базы, если таблица уже существовала.
  await pool.query(`
    ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS payment_orders_telegram_id_idx
    ON payment_orders (telegram_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS payment_orders_status_idx
    ON payment_orders (status)
  `);
}

export async function upsertTelegramUser(client, telegramUser) {
  const result = await client.query(
    `INSERT INTO users
      (telegram_id, username, first_name, last_name, language_code, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (telegram_id)
     DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       language_code = EXCLUDED.language_code,
       updated_at = NOW()
     RETURNING
       telegram_id::text AS telegram_id,
       username,
       first_name,
       last_name,
       language_code,
       gp::text AS gp,
       gold_license,
       created_at,
       updated_at`,
    [
      telegramUser.id,
      telegramUser.username || null,
      telegramUser.first_name || null,
      telegramUser.last_name || null,
      telegramUser.language_code || null
    ]
  );

  return result.rows[0];
}
