// 구독 결제(포트원 V2 빌링키) 관련 API 라우트 + 정기결제 자동 실행(cron).
// - POST /api/payments/subscribe : 프론트에서 발급받은 빌링키로 첫 결제를 시도하고,
//   성공하면 Firestore에 구독 상태 + 결제내역을 반영한다.
// - POST /api/payments/annual    : 연간 플랜(28,000원) 단건 결제 확정. 이니시스가 연간 주기
//   정기결제를 지원하지 않아서(2026.10) 연간은 빌링키가 아니라 일반(단건) 결제로 받는다 --
//   프론트가 requestPayment로 결제를 끝낸 뒤 paymentId만 보내면, 서버가 포트원에서 결제
//   내역을 다시 조회해 금액·상태를 검증하고 이용 기간(12개월)을 부여한다. 자동 갱신은 없다.
// - POST /api/payments/cancel    : 구독 해지(자동결제 중단).
// - POST /api/payments/webhook   : 포트원이 보내는 결제 결과 알림 수신.
// - runScheduledBilling(env)     : Cloudflare Cron Trigger에서 매일 호출 — 다음 결제일이
//   지난 구독자를 찾아 저장해둔 빌링키로 자동으로 재결제한다(index.js의 scheduled 핸들러 참고).

import { payWithBillingKey, getPayment, deleteBillingKey, verifyPortOneWebhook } from "./portone.js";
import {
  firestoreGetDoc,
  firestorePatchDoc,
  firestoreAddDoc,
  firestoreQuery,
  firestoreQueryDueBilling,
  firestoreQueryDueCancellation,
} from "./firestore.js";

// oneTime: true 이면 빌링키 자동결제가 아니라 단건 결제(requestPayment)로만 구매하는 플랜.
// 연간은 PG(KG이니시스)에서 연 단위 정기결제를 허용하지 않아 단건 결제로 받는다.
const PLANS = {
  monthly: { amount: 3000, orderName: "기억숲 구독 (월간)", periodMonths: 1, oneTime: false },
  annual: { amount: 28000, orderName: "기억숲 구독 (연간)", periodMonths: 12, oneTime: true },
};

// 연간 단건 결제의 paymentId는 항상 이 접두어로 시작한다(프론트가 채번). 웹훅이 "이건 연간
// 결제구나" 하고 알아보는 용도이기도 하다. KG이니시스 주문번호는 40자 제한이 있어 짧게 쓴다.
const ANNUAL_PAYMENT_ID_PREFIX = "ann_";

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
  if (planInfo.oneTime) {
    return jsonResponse({ error: "one_time_plan", detail: "연간 플랜은 카드 등록이 아니라 단건 결제로만 이용할 수 있어요." }, 400);
  }

  let existingUser = null;
  try {
    existingUser = await firestoreGetDoc(env, `users/${user.uid}`);
  } catch (e) {
    console.error("firestore_user_lookup_failed", e);
  }

  // 이미 구독 중인 사용자가(플랜 변경 목적으로) 여기로 왔다면 바로 다시 결제하지
  // 않는다 -- 플랜 변경은 /api/payments/change-plan에서 다음 결제일부터 예약 처리한다.
  if (existingUser && existingUser.subscription_status === "active") {
    return jsonResponse({ error: "already_subscribed", detail: "이미 구독 중이에요. 플랜을 바꾸려면 change-plan을 사용하세요." }, 409);
  }

  // 결제 요청에 이름/전화번호가 없으면(구버전 프론트 등) Firestore에 저장된 값으로 보완한다.
  // KG이니시스 채널은 이 두 값이 없으면 실제 청구(REST 결제) 요청 자체를 거부한다.
  const fullName = bodyFullName || (existingUser && existingUser.name);
  const phoneNumber = bodyPhoneNumber || (existingUser && existingUser.phone);
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
      payment_type: "billing",
      billing_key: billingKey,
      auto_renew: true,
      cancel_at_period_end: false,
      pending_plan: null,
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

