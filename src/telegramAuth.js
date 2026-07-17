import crypto from "node:crypto";

export function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) {
    throw new Error("Telegram initData or bot token is missing");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash) {
    throw new Error("Telegram hash is missing");
  }

  params.delete("hash");
  params.delete("signature");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const expected = Buffer.from(calculatedHash, "hex");
  const actual = Buffer.from(receivedHash, "hex");

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error("Invalid Telegram initData signature");
  }

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);

  if (!Number.isFinite(authDate) || now - authDate > maxAgeSeconds || authDate > now + 60) {
    throw new Error("Telegram initData has expired");
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    throw new Error("Telegram user is missing");
  }

  const user = JSON.parse(userRaw);
  return { user, authDate };
}
