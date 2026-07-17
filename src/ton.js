import { Address, beginCell } from "@ton/core";

export function createCommentPayload(comment) {
  return beginCell()
    .storeUint(0, 32)
    .storeStringTail(comment)
    .endCell()
    .toBoc()
    .toString("base64");
}

export function normalizeAddress(value) {
  if (!value) return "";
  try {
    return Address.parse(value).toRawString();
  } catch {
    return String(value).trim();
  }
}

function decodePossibleBase64(value) {
  if (!value || typeof value !== "string") return "";
  try {
    return Buffer.from(value, "base64").toString("utf8").replace(/^\u0000{4}/, "");
  } catch {
    return "";
  }
}

export function extractIncomingComment(inMessage) {
  if (!inMessage) return "";

  const directCandidates = [
    inMessage.message,
    inMessage.comment,
    inMessage.decoded_body?.text,
    inMessage.decoded_body?.comment
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const encodedCandidates = [
    inMessage.msg_data?.text,
    inMessage.message_content?.body,
    inMessage.body
  ];

  for (const candidate of encodedCandidates) {
    const decoded = decodePossibleBase64(candidate);
    if (decoded.trim()) return decoded.trim();
  }

  return "";
}

export async function findPayment({
  merchantWallet,
  expectedSource,
  expectedAmountNano,
  comment,
  apiKey
}) {
  const url = new URL("https://toncenter.com/api/v2/getTransactions");
  url.searchParams.set("address", merchantWallet);
  url.searchParams.set("limit", "50");
  url.searchParams.set("archival", "true");

  const response = await fetch(url, {
    headers: apiKey ? { "X-API-Key": apiKey } : {}
  });

  if (!response.ok) {
    throw new Error(`TON Center error ${response.status}`);
  }

  const body = await response.json();
  const transactions = Array.isArray(body.result) ? body.result : [];

  const merchant = normalizeAddress(merchantWallet);
  const sender = normalizeAddress(expectedSource);

  for (const tx of transactions) {
    const incoming = tx.in_msg ?? tx.inMessage ?? tx.in_message;
    if (!incoming) continue;

    const destination = normalizeAddress(incoming.destination);
    const source = normalizeAddress(incoming.source);
    const amount = BigInt(incoming.value ?? incoming.amount ?? "0");
    const txComment = extractIncomingComment(incoming);

    const successful =
      tx.aborted !== true &&
      tx.destroyed !== true &&
      tx.compute_ph?.success !== false;

    if (
      successful &&
      destination === merchant &&
      source === sender &&
      amount >= BigInt(expectedAmountNano) &&
      txComment === comment
    ) {
      return {
        hash: tx.transaction_id?.hash ?? tx.hash ?? "",
        lt: tx.transaction_id?.lt ?? tx.lt ?? "",
        amount: amount.toString(),
        source,
        destination,
        comment: txComment
      };
    }
  }

  return null;
}