// 연간 단건 결제 확정 -- /api/payments/annual 과 웹훅이 같이 쓴다.
// 프론트가 알려준 값은 믿지 않고, 포트원에 결제 내역(getPayment)을 직접 다시 조회해서
// (1) 결제가 실제로 끝났는지(PAID) (2) 금액이 연간 요금과 정확히 같은지 (3) 결제한 사람이
// 이 uid가 맞는지 확인한 뒤에만 이용 기간을 준다.
//
// 이용 기간 계산: 이미 구독 중이면 남은 기간 뒤에 12개월을 이어 붙인다(월간 이용 중 연간으로
// 갈아타거나, 연간을 만료 전에 미리 연장해도 이미 낸 기간이 사라지지 않게). 월간 자동결제
// 중이었다면 빌링키를 정리해 이중 청구를 막는다.
//
// 저장 방식: 자동결제가 없으므로 auto_renew=false 로 두어 정기결제 cron(runScheduledBilling)이
// 건드리지 않게 하고, cancel_at_period_end=true 로 두어 기존 "이용 기간 종료 처리" 패스가
// 만료일(next_billing_at)에 구독을 끝내도록 한다(새 Firestore 복합 인덱스 없이 기존 로직 재사용).
// 화면에서는 payment_type="one_time" 으로 "해지 예정"이 아니라 "이용 기간 N까지"로 보여준다.
//
// 멱등성: 같은 paymentId로 두 번 호출돼도(프론트 재시도 + 웹훅) 기간이 두 번 늘지 않도록
// users 문서의 last_one_time_payment_id 로 이미 처리했는지 확인한다. (두 요청이 정확히 같은
// 순간에 겹치는 극히 드문 경우까지 막지는 못한다 -- 그 경우 기간이 한 번 더 늘 수 있지만,
// 결제했는데 이용을 못 하는 쪽보다는 안전한 방향의 오차라 감수한다.)
async function activateAnnualPurchase(env, uid, paymentId, createdBy) {
  const planInfo = PLANS.annual;

  let payment;
  try {
    payment = await getPayment(env, paymentId);
  } catch (e) {
    return { ok: false, status: 502, error: "portone_get_payment_failed", detail: String(e.message || e) };
  }

  if (payment.status !== "PAID") {
    return { ok: false, status: 402, error: "payment_not_paid", detail: payment.status };
  }
  const paidTotal = payment.amount && payment.amount.total;
  if (paidTotal !== planInfo.amount || (payment.currency && payment.currency !== "KRW")) {
    console.error("annual_amount_mismatch", uid, paymentId, paidTotal, payment.currency);
    return { ok: false, status: 400, error: "amount_mismatch" };
  }
  const payerId = payment.customer && payment.customer.id;
  if (payerId && payerId !== uid) {
    console.error("annual_payer_mismatch", uid, paymentId, payerId);
    return { ok: false, status: 403, error: "payer_mismatch" };
  }

  let userDoc = null;
  try {
    userDoc = await firestoreGetDoc(env, `users/${uid}`);
  } catch (e) {
    return { ok: false, status: 500, error: "firestore_lookup_failed", detail: String(e.message || e) };
  }
  if (userDoc && userDoc.last_one_time_payment_id === paymentId) {
    return { ok: true, already: true };
  }

  const now = new Date();
  const wasActive = !!(userDoc && userDoc.subscription_status === "active" && userDoc.next_billing_at);
  const base = wasActive && userDoc.next_billing_at.getTime() > now.getTime() ? userDoc.next_billing_at : now;
  const expiresAt = addMonths(base, planInfo.periodMonths);

  const oldBillingKey = userDoc && userDoc.billing_key;
  const cardInfo = extractCardInfo(payment);

  // 연간 이용이 "실제로 시작되는 시점" -- 월간 이용 중에 연간을 결제한 경우 월간 만료일부터 연간이
  // 시작된다(그 전까지는 월간 이용 기간). 이미 연간 이용권을 쓰던 사용자는 기존 시작 시점을 유지하고,
  // 이미 시작된 연간이면 null. 화면이 "월간 이용 중 → 이후 연간" 안내를 정확히 보여주는 데 쓴다.
  let annualStartsAt = null;
  if (wasActive) {
    const prevWasOneTime = userDoc.payment_type === "one_time";
    if (prevWasOneTime) {
      const prevStart = userDoc.annual_starts_at;
      annualStartsAt = prevStart && prevStart.getTime() > now.getTime() ? prevStart : null;
    } else if (userDoc.next_billing_at.getTime() > now.getTime()) {
      annualStartsAt = userDoc.next_billing_at;
    }
  }

  try {
    await firestorePatchDoc(env, `users/${uid}`, {
      subscription_status: "active",
      subscription_plan: "annual",
      payment_type: "one_time",
      billing_key: null,
      auto_renew: false,
      cancel_at_period_end: true,
      pending_plan: null,
      billing_key_issued_at: wasActive && userDoc.billing_key_issued_at ? userDoc.billing_key_issued_at : now,
      next_billing_at: expiresAt,
      annual_starts_at: annualStartsAt,
      last_one_time_payment_id: paymentId,
      ...(cardInfo || {}),
    });
  } catch (e) {
    console.error("annual_user_update_failed", uid, paymentId, e);
    return { ok: false, status: 500, error: "firestore_update_failed", detail: String(e.message || e) };
  }

  try {
    await firestoreAddDoc(env, "payments", {
      uid,
      amount: planInfo.amount,
      plan: "annual",
      method: "카드",
      status: "paid",
      paid_at: now,
      created_at: now,
      created_by: createdBy,
      payment_id: paymentId,
      ...(cardInfo || {}),
    });
  } catch (e) {
    // 이용 기간은 이미 부여했으니 결제내역 기록 실패는 로그만 남긴다(관리자 화면에서 수동 보완).
    console.error("annual_payment_record_failed", uid, paymentId, e);
  }

  // 월간 자동결제를 쓰던 사용자가 연간으로 갈아탄 경우 -- 남은 월간 빌링키를 정리한다.
  if (oldBillingKey) {
    try {
      await deleteBillingKey(env, oldBillingKey);
    } catch (e) {
      console.error("annual_delete_old_billing_key_failed", uid, e);
    }
  }

  return { ok: true, expiresAt };
}

