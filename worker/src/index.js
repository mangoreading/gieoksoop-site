// gieoksoop-share Worker
// 인생챕터 외부공유: 로그인한 사용자가 PC 앱에서 챕터 사진을 올리면
// R2에 저장하고 공개 공유 링크(/share/<id>)를 만들어준다.
// 메타데이터는 Firestore 없이 R2 안의 manifest.json 하나로 관리한다(2026.09.17 결정).

import { handlePaymentsRoute, runScheduledBilling } from "./payments.js";

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
  if (!photoFiles.length) return jsonResponse({ error: "no_photos" }, 400);

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
      caption: (manifestInput.captions && manifestInput.captions[i]) || "",
      dt: (manifestInput.dates && manifestInput.dates[i]) || "",
      place: (manifestInput.places && manifestInput.places[i]) || "",
    });
  }

  const now = new Date().toISOString();
  const manifest = {
    share_id: shareId,
    owner_uid: user.uid,
    title: manifestInput.title || "인생챕터",
    subtitle: manifestInput.subtitle || "",
    description: manifestInput.description || "",
    created_at: createdAt || now,
    updated_at: now,
    photos,
  };

  await env.SHARE_BUCKET.put(
    `shares/${shareId}/manifest.json`,
    JSON.stringify(manifest),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } }
  );

  const shareUrl = `https://gieoksoop.com/share/${shareId}`;
  return jsonResponse({ share_id: shareId, share_url: shareUrl });
}

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c])
  );
}

function renderSharePage(manifest) {
  // 배포자(PC 앱)가 보는 "인생챕터 보기" 화면과 같은 느낌으로 렌더링한다
  // (2026.09.21, 사용자 요청) — 큰 표지 사진 위에 제목/날짜가 겹쳐진 히어로,
  // 그 아래 설명, 그리고 정사각형 그리드. 색상/폰트 변수는
  // gieoksoop-PC/static/css/style.css의 :root 값과 맞췄다(브랜드 통일).
  const photoCount = manifest.photos.length;
  const heroKey = manifest.photos.length ? manifest.photos[0].key : null;
  const metaBits = [manifest.subtitle, photoCount ? `사진 ${photoCount}장` : ""].filter(Boolean);
  const metaText = metaBits.join(" · ");

  const tilesHtml = manifest.photos
    .map(
      (p, i) => `
      <div class="tile" data-idx="${i}">
        <img src="/share/${manifest.share_id}/photo/${encodeURIComponent(p.key)}" loading="lazy" alt="${escapeHtml(p.caption)}">
      </div>`
    )
    .join("\n");

  const lbItems = manifest.photos.map((p) => ({
    url: `/share/${manifest.share_id}/photo/${encodeURIComponent(p.key)}`,
    dt: p.dt || "",
    place: p.place || "",
  }));
  const pageDesc = manifest.description || manifest.subtitle || "기억숲으로 공유된 인생챕터입니다.";

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(manifest.title)} — 기억숲</title>
<meta name="description" content="${escapeHtml(pageDesc)}">
<style>
:root{
  --bg:#f7f1e7;--surface-2:#f2ead9;--border-soft:#efe4cf;
  --text:#2c2419;--text-dim:#8a7b64;--text-faint:#b7a888;
  --accent-strong:#b0552f;
  --radius-sm:6px;--radius-md:10px;--radius-lg:16px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","맑은 고딕",Roboto,sans-serif;
  --font-serif:Georgia,"Noto Serif","Nanum Myeongjo","바탕",Batang,serif;
}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);}
.wrap{max-width:920px;margin:0 auto;padding:32px 20px 80px;}
.hero{position:relative;border-radius:var(--radius-lg);overflow:hidden;margin-bottom:26px;aspect-ratio:21/9;background:var(--surface-2);}
.hero img{width:100%;height:100%;object-fit:cover;display:block;}
.hero .scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(28,23,18,0) 40%,rgba(28,23,18,.82) 100%);}
.hero-overlay{position:absolute;left:0;right:0;bottom:0;padding:22px 24px;color:#fdf6e8;}
.hero-title{font-family:var(--font-serif);font-size:28px;font-weight:600;letter-spacing:-.008em;text-shadow:0 2px 12px rgba(0,0,0,.4);margin:0;}
.hero-meta{font-size:13px;color:rgba(253,246,232,.88);margin-top:8px;}
.desc{font-size:14.8px;line-height:1.8;color:var(--text);white-space:pre-wrap;margin-bottom:28px;}
.section-title{font-size:11.5px;font-weight:700;color:var(--text-dim);letter-spacing:.06em;margin-bottom:11px;text-transform:uppercase;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;}
.tile{position:relative;aspect-ratio:1/1;border-radius:var(--radius-sm);overflow:hidden;background:var(--surface-2);border:1px solid var(--border-soft);cursor:zoom-in;}
.tile img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .18s;}
.tile:hover img{transform:scale(1.04);}
footer{margin-top:48px;text-align:center;color:var(--text-faint);font-size:12.5px;}
footer a{color:var(--accent-strong);text-decoration:none;}
/* 라이트박스: PC 앱의 "큰 사진 보기"(static/css/style.css .lightbox 계열)와 같은
   느낌으로 맞춤(2026.09.21, 사용자 요청) — 색/크기/버튼 배치를 그대로 가져오되,
   즐겨찾기·삭제·날짜수정처럼 로그인한 배포자만 쓰는 편집 기능은 뺐다. */
