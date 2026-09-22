// 포트원(PortOne) V2 REST API 클라이언트 + 웹훅 검증
// (Standard Webhooks 규격: https://www.standardwebhooks.com/ 와 동일한 방식을
//  포트원이 그대로 채택하고 있음 — @portone/server-sdk의 verify() 구현을 참고해
//  Cloudflare Workers의 Web Crypto로 직접 구현했다.)

const PORTONE_API_BASE = "https://api.portone.io";

export async function payWithBillingKey(env, { paymentId, billingKey, orderName, amount, currency, customer }) {
  const res = await fetch(`${PORTONE_API_BASE}/payments/${encodeURIComponent(paymentId)}/billing-key`, {
    method: "POST",
    headers: {
      Authorization: `PortOne ${env.PORTONE_API_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      billingKey,
      orderName,
      amount: { total: amount },
      currency: currency || "KRW",
      customer,
    }),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

export async function getPayment(env, paymentId) {
  const res = await fetch(`${PORTONE_API_BASE}/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `PortOne ${env.PORTONE_API_SECRET}` },
  });
  if (!res.ok) throw new Error("portone_get_payment_failed: " + (await res.text()));
  return res.json();
}

export async function deleteBillingKey(env, billingKey) {
  const res = await fetch(`${PORTONE_API_BASE}/billing-keys/${encodeURIComponent(billingKey)}`, {
    method: "DELETE",
    headers: { Authorization: `PortOne ${env.PORTONE_API_SECRET}` },
  });
  return res.ok;
}

// --- 웹훅 서명 검증 (Standard Webhooks 규격) ---

class WebhookVerificationError extends Error {}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacSha256(rawSecretBytes, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    rawSecretBytes.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// headers: Fetch API Headers 인스턴스. payload: raw body 문자열(파싱 전).
// 검증 성공 시 JSON.parse(payload)를 반환, 실패 시 throw.
export async function verifyPortOneWebhook(secret, payload, headers) {
  const msgId = headers.get("webhook-id");
  const msgTimestamp = headers.get("webhook-timestamp");
  const msgSignature = headers.get("webhook-signature");
  if (!msgId || !msgTimestamp || !msgSignature) {
    throw new WebhookVerificationError("필수 웹훅 헤더가 누락됐어요.");
  }

  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(msgTimestamp, 10);
  if (Number.isNaN(ts) || Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new WebhookVerificationError("웹훅 타임스탬프가 유효 범위를 벗어났어요.");
  }

  const secretB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const rawSecret = base64ToBytes(secretB64);
  const expected = await hmacSha256(rawSecret, `${msgId}.${msgTimestamp}.${payload}`);

  for (const part of msgSignature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    let sigBytes;
    try {
      sigBytes = base64ToBytes(sig);
    } catch (e) {
      continue;
    }
    if (timingSafeEqual(sigBytes, expected)) {
      return JSON.parse(payload);
    }
  }
  throw new WebhookVerificationError("웹훅 서명이 일치하지 않아요.");
}
