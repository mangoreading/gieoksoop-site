// 선물 받는 사람 화면 (2026.10) — 세로로 천천히 내려가며 읽는 포토에세이.
//
// 원칙: 한없이 깔끔하게. 장식·버튼·재생 효과 없이 "표지 → 편지 → 날짜별 사진과 한 줄 → 보낸 사람" 순서로만 흐른다.
// 분위기는 보내는 사람이 고른다(manifest.theme): "paper"(밝고 조용한 종이 톤, 기본) / "white"(흰 바탕 초미니멀).
//
// 사용하는 manifest 필드:
//   title, subtitle, to_name, from_name, message(편지), theme, day_lines({"2023-08-08": "한 줄"}),
//   cover, photos[{key, type, dt, place, w, h, fx, fy, poster?, duration?, caption?}]  — 순서가 곧 보여주는 순서.
// 글자체는 sharepage.js와 같은 /fonts/share/ 사본을 쓴다(외부 CDN 없음).

const FONT_BASE = "/fonts/share/";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

const WD = ["일", "월", "화", "수", "목", "금", "토"];

function dayLabel(day) {
  const d = new Date(day + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
}

function pct(v) {
  return `${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}%`;
}

function ratioOf(p) {
  const w = Number(p.w), h = Number(p.h);
  return w > 0 && h > 0 ? w / h : 0;
}

const CSS = String.raw`
@font-face{font-family:'Pretendard Variable';src:url('/fonts/share/share-sans.woff2') format('woff2-variations');font-weight:45 920;font-style:normal;font-display:swap;}
@font-face{font-family:'Noto Serif KR';src:url('/fonts/share/share-serif-400.woff2') format('woff2');font-weight:400;font-style:normal;font-display:swap;}
@font-face{font-family:'Noto Serif KR';src:url('/fonts/share/share-serif-600.woff2') format('woff2');font-weight:600 700;font-style:normal;font-display:swap;}
:root{
  --sans:'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","맑은 고딕",Roboto,sans-serif;
  --serif:'Noto Serif KR','Nanum Myeongjo',Georgia,"바탕",Batang,serif;
}
.theme-paper{--bg:#f6f2ea;--ink:#2a2620;--dim:#6d665a;--faint:#a39b8c;--line:#e2dacb;--ph:#ebe5d8;}
.theme-white{--bg:#ffffff;--ink:#1c1c1c;--dim:#6a6a6a;--faint:#a9a9a9;--line:#ececec;--ph:#f2f2f2;}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html{background:var(--bg);}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;line-height:1.6;}
img,video{display:block;max-width:100%;}
.col{width:100%;max-width:720px;margin:0 auto;padding:0 20px;}

/* 표지 */
.hero{padding:calc(env(safe-area-inset-top,0px) + 28px) 0 0;}
.hero-img{margin:0 auto;width:min(100%,1040px);padding:0 20px;}
.hero-img .frame{aspect-ratio:4/5;overflow:hidden;background:var(--ph);}
.hero-img img{width:100%;height:100%;object-fit:cover;}
@media (min-width:760px){.hero-img .frame{aspect-ratio:3/2;}}
.hero-text{text-align:center;padding:44px 0 0;}
.to{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);}
.title{font-family:var(--serif);font-weight:600;font-size:clamp(28px,6.4vw,42px);line-height:1.35;letter-spacing:-.01em;margin:14px 0 0;word-break:keep-all;}
.sub{font-size:13.5px;color:var(--dim);margin-top:14px;letter-spacing:.02em;}

/* 편지 */
.letter{padding:84px 0 0;text-align:center;}
.letter-to{font-family:var(--serif);font-size:15px;color:var(--dim);margin-bottom:26px;}
.letter-body{font-family:var(--serif);font-size:17px;line-height:2.05;white-space:pre-wrap;word-break:keep-all;max-width:30em;margin:0 auto;text-align:left;}
@media (min-width:760px){.letter-body{font-size:18px;}}
.letter-from{font-family:var(--serif);font-size:15px;color:var(--dim);margin-top:30px;}

/* 날짜별 */
.day{padding:104px 0 0;}
.dayhead{text-align:center;}
.dayhead .no{display:block;font-size:12px;letter-spacing:.2em;color:var(--faint);}
.dayhead .date{display:block;font-family:var(--serif);font-size:19px;margin-top:6px;}
.dayhead .place{display:block;font-size:13px;color:var(--dim);margin-top:4px;}
.line{font-family:var(--serif);font-size:16px;line-height:1.9;color:var(--dim);text-align:center;margin:20px auto 0;max-width:26em;white-space:pre-wrap;word-break:keep-all;}
.shots{margin:36px auto 0;width:min(100%,960px);padding:0 20px;display:flex;flex-direction:column;gap:14px;}
@media (min-width:760px){.shots{gap:22px;}}
.shot{margin:0;background:var(--ph);overflow:hidden;cursor:zoom-in;}
.shot img{width:100%;height:auto;}
.shot.v{cursor:default;}
.shot video{width:100%;height:auto;background:#000;}
.shot.solo-p{width:78%;margin:0 auto;}
.pair{display:flex;gap:14px;}
@media (min-width:760px){.pair{gap:22px;}}

/* 끝 */
.fin{padding:112px 0 0;text-align:center;}
.fin .from{font-family:var(--serif);font-size:15px;color:var(--dim);}
footer{padding:90px 20px calc(env(safe-area-inset-bottom,0px) + 44px);text-align:center;font-size:11.5px;letter-spacing:.16em;color:var(--faint);}
footer a{color:inherit;text-decoration:none;}

/* 크게 보기 */
.zoom{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;background:var(--bg);cursor:zoom-out;padding:10px;}
.zoom.open{display:flex;}
.zoom img{max-width:100%;max-height:100%;object-fit:contain;}

/* 천천히 나타나기(스크립트가 있을 때만) */
.js .rv{opacity:0;transform:translateY(14px);transition:opacity .9s ease,transform .9s ease;}
.js .rv.in{opacity:1;transform:none;}
@media (prefers-reduced-motion:reduce){.js .rv{opacity:1;transform:none;transition:none;}}
`;

const CLIENT_JS = String.raw`
(function(){
  document.documentElement.classList.add('js');
  var els = document.querySelectorAll('.rv');
  if('IntersectionObserver' in window){
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
    }, {rootMargin: '0px 0px -8% 0px'});
    els.forEach(function(el){ io.observe(el); });
  } else { els.forEach(function(el){ el.classList.add('in'); }); }

  var z = document.getElementById('zoom'), zi = z.querySelector('img');
  function close(){ z.classList.remove('open'); zi.removeAttribute('src'); document.body.style.overflow = ''; }
  document.addEventListener('click', function(e){
    if(e.target.closest('#zoom')){ close(); return; }
    var s = e.target.closest('.shot'); if(!s || s.classList.contains('v')) return;
    var img = s.querySelector('img'); if(!img) return;
    zi.src = img.currentSrc || img.src; z.classList.add('open'); document.body.style.overflow = 'hidden';
  });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape') close(); });
})();
`;

function figure(base, p, extra) {
  const isV = p.type === "video";
  const r = ratioOf(p);
  const dim = r ? ` width="${Math.round(Number(p.w))}" height="${Math.round(Number(p.h))}"` : "";
  if (isV) {
    const poster = p.poster ? ` poster="${esc(base + encodeURIComponent(p.poster))}"` : "";
    return `<figure class="shot v${extra || ""}"${r ? ` style="aspect-ratio:${r.toFixed(4)}"` : ""}><video controls playsinline preload="none"${poster} src="${esc(base + encodeURIComponent(p.key))}"></video></figure>`;
  }
  return `<figure class="shot${extra || ""}"><img src="${esc(base + encodeURIComponent(p.key))}"${dim} loading="lazy" alt="${esc(p.caption || "")}"></figure>`;
}

// 하루치 사진을 줄로 묶는다: 세로 사진이 연달아 두 장이면 한 줄에 나란히(높이를 맞춰서), 혼자인 세로 사진은 좁게 가운데에, 가로 사진은 꽉 채워서.
function renderShots(base, items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    const ra = ratioOf(a), isPortrait = a.type !== "video" && ra && ra < 0.95;
    const b = items[i + 1];
    const rb = b ? ratioOf(b) : 0;
    if (isPortrait && b && b.type !== "video" && rb && rb < 0.95) {
      out.push(`<div class="pair rv"><div style="flex:${ra.toFixed(4)} 1 0">${figure(base, a)}</div><div style="flex:${rb.toFixed(4)} 1 0">${figure(base, b)}</div></div>`);
      i++;
    } else {
      out.push(`<div class="rv">${figure(base, a, isPortrait ? " solo-p" : "")}</div>`);
    }
  }
  return out.join("");
}

