// 구독 결제(포트원 V2 빌링키) 관련 API 라우트 + 정기결제 자동 실행(cron).
// - POST /api/payments/subscribe : 프론트에서 발급받은 빌링키로 첫 결제를 시도하고,
//   성공하면 Firestore에 구독 상태 + 결제내역을 반영한다.
// - POST /api/payments/annual    : 연간 플랜(28,000원) 단건 결제 확정. 이니시스가 연간 주기
//   정기결제를 지원하지 않아서(2026.10) 연간은 빌링키가 아니라 일반(단건) 결제로 받는다 --
//   프론트가 requestPayment로 결제를 끝낸 뒤 paymentId만 보내면, 서버가 포트원에서 결제
//   내역을 다시 조회해 금액·상태를 검증하고 이용 기간(12개월)을 부여한다. 자동 갱신은 없다.
// - POST /api/payments/refund    : 연간 이용권 셀프 취소(환불) -- 사용 개월 수에 따라 부분/전액 환불 + 이용 기간 정리.
// - POST /api/payments/cancel    : 구독 해지(자동결제 중단).
// - POST /api/payments/webhook   : 포트원이 보내는 결제 결과 알림 수신.
// - runScheduledBilling(env)     : Cloudflare Cron Trigger에서 매시간 호출 — 다음 결제일이
//   지난 구독자를 찾아 저장해둔 빌링키로 자동으로 재결제하고, 실패하면 정해진 간격으로 재시도한다(index.js의 scheduled 핸들러 참고).

import { payWithBillingKey, getPayment, getBillingKey, cancelPayment, deleteBillingKey, verifyPortOneWebhook } from "./portone.js";
import {
  firestoreGetDoc,
  firestorePatchDoc,
  firestoreAddDoc,
  firestoreQuery,
  firestoreQueryDueBilling,
  firestoreQueryDueCancellation,
  firestoreDeleteDoc,
} from "./firestore.js";
import { PLAN_MONTHS, addMonths, kstDay, kstDayStart, kstMonthDiff, stackStart, toLedgerEntry, revokePeriod, summarizeLedger } from "./ledger.js";

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