export async function handleAnnual(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "bad_json" }, 400);
  }
  const { paymentId } = body || {};
  if (!paymentId || typeof paymentId !== "string" || !paymentId.startsWith(ANNUAL_PAYMENT_ID_PREFIX)) {
    return jsonResponse({ error: "invalid_params" }, 400);
  }

  const result = await activateAnnualPurchase(env, user.uid, paymentId, "portone");
  if (!result.ok) {
    return jsonResponse({ error: result.error, detail: result.detail }, result.status || 500);
  }
  return jsonResponse({ ok: true, paymentId, expiresAt: result.expiresAt || null });
}

// 구독 해지 -- 즉시 끊지 않고, 이미 결제한 기간(next_billing_at)까지는 계속
// 이용할 수 있게 자동 재결제만 끈다(ChatGPT/Claude 등 흔한 LLM 구독 서비스와
// 동일한 방식). 실제 구독 종료 처리는 runScheduledBilling의 만료 처리 패스에서
// 이용 기간이 지난 뒤에 이뤄진다.
export async function handleCancel(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;

  try {
    await firestorePatchDoc(env, `users/${user.uid}`, {
      auto_renew: false,
      cancel_at_period_end: true,
    });
  } catch (e) {
    return jsonResponse({ error: "firestore_update_failed", detail: String(e.message || e) }, 500);
  }
  return jsonResponse({ ok: true });
}

// 해지 예약 취소(구독 유지하기) -- 아직 이용 기간이 남아있는 동안에는 카드를
// 다시 등록할 필요 없이 자동 재결제만 다시 켤 수 있다.
export async function handleResume(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;

  try {
    const userDoc = await firestoreGetDoc(env, `users/${user.uid}`);
    if (!userDoc || userDoc.subscription_status !== "active" || !userDoc.next_billing_at) {
      return jsonResponse({ error: "not_resumable" }, 400);
    }
    await firestorePatchDoc(env, `users/${user.uid}`, {
      auto_renew: true,
      cancel_at_period_end: false,
    });
  } catch (e) {
    return jsonResponse({ error: "firestore_update_failed", detail: String(e.message || e) }, 500);
  }
  return jsonResponse({ ok: true });
}

