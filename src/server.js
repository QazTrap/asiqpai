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
const MERCHANT_WALLET = process.env.MERCHANT_WALLET;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;

const PAYMENT_AMOUNT_NANO =
  process.env.PAYMENT_AMOUNT_NANO || "10000000000";

const GP_REWARD = Number(
  process.env.GP_REWARD || 100000
);

const AUTH_MAX_AGE = Number(
  process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 86400
);

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

  const amountTon = (
    Number(order.amount_nano) / 1_000_000_000
  ).toString();

  const transactionHash =
    payment.hash ||
    `${payment.lt}:${order.comment}`;

  const message = [
    "🛒 Новая покупка ASIQPAI",
    "",
    `👤 Покупатель: ${fullName}`,
    `🔗 Username: ${username}`,
    `🆔 Telegram ID: ${telegramUser.id}`,
    "",
    `💎 Начислено GP: ${order.gp_reward}`,
    `💰 Оплачено: ${amountTon} TON`,
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

app.post(
  "/api/orders",
  requireTelegramUser,
  async (req, res) => {
    try {
      const walletAddress = normalizeAddress(
        req.body.walletAddress
      );

      if (!walletAddress) {
        return res.status(400).json({
          error: "Wallet address is required"
        });
      }

      const orderId = crypto.randomUUID();
      const comment = `ASIQPAI-GP-${orderId}`;

      await pool.query(
        `INSERT INTO payment_orders
         (
           id,
           telegram_id,
           wallet_address,
           comment,
           amount_nano,
           gp_reward
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          orderId,
          req.telegramUser.id,
          walletAddress,
          comment,
          PAYMENT_AMOUNT_NANO,
          GP_REWARD
        ]
      );

      return res.status(201).json({
        orderId,
        address: MERCHANT_WALLET,
        amount: PAYMENT_AMOUNT_NANO,
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

      /*
       * Заказ уже был подтверждён ранее.
       * Повторное уведомление в группу не отправляем.
       */
      if (order.status === "paid") {
        let gpTotal;

        if (!order.credited_at) {
          const creditResult =
            await client.query(
              `UPDATE users
               SET gp = gp + $2,
                   updated_at = NOW()
               WHERE telegram_id = $1
               RETURNING gp::text AS gp`,
              [
                req.telegramUser.id,
                order.gp_reward
              ]
            );

          await client.query(
            `UPDATE payment_orders
             SET credited_at = NOW()
             WHERE id = $1
               AND credited_at IS NULL`,
            [order.id]
          );

          gpTotal =
            creditResult.rows[0]?.gp;
        } else {
          const userResult =
            await client.query(
              `SELECT gp::text AS gp
               FROM users
               WHERE telegram_id = $1`,
              [req.telegramUser.id]
            );

          gpTotal =
            userResult.rows[0]?.gp;
        }

        await client.query("COMMIT");

        return res.json({
          orderId: order.id,
          status: "paid",
          gpReward: order.gp_reward,
          gpTotal,
          txHash: order.tx_hash
        });
      }

      const ageMs =
        Date.now() -
        new Date(order.created_at).getTime();

      if (ageMs > 30 * 60 * 1000) {
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

      const creditResult =
        await client.query(
          `UPDATE users
           SET gp = gp + $2,
               updated_at = NOW()
           WHERE telegram_id = $1
           RETURNING gp::text AS gp`,
          [
            req.telegramUser.id,
            order.gp_reward
          ]
        );

      await client.query(
        `UPDATE payment_orders
         SET credited_at = NOW()
         WHERE id = $1`,
        [order.id]
      );

      await client.query("COMMIT");

      /*
       * Уведомление отправляется только при первом
       * подтверждении новой оплаты.
       */
      await sendTelegramNotification({
        telegramUser: req.telegramUser,
        order,
        payment
      });

      return res.json({
        orderId: order.id,
        status: "paid",
        gpReward: order.gp_reward,
        gpTotal: creditResult.rows[0]?.gp,
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

app.listen(PORT, () => {
  console.log(
    `ASIQPAI backend is running on port ${PORT}`
  );
});
