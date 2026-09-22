// 구독 결제(포트원 V2 빌링키) 관련 API 라우트 + 정기결제 자동 실행(cron).
// - POST /api/payments/subscribe : 프론트에서 발급받은 빌링키로 첫 결제를 시도하고,
//   성공하면 Firestore에 구독 상태 + 결제내역을 반영한다.
// - POST /api/payments/cancel    : 구독 해지(자동결제 중단).
// - POST /api/payments/webhook   : 포트원이 보내는 결제 결과 알림 수신.
// - runScheduledBilling(env)     : Cloudflare Cron Trigger에서 매일 호출 — 다음 결제일이
//   지난 구독자를 찾아 저장해둔 빌링키로 자동으로 재결제한다(index.js의 scheduled 핸들러 참고).

import { payWithBillingKey, getPayment, verifyPortOneWebhook } from "./portone.js";
import { firestoreGetDoc, firestorePatchDoc, firestoreAddDoc, firestoreQuery, firestoreQueryDueBilling } from "./firestore.js";

const PLANS = {
  monthly: { amount: 3000, orderName: "기억숲 구독 (월간)", periodMonths: 1 },
  annual: { amount: 28000, orderName: "기억숲 구독 (연간)", periodMonths: 12 },
};

// 포트원 결제 상세 조회(getPayment) 응답에서 등록된 카드 정보를 뽑아낸다.
// 카드 결제가 아니거나 조회에 실패하면 null을 반환 -- 카드 정보는 화면 표시용
// 부가 정보라 실패해도 결제/구독 처리 자체를 막지 않는다.
function extractCardInfo(payment) {
  try {
    const method = payment && payment.method;
    if (method && method.type === "PaymentMethodCard" && method.card) {
      const card = method.card;
      return {
        card_brand: card.brand || null,
        card_name: card.name || null,
        card_number: card.number || null,
        card_issuer: card.issuer || null,
      };
    }
  } catch (e) {
    console.error("extract_card_info_failed", e);
  }
  return null;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + months);
  return d;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function requireUser(request, env, verifyFirebaseIdToken) {
  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return { error: jsonResponse({ error: "missing_token" }, 401) };
  try {
    const user = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
    return { user };
  } catch (e) {
    return { error: jsonResponse({ error: "invalid_token", detail: String(e.message || e) }, 401) };
  }
}