// 포트원 빌링키 조회(getBillingKey) 응답에서 등록된 카드 정보를 뽑아낸다(결제 상세의 extractCardInfo와 같은 필드).
function extractBillingKeyCardInfo(info) {
  try {
    const methods = (info && Array.isArray(info.methods) && info.methods) || [];
    const m = methods.find((x) => x && x.card);
    if (m) {
      const card = m.card;
      return {
        card_brand: card.brand || null,
        card_name: card.name || null,
        card_number: card.number || null,
        card_issuer: card.issuer || null,
      };
    }
  } catch (e) {
    console.error("extract_billing_key_card_info_failed", e);
  }
  return null;
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
  // 이용 기간은 한국시간 날짜 단위: 결제한 날 00:00 ~ N개월 뒤 같은 날 00:00 (다음 정기결제도 그 시각).
  const periodStart = kstDayStart(now);
  const nextBillingAt = addMonths(periodStart, planInfo.periodMonths);

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
      period_start: periodStart,
      period_end: nextBillingAt,
      period_months: planInfo.periodMonths,
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
      billing_retry_count: 0,
      billing_retry_at: null,
      billing_first_failure_at: null,
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
  const { base, wasActive } = stackStart(userDoc, now);
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
      annualStartsAt = base;
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
      annual_cancel_requested_at: null,
      last_one_time_payment_id: paymentId,
      last_one_time_paid_at: now,
      last_one_time_period_start: base,
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
      period_start: base,
      period_end: expiresAt,
      period_months: planInfo.periodMonths,
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

// 연간 이용권 셀프 취소(환불) -- 이용약관 제7조의 환불 규정:
//  1) 이용 시작 전(월간 이용 중 결제해 아직 연간 기간이 시작되지 않은 경우 등): 28,000원 전액 환불.
//  2) 결제 후 7일 이내이고 사용한 이력이 없으면: 전액 환불 + 즉시 종료.
//     "사용" = 결제 이후에 기억숲 PC 앱에 로그인한 기록이 있는 경우(users.app_last_login_at > 결제 시각,
//     PC 앱이 POST /api/payments/app-login 으로 남긴다). 앱 게이팅이 생기면 paid_feature_used_at 으로 더 세분화할 수 있다.
//  3) 그 외(1일이라도 이용한 경우): 사용한 달(경과 개월을 올림, 최소 1개월)은 그대로 이용하게 하고
//     환불액 = 28,000원 - 사용 개월 수 x 3,000원. 취소해도 이용 기간은 "시작일 + 사용 개월 수"까지 유지된다
//     (예: 10/6 시작, 10/20 취소 → 사용 1개월 → 25,000원 환불, 11/6까지 이용). 환불액이 0원이면 환불할 금액이 없다.
//  가장 최근 연간 결제 1건만 대상. 포트원 결제 취소(부분취소 포함)에 성공한 뒤에만 이용 기간을 바꾼다.
// 취소 후 상태:
//  - 1)·2) 중 이용이 이미 시작된 연간: 구독이 바로 종료(canceled).
//  - 1) 중 월간 이용 중에 결제해 아직 시작 전인 연간: 원래 월간 만료일까지만 남는다(월간 자동결제는 연간
//    결제 때 이미 종료됐으므로 되살아나지 않는다).
//  - 1) 중 연간을 미리 연장(2번째 결제)해 아직 시작 전인 분: 이번 결제분 12개월만 줄어든다.
//  - 3): 이용 기간이 "시작일 + 사용 개월 수"로 줄어들고 그날 종료된다(annual_cancel_requested_at 기록).
const MONTHLY_PRICE = PLANS.monthly.amount;
const FULL_REFUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// 시작일부터 now까지 경과한 개월 수(올림). now가 시작일 이전이거나 같으면 0.
function usedMonthsCeil(start, now) {
  if (now.getTime() <= start.getTime()) return 0;
  let m = kstMonthDiff(start, now);
  let anchor = addMonths(start, m);
  if (anchor.getTime() > now.getTime()) {
    m -= 1;
    anchor = addMonths(start, m);
  }
  return anchor.getTime() === now.getTime() ? m : m + 1;
}

// 연간 결제 1건의 환불 계산. periodStart: 그 결제로 늘어난 12개월 기간의 시작 시각.
// ctx.paidAt: 결제 시각, ctx.featureUsed: 유료 기능 사용 이력 여부.
// mode: "before_start"(전액·시작 전) | "within_7days"(전액·즉시 종료) | "prorated"(사용 개월 차감, 사용한 달까지 이용 유지)
export function computeAnnualRefund(periodStart, now, ctx = {}) {
  const price = PLANS.annual.amount;
  if (now.getTime() <= periodStart.getTime()) {
    return { mode: "before_start", started: false, usedMonths: 0, amount: price, endsAt: null };
  }
  if (ctx.paidAt && now.getTime() - ctx.paidAt.getTime() <= FULL_REFUND_WINDOW_MS && !ctx.featureUsed) {
    return { mode: "within_7days", started: true, usedMonths: 0, amount: price, endsAt: null };
  }
  const used = Math.max(1, usedMonthsCeil(periodStart, now));
  return {
    mode: "prorated",
    started: true,
    usedMonths: used,
    amount: Math.max(0, price - used * MONTHLY_PRICE),
    endsAt: addMonths(periodStart, used),
  };
}

// 환불 계산에 쓰는 "이번 연간 결제 기간의 시작 시각". 결제 시 저장한 값을 우선 쓰고,
// 없는 예전 데이터는 월간 만료일 기준 시작일 → 결제 시각 순으로 추정한다.
function annualPeriodStart(userDoc) {
  if (userDoc.last_one_time_period_start && userDoc.last_one_time_period_start.getTime) return userDoc.last_one_time_period_start;
  if (userDoc.annual_starts_at && userDoc.annual_starts_at.getTime) return userDoc.annual_starts_at;
  if (userDoc.last_one_time_paid_at && userDoc.last_one_time_paid_at.getTime) return userDoc.last_one_time_paid_at;
  return null;
}

export async function handleRefund(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;
  const uid = user.uid;

  let body = {};
  try {
    body = (await request.json()) || {};
  } catch (e) {
    // 본문이 없어도 된다(expectedAmount는 선택)
  }

  let userDoc;
  try {
    userDoc = await firestoreGetDoc(env, `users/${uid}`);
  } catch (e) {
    return jsonResponse({ error: "firestore_lookup_failed", detail: String(e.message || e) }, 500);
  }
  const paymentId = userDoc && userDoc.last_one_time_payment_id;
  if (!userDoc || userDoc.payment_type !== "one_time" || !paymentId) {
    return jsonResponse({ error: "no_refundable_payment" }, 400);
  }
  if (userDoc.last_refunded_payment_id === paymentId) {
    return jsonResponse({ error: "already_refunded" }, 409);
  }
  // 환불 기준 기간 시작일: 결제 기록에 저장된 구독기간 시작일을 우선 쓰고, 없는 예전 건은 사용자 문서 값으로 추정한다.
  let paymentRows = [];
  try {
    paymentRows = await firestoreQuery(env, "payments", "payment_id", "EQUAL", paymentId);
  } catch (e) {
    console.error("refund_payment_row_lookup_failed", uid, paymentId, e);
  }
  const paymentRow = paymentRows[0] || null;
  const periodStart = (paymentRow && paymentRow.period_start && paymentRow.period_start.getTime && paymentRow.period_start) || annualPeriodStart(userDoc);
  if (!periodStart) return jsonResponse({ error: "period_start_unknown" }, 409);

  let payment;
  try {
    payment = await getPayment(env, paymentId);
  } catch (e) {
    return jsonResponse({ error: "portone_get_payment_failed", detail: String(e.message || e) }, 502);
  }
  if (payment.status !== "PAID") {
    return jsonResponse({ error: "payment_not_paid", detail: payment.status }, 409);
  }
  const payerId = payment.customer && payment.customer.id;
  if (payerId && payerId !== uid) {
    console.error("refund_payer_mismatch", uid, paymentId, payerId);
    return jsonResponse({ error: "payer_mismatch" }, 403);
  }

  const now = new Date();
  const paidAtDate = userDoc.last_one_time_paid_at && userDoc.last_one_time_paid_at.getTime ? userDoc.last_one_time_paid_at : null;
  // "사용" 판단: 결제 이후에 기억숲 PC 앱에 로그인한 기록(app_last_login_at)이 있으면 사용한 것으로 본다.
  const lastLogin = userDoc.app_last_login_at && userDoc.app_last_login_at.getTime ? userDoc.app_last_login_at : null;
  const usedAfterPayment = !!(lastLogin && paidAtDate && lastLogin.getTime() > paidAtDate.getTime());
  const calc = computeAnnualRefund(periodStart, now, { paidAt: paidAtDate, featureUsed: usedAfterPayment || !!userDoc.paid_feature_used_at });
  if (calc.amount <= 0) {
    return jsonResponse({ error: "no_refund_amount", usedMonths: calc.usedMonths }, 409);
  }
  // 화면에서 보여준 환불액과 서버 계산이 다르면(시간이 흘러 사용 개월 수가 바뀐 경우 등) 다시 확인받도록 돌려보낸다.
  if (body.expectedAmount !== undefined && Number(body.expectedAmount) !== calc.amount) {
    return jsonResponse({ error: "refund_amount_changed", refundAmount: calc.amount, usedMonths: calc.usedMonths }, 409);
  }

  const total = (payment.amount && payment.amount.total) || PLANS.annual.amount;
  const alreadyCancelled = (payment.amount && payment.amount.cancelled) || 0;
  const cancel = await cancelPayment(env, paymentId, `고객 요청 취소(환불) - 사용 ${calc.usedMonths}개월`, {
    amount: calc.amount,
    currentCancellableAmount: total - alreadyCancelled,
  });
  if (!cancel.ok) {
    console.error("refund_cancel_failed", uid, paymentId, cancel.status, JSON.stringify(cancel.data));
    return jsonResponse({ error: "portone_cancel_failed", detail: cancel.data && (cancel.data.message || cancel.data.type) }, 502);
  }

  // 이용 기간 정리. 환불은 이미 성공했으므로 여기서 실패해도 사용자에겐 환불 성공으로 알리고 로그만 남긴다.
  // 결제 기록 상태를 먼저 바꾸고, 이용 기간은 장부 규칙(revokeUserPeriod)으로 줄이거나 회수한다:
  //  - 사용 개월 수 차감 환불(prorated): 그 결제의 기간을 "시작일 + 사용 개월 수"로 줄인다(사용한 달까지 이용).
  //  - 전액 환불: 그 결제의 기간을 전부 회수한다. 뒤에 이어 붙은 결제가 있으면 앞으로 당겨지고, 남는 기간이 없으면 구독 종료.
  let targetRow = paymentRow;
  if (!targetRow) {
    targetRow = { id: "__virtual", plan: "annual", paid_at: paidAtDate, payment_id: paymentId, status: "paid" };
  }
  if (!targetRow.period_start || !targetRow.period_start.getTime) {
    targetRow = { ...targetRow, period_start: periodStart, period_end: addMonths(periodStart, PLANS.annual.periodMonths) };
  }
  if (paymentRow) {
    try {
      await firestorePatchDoc(env, `payments/${paymentRow.id}`, {
        status: calc.amount >= PLANS.annual.amount ? "refunded" : "partial_refunded",
        refunded_amount: calc.amount,
        used_months: calc.usedMonths,
      });
    } catch (e) {
      console.error("refund_payment_record_failed", uid, paymentId, e);
    }
  }
  const prorated = calc.mode === "prorated";
  let revoked = { ok: false };
  try {
    revoked = await revokeUserPeriod(
      env, uid, userDoc, targetRow, prorated ? calc.usedMonths : 0, now,
      prorated ? { annual_cancel_requested_at: now, cancel_at_period_end: true, auto_renew: false } : {}
    );
  } catch (e) {
    console.error("refund_user_update_failed", uid, paymentId, e);
  }
  const outcome = !revoked.ok
    ? "update_failed"
    : revoked.ended
      ? "ended"
      : prorated
        ? "ends_at_used_month_end"
        : (revoked.summary.plan || "monthly") === "monthly"
          ? "reverted_to_monthly_period"
          : "shortened";
  const patch = revoked.patch || {};

  return jsonResponse({
    ok: true,
    outcome,
    refundedAmount: calc.amount,
    usedMonths: calc.usedMonths,
    mode: calc.mode,
    validUntil: patch.next_billing_at || null,
  });
}

// ---- 이용 기간 회수/단축 (환불·삭제 공통) ----
// 결제 한 건(targetRow)의 이용 기간을 keepMonths 개월만 남기고(0이면 전부) 줄인다. 결제 기록에는 줄어든 기간을 저장하고,
// 뒤에 이어 붙은 결제의 기간은 앞으로 당기며, 사용자 문서의 만료일/플랜/연간 시작 예정일/환불 기준 필드를 다시 맞춘다.
// 남는 이용 기간이 없으면 구독을 종료(canceled)하고 빌링키·카드 정보를 정리한다.
const ENDED_USER_PATCH = {
  subscription_status: "canceled",
  cancel_at_period_end: false,
  auto_renew: false,
  next_billing_at: null,
  annual_starts_at: null,
  billing_key: null,
  card_brand: null,
  card_name: null,
  card_number: null,
  card_issuer: null,
  pending_plan: null,
  annual_cancel_requested_at: null,
};

async function revokeUserPeriod(env, uid, userDoc, targetRow, keepMonths, now, extra = {}) {
  const rows = await firestoreQuery(env, "payments", "uid", "EQUAL", uid);
  const all = rows.filter((r) => r.id !== targetRow.id);
  all.push(targetRow);
  // 대상 결제는 이미 환불 상태로 바뀌었어도 "회수 전 기간"으로 계산해야 하므로 항상 포함시킨다.
  const entries = all.map((r) => toLedgerEntry(r.id === targetRow.id ? { ...r, status: "paid" } : r)).filter(Boolean);
  const userExpiry = userDoc.next_billing_at && userDoc.next_billing_at.getTime ? userDoc.next_billing_at : null;
  const res = revokePeriod(entries, targetRow.id, keepMonths, now, userExpiry);
  if (!res) return { ok: false, error: "ledger_target_missing" };

  for (const e of res.entries) {
    if (e.id === "__virtual") continue;
    if (e.id !== targetRow.id && !res.changed.includes(e.id)) continue;
    const patch = { period_start: e.start, period_end: e.end };
    if (e.id === targetRow.id) patch.period_months = keepMonths;
    try {
      await firestorePatchDoc(env, `payments/${e.id}`, patch);
    } catch (err) {
      console.error("revoke_payment_period_failed", uid, e.id, err);
    }
  }

  const ended = !res.expiresAt || res.expiresAt.getTime() <= now.getTime();
  const la = ended ? null : res.lastAnnual;
  const common = {
    last_refunded_payment_id: targetRow.payment_id || userDoc.last_refunded_payment_id || null,
    last_one_time_payment_id: la ? la.paymentId : null,
    last_one_time_paid_at: la ? la.paidAt : null,
    last_one_time_period_start: la ? la.start : null,
  };
  let patch;
  if (ended) {
    patch = { ...ENDED_USER_PATCH, ...common };
    if (userDoc.billing_key) {
      try {
        await deleteBillingKey(env, userDoc.billing_key);
      } catch (err) {
        console.error("revoke_delete_billing_key_failed", uid, err);
      }
    }
  } else {
    patch = {
      subscription_status: "active",
      subscription_plan: res.summary.plan || "monthly",
      next_billing_at: res.expiresAt,
      annual_starts_at: res.summary.annualStartsAt,
      ...(userDoc.payment_type === "one_time" ? { auto_renew: false, cancel_at_period_end: true } : {}),
      ...common,
      ...extra,
    };
  }
  try {
    await firestorePatchDoc(env, `users/${uid}`, patch);
  } catch (err) {
    console.error("revoke_user_update_failed", uid, err);
    return { ok: true, ended, patch, summary: res.summary, userUpdateFailed: true };
  }
  return { ok: true, ended, patch, summary: res.summary };
}

// ---- 관리자 전용 API 공통 ----
// 관리자 사이트(admin.gieoksoop.com)에서 호출한다. 호출자가 Firebase 로그인 + admins/{uid} 문서가 있는
// 관리자인지 서버에서 직접 확인한다(화면의 관리자 체크는 UI용일 뿐).
const ADMIN_ORIGINS = ["https://admin.gieoksoop.com"];

function adminCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = { Vary: "Origin" };
  if (ADMIN_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Max-Age"] = "600";
  }
  return headers;
}

