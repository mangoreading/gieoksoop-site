// 결제 기록(payments) 기반 이용 기간 계산 -- 순수 함수 모음(I/O 없음).
//
// 이용 기간의 단일 원칙: 회원의 이용 기간은 "결제 한 건 = 기간 한 구간(period_start ~ period_end)"을
// 결제 순서대로 이어 붙인 것이다. 새 결제는 기존 만료일 뒤에 이어 붙고(stackStart), 결제를 취소·삭제하면
// 그 구간을 줄이거나 없애고 뒤에 이어 붙은 구간을 앞으로 당긴다(revokePeriod). 어떤 경로(카드 결제,
// 월간 자동결제, 수동 등록, 사용자 환불, 관리자 결제취소, 수동 기록 삭제)든 이 규칙을 같이 쓴다.

export const PLAN_MONTHS = { monthly: 1, annual: 12 };

// ---- 한국시간(KST) 기준 날짜 계산 ----
// 이용 기간은 "한국시간 날짜 단위"로 다룬다: 시작 = 결제한 날 00:00, 종료 = 그 N개월 뒤 같은 날 00:00(그 시각은 포함하지 않음).
// 예) 10/7 15:00 월간 결제 -> 10/7 00:00 ~ 11/7 00:00 (화면에는 "10/7 ~ 11/6"), 다음 정기결제는 11/7 00:00.
// Worker는 UTC로 돌아가므로 월/일 계산은 모두 +9시간으로 옮겨서 UTC getter로 한다.
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// 해당 시각이 속한 한국시간 날짜의 00:00
export function kstDayStart(date) {
  return new Date(Math.floor((date.getTime() + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS);
}

// 한국시간 00:00이면 그대로, 아니면 다음 날 00:00
export function kstDayCeil(date) {
  const s = kstDayStart(date);
  return s.getTime() === date.getTime() ? date : new Date(s.getTime() + DAY_MS);
}

// 한국시간 기준 "일"(1~31)
export function kstDay(date) {
  return new Date(date.getTime() + KST_OFFSET_MS).getUTCDate();
}

// 한국시간 기준 달력 개월 차이(b - a)
export function kstMonthDiff(a, b) {
  const x = new Date(a.getTime() + KST_OFFSET_MS);
  const y = new Date(b.getTime() + KST_OFFSET_MS);
  return (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + (y.getUTCMonth() - x.getUTCMonth());
}

// 한국시간 기준으로 N개월 뒤(시각은 유지). 대상 달에 그 날짜가 없으면 말일로 맞춘다(1/31 + 1개월 = 2/28).
// anchorDay를 주면 그 "일"을 기준으로 계산해 말일 때문에 결제일이 앞으로 밀리지 않는다(1/31 -> 2/28 -> 3/31).
export function addMonths(date, months, anchorDay) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  const total = k.getUTCFullYear() * 12 + k.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay || k.getUTCDate(), dim);
  const t = Date.UTC(y, m, day, k.getUTCHours(), k.getUTCMinutes(), k.getUTCSeconds(), k.getUTCMilliseconds());
  return new Date(t - KST_OFFSET_MS);
}

const asDate = (v) => (v && typeof v.getTime === "function" ? v : null);

// 새 결제가 시작되는 시각(한국시간 날짜 00:00). 이미 이용 중이면 현재 만료일 뒤(예전 기록처럼 00:00이
// 아니면 다음 날 00:00으로 올림), 아니면 오늘 00:00.
export function stackStart(userDoc, now) {
  const exp = userDoc && asDate(userDoc.next_billing_at);
  const wasActive = !!(userDoc && userDoc.subscription_status === "active" && exp);
  const base = wasActive && exp.getTime() > now.getTime() ? kstDayCeil(exp) : kstDayStart(now);
  return { base, wasActive };
}

// payments 문서 한 건 -> 이어 붙이기용 항목. 기간이 저장되지 않은 예전 기록은 결제일 기준으로 추정한다.
// 이용 기간을 회수한 기록(refunded, 기간 유지 표시 없음), 실패한 기록, 길이가 0인 기록은 제외한다(null).
export function toLedgerEntry(row) {
  if (!row || !PLAN_MONTHS[row.plan]) return null;
  const status = row.status || "paid";
  if (status === "failed") return null;
  if (status === "refunded" && !row.period_kept) return null;
  if (status !== "paid" && status !== "partial_refunded" && status !== "refunded") return null;
  const paidAt = asDate(row.paid_at);
  const start = asDate(row.period_start) || paidAt;
  if (!start) return null;
  const planMonths = PLAN_MONTHS[row.plan];
  const months = row.period_months != null ? Number(row.period_months) : planMonths;
  const end = asDate(row.period_end) || addMonths(start, months);
  if (end.getTime() <= start.getTime()) return null;
  return {
    id: row.id,
    plan: row.plan,
    paidAt: paidAt || start,
    start,
    end,
    months,
    paymentId: row.payment_id || null,
    pinned: !!row.period_start_pinned,
  };
}

// 항목들에서 사용자 문서에 반영할 요약.
//  - expiresAt: 가장 늦은 종료일
//  - plan: 아직 끝나지 않은 구간 중 연간이 하나라도 있으면 "annual", 아니면 "monthly"
//  - annualStartsAt: 연간이 아직 시작 전일 때만 그 시작일("월간 이용 중 → 이후 연간" 안내용). 이미 시작된 연간이 있으면 null.
//  - lastAnnual: 환불 기준이 되는 가장 최근 연간 카드 결제(paymentId 있는 것)
export function summarizeLedger(entries, now) {
  if (!entries.length) return { empty: true, expiresAt: null, plan: null, annualStartsAt: null, lastAnnual: null };
  const t = now.getTime();
  const expiresAt = entries.reduce((m, e) => (e.end.getTime() > m.getTime() ? e.end : m), entries[0].end);
  const liveAnnual = entries.filter((e) => e.plan === "annual" && e.end.getTime() > t);
  const annualRunning = liveAnnual.some((e) => e.start.getTime() <= t);
  let annualStartsAt = null;
  if (!annualRunning && liveAnnual.length) {
    annualStartsAt = liveAnnual.reduce((m, e) => (e.start.getTime() < m.getTime() ? e.start : m), liveAnnual[0].start);
  }
  const lastAnnual =
    entries
      .filter((e) => e.plan === "annual" && e.paymentId)
      .sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime() || b.start.getTime() - a.start.getTime())[0] || null;
  return {
    empty: false,
    expiresAt,
    plan: liveAnnual.length ? "annual" : "monthly",
    annualStartsAt,
    lastAnnual,
  };
}

