import { Address, beginCell, toNano } from "@ton/core";
import { TonClient, WalletContractV5R1 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";

/**
 * Читает и проверяет конфигурацию payout-кошелька.
 *
 * Railway Variables:
 *   PAYOUT_MNEMONIC="word1 word2 ... word24"
 *   PAYOUT_WALLET_ADDRESS="UQ... или EQ..."
 *
 * Этот файл пока НЕ отправляет транзакции.
 */

function getMnemonicWords() {
  const value = String(process.env.PAYOUT_MNEMONIC || "").trim();

  if (!value) {
    throw new Error("PAYOUT_MNEMONIC is not configured");
  }

  const words = value.split(/\s+/).filter(Boolean);

  if (words.length !== 24) {
    throw new Error(
      `PAYOUT_MNEMONIC must contain 24 words; received ${words.length}`
    );
  }

  return words;
}
const client = new TonClient({
  endpoint: process.env.TON_RPC || "https://toncenter.com/api/v2/jsonRPC"
});

export async function getPayoutWallet() {
  
}

export async function verifyPayoutWallet() {
  
}
function getExpectedAddress() {
  const value = String(process.env.PAYOUT_WALLET_ADDRESS || "").trim();

  if (!value) {
    throw new Error("PAYOUT_WALLET_ADDRESS is not configured");
  }

  try {
    return Address.parse(value);
  } catch {
    throw new Error("PAYOUT_WALLET_ADDRESS is not a valid TON address");
  }
}

/**
 * Восстанавливает Wallet V5R1 из мнемоники.
 * Никаких сетевых запросов и переводов здесь нет.
 */
export async function getPayoutWallet() {
  const mnemonicWords = getMnemonicWords();
  const keyPair = await mnemonicToPrivateKey(mnemonicWords);

  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey
  });

  return {
    wallet,
    keyPair
  };
}

/**
 * Проверяет, что мнемоника соответствует указанному payout-адресу.
 * Seed-фраза никогда не возвращается и не выводится в лог.
 */
export async function verifyPayoutWallet() {
  const expectedAddress = getExpectedAddress();
  const { wallet } = await getPayoutWallet();

  if (!wallet.address.equals(expectedAddress)) {
    throw new Error(
      [
        "Payout wallet address mismatch.",
        `Derived: ${wallet.address.toString({
          bounceable: false,
          testOnly: false
        })}`,
        `Expected: ${expectedAddress.toString({
          bounceable: false,
          testOnly: false
        })}`,
        "Проверь PAYOUT_MNEMONIC, PAYOUT_WALLET_ADDRESS и версию кошелька W5."
      ].join(" ")
    );
  }

  return {
    ok: true,
    version: "v5r1",
    address: wallet.address.toString({
      bounceable: false,
      testOnly: false
    }),
    rawAddress: wallet.address.toRawString()
  };
}