function withHeaders(res, extra) {
  const headers = new Headers(res.headers);
  Object.entries(extra).forEach(([k, v]) => headers.set(k, v));
  return new Response(res.body, { status: res.status, headers });
}

async function withAdminCors(request, handler) {
  const cors = adminCorsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  return withHeaders(await handler(), cors);
}

async function requireAdmin(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return { error };
  let adminDoc = null;
  try {
    adminDoc = await firestoreGetDoc(env, `admins/${user.uid}`);
  } catch (e) {
    return { error: jsonResponse({ error: "firestore_lookup_failed", detail: String(e.message || e) }, 500) };
  }
  if (!adminDoc) {
    console.error("admin_forbidden", user.uid);
    return { error: jsonResponse({ error: "not_admin" }, 403) };
  }
  return { user, adminLabel: user.email || user.uid };
}

// ---- 관리자 결제취소(환불) ----
// 포트원에 실제 결제 취소(전액/부분)를 요청하고, 결제 기록을 정리하며, 선택하면 그 결제가 준 이용 기간도 회수한다.
export async function handleAdminRefund(request, env, verifyFirebaseIdToken) {
  return withAdminCors(request, () => adminRefundInner(request, env, verifyFirebaseIdToken));
}

async function adminRefundInner(request, env, verifyFirebaseIdToken) {
  const { error, adminLabel } = await requireAdmin(request, env, verifyFirebaseIdToken);
  if (error) return error;

  let body = {};
  try {
    body = (await request.json()) || {};
  } catch (e) {
    return jsonResponse({ error: "bad_request" }, 400);
  }
  const paymentId = typeof body.paymentId === "string" ? body.paymentId : "";
  const reason = (typeof body.reason === "string" ? body.reason.trim() : "").slice(0, 200) || "관리자 취소";
  // 이용 기간도 함께 회수할지(기본: 회수 안 함). 예전 클라이언트의 endAccess 이름도 받아준다.
  const revoke = body.revokePeriod === true || body.endAccess === true;
  if (!paymentId) return jsonResponse({ error: "payment_id_required" }, 400);

  let rows;
  try {
    rows = await firestoreQuery(env, "payments", "payment_id", "EQUAL", paymentId);
  } catch (e) {
    return jsonResponse({ error: "firestore_lookup_failed", detail: String(e.message || e) }, 500);
  }
  const record = rows[0];
  if (!record) return jsonResponse({ error: "payment_record_not_found" }, 404);

  let payment;
  try {
    payment = await getPayment(env, paymentId);
  } catch (e) {
    return jsonResponse({ error: "portone_get_payment_failed", detail: String(e.message || e) }, 502);
  }
  if (payment.status !== "PAID" && payment.status !== "PARTIAL_CANCELLED") {
    return jsonResponse({ error: "payment_not_cancellable", detail: payment.status }, 409);
  }
  const total = (payment.amount && payment.amount.total) || 0;
  const alreadyCancelled = (payment.amount && payment.amount.cancelled) || 0;
  const cancellable = total - alreadyCancelled;
  if (cancellable <= 0) return jsonResponse({ error: "nothing_to_cancel" }, 409);

  const amount = body.amount === undefined || body.amount === null ? cancellable : Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > cancellable) {
    return jsonResponse({ error: "invalid_amount", cancellable }, 400);
  }

  const cancel = await cancelPayment(env, paymentId, `관리자 취소: ${reason}`, {
    amount,
    currentCancellableAmount: cancellable,
    requester: "ADMIN",
  });
  if (!cancel.ok) {
    console.error("admin_refund_cancel_failed", adminLabel, paymentId, cancel.status, JSON.stringify(cancel.data));
    return jsonResponse({ error: "portone_cancel_failed", detail: cancel.data && (cancel.data.message || cancel.data.type) }, 502);
  }

  const now = new Date();
  const refundedTotal = alreadyCancelled + amount;
  const fullRefund = refundedTotal >= total;
  try {
    await firestorePatchDoc(env, `payments/${record.id}`, {
      status: fullRefund ? "refunded" : "partial_refunded",
      refunded_amount: refundedTotal,
      refund_reason: reason,
      refunded_by: adminLabel,
      refunded_at: now,
      // 전액 환불인데 이용 기간은 유지하는 경우: 장부가 이 결제의 기간을 계속 인정하도록 표시한다.
      ...(fullRefund && !revoke ? { period_kept: true } : {}),
    });
  } catch (e) {
    console.error("admin_refund_record_failed", paymentId, e);
  }

  let periodRevoked = false;
  let accessEnded = false;
  if (revoke && record.uid && PLAN_MONTHS[record.plan]) {
    try {
      const userDoc = await firestoreGetDoc(env, `users/${record.uid}`);
      if (userDoc) {
        const r = await revokeUserPeriod(env, record.uid, userDoc, record, 0, now);
        periodRevoked = !!r.ok;
        accessEnded = !!(r.ok && r.ended);
      }
    } catch (e) {
      console.error("admin_refund_user_update_failed", record.uid, paymentId, e);
    }
  }

  console.log("admin_refund_done", adminLabel, paymentId, amount, revoke);
  return jsonResponse({ ok: true, refundedAmount: amount, refundedTotal, fullyRefunded: fullRefund, periodRevoked, accessEnded });
}

