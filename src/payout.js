import {
  Address,
  beginCell,
  internal,
  SendMode,
  toNano
} from "@ton/core";

import {
  TonClient,
  WalletContractV5R1
} from "@ton/ton";

import {
  mnemonicToPrivateKey
} from "@ton/crypto";

const ASIQ_MASTER_ADDRESS =
  "EQDtaiYQRMlcGHXVkcK873McLzx-JQUZtyR8W1O6e2XISp52";

const ASIQ_DECIMALS = 9;

const client = new TonClient({
  endpoint:
    process.env.TON_RPC ||
    "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TONCENTER_API_KEY || undefined
});

function getMnemonicWords() {
  const value = String(
    process.env.PAYOUT_MNEMONIC || ""
  ).trim();

  if (!value) {
    throw new Error(
      "PAYOUT_MNEMONIC is not configured"
    );
  }

  const words = value
    .split(/\s+/)
    .filter(Boolean);

  if (words.length !== 24) {
    throw new Error(
      `PAYOUT_MNEMONIC must contain 24 words; received ${words.length}`
    );
  }

  return words;
}

function getExpectedAddress() {
  const value = String(
    process.env.PAYOUT_WALLET_ADDRESS || ""
  ).trim();

  if (!value) {
    throw new Error(
      "PAYOUT_WALLET_ADDRESS is not configured"
    );
  }

  try {
    return Address.parse(value);
  } catch {
    throw new Error(
      "PAYOUT_WALLET_ADDRESS is not a valid TON address"
    );
  }
}

function parseAsiqAmount(value) {
  const amount = String(value).trim();

  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error("Invalid ASIQ amount");
  }

  const [whole, fraction = ""] = amount.split(".");

  if (fraction.length > ASIQ_DECIMALS) {
    throw new Error(
      `ASIQ supports maximum ${ASIQ_DECIMALS} decimal places`
    );
  }

  const normalizedFraction =
    fraction.padEnd(ASIQ_DECIMALS, "0");

  const units =
    BigInt(whole) * 10n ** BigInt(ASIQ_DECIMALS) +
    BigInt(normalizedFraction || "0");

  if (units <= 0n) {
    throw new Error(
      "ASIQ amount must be greater than zero"
    );
  }

  return units;
}

export async function getPayoutWallet() {
  const mnemonicWords = getMnemonicWords();

  const keyPair =
    await mnemonicToPrivateKey(mnemonicWords);

  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey
  });

  return {
    wallet,
    keyPair
  };
}

export async function verifyPayoutWallet() {
  const expectedAddress =
    getExpectedAddress();

  const { wallet } =
    await getPayoutWallet();

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
    rawAddress:
      wallet.address.toRawString()
  };
}

async function getJettonWalletAddress(ownerAddress) {
  const masterAddress =
    Address.parse(ASIQ_MASTER_ADDRESS);

  const result = await client.runMethod(
    masterAddress,
    "get_wallet_address",
    [
      {
        type: "slice",
        cell: beginCell()
          .storeAddress(ownerAddress)
          .endCell()
      }
    ]
  );

  return result.stack.readAddress();
}

function createJettonTransferBody({
  destination,
  responseDestination,
  amount,
  queryId
}) {
  return beginCell()
    // transfer operation согласно TEP-74
    .storeUint(0x0f8a7ea5, 32)

    // уникальный ID запроса
    .storeUint(queryId, 64)

    // количество ASIQ в минимальных единицах
    .storeCoins(amount)

    // обычный TON-адрес получателя
    .storeAddress(destination)

    // сюда вернутся остатки комиссии
    .storeAddress(responseDestination)

    // custom_payload отсутствует
    .storeBit(0)

    // 1 нанограмм для transfer_notification
    .storeCoins(1n)

    // forward_payload хранится прямо в cell
    .storeBit(0)

    .endCell();
}

async function waitForSeqnoChange(
  walletContract,
  previousSeqno,
  timeoutMs = 60000
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) =>
      setTimeout(resolve, 3000)
    );

    const currentSeqno =
      await walletContract.getSeqno();

    if (currentSeqno > previousSeqno) {
      return currentSeqno;
    }
  }

  throw new Error(
    "Transaction was sent, but wallet seqno did not change within 60 seconds"
  );
}

export async function sendAsiqJettons({
  destination,
  amount,
  queryId
}) {
  const destinationAddress =
    Address.parse(String(destination).trim());

  const jettonAmount =
    parseAsiqAmount(amount);

  const { wallet, keyPair } =
    await getPayoutWallet();

  const expectedAddress =
    getExpectedAddress();

  if (!wallet.address.equals(expectedAddress)) {
    throw new Error(
      "Payout wallet does not match PAYOUT_WALLET_ADDRESS"
    );
  }

  const walletContract =
    client.open(wallet);

  const balance =
    await walletContract.getBalance();

  // На оплату Jetton-перевода нужен GRAM.
  if (balance < toNano("0.12")) {
    throw new Error(
      "Payout wallet has insufficient GRAM for transaction fees"
    );
  }

  const senderJettonWallet =
    await getJettonWalletAddress(
      wallet.address
    );

  const numericQueryId =
    queryId !== undefined
      ? BigInt(queryId)
      : BigInt(Date.now());

  const transferBody =
    createJettonTransferBody({
      destination:
        destinationAddress,
      responseDestination:
        wallet.address,
      amount:
        jettonAmount,
      queryId:
        numericQueryId
    });

  const seqno =
    await walletContract.getSeqno();

  await walletContract.sendTransfer({
    seqno,
    secretKey:
      keyPair.secretKey,

    sendMode:
      SendMode.PAY_GAS_SEPARATELY |
      SendMode.IGNORE_ERRORS,

    messages: [
      internal({
        to:
          senderJettonWallet,

        // Комиссия на обработку Jetton Wallet
        // и возможное создание Jetton Wallet получателя
        value:
          toNano("0.08"),

        bounce:
          true,

        body:
          transferBody
      })
    ]
  });

  await waitForSeqnoChange(
    walletContract,
    seqno
  );

  return {
    ok: true,

    queryId:
      numericQueryId.toString(),

    amount:
      String(amount),

    destination:
      destinationAddress.toString({
        bounceable: false,
        testOnly: false
      }),

    senderWallet:
      wallet.address.toString({
        bounceable: false,
        testOnly: false
      }),

    senderJettonWallet:
      senderJettonWallet.toString({
        bounceable: true,
        testOnly: false
      }),

    seqnoBefore:
      seqno,

    seqnoAfter:
      seqno + 1
  };
}
