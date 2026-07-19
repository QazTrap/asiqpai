import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";

import {
  pool,
  initDatabase,
  upsertTelegramUser
} from "./db.js";

import {
  validateTelegramInitData
} from "./telegramAuth.js";

import {
  createCommentPayload,
  findPayment,
  normalizeAddress
} from "./ton.js";

const app = express();

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || "";
const TONAPI_API_KEY = process.env.TONAPI_API_KEY || "";
const MERCHANT_WALLET = process.env.MERCHANT_WALLET;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;

const ASIQ_MASTER =
  process.env.ASIQ_MASTER ||
  "EQDtaiYQRMlcGHXVkcK873McLzx-JQUZtyR8W1O6e2XISp52";

const AUTH_MAX_AGE = Number(
  process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 86400
);

const ORDER_TTL_MS = 30 * 60 * 1000;


const DAILY_REWARD_AMOUNT = 25;
const DAILY_REWARD_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAILY_STREAK_GRACE_MS = 48 * 60 * 60 * 1000;


const WITHDRAW_MIN_ASIQ = Number(process.env.WITHDRAW_MIN_ASIQ || 25);
const WITHDRAW_MAX_ASIQ = Number(process.env.WITHDRAW_MAX_ASIQ || 10000);
const WITHDRAW_ADMIN_SECRET = process.env.WITHDRAW_ADMIN_SECRET || "";



const LICENSES = Object.freeze({
  mp3: {
    label: "MP3",
    priceGram: 10,
    amountNano: "10000000000"
  },
  wav: {
    label: "WAV",
    priceGram: 20,
    amountNano: "20000000000"
  },
  full: {
    label: "FULL",
    priceGram: 40,
    amountNano: "40000000000"
  }
});

const SELLABLE_TRACKS = new Set([
  "Әңгіме"
]);

if (!BOT_TOKEN || !MERCHANT_WALLET || !process.env.DATABASE_URL) {
  throw new Error(
    "BOT_TOKEN, MERCHANT_WALLET and DATABASE_URL are required"
  );
}

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        !FRONTEND_ORIGIN ||
        origin === FRONTEND_ORIGIN
      ) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin is not allowed"));
    }
  })
);

app.use(express.json({ limit: "32kb" }));

function cleanTrackTitle(value) {
  if (typeof value !== "string") return "";

  return value
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

function formatJettonBalance(rawBalance, decimals) {
  const raw = BigInt(String(rawBalance || "0"));
  const safeDecimals = Number.isInteger(decimals) && decimals >= 0
    ? decimals
    : 9;

  if (safeDecimals === 0) {
    return raw.toString();
  }

  const divisor = 10n ** BigInt(safeDecimals);
  const whole = raw / divisor;
  const fraction = raw % divisor;

  if (fraction === 0n) {
    return whole.toString();
  }

  const fractionText = fraction
    .toString()
    .padStart(safeDecimals, "0")
    .replace(/0+$/, "");

  return `${whole}.${fractionText}`;
}

async function sendTelegramNotification({
  telegramUser,
  order,
  payment
}) {
  if (!ADMIN_CHAT_ID) {
    console.warn("ADMIN_CHAT_ID is not configured");
    return;
  }

  const username = telegramUser.username
    ? `@${telegramUser.username}`
    : "username отсутствует";

  const firstName = telegramUser.first_name || "";
  const lastName = telegramUser.last_name || "";

  const fullName =
    `${firstName} ${lastName}`.trim() || "Не указано";

  const transactionHash =
    payment.hash ||
    `${payment.lt}:${order.comment}`;

  const license =
    LICENSES[String(order.license_type).toLowerCase()];

  const message = [
    "🛒 Новая покупка ASIQPAI",
    "",
    `👤 Покупатель: ${fullName}`,
    `🔗 Username: ${username}`,
    `🆔 Telegram ID: ${telegramUser.id}`,
    "",
    `🎵 Инструментал: ${order.track_title}`,
    `📄 Лицензия: ${license?.label || order.license_type}`,
    `💰 Оплачено: ${order.price_gram} GRAM`,
    `📦 Заказ: ${order.id}`,
    "✅ Статус: подтверждено",
    "",
    `🔐 Транзакция: ${transactionHash}`
  ].join("\n");

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT_ID,
          text: message
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error(
        "Telegram notification failed:",
        result
      );
    }
  } catch (error) {
    console.error(
      "Telegram notification error:",
      error
    );
  }
}

