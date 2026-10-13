// gieoksoop-share Worker
// 인생챕터 외부공유: 로그인한 사용자가 PC 앱에서 챕터 사진을 올리면
// R2에 저장하고 공개 공유 링크(/share/<id>)를 만들어준다.
// 메타데이터는 Firestore 없이 R2 안의 manifest.json 하나로 관리한다(2026.09.17 결정).

import { handlePaymentsRoute, runScheduledBilling } from "./payments.js";
import { handleInquiryRoute } from "./inquiry.js";
import { renderSharePage } from "./sharepage.js";
import { planZip, zipStream, entryName } from "./zipstream.js";

const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let cachedJwks = null;
let cachedJwksExpiry = 0;

async function getFirebaseJwks() {
  const now = Date.now();
  if (cachedJwks && now < cachedJwksExpiry) return cachedJwks;
  const res = await fetch(FIREBASE_JWKS_URL, {
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error("jwks_fetch_failed");
  const data = await res.json();
  cachedJwks = data.keys;
  cachedJwksExpiry = now + 60 * 60 * 1000; // 1시간 캐시
  return cachedJwks;
}

function base64UrlToUint8Array(base64Url) {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson(base64Url) {
  const bytes = base64UrlToUint8Array(base64Url);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

async function verifyFirebaseIdToken(idToken, projectId) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed_token");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = base64UrlDecodeJson(headerB64);
  const payload = base64UrlDecodeJson(payloadB64);

  if (header.alg !== "RS256") throw new Error("unsupported_alg");

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new Error("token_expired");
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error("bad_issuer");
  }
  if (payload.aud !== projectId) throw new Error("bad_audience");
  if (!payload.sub) throw new Error("no_sub");

  const jwks = await getFirebaseJwks();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown_kid");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToUint8Array(sigB64);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signedData
  );
  if (!valid) throw new Error("bad_signature");

  return { uid: payload.sub, email: payload.email || null };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function newShareId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// 사진 속 관심 지점(받는 친구의 얼굴 위치, 0~1). 이상한 값이면 버린다.
function focusFields(f) {
  if (Array.isArray(f) && f.length === 2) {
    const x = Number(f[0]);
    const y = Number(f[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const c = (v) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
      return { fx: c(x), fy: c(y) };
    }
  }
  return {};
}

// 사진 원래 크기(가로, 세로 px). 받는 사람 화면이 사진 자리를 미리 잡고 세로 사진을 짝지어 놓는 데 쓴다.
function dimFields(d) {
  if (Array.isArray(d) && d.length === 2) {
    const w = Math.round(Number(d[0]));
    const h = Math.round(Number(d[1]));
    if (w > 0 && h > 0 && w <= 20000 && h <= 20000) return { w, h };
  }
  return {};
}

// 날짜별 한 줄: {"2023-08-08": "글"} — 날짜 모양이 아닌 키와 빈 글은 버리고, 최대 60일·120자.
function dayLines(v) {
  const out = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  let n = 0;
  for (const k of Object.keys(v)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    const t = String(v[k] == null ? "" : v[k]).trim().slice(0, 120);
    if (!t) continue;
    out[k] = t;
    if (++n >= 60) break;
  }
  return out;
}

// 파일 CRC32(PC 앱이 계산해 보낸 값, 0~2^32-1 정수). 이상하면 버린다 — ZIP 내려받기를 못 쓰게 될 뿐이다.
function crcField(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? { crc: n } : {};
}

function sanitizeFilename(name) {
  return (name || "photo").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

async function _deleteAllUnderPrefix(env, prefix) {
  // R2엔 "폴더 통째로 지우기"가 없어서 리스트 후 하나씩 지워야 한다. 재공유
  // 시(같은 share_id를 재사용할 때) 이번에 빠진 예전 사진이 R2에 계속 쌓이지
  // 않도록, 새로 올리기 전에 그 share_id의 photos/ 밑을 통째로 비운다
  // (2026.09.21).
  let cursor;
  for (let guard = 0; guard < 20; guard++) {
    const listing = await env.SHARE_BUCKET.list({ prefix, cursor });
    if (listing.objects.length) {
      await Promise.all(
        listing.objects.map((o) => env.SHARE_BUCKET.delete(o.key))
      );
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
}

async function _resolveShareId(env, existingShareId, ownerUid) {
  // "다시 공유하기"를 눌러도 URL이 안 바뀌도록, 이미 이 챕터를 공유한 적
  // 있으면(existingShareId) 그 자리를 그대로 재사용한다 — 단, 그 공유의 실제
  // 소유자가 지금 요청한 사람과 같을 때만(남의 share_id를 넘겨서 덮어쓰는 걸
  // 막기 위해). 못 찾거나 소유자가 다르면 안전하게 새 id를 발급한다
  // (2026.09.21, 사용자 요청: 다시 공유해도 링크가 그대로였으면 좋겠다).
  if (existingShareId && /^[a-zA-Z0-9]{1,40}$/.test(existingShareId)) {
    try {
      const obj = await env.SHARE_BUCKET.get(
        `shares/${existingShareId}/manifest.json`
      );
      if (obj) {
        const existing = await obj.json();
        if (existing.owner_uid === ownerUid) {
          return { shareId: existingShareId, createdAt: existing.created_at || null };
        }
      }
    } catch (e) {
      // 못 읽었으면 그냥 새로 만든다(아래로 이어짐)
    }
  }
  return { shareId: newShareId(), createdAt: null };
}

async function handleCreateShare(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return jsonResponse({ error: "missing_token" }, 401);

  let user;
  try {
    user = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
  } catch (e) {
    return jsonResponse(
      { error: "invalid_token", detail: String(e.message || e) },
      401
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return jsonResponse({ error: "bad_form_data" }, 400);
  }

  const manifestRaw = form.get("manifest");
  let manifestInput = {};
  if (manifestRaw) {
    try {
      manifestInput = JSON.parse(manifestRaw);
    } catch (e) {
      return jsonResponse({ error: "bad_manifest_json" }, 400);
    }
  }

  const photoFiles = form.getAll("photo");
  // 선물 공유(2026.10): 영상은 "video" 필드, 그 대표 이미지는 같은 순서의 "poster" 필드로 온다.
  const videoFiles = form.getAll("video");
  const posterFiles = form.getAll("poster");
  if (!photoFiles.length && !videoFiles.length) return jsonResponse({ error: "no_photos" }, 400);
  const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
  for (const v of videoFiles) {
    if (v instanceof File && v.size > MAX_VIDEO_BYTES) {
      return jsonResponse({ error: "video_too_large" }, 413);
    }
  }

  const { shareId, createdAt } = await _resolveShareId(
    env,
    manifestInput.existing_share_id,
    user.uid
  );
  // 같은 share_id를 재사용하는 경우, 안 올라온(챕터에서 빠진) 예전 사진이
  // 계속 남지 않도록 먼저 통째로 비운다.
  await _deleteAllUnderPrefix(env, `shares/${shareId}/photos/`);

  // 사진 URL 자체에 버전을 넣는다 — 사진 응답엔 "영원히 캐시해도 됨"(immutable)
  // 헤더를 붙여놨는데, 같은 share_id를 재사용해도(위) 사진 파일명이 그대로면
  // 내용이 바뀌어도 이미 봤던 사람 브라우저엔 예전 사진이 캐시된 채 남아
  // 안 바뀐 것처럼 보이기 때문(2026.09.21).
  const uploadVersion = Date.now().toString(36);
  const photos = [];

  for (let i = 0; i < photoFiles.length; i++) {
    const file = photoFiles[i];
    if (!(file instanceof File)) continue;
    const safeName = `${uploadVersion}_${String(i).padStart(3, "0")}_${sanitizeFilename(file.name)}`;
    const key = `shares/${shareId}/photos/${safeName}`;
    await env.SHARE_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
    photos.push({
      key: safeName,
      type: "photo",
      caption: (manifestInput.captions && manifestInput.captions[i]) || "",
      dt: (manifestInput.dates && manifestInput.dates[i]) || "",
      place: (manifestInput.places && manifestInput.places[i]) || "",
      ...focusFields(manifestInput.focus && manifestInput.focus[i]),
      ...dimFields(manifestInput.dims && manifestInput.dims[i]),
      size: file.size,
      ...crcField(manifestInput.crcs && manifestInput.crcs[i]),
    });
  }

  const videoMeta = Array.isArray(manifestInput.videos) ? manifestInput.videos : [];
  const videoEntries = [];
  for (let j = 0; j < videoFiles.length; j++) {
    const file = videoFiles[j];
    if (!(file instanceof File)) continue;
    const meta = videoMeta[j] || {};
    const vName = `${uploadVersion}_v${String(j).padStart(2, "0")}_${sanitizeFilename(file.name)}`;
    await env.SHARE_BUCKET.put(`shares/${shareId}/photos/${vName}`, file.stream(), {
      httpMetadata: { contentType: file.type && file.type.startsWith("video/") ? file.type : "video/mp4" },
    });
    let posterName = "";
    const pf = posterFiles[j];
    if (pf instanceof File) {
      posterName = `${uploadVersion}_v${String(j).padStart(2, "0")}_poster_${sanitizeFilename(pf.name)}`;
      await env.SHARE_BUCKET.put(`shares/${shareId}/photos/${posterName}`, pf.stream(), {
        httpMetadata: { contentType: pf.type || "image/jpeg" },
      });
    }
    videoEntries.push({
      key: vName,
      type: "video",
      poster: posterName,
      duration: Number(meta.duration) || 0,
      caption: meta.caption || "",
      dt: meta.dt || "",
      place: meta.place || "",
      ...dimFields(meta.dims),
      size: file.size,
      ...crcField(meta.crc),
    });
  }

  // 사진과 영상을 어떤 순서로 보여줄지: PC 앱이 order(["p0","v0","p1",...])를 보내면 그대로,
  // 없으면 예전처럼 사진만(영상은 뒤에).
  let ordered = photos.concat(videoEntries);
  if (Array.isArray(manifestInput.order) && manifestInput.order.length) {
    const pick = [];
    for (const tok of manifestInput.order) {
      const mm = /^([pv])(\d+)$/.exec(String(tok));
      if (!mm) continue;
      const src = mm[1] === "p" ? photos : videoEntries;
      const item = src[parseInt(mm[2], 10)];
      if (item && !pick.includes(item)) pick.push(item);
    }
    for (const it of ordered) if (!pick.includes(it)) pick.push(it);
    ordered = pick;
  }

  // 표지로 쓸 사진: cover_ref("p3" = 올린 사진 중 4번째). 없거나 잘못되면 페이지가 첫 사진을 쓴다.
  let cover = "";
  const cm = /^p(\d+)$/.exec(String(manifestInput.cover_ref || ""));
  if (cm && photos[parseInt(cm[1], 10)]) cover = photos[parseInt(cm[1], 10)].key;

  const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
  const kind = ["chapter", "gift", "year"].includes(manifestInput.kind) ? manifestInput.kind : "chapter";
  const now = new Date().toISOString();
  const manifest = {
    share_id: shareId,
    owner_uid: user.uid,
    kind,
    kicker: clip(manifestInput.kicker, 30),
    title: manifestInput.title || "인생챕터",
    subtitle: manifestInput.subtitle || "",
    description: manifestInput.description || "",
    to_name: clip(manifestInput.to_name, 60),
    from_name: clip(manifestInput.from_name, 30),
    message: clip(manifestInput.message, 2000),
    theme: manifestInput.theme === "white" ? "white" : "paper",
    allow_download: manifestInput.allow_download !== false,
    day_lines: dayLines(manifestInput.day_lines),
    cover,
    created_at: createdAt || now,
    updated_at: now,
    photos: ordered,
  };

  await env.SHARE_BUCKET.put(
    `shares/${shareId}/manifest.json`,
    JSON.stringify(manifest),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } }
  );

  const shareUrl = `https://gieoksoop.com/share/${shareId}`;
  return jsonResponse({ share_id: shareId, share_url: shareUrl });
}

async function handleViewShare(shareId, env, origin) {
  const obj = await env.SHARE_BUCKET.get(`shares/${shareId}/manifest.json`);
  if (!obj) return new Response("공유 링크를 찾을 수 없어요.", { status: 404 });
  const manifest = await obj.json();
  const html = renderSharePage(manifest, origin);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 받은 사람이 아니면 검색에 노출되지 않도록
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

// 사진과 영상을 내려준다. 영상은 브라우저가 중간부터 재생(시킹)할 수 있어야 해서
// Range 요청(206 Partial Content)을 지원한다(2026.10 선물 공유 추가).
async function handlePhoto(shareId, photoKey, env, request) {
  if (!/^[A-Za-z0-9._-]+$/.test(photoKey)) return new Response("not found", { status: 404 });
  const key = `shares/${shareId}/photos/${photoKey}`;
  const range = request && request.headers.get("Range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const head = await env.SHARE_BUCKET.head(key);
    if (!head) return new Response("not found", { status: 404 });
    const size = head.size;
    if (m && (m[1] !== "" || m[2] !== "")) {
      let start, end;
      if (m[1] === "") {                 // bytes=-N : 끝에서 N바이트
        start = Math.max(0, size - parseInt(m[2], 10));
        end = size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
      }
      if (start >= size || start > end) {
        return new Response("range not satisfiable", {
          status: 416, headers: { "Content-Range": `bytes */${size}` },
        });
      }
      const obj = await env.SHARE_BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
      if (!obj) return new Response("not found", { status: 404 });
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set("Content-Range", `bytes ${start}-${end}/${size}`);
      h.set("Content-Length", String(end - start + 1));
      h.set("Accept-Ranges", "bytes");
      h.set("Cache-Control", "public, max-age=31536000, immutable");
      return new Response(obj.body, { status: 206, headers: h });
    }
  }
  const obj = await env.SHARE_BUCKET.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

// ---------------- 받는 사람: 한꺼번에 저장(ZIP) ----------------
async function handleDownloadZip(shareId, env) {
  const obj = await env.SHARE_BUCKET.get(`shares/${shareId}/manifest.json`);
  if (!obj) return new Response("공유 링크를 찾을 수 없어요.", { status: 404 });
  const manifest = await obj.json();
  if (manifest.kind !== "gift" || manifest.allow_download === false) {
    return new Response("이 선물은 한꺼번에 저장할 수 없어요.", { status: 403 });
  }
  const entries = [];
  (manifest.photos || []).forEach((p, idx) => {
    if (Number.isInteger(p.crc) && Number.isInteger(p.size) && p.size > 0) {
      entries.push({ name: entryName(p, idx), size: p.size, crc: p.crc, key: p.key });
    }
  });
  if (!entries.length) {
    return new Response("예전에 만든 선물이라 한꺼번에 저장할 수 없어요. 보낸 사람에게 다시 보내 달라고 해 주세요.", { status: 409 });
  }
  const plan = planZip(entries, new Date(manifest.updated_at || Date.now()));
  const stream = zipStream(entries, plan, (e) => env.SHARE_BUCKET.get(`shares/${shareId}/photos/${e.key}`));
  const title = String(manifest.title || "선물").replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 40) || "선물";
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(plan.total),
      "Content-Disposition": `attachment; filename="gift.zip"; filename*=UTF-8''${encodeURIComponent(title)}.zip`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

// ---------------- 받는 사람: 마음 남기기(♥·한마디) ----------------
// 로그인 없이 닉네임만. 한 번에 R2 객체 하나씩(shares/<id>/reactions/...) 쌓아서 동시에 와도 서로 덮어쓰지 않는다.
const MAX_REACTIONS = 200;

async function handleReact(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "bad_json" }, 400); }
  const shareId = String(body.share_id || "");
  if (!/^[a-zA-Z0-9]+$/.test(shareId)) return jsonResponse({ error: "bad_share" }, 400);
  if (body.website) return jsonResponse({ ok: true });      // 자동 입력 봇이 채우는 숨김 칸 — 조용히 무시
  const head = await env.SHARE_BUCKET.head(`shares/${shareId}/manifest.json`);
  if (!head) return jsonResponse({ error: "not_found" }, 404);
  const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  const name = clip(body.name, 20);
  const text = String(body.text == null ? "" : body.text).replace(/\r/g, "").trim().slice(0, 500);
  const heart = body.heart === true;
  if (!text && !heart) return jsonResponse({ error: "empty" }, 400);
  const listed = await env.SHARE_BUCKET.list({ prefix: `shares/${shareId}/reactions/`, limit: MAX_REACTIONS + 1 });
  if ((listed.objects || []).length >= MAX_REACTIONS) return jsonResponse({ error: "too_many" }, 429);
  const at = new Date().toISOString();
  const id = `${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  await env.SHARE_BUCKET.put(`shares/${shareId}/reactions/${id}.json`,
    JSON.stringify({ id, name, text, heart, at }),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  return jsonResponse({ ok: true });
}

// 보낸 사람(소유자)만 받은 마음을 읽는다.
async function handleReactions(request, env, url) {
  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return jsonResponse({ error: "missing_token" }, 401);
  let user;
  try { user = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID); }
  catch (e) { return jsonResponse({ error: "invalid_token" }, 401); }
  const shareId = String(url.searchParams.get("share_id") || "");
  if (!/^[a-zA-Z0-9]+$/.test(shareId)) return jsonResponse({ error: "bad_share" }, 400);
  const mo = await env.SHARE_BUCKET.get(`shares/${shareId}/manifest.json`);
  if (!mo) return jsonResponse({ error: "not_found" }, 404);
  const manifest = await mo.json();
  if (manifest.owner_uid !== user.uid) return jsonResponse({ error: "forbidden" }, 403);
  const listed = await env.SHARE_BUCKET.list({ prefix: `shares/${shareId}/reactions/`, limit: MAX_REACTIONS });
  const items = [];
  for (const o of listed.objects || []) {
    const r = await env.SHARE_BUCKET.get(o.key);
    if (!r) continue;
    try { items.push(await r.json()); } catch (e) { /* 깨진 항목은 건너뜀 */ }
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return jsonResponse({ ok: true, items });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/payments/")) {
      const paymentsResponse = await handlePaymentsRoute(request, env, url, verifyFirebaseIdToken);
      if (paymentsResponse) return paymentsResponse;
    }

    if (path.startsWith("/api/inquiry/")) {
      const inquiryResponse = await handleInquiryRoute(request, env, url, verifyFirebaseIdToken);
      if (inquiryResponse) return inquiryResponse;
    }

    if (path === "/api/share/create" && request.method === "POST") {
      return handleCreateShare(request, env);
    }

    if (path === "/api/share/react" && request.method === "POST") {
      return handleReact(request, env);
    }
    if (path === "/api/share/reactions" && request.method === "GET") {
      return handleReactions(request, env, url);
    }

    const zipMatch = path.match(/^\/share\/([a-zA-Z0-9]+)\/download\.zip$/);
    if (zipMatch && request.method === "GET") {
      return handleDownloadZip(zipMatch[1], env);
    }

    const photoMatch = path.match(/^\/share\/([a-zA-Z0-9]+)\/photo\/(.+)$/);
    if (photoMatch && request.method === "GET") {
      return handlePhoto(photoMatch[1], decodeURIComponent(photoMatch[2]), env, request);
    }

    const viewMatch = path.match(/^\/share\/([a-zA-Z0-9]+)\/?$/);
    if (viewMatch && request.method === "GET") {
      return handleViewShare(viewMatch[1], env, url.origin);
    }

    return new Response("not found", { status: 404 });
  },

  // Cloudflare Cron Trigger(wrangler.toml의 [triggers] crons)가 매일 호출한다.
  // 정기결제 대상을 찾아 자동으로 재결제하는 로직은 payments.js에 있다.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledBilling(env));
  },
};
