// 고객 문의(inquiries) 알림 메일 처리.
//
// 문의 접수/답변 자체는 Firestore(inquiries 컬렉션 + 보안 규칙)로 처리되고, 이 파일은 "메일 알림"만 맡는다.
//   POST /api/inquiry/created  : 사용자가 문의를 저장한 직후 호출 -> 운영자 메일함으로 새 문의 알림
//   POST /api/inquiry/answered : 관리자가 답변을 저장한 직후 호출 -> 문의한 사용자에게 "답변이 도착했어요" 알림
//
// 메일 발송은 Resend(https://resend.com) HTTP API를 쓴다. 아래 값이 설정되지 않으면 메일은 건너뛰고
// {mail:"not_configured"}만 돌려주므로, 메일 설정 전에도 문의 접수/답변 자체는 정상 동작한다.
//   - Secret  RESEND_API_KEY    : wrangler secret put RESEND_API_KEY
//   - Var     MAIL_FROM         : 예) 기억숲 <noreply@gieoksoop.com>  (Resend에서 gieoksoop.com 도메인 인증 필요)
//   - Var     INQUIRY_NOTIFY_TO : 새 문의 알림을 받을 주소(없으면 gieoksoop@gmail.com)
// 메일에는 문의/답변 본문을 넣지 않고 링크만 넣는다(계정 정보·내용이 메일에 남지 않게).

import { firestoreGetDoc, firestorePatchDoc } from "./firestore.js";

const SITE_URL = "https://gieoksoop.com";
const ADMIN_URL = "https://admin.gieoksoop.com";
const ADMIN_ORIGINS = [ADMIN_URL];
const DEFAULT_NOTIFY_TO = "gieoksoop@gmail.com";

const CATEGORY_LABEL = {
  payment: "결제·환불",
  subscription: "구독·해지",
  account: "계정·로그인",
  app: "앱 사용·오류",
  etc: "기타",
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function corsHeaders(request) {
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

async function requireUser(request, env, verifyFirebaseIdToken) {
  const match = (request.headers.get("Authorization") || "").match(/^Bearer (.+)$/);
  if (!match) return { error: jsonResponse({ error: "missing_token" }, 401) };
  try {
    const user = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
    return { user };
  } catch (e) {
    return { error: jsonResponse({ error: "invalid_token" }, 401) };
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return null;
  }
}

// 문의 문서 ID 형식: {uid}_{YYYYMMDD}_{1..5} (Firestore 규칙과 동일한 형식만 허용)
function validInquiryId(id) {
  return typeof id === "string" && /^[A-Za-z0-9]{1,128}_[0-9]{8}_[1-5]$/.test(id);
}

// 메일 발송. 설정이 없으면 "not_configured", 실패해도 예외를 던지지 않고 "failed"를 돌려준다(문의 처리 자체는 이미 끝났으므로).
async function sendMail(env, { to, subject, text, html }) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return "not_configured";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, html }),
    });
    if (!res.ok) {
      console.error("inquiry_mail_failed", res.status, (await res.text()).slice(0, 300));
      return "failed";
    }
    return "sent";
  } catch (e) {
    console.error("inquiry_mail_error", String(e && e.message ? e.message : e));
    return "failed";
  }
}

function mailShell(title, bodyHtml) {
  return `<div style="font-family:-apple-system,'Malgun Gothic',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#2c2419;line-height:1.65;">
<h2 style="font-size:18px;margin:0 0 16px;color:#1e2a3c;">${escapeHtml(title)}</h2>
${bodyHtml}
<p style="font-size:12px;color:#8c8064;margin-top:28px;border-top:1px solid #e8dbc0;padding-top:12px;">기억숲 · 이 메일은 발신 전용이에요.</p>
</div>`;
}