function groupByDay(photos) {
  const map = new Map();
  for (const p of photos) {
    const d = String(p.dt || "").slice(0, 10);
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(p);
  }
  const days = [...map.keys()].filter(Boolean).sort();
  const groups = days.map((d) => ({ day: d, items: map.get(d) }));
  if (map.has("")) groups.push({ day: "", items: map.get("") });
  return groups;
}

function topPlace(items) {
  const cnt = new Map();
  for (const p of items) if (p.place) cnt.set(p.place, (cnt.get(p.place) || 0) + 1);
  let best = "", n = 0;
  for (const [k, v] of cnt) if (v > n) { best = k; n = v; }
  return best;
}

export function renderGiftPage(manifest, origin) {
  const m = manifest;
  const photos = m.photos || [];
  const theme = m.theme === "white" ? "white" : "paper";
  const base = `/share/${m.share_id}/photo/`;
  const cover = (m.cover && photos.find((p) => p.key === m.cover && p.type !== "video")) || photos.find((p) => p.type !== "video") || null;
  const coverUrl = cover ? base + encodeURIComponent(cover.key) : "";
  const lines = (m.day_lines && typeof m.day_lines === "object") ? m.day_lines : {};
  const letterText = String(m.message || "").trim();
  const ogTitle = m.to_name ? `${m.to_name}님께 — ${m.title || "선물"}` : (m.title || "기억숲");
  const ogDesc = (letterText.split(/\n/)[0] || m.subtitle || "함께한 시간을 담았어요.").slice(0, 90);
  const abs = (p) => (origin ? origin + p : p);

  const groups = groupByDay(photos);
  const multi = groups.filter((g) => g.day).length > 1;
  const daysHtml = groups.map((g, gi) => {
    const label = g.day ? dayLabel(g.day) : "";
    const place = topPlace(g.items);
    const line = g.day ? String(lines[g.day] || "").trim() : "";
    const head = label || line ? `
    <div class="dayhead rv">
      ${multi && g.day ? `<span class="no">DAY ${groups.filter((x) => x.day).findIndex((x) => x.day === g.day) + 1}</span>` : ""}
      ${label ? `<span class="date">${esc(label)}</span>` : ""}
      ${place && label ? `<span class="place">${esc(place)}</span>` : ""}
    </div>
    ${line ? `<p class="line rv">${esc(line)}</p>` : ""}` : "";
    return `<section class="day">${head}<div class="shots">${renderShots(base, g.items)}</div></section>`;
  }).join("");

  const heroImg = cover ? `
  <div class="hero-img rv"><div class="frame"><img src="${esc(coverUrl)}"${typeof cover.fx === "number" && typeof cover.fy === "number" ? ` style="object-position:${pct(cover.fx)} ${pct(cover.fy)}"` : ""} alt=""></div></div>` : "";

  const letter = letterText ? `
  <section class="letter col rv">
    ${m.to_name ? `<div class="letter-to">${esc(m.to_name)}에게</div>` : ""}
    <div class="letter-body">${esc(letterText)}</div>
    ${m.from_name ? `<div class="letter-from">${esc(m.from_name)}가</div>` : ""}
  </section>` : "";

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${theme === "white" ? "#ffffff" : "#f6f2ea"}">
<title>${esc(ogTitle)} — 기억숲</title>
<meta name="description" content="${esc(ogDesc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="기억숲">
<meta property="og:title" content="${esc(ogTitle)}">
<meta property="og:description" content="${esc(ogDesc)}">
${coverUrl ? `<meta property="og:image" content="${esc(abs(coverUrl))}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<link rel="preload" as="font" type="font/woff2" crossorigin href="${FONT_BASE}share-sans.woff2">
<link rel="preload" as="font" type="font/woff2" crossorigin href="${FONT_BASE}share-serif-600.woff2">
<style>${CSS}</style>
</head>
<body class="theme-${theme}">
<header class="hero">
  ${heroImg}
  <div class="hero-text col rv">
    ${m.to_name ? `<div class="to">To. ${esc(m.to_name)}</div>` : ""}
    <h1 class="title">${esc(m.title || "함께한 시간")}</h1>
    ${m.subtitle ? `<div class="sub">${esc(m.subtitle)}</div>` : ""}
  </div>
</header>
${letter}
<main>${daysHtml}</main>
<div class="fin col rv">${m.from_name ? `<div class="from">From. ${esc(m.from_name)}</div>` : ""}</div>
<footer><a href="https://gieoksoop.com">기억숲 · LIFE ARCHIVE</a></footer>
<div class="zoom" id="zoom" aria-hidden="true"><img alt=""></div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}