.lightbox{
  position:fixed;inset:0;background:rgba(6,9,7,.94);z-index:2000;
  display:none;align-items:center;justify-content:center;flex-direction:column;
}
.lightbox.open{display:flex;}
.lightbox-media{max-width:88vw;max-height:78vh;display:flex;align-items:center;justify-content:center;}
.lightbox-media img{max-width:88vw;max-height:78vh;border-radius:8px;object-fit:contain;display:block;}
.lightbox-close,.lightbox-nav{
  position:absolute;border:none;background:rgba(255,255,255,.06);color:#fff;
  cursor:pointer;display:flex;align-items:center;justify-content:center;
}
.lightbox-close{top:22px;right:26px;width:38px;height:38px;border-radius:50%;}
.lightbox-close:hover{background:rgba(255,255,255,.14);}
.lightbox-close svg{width:16px;height:16px;}
.lightbox-position{
  position:absolute;top:33px;left:50%;transform:translateX(-50%);
  color:rgba(255,255,255,.72);font-size:12.6px;
}
.lightbox-nav{top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;}
.lightbox-nav:hover{background:rgba(255,255,255,.16);}
.lightbox-nav:disabled{opacity:.25;cursor:default;pointer-events:none;}
.lightbox-nav svg{width:20px;height:20px;}
.lightbox-prev{left:22px;}
.lightbox-next{right:22px;}
.lightbox-caption{color:rgba(255,255,255,.72);font-size:12.6px;margin-top:16px;text-align:center;}
.lightbox-place{display:none;align-items:center;justify-content:center;gap:5px;color:rgba(255,255,255,.5);font-size:12px;margin-top:6px;}
.lightbox-place.show{display:flex;}
.lightbox-place svg{width:13px;height:13px;flex:none;}
@media (max-width:640px){
  .hero{aspect-ratio:4/3;}
  .hero-title{font-size:22px;}
  .lightbox-nav{width:38px;height:38px;}
  .lightbox-nav svg{width:17px;height:17px;}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="hero">
    ${heroKey ? `<img src="/share/${manifest.share_id}/photo/${encodeURIComponent(heroKey)}" alt="">` : ""}
    <div class="scrim"></div>
    <div class="hero-overlay">
      <h1 class="hero-title">${escapeHtml(manifest.title)}</h1>
      ${metaText ? `<div class="hero-meta">${escapeHtml(metaText)}</div>` : ""}
    </div>
  </div>
  ${manifest.description ? `<div class="desc">${escapeHtml(manifest.description)}</div>` : ""}
  <div class="section-title">사진</div>
  <div class="grid" id="grid">
    ${tilesHtml}
  </div>
  <footer>기억숲(LIFE ARCHIVE)으로 공유된 인생챕터입니다 · <a href="https://gieoksoop.com">gieoksoop.com</a></footer>
</div>

<div class="lightbox" id="lightbox">
  <div class="lightbox-position" id="lbPosition"></div>
  <button type="button" class="lightbox-close" id="lbClose" aria-label="닫기">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>
  </button>
  <button type="button" class="lightbox-nav lightbox-prev" id="lbPrev" aria-label="이전 사진">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
  </button>
  <div class="lightbox-media"><img id="lbImg" src="" alt=""></div>
  <button type="button" class="lightbox-nav lightbox-next" id="lbNext" aria-label="다음 사진">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
  </button>
  <div class="lightbox-caption" id="lbCaption"></div>
  <div class="lightbox-place" id="lbPlace">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.1 7-11.5A7 7 0 0 0 5 9.5C5 14.9 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.4"/></svg>
    <span id="lbPlaceText"></span>
  </div>
</div>

<script>
(function(){
  var items = ${JSON.stringify(lbItems)};
  var idx = 0;
  var lb = document.getElementById('lightbox');
  var lbImg = document.getElementById('lbImg');
  var lbPos = document.getElementById('lbPosition');
  var lbPrev = document.getElementById('lbPrev');
  var lbNext = document.getElementById('lbNext');
  var lbCaption = document.getElementById('lbCaption');
  var lbPlace = document.getElementById('lbPlace');
  var lbPlaceText = document.getElementById('lbPlaceText');
  var WEEKDAYS = ['일','월','화','수','목','금','토'];
  function fmtDate(iso){
    if(!iso) return '';
    var d = new Date(iso);
    if(isNaN(d.getTime())) return '';
    var pad = function(n){ return String(n).padStart(2,'0'); };
    return d.getFullYear() + '.' + pad(d.getMonth()+1) + '.' + pad(d.getDate()) + ' (' + WEEKDAYS[d.getDay()] + ')';
  }
  function show(i){
    if(!items.length) return;
    if(i < 0 || i >= items.length) return; // 앱과 동일하게 끝에서 순환하지 않음
    idx = i;
    var it = items[idx];
    lbImg.src = it.url;
    lbPos.textContent = (idx + 1) + ' / ' + items.length;
    lbPrev.disabled = idx <= 0;
    lbNext.disabled = idx >= items.length - 1;
    lbCaption.textContent = fmtDate(it.dt);
    if(it.place){
      lbPlaceText.textContent = it.place;
      lbPlace.classList.add('show');
    } else {
      lbPlace.classList.remove('show');
    }
  }
  function openAt(i){ show(i); lb.classList.add('open'); }
  function close(){ lb.classList.remove('open'); lbImg.src=''; }
  var gridEl = document.getElementById('grid');
  if(gridEl){
    gridEl.addEventListener('click', function(e){
      var tile = e.target.closest('.tile');
      if(!tile) return;
      openAt(parseInt(tile.getAttribute('data-idx'), 10) || 0);
    });
  }
  document.getElementById('lbClose').onclick = close;
  lbPrev.onclick = function(){ show(idx - 1); };
  lbNext.onclick = function(){ show(idx + 1); };
  lb.addEventListener('click', function(e){ if(e.target === lb) close(); });
  document.addEventListener('keydown', function(e){
    if(!lb.classList.contains('open')) return;
    if(e.key === 'Escape') close();
    else if(e.key === 'ArrowLeft') show(idx - 1);
    else if(e.key === 'ArrowRight') show(idx + 1);
  });
})();
</script>
</body>
</html>`;
}
async function handleViewShare(shareId, env) {
  const obj = await env.SHARE_BUCKET.get(`shares/${shareId}/manifest.json`);
  if (!obj) return new Response("공유 링크를 찾을 수 없어요.", { status: 404 });
  const manifest = await obj.json();
  const html = renderSharePage(manifest);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handlePhoto(shareId, photoKey, env) {
  const key = `shares/${shareId}/photos/${photoKey}`;
  const obj = await env.SHARE_BUCKET.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/payments/")) {
      const paymentsResponse = await handlePaymentsRoute(request, env, url, verifyFirebaseIdToken);
      if (paymentsResponse) return paymentsResponse;
    }

    if (path === "/api/share/create" && request.method === "POST") {
      return handleCreateShare(request, env);
    }

    const photoMatch = path.match(/^\/share\/([a-zA-Z0-9]+)\/photo\/(.+)$/);
    if (photoMatch && request.method === "GET") {
      return handlePhoto(photoMatch[1], decodeURIComponent(photoMatch[2]), env);
    }

    const viewMatch = path.match(/^\/share\/([a-zA-Z0-9]+)\/?$/);
    if (viewMatch && request.method === "GET") {
      return handleViewShare(viewMatch[1], env);
    }

    return new Response("not found", { status: 404 });
  },

  // Cloudflare Cron Trigger(wrangler.toml의 [triggers] crons)가 매일 호출한다.
  // 정기결제 대상을 찾아 자동으로 재결제하는 로직은 payments.js에 있다.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledBilling(env));
  },
};