// 사용자가 문의를 저장한 뒤 호출 -> 운영자에게 새 문의 알림.
async function handleCreated(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;
  const body = await readJson(request);
  const id = body && body.id;
  if (!validInquiryId(id)) return jsonResponse({ error: "invalid_params" }, 400);

  const inquiry = await firestoreGetDoc(env, `inquiries/${id}`);
  if (!inquiry || inquiry.uid !== user.uid) return jsonResponse({ error: "not_found" }, 404);
  // 같은 문의로 알림이 여러 번 나가지 않게 한 번만 처리한다.
  if (inquiry.admin_notified === true) return jsonResponse({ ok: true, mail: "already_notified" });

  const category = CATEGORY_LABEL[inquiry.category] || "기타";
  const link = `${ADMIN_URL}/inquiries.html`;
  const mail = await sendMail(env, {
    to: env.INQUIRY_NOTIFY_TO || DEFAULT_NOTIFY_TO,
    subject: `[기억숲] 새 문의가 도착했어요 (${category})`,
    text: `새 문의가 도착했어요.\n분류: ${category}\n제목: ${inquiry.title || ""}\n\n관리자에서 확인: ${link}`,
    html: mailShell(
      "새 문의가 도착했어요",
      `<p style="margin:0 0 6px;">분류: ${escapeHtml(category)}</p>
<p style="margin:0 0 16px;">제목: ${escapeHtml(inquiry.title || "")}</p>
<p style="margin:0;"><a href="${link}" style="color:#2d4a86;">관리자에서 확인하기</a></p>`
    ),
  });
  if (mail === "sent" || mail === "not_configured") {
    await firestorePatchDoc(env, `inquiries/${id}`, { admin_notified: true });
  }
  return jsonResponse({ ok: true, mail });
}

// 관리자가 답변을 저장한 뒤 호출 -> 문의한 사용자에게 알림.
async function handleAnswered(request, env, verifyFirebaseIdToken) {
  const { user, error } = await requireUser(request, env, verifyFirebaseIdToken);
  if (error) return error;
  const adminDoc = await firestoreGetDoc(env, `admins/${user.uid}`);
  if (!adminDoc) return jsonResponse({ error: "not_admin" }, 403);

  const body = await readJson(request);
  const id = body && body.id;
  if (!validInquiryId(id)) return jsonResponse({ error: "invalid_params" }, 400);

  const inquiry = await firestoreGetDoc(env, `inquiries/${id}`);
  if (!inquiry) return jsonResponse({ error: "not_found" }, 404);
  if (inquiry.status !== "answered" || !inquiry.answer) {
    return jsonResponse({ error: "not_answered" }, 400);
  }
  const to = String(inquiry.email || "").trim();
  if (!to) return jsonResponse({ error: "no_recipient" }, 400);

  const link = `${SITE_URL}/contact.html`;
  const mail = await sendMail(env, {
    to,
    subject: "[기억숲] 문의하신 내용에 답변이 도착했어요",
    text: `문의하신 내용에 답변이 도착했어요.\n아래 링크에서 로그인 후 '내 문의 내역'을 확인해 주세요.\n${link}`,
    html: mailShell(
      "문의하신 내용에 답변이 도착했어요",
      `<p style="margin:0 0 16px;">로그인 후 <b>내 문의 내역</b>에서 답변을 확인해 주세요.</p>
<p style="margin:0;"><a href="${link}" style="color:#2d4a86;">내 문의 내역 보기</a></p>`
    ),
  });
  if (mail === "sent") {
    await firestorePatchDoc(env, `inquiries/${id}`, { answer_notified_at: new Date() });
  }
  return jsonResponse({ ok: true, mail });
}

export async function handleInquiryRoute(request, env, url, verifyFirebaseIdToken) {
  const path = url.pathname;
  if (path !== "/api/inquiry/created" && path !== "/api/inquiry/answered") return null;
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
  try {
    const res =
      path === "/api/inquiry/created"
        ? await handleCreated(request, env, verifyFirebaseIdToken)
        : await handleAnswered(request, env, verifyFirebaseIdToken);
    return withHeaders(res, cors);
  } catch (e) {
    console.error("inquiry_route_error", path, String(e && e.message ? e.message : e));
    return withHeaders(jsonResponse({ error: "server_error" }, 500), cors);
  }
}