async function requireTelegramUser(req, res, next) {
  try {
    const initData = req.get(
      "X-Telegram-Init-Data"
    );

    const result = validateTelegramInitData(
      initData,
      BOT_TOKEN,
      AUTH_MAX_AGE
    );

    req.telegramUser = result.user;

    req.appUser = await upsertTelegramUser(
      pool,
      result.user
    );

    next();
  } catch (error) {
    console.error(
      "Telegram auth error:",
      error
    );

    return res.status(401).json({
      error: "Telegram authorization failed"
    });
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get(
  "/api/me",
  requireTelegramUser,
  (req, res) => {
    res.json({
      ok: true,
      user: {
        telegramId: req.appUser.telegram_id,
        username: req.appUser.username,
        firstName: req.appUser.first_name,
        lastName: req.appUser.last_name,
        languageCode: req.appUser.language_code,
        gp: req.appUser.gp,
        goldLicense: req.appUser.gold_license,
        createdAt: req.appUser.created_at,
        updatedAt: req.appUser.updated_at
      }
    });
  }
);

/*
 * Возвращает баланс ASIQ подключённого TON-кошелька.
 * Telegram-авторизация здесь не нужна: данные баланса публичны.
 */
app.get(
  "/api/asiq-balance/:wallet",
  async (req, res) => {
    const wallet = normalizeAddress(req.params.wallet);

    if (!wallet) {
      return res.status(400).json({
        ok: false,
        error: "Invalid wallet address"
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      12000
    );

    try {
      const headers = {
        Accept: "application/json"
      };

      if (TONAPI_API_KEY) {
        headers.Authorization =
          `Bearer ${TONAPI_API_KEY}`;
      }

      const url =
        `https://tonapi.io/v2/accounts/` +
        `${encodeURIComponent(wallet)}/jettons/` +
        `${encodeURIComponent(ASIQ_MASTER)}`;

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal
      });

      const responseText = await response.text();

      let data = {};

      if (responseText) {
        try {
          data = JSON.parse(responseText);
        } catch {
          data = {
            rawResponse: responseText.slice(0, 500)
          };
        }
      }

      if (response.status === 404) {
        return res.json({
          ok: true,
          wallet,
          jettonMaster: ASIQ_MASTER,
          symbol: "ASIQ",
          decimals: 9,
          rawBalance: "0",
          balance: "0",
          balanceText: "0"
        });
      }

      if (!response.ok) {
        console.error(
          "TonAPI ASIQ balance error:",
          response.status,
          data
        );

        return res.status(502).json({
          ok: false,
          error:
            data?.error ||
            data?.message ||
            `TonAPI returned HTTP ${response.status}`
        });
      }

      const decimals = Number(
        data?.jetton?.decimals ?? 9
      );

      const rawBalance = String(
        data?.balance ?? "0"
      );

      const balance =
        formatJettonBalance(rawBalance, decimals);

      return res.json({
        ok: true,
        wallet,
        jettonMaster: ASIQ_MASTER,
        symbol: data?.jetton?.symbol || "ASIQ",
        name: data?.jetton?.name || "ASIQ",
        decimals,
        rawBalance,
        balance,
        balanceText: balance
      });
    } catch (error) {
      console.error(
        "ASIQ balance request error:",
        error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.name === "AbortError"
            ? "TonAPI request timed out"
            : "Could not load ASIQ balance"
      });
    } finally {
      clearTimeout(timeout);
    }
  }
);


async function initDailyRewardTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_rewards (
      telegram_id BIGINT PRIMARY KEY,
      reward_balance NUMERIC(30, 9) NOT NULL DEFAULT 0,
      last_claim_at TIMESTAMPTZ,
      streak INTEGER NOT NULL DEFAULT 0,
      total_claims INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function buildDailyRewardResponse(row, now = new Date()) {
  const lastClaimAt = row?.last_claim_at
    ? new Date(row.last_claim_at)
    : null;

  const nextClaimAt = lastClaimAt
    ? new Date(lastClaimAt.getTime() + DAILY_REWARD_INTERVAL_MS)
    : null;

  const eligible =
    !nextClaimAt || now.getTime() >= nextClaimAt.getTime();

  return {
    ok: true,
    rewardAmount: DAILY_REWARD_AMOUNT,
    rewardBalance: String(row?.reward_balance ?? "0"),
    eligible,
    lastClaimAt: lastClaimAt
      ? lastClaimAt.toISOString()
      : null,
    nextClaimAt: eligible || !nextClaimAt
      ? null
      : nextClaimAt.toISOString(),
    streak: Number(row?.streak || 0),
    totalClaims: Number(row?.total_claims || 0),
    payoutMode: "internal-ledger"
  };
}

app.get(
  "/api/daily-reward",
  requireTelegramUser,
  async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT *
         FROM daily_rewards
         WHERE telegram_id = $1`,
        [req.telegramUser.id]
      );

      return res.json(
        buildDailyRewardResponse(result.rows[0])
      );
    } catch (error) {
      console.error("Daily reward status error:", error);

      return res.status(500).json({
        error: "Could not load daily reward"
      });
    }
  }
);

app.post(
  "/api/daily-reward/claim",
  requireTelegramUser,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO daily_rewards (telegram_id)
         VALUES ($1)
         ON CONFLICT (telegram_id) DO NOTHING`,
        [req.telegramUser.id]
      );

      const locked = await client.query(
        `SELECT *
         FROM daily_rewards
         WHERE telegram_id = $1
         FOR UPDATE`,
        [req.telegramUser.id]
      );

      const current = locked.rows[0];
      const now = new Date();

      const state = buildDailyRewardResponse(
        current,
        now
      );

      if (!state.eligible) {
        await client.query("COMMIT");

        return res.status(409).json({
          error: "Daily reward is not available yet",
          ...state
        });
      }

      const lastClaimAt = current.last_claim_at
        ? new Date(current.last_claim_at)
        : null;

      const keepStreak =
        lastClaimAt &&
        now.getTime() - lastClaimAt.getTime()
          <= DAILY_STREAK_GRACE_MS;

      const nextStreak = keepStreak
        ? Number(current.streak || 0) + 1
        : 1;

      const updated = await client.query(
        `UPDATE daily_rewards
         SET reward_balance =
               reward_balance + $2::numeric,
             last_claim_at = NOW(),
             streak = $3,
             total_claims = total_claims + 1,
             updated_at = NOW()
         WHERE telegram_id = $1
         RETURNING *`,
        [
          req.telegramUser.id,
          DAILY_REWARD_AMOUNT,
          nextStreak
        ]
      );

      await client.query("COMMIT");

      return res.json(
        buildDailyRewardResponse(updated.rows[0])
      );
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error("Daily reward claim error:", error);

      return res.status(500).json({
        error: "Could not claim daily reward"
      });
    } finally {
      client.release();
    }
  }
);


