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

  /*
   * payment_orders supports:
   * 1. old GP orders;
   * 2. new license orders.
   *
   * Old fields are kept so Railway can start without losing data.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id UUID PRIMARY KEY,

      telegram_id BIGINT NOT NULL
        REFERENCES users(telegram_id)
        ON DELETE CASCADE,

      wallet_address TEXT NOT NULL,
      comment TEXT UNIQUE NOT NULL,

      track_title TEXT,
      license_type TEXT,
      price_gram INTEGER,

      amount_nano NUMERIC(30,0),
      gp_reward INTEGER,

      status TEXT NOT NULL DEFAULT 'pending',

      tx_hash TEXT UNIQUE,
      tx_lt TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at TIMESTAMPTZ,
      credited_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ
    )
  `);

  /*
   * Safe migration for an existing table.
   * ADD COLUMN IF NOT EXISTS keeps existing orders.
   */
  await pool.query(`
    ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS track_title TEXT
  `);

  await pool.query(`
    ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS license_type TEXT
  `);

  await pool.query(`
    ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS price_gram INTEGER
  `);

  await pool.query(`
    ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS credited_at TIMESTAMPTZ
  `);

  /*
   * In the old database amount_nano and gp_reward could be NOT NULL.
   * Remove those constraints so both old and new order formats work.
   */
  await pool.query(`
    ALTER TABLE payment_orders
    ALTER COLUMN amount_nano DROP NOT NULL
  `);

  await pool.query(`
    ALTER TABLE payment_orders
    ALTER COLUMN gp_reward DROP NOT NULL
  `);

  /*
   * Constraints are added only when they do not already exist.
   * NULL is allowed for legacy rows.
   */
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'payment_orders_license_type_check'
      ) THEN
        ALTER TABLE payment_orders
        ADD CONSTRAINT payment_orders_license_type_check
        CHECK (
          license_type IS NULL
          OR license_type IN ('mp3', 'wav', 'full')
        );
      END IF;
    END
    $$
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'payment_orders_price_gram_check'
      ) THEN
        ALTER TABLE payment_orders
        ADD CONSTRAINT payment_orders_price_gram_check
        CHECK (
          price_gram IS NULL
          OR price_gram > 0
        );
      END IF;
    END
    $$
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS payment_orders_telegram_id_idx
    ON payment_orders (telegram_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS payment_orders_status_idx
    ON payment_orders (status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS payment_orders_license_type_idx
    ON payment_orders (license_type)
  `);
}

export async function upsertTelegramUser(client, telegramUser) {
  const result = await client.query(
    `
      INSERT INTO users
      (
        telegram_id,
        username,
        first_name,
        last_name,
        language_code,
        updated_at
      )
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
        updated_at
    `,
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