// 플랜 변경(월간<->연간) -- 이미 구독 중인 사용자가 다른 플랜으로 바꾸고 싶을 때
// 그 자리에서 다시 결제하지 않고, 지금 이용 중인 기간이 끝나는 다음 결제일부터
// 새 플랜으로 전환되도록 예약만 해둔다(pending_plan). 실제 전환/청구는
// runScheduledBilling이 다음 결제일에 처리한다.
export async function handleChangePlan(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "bad_json" }, 400);
  }
  const { plan } = body || {};
  if (!PLANS[plan]) {
    return jsonResponse({ error: "invalid_params" }, 400);
  }
  // 연간은 단건 결제라 "다음 결제일부터 전환" 예약이 성립하지 않는다 -- 연간으로 바꾸려면
  // /api/payments/annual 로 바로 결제해야 한다(남은 월간 기간은 뒤에 이어 붙여준다).
  if (PLANS[plan].oneTime) {
    return jsonResponse({ error: "one_time_plan", detail: "연간 플랜은 예약 전환이 아니라 바로 결제해서 이용해 주세요." }, 400);
  }

  let userDoc;
  try {
    userDoc = await firestoreGetDoc(env, `users/${user.uid}`);
  } catch (e) {
    return jsonResponse({ error: "firestore_lookup_failed", detail: String(e.message || e) }, 500);
  }
  if (!userDoc || userDoc.subscription_status !== "active" || !userDoc.billing_key || !userDoc.next_billing_at) {
    return jsonResponse({ error: "not_active_subscription" }, 400);
  }
  if (userDoc.cancel_at_period_end) {
    return jsonResponse({ error: "cancellation_pending", detail: "해지 예약을 먼저 취소해 주세요." }, 400);
  }

  const pendingPlan = plan === userDoc.subscription_plan ? null : plan;
  try {
    await firestorePatchDoc(env, `users/${user.uid}`, { pending_plan: pendingPlan });
  } catch (e) {
    return jsonResponse({ error: "firestore_update_failed", detail: String(e.message || e) }, 500);
  }
  return jsonResponse({ ok: true, pending_plan: pendingPlan, effective_at: userDoc.next_billing_at });
}

// 카드 변경 -- 이미 구독 중인 사용자가 등록된 카드만 바꾸고 싶을 때. 새로
// 발급받은 빌링키로 교체만 하고 그 자리에서 다시 결제(청구)하지는 않는다.
// 카드 브랜드/마스킹 번호 같은 표시용 정보는 빌링키 발급 응답만으로는 알 수
// 없어서(실 결제 응답에서만 내려옴) 일단 비워두고, 다음 정기결제 때 새로 채워진다.
export async function handleUpdateCard(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "bad_json" }, 400);
  }
  const { billingKey } = body || {};
  if (!billingKey) {
    return jsonResponse({ error: "invalid_params" }, 400);
  }

  let userDoc;
  try {
    userDoc = await firestoreGetDoc(env, `users/${user.uid}`);
  } catch (e) {
    return jsonResponse({ error: "firestore_lookup_failed", detail: String(e.message || e) }, 500);
  }
  if (!userDoc || userDoc.subscription_status !== "active") {
    return jsonResponse({ error: "not_active_subscription" }, 400);
  }

  const oldBillingKey = userDoc.billing_key;
  try {
    await firestorePatchDoc(env, `users/${user.uid}`, {
      billing_key: billingKey,
      card_brand: null,
      card_name: null,
      card_number: null,
      card_issuer: null,
    });
  } catch (e) {
    return jsonResponse({ error: "firestore_update_failed", detail: String(e.message || e) }, 500);
  }

  if (oldBillingKey && oldBillingKey !== billingKey) {
    try {
      await deleteBillingKey(env, oldBillingKey);
    } catch (e) {
      console.error("delete_old_billing_key_failed", user.uid, e);
    }
  }

  return jsonResponse({ ok: true });
}