function parseAsiqAmount(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? text : null;
}

function serializeWithdrawal(row) {
  return {
    id: row.id,
    amount: String(row.amount),
    walletAddress: row.wallet_address,
    status: row.status,
    txHash: row.tx_hash || null,
    adminNote: row.admin_note || null,
    createdAt: row.created_at,
    processedAt: row.processed_at || null
  };
}

async function initWithdrawalsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdraw_requests (
      id UUID PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      wallet_address TEXT NOT NULL,
      amount NUMERIC(30, 9) NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'rejected')),
      tx_hash TEXT,
      admin_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS withdraw_requests_user_idx ON withdraw_requests (telegram_id, created_at DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS withdraw_requests_one_pending_idx ON withdraw_requests (telegram_id) WHERE status='pending'`);
}

async function sendWithdrawalNotification({ telegramUser, withdrawal }) {
  if (!ADMIN_CHAT_ID) return;
  const username = telegramUser.username ? `@${telegramUser.username}` : "нет username";
  const text = [
    "💸 Новая заявка на вывод ASIQ","",
    `👤 ${username}`,
    `🆔 Telegram ID: ${telegramUser.id}`,
    `💰 ${withdrawal.amount} ASIQ`,
    `👛 ${withdrawal.walletAddress}`,
    `📄 ID: ${withdrawal.id}`,
    "⏳ Ожидает ручной отправки"
  ].join("\n");
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:ADMIN_CHAT_ID,text})
    });
  } catch (error) {
    console.error("Withdrawal notification error:",error);
  }
}

app.get("/api/withdrawals", requireTelegramUser, async (req,res)=>{
  try{
    const [reward,history] = await Promise.all([
      pool.query(`SELECT reward_balance FROM daily_rewards WHERE telegram_id=$1`,[req.telegramUser.id]),
      pool.query(`SELECT * FROM withdraw_requests WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 10`,[req.telegramUser.id])
    ]);
    const withdrawals = history.rows.map(serializeWithdrawal);
    res.json({
      ok:true,
      minimum:WITHDRAW_MIN_ASIQ,
      maximum:WITHDRAW_MAX_ASIQ,
      rewardBalance:String(reward.rows[0]?.reward_balance ?? "0"),
      hasPending:withdrawals.some(item=>item.status==="pending"),
      withdrawals,
      payoutMode:"manual-jetton-transfer"
    });
  }catch(error){
    console.error("Withdraw load error:",error);
    res.status(500).json({error:"Could not load withdrawals"});
  }
});

app.post("/api/withdrawals", requireTelegramUser, async (req,res)=>{
  const walletAddress = normalizeAddress(req.body.walletAddress);
  const amountText = parseAsiqAmount(req.body.amount);
  if(!walletAddress) return res.status(400).json({error:"Подключите корректный TON-кошелёк"});
  if(!amountText) return res.status(400).json({error:"Некорректная сумма ASIQ"});
  const amount = Number(amountText);
  if(amount < WITHDRAW_MIN_ASIQ) return res.status(400).json({error:`Минимальный вывод: ${WITHDRAW_MIN_ASIQ} ASIQ`});
  if(amount > WITHDRAW_MAX_ASIQ) return res.status(400).json({error:`Максимальный вывод: ${WITHDRAW_MAX_ASIQ} ASIQ`});

  const client = await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query(`INSERT INTO daily_rewards (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING`,[req.telegramUser.id]);
    const reward = await client.query(`SELECT * FROM daily_rewards WHERE telegram_id=$1 FOR UPDATE`,[req.telegramUser.id]);
    const pending = await client.query(`SELECT id FROM withdraw_requests WHERE telegram_id=$1 AND status='pending' LIMIT 1`,[req.telegramUser.id]);
    if(pending.rowCount){ await client.query("ROLLBACK"); return res.status(409).json({error:"У вас уже есть заявка в обработке"}); }
    if(Number(reward.rows[0].reward_balance) < amount){ await client.query("ROLLBACK"); return res.status(400).json({error:"Недостаточно ASIQ во внутреннем балансе"}); }

    const id = crypto.randomUUID();
    await client.query(`UPDATE daily_rewards SET reward_balance=reward_balance-$2::numeric,updated_at=NOW() WHERE telegram_id=$1`,[req.telegramUser.id,amountText]);
    const created = await client.query(`INSERT INTO withdraw_requests(id,telegram_id,wallet_address,amount) VALUES($1,$2,$3,$4) RETURNING *`,[id,req.telegramUser.id,walletAddress,amountText]);
    const balance = await client.query(`SELECT reward_balance FROM daily_rewards WHERE telegram_id=$1`,[req.telegramUser.id]);
    await client.query("COMMIT");

    const withdrawal = serializeWithdrawal(created.rows[0]);
    await sendWithdrawalNotification({telegramUser:req.telegramUser,withdrawal});
    const history = await pool.query(`SELECT * FROM withdraw_requests WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 10`,[req.telegramUser.id]);
    res.status(201).json({
      ok:true,minimum:WITHDRAW_MIN_ASIQ,maximum:WITHDRAW_MAX_ASIQ,
      rewardBalance:String(balance.rows[0].reward_balance),hasPending:true,
      withdrawal,withdrawals:history.rows.map(serializeWithdrawal),
      payoutMode:"manual-jetton-transfer"
    });
  }catch(error){
    try{await client.query("ROLLBACK")}catch{}
    if(error?.code==="23505") return res.status(409).json({error:"У вас уже есть заявка в обработке"});
    console.error("Withdraw create error:",error);
    res.status(500).json({error:"Could not create withdrawal"});
  }finally{client.release()}
});
app.get("/api/admin/withdrawals", async (req, res) => {
  const provided = Buffer.from(
    req.get("X-Withdraw-Admin-Secret") || ""
  );

  const expected = Buffer.from(WITHDRAW_ADMIN_SECRET);

  if (
    !WITHDRAW_ADMIN_SECRET ||
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  try {
    const result = await pool.query(`
      SELECT
        w.*,
        u.username,
        u.first_name,
        u.last_name
      FROM withdraw_requests w
      LEFT JOIN users u
      ON u.telegram_id = w.telegram_id
      ORDER BY w.created_at DESC
    `);

    res.json({
      ok: true,
      withdrawals: result.rows.map(row => ({
        ...serializeWithdrawal(row),
        telegramId: row.telegram_id,
        username: row.username,
        firstName: row.first_name,
        lastName: row.last_name
      }))
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not load withdrawals"
    });
  }
});
app.patch("/api/admin/withdrawals/:id", async (req,res)=>{
  const provided = Buffer.from(req.get("X-Withdraw-Admin-Secret") || "");
  const expected = Buffer.from(WITHDRAW_ADMIN_SECRET);
  if(!WITHDRAW_ADMIN_SECRET || provided.length!==expected.length || !crypto.timingSafeEqual(provided,expected)){
    return res.status(401).json({error:"Unauthorized"});
  }
  const status = String(req.body.status || "").toLowerCase();
  const txHash = String(req.body.txHash || "").trim().slice(0,200);
  const adminNote = String(req.body.adminNote || "").trim().slice(0,500);
  if(!["sent","rejected"].includes(status)) return res.status(400).json({error:"Status must be sent or rejected"});
  // В режиме разработки разрешаем подтверждение без txHash
if (status === "sent" && !txHash) {
  console.log("Withdrawal confirmed without txHash (development mode)");
}

  const client = await pool.connect();
  try{
    await client.query("BEGIN");
    const found = await client.query(`SELECT * FROM withdraw_requests WHERE id=$1 FOR UPDATE`,[req.params.id]);
    if(!found.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Withdrawal not found"})}
    const row = found.rows[0];
    if(row.status!=="pending"){await client.query("ROLLBACK");return res.status(409).json({error:"Already processed"})}
    if(status==="rejected"){
      await client.query(`INSERT INTO daily_rewards(telegram_id) VALUES($1) ON CONFLICT DO NOTHING`,[row.telegram_id]);
      await client.query(`UPDATE daily_rewards SET reward_balance=reward_balance+$2::numeric,updated_at=NOW() WHERE telegram_id=$1`,[row.telegram_id,String(row.amount)]);
    }
    const updated = await client.query(`UPDATE withdraw_requests SET status=$2,tx_hash=NULLIF($3,''),admin_note=NULLIF($4,''),processed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[row.id,status,txHash,adminNote]);
    await client.query("COMMIT");
    res.json({ok:true,withdrawal:serializeWithdrawal(updated.rows[0]),refunded:status==="rejected"});
  }catch(error){
    try{await client.query("ROLLBACK")}catch{}
    console.error("Withdraw admin error:",error);
    res.status(500).json({error:"Could not update withdrawal"});
  }finally{client.release()}
});