// ---- 관리자 수동 결제 등록/삭제 ----
// 계좌이체 등 카드 외 결제를 기록하고 이용 기간을 부여한다(등록). 새 기간은 기존 만료일 뒤에 이어 붙고(시작일을
// 직접 지정하면 그 날짜), 삭제하면 그 결제가 준 기간을 회수한다. 카드(포트원) 결제 기록은 여기서 지우지 못한다 --
// 카드 결제는 결제취소로만 정리한다. 날짜는 한국 시간(KST) 기준.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MANUAL_METHODS = ["계좌이체", "카드", "기타"];

function parseKstDate(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T00:00:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function kstDateString(d) {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export async function handleAdminManual(request, env, verifyFirebaseIdToken) {
  return withAdminCors(request, () => adminManualInner(request, env, verifyFirebaseIdToken));
}

async function adminManualInner(request, env, verifyFirebaseIdToken) {
  const { error, adminLabel } = await requireAdmin(request, env, verifyFirebaseIdToken);
  if (error) return error;

  let body = {};
  try {
    body = (await request.json()) || {};
  } catch (e) {
    return jsonResponse({ error: "bad_request" }, 400);
  }
  if (body.action === "create") return adminManualCreate(env, body, adminLabel);
  if (body.action === "delete") return adminManualDelete(env, body, adminLabel);
  return jsonResponse({ error: "invalid_action" }, 400);
}

async function adminManualCreate(env, body, adminLabel) {
  const uid = typeof body.uid === "string" ? body.uid : "";
  const plan = body.plan;
  const amount = Number(body.amount);
  const method = body.method;
  const memo = typeof body.memo === "string" ? body.memo.trim().slice(0, 200) : "";
  const paidAt = parseKstDate(body.paidAt);
  if (!uid || !PLAN_MONTHS[plan] || !Number.isInteger(amount) || amount <= 0 || amount > 10000000 || !MANUAL_METHODS.includes(method) || !paidAt) {
    return jsonResponse({ error: "invalid_params" }, 400);
  }
  const startInput = body.startDate ? parseKstDate(body.startDate) : null;
  if (body.startDate && !startInput) return jsonResponse({ error: "invalid_params" }, 400);

  let userDoc;
  try {
    userDoc = await firestoreGetDoc(env, `users/${uid}`);
  } catch (e) {
    return jsonResponse({ error: "firestore_lookup_failed", detail: String(e.message || e) }, 500);
  }
  if (!userDoc) return jsonResponse({ error: "user_not_found" }, 404);

  const now = new Date();
  const { base } = stackStart(userDoc, now);
  // 시작일을 기본(이어 붙이기) 날짜 그대로 보냈으면 정확한 시각(base)을 쓰고, 다른 날짜면 그 날짜로 고정한다.
  const pinned = !!(startInput && kstDateString(startInput) !== kstDateString(base));
  const start = pinned ? startInput : base;
  const months = PLAN_MONTHS[plan];
  const end = addMonths(start, months);

  let created;
  try {
    created = await firestoreAddDoc(env, "payments", {
      uid,
      amount,
      plan,
      method,
      memo: memo || null,
      status: "paid",
      paid_at: paidAt,
      created_at: now,
      created_by: adminLabel,
      manual: true,
      period_start: start,
      period_end: end,
      period_months: months,
      ...(pinned ? { period_start_pinned: true } : {}),
    });
  } catch (e) {
    return jsonResponse({ error: "firestore_update_failed", detail: String(e.message || e) }, 500);
  }

  // 이용 권한 반영: 이어 붙인 결과(장부 요약)와 기존 만료일 중 늦은 쪽까지 이용. 자동 갱신 없이 만료일에 끝나도록 저장한다.
  let rows = [];
  try {
    rows = await firestoreQuery(env, "payments", "uid", "EQUAL", uid);
  } catch (e) {
    console.error("manual_ledger_lookup_failed", uid, e);
  }
  const entries = rows.map((r) => toLedgerEntry(r)).filter(Boolean);
  const summary = summarizeLedger(entries, now);
  const oldExpiry = userDoc.subscription_status === "active" && userDoc.next_billing_at && userDoc.next_billing_at.getTime && userDoc.next_billing_at.getTime() > now.getTime() ? userDoc.next_billing_at : null;
  const expiresAt = oldExpiry && oldExpiry.getTime() > end.getTime() ? oldExpiry : end;
  try {
    await firestorePatchDoc(env, `users/${uid}`, {
      subscription_status: "active",
      subscription_plan: summary.empty ? plan : summary.plan,
      payment_type: "one_time",
      billing_key: null,
      auto_renew: false,
      cancel_at_period_end: true,
      pending_plan: null,
      next_billing_at: expiresAt,
      annual_starts_at: summary.empty ? null : summary.annualStartsAt,
    });
  } catch (e) {
    console.error("manual_user_update_failed", uid, e);
    return jsonResponse({ error: "firestore_update_failed", detail: String(e.message || e) }, 500);
  }
  if (userDoc.billing_key) {
    try {
      await deleteBillingKey(env, userDoc.billing_key);
    } catch (e) {
      console.error("manual_delete_billing_key_failed", uid, e);
    }
  }
  console.log("admin_manual_create", adminLabel, uid, plan, amount);
  return jsonResponse({ ok: true, paymentDocId: created.id, periodStart: start, periodEnd: end, expiresAt });
}

async function adminManualDelete(env, body, adminLabel) {
  const docId = typeof body.paymentDocId === "string" ? body.paymentDocId : "";
  if (!docId) return jsonResponse({ error: "invalid_params" }, 400);
  let row;
  try {
    row = await firestoreGetDoc(env, `payments/${docId}`);
  } catch (e) {
    return jsonResponse({ error: "firestore_lookup_failed", detail: String(e.message || e) }, 500);
  }
  if (!row) return jsonResponse({ error: "payment_record_not_found" }, 404);
  if (row.payment_id) return jsonResponse({ error: "card_payment_not_deletable" }, 400);

  let periodAdjusted = false;
  if (row.uid && toLedgerEntry(row)) {
    try {
      const userDoc = await firestoreGetDoc(env, `users/${row.uid}`);
      if (userDoc) {
        const r = await revokeUserPeriod(env, row.uid, userDoc, row, 0, new Date());
        periodAdjusted = !!r.ok;
      }
    } catch (e) {
      console.error("manual_delete_revoke_failed", row.uid, docId, e);
      return jsonResponse({ error: "period_update_failed", detail: String(e.message || e) }, 500);
    }
  }
  try {
    await firestoreDeleteDoc(env, `payments/${docId}`);
  } catch (e) {
    return jsonResponse({ error: "firestore_delete_failed", detail: String(e.message || e) }, 500);
  }
  console.log("admin_manual_delete", adminLabel, docId, periodAdjusted);
  return jsonResponse({ ok: true, periodAdjusted });
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

  // 새 빌링키 확인: 정상 발급 상태인지, 이 사용자 이름으로 발급된 키인지 확인하고 카드 정보(마스킹)를 읽어 저장한다.
  // (카드 변경에는 결제가 없어서 결제 상세에서 카드 정보를 얻을 수 없다.)
  let keyInfo;
  try {
    const lookup = await getBillingKey(env, billingKey);
    if (!lookup.ok) {
      console.error("update_card_billing_key_lookup_failed", user.uid, lookup.status, JSON.stringify(lookup.data));
      return jsonResponse({ error: "billing_key_lookup_failed", detail: lookup.data && (lookup.data.message || lookup.data.type) }, lookup.status === 404 ? 400 : 502);
    }
    keyInfo = lookup.data || {};
  } catch (e) {
    console.error("update_card_billing_key_lookup_error", user.uid, e);
    return jsonResponse({ error: "billing_key_lookup_failed", detail: String(e.message || e) }, 502);
  }
  if (keyInfo.status && keyInfo.status !== "ISSUED") {
    return jsonResponse({ error: "billing_key_not_issued", detail: keyInfo.status }, 400);
  }
  const ownerId = keyInfo.customer && keyInfo.customer.id;
  if (ownerId && ownerId !== user.uid) {
    console.error("update_card_owner_mismatch", user.uid, ownerId);
    return jsonResponse({ error: "billing_key_owner_mismatch" }, 403);
  }
  const newCardInfo = extractBillingKeyCardInfo(keyInfo);

  const oldBillingKey = userDoc.billing_key;
  try {
    await firestorePatchDoc(env, `users/${user.uid}`, {
      billing_key: billingKey,
      // 자동결제 실패로 재시도 대기 중이었다면, 새 카드로 곧바로(다음 정시 cron에) 다시 시도하도록 대기 시각을 비운다.
      ...(Number(userDoc.billing_retry_count) > 0 ? { billing_retry_at: null } : {}),
      card_brand: null,
      card_name: null,
      card_number: null,
      card_issuer: null,
      ...(newCardInfo || {}),
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

  return jsonResponse({ ok: true, card_number: (newCardInfo && newCardInfo.card_number) || null });
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
    billing_retry_count: Number(userDoc.billing_retry_count) || 0,
    billing_retry_at: userDoc.billing_retry_at || null,
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
        status:
          payment.status === "PAID"
            ? "paid"
            : payment.status === "CANCELLED"
              ? "refunded"
              : payment.status === "PARTIAL_CANCELLED"
                ? "partial_refunded"
                : "failed",
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

// PC 앱이 로그인에 성공했을 때(또는 로그인된 채 앱을 켰을 때) 호출 -- 마지막 로그인 시각만 기록한다.
// 연간 이용권 환불 시 "사용 여부" 판단(결제 이후 PC 앱 로그인 기록)에 쓰인다.
export async function handleAppLogin(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;
  try {
    await firestorePatchDoc(env, `users/${user.uid}`, { app_last_login_at: new Date() });
  } catch (e) {
    return jsonResponse({ error: "firestore_update_failed", detail: String(e.message || e) }, 500);
  }
  return jsonResponse({ ok: true });
}

export async function handlePaymentsRoute(request, env, url, verifyFirebaseIdToken) {
  if (url.pathname === "/api/payments/admin-refund" && (request.method === "POST" || request.method === "OPTIONS")) {
    return handleAdminRefund(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/admin-manual" && (request.method === "POST" || request.method === "OPTIONS")) {
    return handleAdminManual(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/subscribe" && request.method === "POST") {
    return handleSubscribe(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/annual" && request.method === "POST") {
    return handleAnnual(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/app-login" && request.method === "POST") {
    return handleAppLogin(request, env, verifyFirebaseIdToken);
  }
  if (url.pathname === "/api/payments/refund" && request.method === "POST") {
    return handleRefund(request, env, verifyFirebaseIdToken);
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

// 자동결제 실패 시 재시도 일정. "최초 실패 시각"으로부터 아래 시간(시간) 뒤에 각각 다시 시도하고, 모두 실패하면 구독을 종료한다.
// 예) 00:00 결제 실패 → 03:00 재시도(카드사 점검 시간 대비) → 06:00 → 다음 날 00:00 → 모두 실패하면 종료.
// 재시도하는 동안(최대 1일) 구독 상태는 active로 유지한다(이용 유예). cron이 매시간 돌기 때문에 시도 시각은 정시 단위로 맞춰진다.
export const BILLING_RETRY_DELAYS_HOURS = [3, 6, 24];
const RETRY_TOLERANCE_MS = 5 * 60 * 1000; // cron이 예정 시각보다 몇 초 먼저 돌아도 놓치지 않게 하는 여유

// 정기결제 자동 실행 -- Cloudflare Cron Trigger가 매시간 호출한다(index.js의
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
    // 이전 시도가 실패해 재시도 대기 중이면 예약된 시각이 올 때까지 건너뛴다.
    const retryAt = userDoc.billing_retry_at && userDoc.billing_retry_at.getTime ? userDoc.billing_retry_at : null;
    if (retryAt && retryAt.getTime() - now.getTime() > RETRY_TOLERANCE_MS) continue;
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
    // 이번이 몇 번째 시도인지(첫 시도 = 1). 직전까지 연속 실패한 횟수 + 1.
    const attemptNo = (Number(userDoc.billing_retry_count) || 0) + 1;
    // 재시도 일정의 기준이 되는 최초 실패 시각(첫 실패면 지금).
    const firstFailureAt = attemptNo > 1 && userDoc.billing_first_failure_at && userDoc.billing_first_failure_at.getTime ? userDoc.billing_first_failure_at : chargedAt;

    if (result.ok) {
      // 새 이용 기간은 "이전 기간의 종료 시각(= 예정된 결제일 00:00)"에서 이어 붙인다(배치가 늦게 돌아도 결제일이 밀리지 않게).
      // 월말 결제일(31일 등)은 최초 결제일의 "일"을 기준으로 계산해 말일 때문에 앞당겨지지 않게 한다.
      const anchorDay = userDoc.billing_key_issued_at && userDoc.billing_key_issued_at.getTime ? kstDay(userDoc.billing_key_issued_at) : undefined;
      const scheduled = userDoc.next_billing_at && userDoc.next_billing_at.getTime ? kstDayStart(userDoc.next_billing_at) : null;
      let periodStart = scheduled && scheduled.getTime() <= chargedAt.getTime() ? scheduled : kstDayStart(chargedAt);
      let nextBillingAt = addMonths(periodStart, planInfo.periodMonths, anchorDay);
      if (nextBillingAt.getTime() <= chargedAt.getTime()) {
        // 배치가 오래 멈췄다가 돌아온 경우: 밀린 기간을 한꺼번에 재청구하지 않도록 오늘부터 새로 시작한다.
        periodStart = kstDayStart(chargedAt);
        nextBillingAt = addMonths(periodStart, planInfo.periodMonths, anchorDay);
      }
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
          period_start: periodStart,
          period_end: nextBillingAt,
          period_months: planInfo.periodMonths,
          created_by: "portone-cron",
          payment_id: paymentId,
          ...(cardInfo || {}),
        });
        await firestorePatchDoc(env, `users/${uid}`, {
          subscription_plan: plan,
          pending_plan: null,
          next_billing_at: nextBillingAt,
          last_billing_at: chargedAt,
          billing_retry_count: 0,
          billing_retry_at: null,
          billing_first_failure_at: null,
          billing_last_failure_at: null,
          billing_last_failure_reason: null,
          ...(cardInfo || {}),
        });
        console.log("[정기결제] 성공", uid, plan, attemptNo > 1 ? `(재시도 ${attemptNo - 1}회 후)` : "");
      } catch (e) {
        console.error("billing_firestore_update_failed", uid, e);
      }
    } else {
      const message = (result.data && (result.data.message || result.data.pgMessage)) || null;
      console.error("billing_failed", uid, `attempt=${attemptNo}`, message);
      const delayHours = BILLING_RETRY_DELAYS_HOURS[attemptNo - 1];
      const willRetry = delayHours !== undefined;
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
          attempt: attemptNo,
          failure_reason: message,
          will_retry: willRetry,
        });
        if (willRetry) {
          // 재시도 예약 -- 구독은 active로 유지하고(이용 유예), 정해진 시간 뒤에 다시 시도한다.
          await firestorePatchDoc(env, `users/${uid}`, {
            billing_retry_count: attemptNo,
            billing_retry_at: new Date(firstFailureAt.getTime() + delayHours * 3600 * 1000),
            billing_first_failure_at: firstFailureAt,
            billing_last_failure_at: chargedAt,
            billing_last_failure_reason: message,
          });
          console.log("[정기결제] 실패 → 재시도 예약", uid, `${attemptNo}/${BILLING_RETRY_DELAYS_HOURS.length}`, `최초 실패 ${delayHours}시간 후`);
        } else {
          // 재시도까지 모두 실패 -- 구독을 종료한다(카드 재등록은 사용자가 다시 구독하기를 눌러야 한다).
          await firestorePatchDoc(env, `users/${uid}`, {
            subscription_status: "none",
            auto_renew: false,
            next_billing_at: null,
            billing_retry_count: 0,
            billing_retry_at: null,
            billing_first_failure_at: null,
            billing_last_failure_at: chargedAt,
            billing_last_failure_reason: message,
          });
          console.log("[정기결제] 재시도 모두 실패 → 구독 종료", uid);
        }
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
        billing_retry_count: 0,
        billing_retry_at: null,
        billing_first_failure_at: null,
      });
      console.log("[구독만료] 처리 완료", uid);
    } catch (e) {
      console.error("cancellation_firestore_update_failed", uid, e);
    }
  }
}