// 구독 상태 조회(읽기 전용) -- PC 앱 등 클라이언트가 "지금 구독 중인가?"만 가볍게
// 확인할 때 쓰는 엔드포인트. 2026.09 추가: 기존에는 subscribe/cancel/resume/
// change-plan/update-card/webhook 등 상태를 "바꾸는" 라우트만 있고 그냥 "읽는"
// 라우트가 없어서, PC 앱 쪽에 구독 상태를 반영할 방법이 없었다(로컬 앱 <-> 웹서비스
// 사이엔 "구독 중인가?"만 확인하는 가벼운 API 호출 하나만 두는 설계 원칙 참고).
// billing_key처럼 민감한 값은 응답에 포함하지 않는다.
export async function handleStatus(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;

  let userDoc;
  try {
    userDoc = await firestoreGetDoc(env, `users/${user.uid}`);
  } catch (e) {
    return jsonResponse({ error: "firestore_lookup_failed", detail: String(e.message || e) }, 500);
  }

  if (!userDoc) {
    return jsonResponse({ ok: true, subscription_status: "none" });
  }

  return jsonResponse({
    ok: true,
    subscription_status: userDoc.subscription_status || "none",
    subscription_plan: userDoc.subscription_plan || null,
    payment_type: userDoc.payment_type || (userDoc.billing_key ? "billing" : null),
    annual_starts_at: userDoc.annual_starts_at || null,
    pending_plan: userDoc.pending_plan || null,
    auto_renew: userDoc.auto_renew !== false,
    cancel_at_period_end: !!userDoc.cancel_at_period_end,
    next_billing_at: userDoc.next_billing_at || null,
    billing_key_issued_at: userDoc.billing_key_issued_at || null,
    card_brand: userDoc.card_brand || null,
    card_name: userDoc.card_name || null,
    card_number: userDoc.card_number || null,
  });
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

  // 연간 단건 결제 -- 결제는 끝났는데 사용자가 결제창을 닫아서 /annual 확정 호출이
  // 오지 못한 경우를 웹훅이 보정한다(이미 처리됐으면 멱등하게 건너뜀).
  if (paymentId.startsWith(ANNUAL_PAYMENT_ID_PREFIX) && payment.status === "PAID") {
    const payerUid = payment.customer && payment.customer.id;
    if (!payerUid) {
      console.error("annual_webhook_no_payer", paymentId);
      return jsonResponse({ ok: true, ignored: true });
    }
    const activated = await activateAnnualPurchase(env, payerUid, paymentId, "portone-webhook");
    if (!activated.ok && activated.status >= 500) {
      return jsonResponse({ error: "internal_error" }, 500); // 포트원이 웹훅을 재전송하도록
    }
    return jsonResponse({ ok: true });
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
  if (url.pathname === "/api/payments/annual" && request.method === "POST") {
    return handleAnnual(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/cancel" && request.method === "POST") {
    return handleCancel(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/resume" && request.method === "POST") {
    return handleResume(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/change-plan" && request.method === "POST") {
    return handleChangePlan(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/update-card" && request.method === "POST") {
    return handleUpdateCard(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/webhook" && request.method === "POST") {
    return handleWebhook(request, env);
  }
  if (url.pathname === "/api/payments/status" && request.method === "GET") {
    return handleStatus(request, env, verifyFirebaseIdToken);
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
    // 플랜 변경 예약(pending_plan)이 있으면 이번 재결제부터 새 플랜으로 청구한다.
    let plan = userDoc.pending_plan || userDoc.subscription_plan;
    if (PLANS[plan] && PLANS[plan].oneTime) plan = userDoc.subscription_plan; // 예전 "연간 전환 예약" 잔재는 무시
    const billingKey = userDoc.billing_key;
    const planInfo = PLANS[plan];

    // 연간(단건) 플랜은 빌링키로 청구하지 않는다 -- 빌링키가 남아있는 예전 연간 구독자 잔재도 건너뜀.
    if (!planInfo || planInfo.oneTime || !billingKey) {
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
          subscription_plan: plan,
          pending_plan: null,
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

  // 해지 예약(cancel_at_period_end)한 사용자 중 이용 기간이 끝난 사람을 실제로
  // 종료 처리한다. 카드(빌링키)는 더 안 쓸 거라 함께 정리한다(삭제 실패해도
  // 구독 종료 처리 자체는 계속 진행 -- 화면 표시용 부가 정보라 치명적이지 않음).
  let dueCancellations;
  try {
    dueCancellations = await firestoreQueryDueCancellation(env, now);
  } catch (e) {
    console.error("cancellation_query_failed", e);
    dueCancellations = [];
  }

  console.log(`[구독만료] 대상 ${dueCancellations.length}명 확인`);

  for (const userDoc of dueCancellations) {
    const uid = userDoc.id;
    if (userDoc.billing_key) {
      try {
        await deleteBillingKey(env, userDoc.billing_key);
      } catch (e) {
        console.error("delete_billing_key_failed", uid, e);
      }
    }
    try {
      await firestorePatchDoc(env, `users/${uid}`, {
        subscription_status: "canceled",
        cancel_at_period_end: false,
        next_billing_at: null,
        billing_key: null,
        card_brand: null,
        card_name: null,
        card_number: null,
        card_issuer: null,
      });
      console.log("[구독만료] 처리 완료", uid);
    } catch (e) {
      console.error("cancellation_firestore_update_failed", uid, e);
    }
  }
}