app.post(
  "/api/orders",
  requireTelegramUser,
  async (req, res) => {
    try {
      const walletAddress = normalizeAddress(
        req.body.walletAddress
      );

      const trackTitle = cleanTrackTitle(
        req.body.trackTitle
      );

      const licenseType = String(
        req.body.licenseType || ""
      ).toLowerCase();

      const license = LICENSES[licenseType];

      if (!walletAddress) {
        return res.status(400).json({
          error: "Wallet address is required"
        });
      }

      if (!trackTitle) {
        return res.status(400).json({
          error: "Track title is required"
        });
      }

      if (!SELLABLE_TRACKS.has(trackTitle)) {
        return res.status(400).json({
          error: "Этот трек не продаётся"
        });
      }

      if (!license) {
        return res.status(400).json({
          error: "Unknown license type"
        });
      }

      const orderId = crypto.randomUUID();

      const comment =
        `ASIQPAI-${licenseType.toUpperCase()}-${orderId}`;

      await pool.query(
        `INSERT INTO payment_orders
         (
           id,
           telegram_id,
           wallet_address,
           comment,
           track_title,
           license_type,
           price_gram,
           amount_nano,
           status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')`,
        [
          orderId,
          req.telegramUser.id,
          walletAddress,
          comment,
          trackTitle,
          licenseType,
          license.priceGram,
          license.amountNano
        ]
      );

      return res.status(201).json({
        orderId,
        address: MERCHANT_WALLET,
        amount: license.amountNano,
        amountGram: license.priceGram,
        trackTitle,
        licenseType,
        payload: createCommentPayload(comment),
        status: "pending"
      });
    } catch (error) {
      console.error(
        "Order creation error:",
        error
      );

      return res.status(500).json({
        error: "Could not create order"
      });
    }
  }
);