// 결제 한 건(targetId)의 기간을 줄이거나(keepMonths 개월만 남김, 0이면 전부 회수) 없애고, 그 뒤에 이어 붙은
// 구간들을 앞으로 당긴다. 반환:
//  - entries: 갱신된 전체 항목(대상 포함. 대상은 keepMonths==0이면 start==end)
//  - changed: 값이 바뀐 항목 id 목록(대상 포함)
//  - summary: 대상이 남지 않으면 대상을 뺀 항목들로 요약
//  - lastAnnual: 대상을 제외한 가장 최근 연간 카드 결제(환불 기준 갱신용)
//  - expiresAt: 사용자 만료일. 예전 기록에 없는 이용 시간(수동으로 켜 둔 구독 등)이 있어 사용자 만료일이
//    장부 최대 종료일보다 늦으면, 줄어든 만큼만 빼서 보존한다.
export function revokePeriod(entries, targetId, keepMonths, now, userExpiry) {
  const target = entries.find((e) => e.id === targetId);
  if (!target) return null;
  const newTargetEnd = keepMonths > 0 ? addMonths(target.start, keepMonths) : target.start;
  const oldMax = entries.reduce((m, e) => Math.max(m, e.end.getTime()), 0);

  const others = entries.filter((e) => e.id !== targetId);
  const later = others
    .filter((e) => e.start.getTime() >= target.end.getTime() - 1000)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const laterIds = new Set(later.map((e) => e.id));
  let cursor = newTargetEnd.getTime();
  for (const e of others) {
    if (!laterIds.has(e.id) && e.end.getTime() <= target.end.getTime() + 1000) cursor = Math.max(cursor, e.end.getTime());
  }

  const changed = [];
  const updated = new Map();
  updated.set(targetId, { ...target, end: newTargetEnd });
  if (newTargetEnd.getTime() !== target.end.getTime()) changed.push(targetId);
  for (const e of later) {
    let newStart = e.start;
    if (!e.pinned) {
      const candidate = Math.max(e.paidAt.getTime(), cursor);
      newStart = new Date(Math.min(e.start.getTime(), candidate));
    }
    const moved = newStart.getTime() !== e.start.getTime();
    const newEnd = moved ? addMonths(newStart, e.months) : e.end;
    if (moved) {
      updated.set(e.id, { ...e, start: newStart, end: newEnd });
      changed.push(e.id);
    }
    cursor = Math.max(cursor, newEnd.getTime());
  }

  const next = entries.map((e) => updated.get(e.id) || e);
  const remaining = next.filter((e) => e.id !== targetId || keepMonths > 0);
  const summary = summarizeLedger(remaining, now);
  const withoutTarget = summarizeLedger(next.filter((e) => e.id !== targetId), now);
  // 장부 끝(가장 늦은 종료일)이 줄어든 만큼. 대상이 완전히 회수돼도 그 시작 시점까지는 이어져 있었으므로 대상의 시작을 포함해 계산한다.
  const newMax = next.reduce((m, e) => Math.max(m, e.end.getTime()), 0);
  const shift = Math.max(0, oldMax - newMax);
  let expiresAt = summary.expiresAt;
  if (userExpiry && userExpiry.getTime() >= oldMax) {
    expiresAt = new Date(userExpiry.getTime() - shift);
  }
  return { entries: next, changed, summary, lastAnnual: withoutTarget.lastAnnual, expiresAt };
}