export async function handleSubscribe(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "bad_json" }, 400);
  }

  const { billingKey, plan, fullName: bodyFullName, phoneNumber: bodyPhoneNumber } = body || {};
  if (!billingKey || !PLANS[plan]) {
    return jsonResponse({ error: "invalid_params" }, 400);
  }
  const planInfo = PLANS[plan];

  // 결제 요청에 이름/전화번호가 없으면(구버전 프론트 등) Firestore에 저장된 값으로 보완한다.
  // KG이니시스 채널은 이 두 값이 없으면 실제 청구(REST 결제) 요청 자체를 거부한다.
  let fullName = bodyFullName;
  let phoneNumber = bodyPhoneNumber;
  if (!fullName || !phoneNumber) {
    try {
      const userDoc = await firestoreGetDoc(env, `users/${user.uid}`);
      if (userDoc) {
        fullName = fullName || userDoc.name;
        phoneNumber = phoneNumber || userDoc.phone;
      }
    } catch (e) {
      console.error("firestore_user_lookup_failed", e);
    }
  }
  if (!fullName || !phoneNumber) {
    return jsonResponse({ error: "missing_customer_info", detail: "이름/휴대폰번호가 필요해요." }, 400);
  }

  // KG이니시스 등 일부 PG는 주문번호(oid) 길이를 40자로 제한하므로 uid를 그대로 넣지 않고 짧게 채번한다.
  const paymentId = `sub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  let result;
  try {
    result = await payWithBillingKey(env, {
      paymentId,
      billingKey,
      orderName: planInfo.orderName,
      amount: planInfo.amount,
      currency: "KRW",
      customer: {
        id: user.uid,
        name: { full: fullName },
        phoneNumber,
        email: user.email || undefined,
      },
    });
  } catch (e) {
    return jsonResponse({ error: "portone_request_failed", detail: String(e.message || e) }, 502);
  }

  if (!result.ok) {
    // 결제 실패 — 구독을 활성화하지 않고 실패 사유만 돌려준다.
    const message = result.data && (result.data.message || result.data.pgMessage);
    return jsonResponse({ error: "payment_failed", detail: message || result.data }, 402);
  }

  const now = new Date();
  const nextBillingAt = addMonths(now, planInfo.periodMonths);

  // 등록된 카드 정보(마스킹된 카드번호, 브랜드 등)를 조회해 사용자 화면/어드민 화면에
  // 노출할 수 있게 저장해둔다. 조회에 실패해도 결제 자체는 이미 끝났으니 계속 진행.
  let cardInfo = null;
  try {
    const paymentDetail = await getPayment(env, paymentId);
    cardInfo = extractCardInfo(paymentDetail);
  } catch (e) {
    console.error("get_payment_for_card_info_failed", e);
  }

  try {
    await firestoreAddDoc(env, "payments", {
      uid: user.uid,
      amount: planInfo.amount,
      plan,
      method: "카드",
      status: "paid",
      paid_at: now,
      created_at: now,
      created_by: "portone",
      payment_id: paymentId,
      ...(cardInfo || {}),
    });
    await firestorePatchDoc(env, `users/${user.uid}`, {
      subscription_status: "active",
      subscription_plan: plan,
      billing_key: billingKey,
      auto_renew: true,
      billing_key_issued_at: now,
      next_billing_at: nextBillingAt,
      ...(cardInfo || {}),
    });
  } catch (e) {
    // 결제 자체는 이미 성공했으니 사용자에게는 성공으로 알리되, 서버 기록 실패는
    // 로그로만 남긴다(운영 중 Cloudflare 로그에서 확인). 그대로 두면 구독 상태가
    // 반영 안 될 수 있어 관리자 화면에서 수동 확인이 필요할 수 있음.
    console.error("firestore_update_failed_after_payment", e);
    return jsonResponse({
      ok: true,
      warning: "결제는 완료됐지만 구독 상태 저장 중 문제가 있었어요. 잠시 후 새로고침해서 확인해 주세요.",
    });
  }

  return jsonResponse({ ok: true, paymentId });
}

export async function handleCancel(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;

  try {
    await firestorePatchDoc(env, `users/${user.uid}`, {
      subscription_status: "canceled",
      auto_renew: false,
      next_billing_at: null,
    });
  } catch (e) {
    return jsonResponse({ error: "firestore_update_failed", detail: String(e.message || e) }, 500);
  }
  return jsonResponse({ ok: true });
}

export async function handleWebhook(request, env) {
  const rawBody = await request.text();
  let event;
  try {
    event = await verifyPortOneWebhook(env.PORTONE_WEBHOOK_SECRET, rawBody, request.headers);
  } catch (e) {
    return jsonResponse({ error: "invalid_signature", detail: String(e.message || e) }, 401);
  }

  if (!event.type || !event.type.startsWith("Transaction.")) {
    // 빌링키 발급/삭제 등 결제 이외의 이벤트는 지금 단계에서는 무시.
    return jsonResponse({ ok: true, ignored: true });
  }

  const paymentId = event.data && event.data.paymentId;
  if (!paymentId) return jsonResponse({ ok: true, ignored: true });

  let payment;
  try {
    payment = await getPayment(env, paymentId);
  } catch (e) {
    return jsonResponse({ error: "portone_get_payment_failed", detail: String(e.message || e) }, 502);
  }

  try {
    const rows = await firestoreQuery(env, "payments", "payment_id", "EQUAL", paymentId);
    const uid = rows[0] && rows[0].uid;
    if (rows[0]) {
      await firestorePatchDoc(env, `payments/${rows[0].id}`, {
        status: payment.status === "PAID" ? "paid" : payment.status === "CANCELLED" ? "refunded" : "failed",
      });
    }
    if (uid && payment.status === "FAILED") {
      await firestorePatchDoc(env, `users/${uid}`, {
        subscription_status: "none",
        auto_renew: false,
        next_billing_at: null,
      });
    }
  } catch (e) {
    console.error("webhook_firestore_update_failed", e);
    // 웹훅은 실패해도 포트원이 재시도하므로, 500을 돌려주면 재전송을 유도할 수 있다.
    return jsonResponse({ error: "internal_error" }, 500);
  }

  return jsonResponse({ ok: true });
}

export async function handlePaymentsRoute(request, env, url, verifyFirebaseIdToken) {
  if (url.pathname === "/api/payments/subscribe" && request.method === "POST") {
    return handleSubscribe(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/cancel" && request.method === "POST") {
    return handleCancel(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/webhook" && request.method === "POST") {
    return handleWebhook(request, env);
  }
  return null;
}

// 정기결제 자동 실행 -- Cloudflare Cron Trigger가 매일 한 번 호출한다(index.js의
// scheduled 핸들러 참고). 구독중(active) + 자동결제(auto_renew) + 다음 결제일 도래
// 조건을 만족하는 사용자를 찾아 저장된 빌링키로 다시 청구하고, 성공/실패를 각각
// Firestore에 반영한다. 결제 실패 시에는 구독을 자동으로 해지 처리한다(재시도 없음 --
// 카드 재등록은 사용자가 다시 구독하기를 눌러야 한다. 재시도 로직은 다음 단계 과제).
export async function runScheduledBilling(env) {
  const now = new Date();
  let dueUsers;
  try {
    dueUsers = await firestoreQueryDueBilling(env, now);
  } catch (e) {
    console.error("billing_query_failed", e);
    return;
  }

  console.log(`[정기결제] 대상 ${dueUsers.length}명 확인`);

  for (const userDoc of dueUsers) {
    const uid = userDoc.id;
    const plan = userDoc.subscription_plan;
    const billingKey = userDoc.billing_key;
    const planInfo = PLANS[plan];

    if (!planInfo || !billingKey) {
      console.error("billing_skip_invalid_user", uid, plan);
      continue;
    }

    const paymentId = `sub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let result;
    try {
      result = await payWithBillingKey(env, {
        paymentId,
        billingKey,
        orderName: planInfo.orderName,
        amount: planInfo.amount,
        currency: "KRW",
        customer: {
          id: uid,
          name: userDoc.name ? { full: userDoc.name } : undefined,
          phoneNumber: userDoc.phone || undefined,
          email: userDoc.email || undefined,
        },
      });
    } catch (e) {
      console.error("billing_request_failed", uid, e);
      continue;
    }

    const chargedAt = new Date();

    if (result.ok) {
      const nextBillingAt = addMonths(chargedAt, planInfo.periodMonths);
      let cardInfo = null;
      try {
        const paymentDetail = await getPayment(env, paymentId);
        cardInfo = extractCardInfo(paymentDetail);
      } catch (e) {
        console.error("get_payment_for_card_info_failed_cron", uid, e);
      }
      try {
        await firestoreAddDoc(env, "payments", {
          uid,
          amount: planInfo.amount,
          plan,
          method: "카드",
          status: "paid",
          paid_at: chargedAt,
          created_at: chargedAt,
          created_by: "portone-cron",
          payment_id: paymentId,
          ...(cardInfo || {}),
        });
        await firestorePatchDoc(env, `users/${uid}`, {
          next_billing_at: nextBillingAt,
          last_billing_at: chargedAt,
          ...(cardInfo || {}),
        });
        console.log("[정기결제] 성공", uid, plan);
      } catch (e) {
        console.error("billing_firestore_update_failed", uid, e);
      }
    } else {
      const message = result.data && (result.data.message || result.data.pgMessage);
      console.error("billing_failed", uid, message);
      try {
        await firestoreAddDoc(env, "payments", {
          uid,
          amount: planInfo.amount,
          plan,
          method: "카드",
          status: "failed",
          paid_at: null,
          created_at: chargedAt,
          created_by: "portone-cron",
          payment_id: paymentId,
        });
        // 재결제 실패 -- 다음 단계(재시도)가 생기기 전까지는 구독을 바로 해지 처리해서
        // 실패한 채로 매일 계속 재시도되는 걸 막는다.
        await firestorePatchDoc(env, `users/${uid}`, {
          subscription_status: "none",
          auto_renew: false,
          next_billing_at: null,
        });
      } catch (e) {
        console.error("billing_firestore_update_failed_after_failure", uid, e);
      }
    }
  }
}
