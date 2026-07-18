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

app.listen(PORT, () => {
  console.log(
    `ASIQPAI backend is running on port ${PORT}`
  );
});