app.get(
  "/api/orders/:id",
  requireTelegramUser,
  async (req, res) => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `SELECT *
         FROM payment_orders
         WHERE id = $1
           AND telegram_id = $2
         FOR UPDATE`,
        [
          req.params.id,
          req.telegramUser.id
        ]
      );

      if (result.rowCount === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          error: "Order not found"
        });
      }

      const order = result.rows[0];

      if (order.status === "paid") {
        await client.query("COMMIT");

        return res.json({
          orderId: order.id,
          status: "paid",
          trackTitle: order.track_title,
          licenseType: order.license_type,
          priceGram: order.price_gram,
          delivered: Boolean(order.delivered_at),
          txHash: order.tx_hash
        });
      }

      if (order.status === "expired") {
        await client.query("COMMIT");

        return res.json({
          orderId: order.id,
          status: "expired"
        });
      }

      const ageMs =
        Date.now() -
        new Date(order.created_at).getTime();

      if (ageMs > ORDER_TTL_MS) {
        await client.query(
          `UPDATE payment_orders
           SET status = 'expired'
           WHERE id = $1`,
          [order.id]
        );

        await client.query("COMMIT");

        return res.json({
          orderId: order.id,
          status: "expired"
        });
      }

      const payment = await findPayment({
        merchantWallet: MERCHANT_WALLET,
        expectedSource: order.wallet_address,
        expectedAmountNano: order.amount_nano,
        comment: order.comment,
        apiKey: TONCENTER_API_KEY
      });

      if (!payment) {
        await client.query("COMMIT");

        return res.json({
          orderId: order.id,
          status: "pending"
        });
      }

      const transactionHash =
        payment.hash ||
        `${payment.lt}:${order.comment}`;

      await client.query(
        `UPDATE payment_orders
         SET status = 'paid',
             tx_hash = $2,
             tx_lt = $3,
             paid_at = NOW()
         WHERE id = $1`,
        [
          order.id,
          transactionHash,
          payment.lt
        ]
      );

      await client.query("COMMIT");

      await sendTelegramNotification({
        telegramUser: req.telegramUser,
        order,
        payment
      });

      return res.json({
        orderId: order.id,
        status: "paid",
        trackTitle: order.track_title,
        licenseType: order.license_type,
        priceGram: order.price_gram,
        delivered: false,
        txHash: transactionHash
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Rollback error:",
          rollbackError
        );
      }

      console.error(
        "Payment verification error:",
        error
      );

      return res.status(500).json({
        error: "Could not verify payment"
      });
    } finally {
      client.release();
    }
  }
);

await initDatabase();
await initDailyRewardTable();
await initWithdrawalsTable();

app.listen(PORT, () => {
  console.log(
    `ASIQPAI backend is running on port ${PORT}`
  );
});
