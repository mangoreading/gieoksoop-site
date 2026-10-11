// 공유 페이지 v2 (2026.10) — 받는 사람이 열어보는 화면.
//
// 목표: 설치·로그인 없이 카톡 링크 한 번으로 열리고, "선물"처럼 느껴지는 첫인상.
//   1) 표지(큰 사진 + 받는 사람/보낸 사람/제목) → 2) 편지(보낸 사람의 한마디) →
//   3) "처음부터 보기"(스토리 형식 전체화면 재생: 천천히 움직이는 사진 + 영상) → 4) 날짜별 갤러리.
// 모바일 우선. 사진이 돋보이도록 어두운 배경.
//
// manifest 필드(모두 선택, 예전 챕터 공유와 호환):
//   kind: "chapter" | "gift" | "year",  kicker, title, subtitle, description,
//   to_name, from_name, message,
//   photos: [{key, type: "photo"|"video", caption, dt, place, poster?, duration?}]
//     · 영상은 key가 mp4 파일, poster가 대표 이미지 파일명.

export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// <script> 안에 JSON을 안전하게 넣기(</script>, <!-- 등 방지)
function jsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(String.fromCharCode(0x2028)).join("\\u2028")
    .split(String.fromCharCode(0x2029)).join("\\u2029");
}

function kickerFor(m) {
  if (m.kicker) return m.kicker;
  if (m.kind === "gift") return "선물이 도착했어요";
  if (m.kind === "year") return "올해의 기억숲";
  return "인생챕터";
}

function coverItem(m) {
  const ps = m.photos || [];
  if (m.cover) {
    const c = ps.find((p) => p.key === m.cover && p.type !== "video");
    if (c) return c;
  }
  return ps.find((p) => p.type !== "video") || ps[0] || null;
}

// 얼굴(관심 지점) 위치(0~1) → CSS 위치. 값이 없으면 null.
function focusPct(p) {
  if (!p || typeof p.fx !== "number" || typeof p.fy !== "number") return null;
  const c = (v) => Math.max(0, Math.min(1, v));
  return `${(c(p.fx) * 100).toFixed(1)}% ${(c(p.fy) * 100).toFixed(1)}%`;
}

function coverKey(m) {
  const ci = coverItem(m);
  if (ci) return ci.type === "video" ? (ci.poster || ci.key) : ci.key;
  const ps = m.photos || [];
  for (const p of ps) {
    if (p.type !== "video") return p.key;
  }
  return ps.length && ps[0].poster ? ps[0].poster : (ps[0] ? ps[0].key : null);
}

// 폰트는 gieoksoop.com/fonts/share/ 에서 직접 내려준다(외부 CDN을 쓰지 않아 방문자 정보가 새지 않고, 항상 같은 모양).
// 한글 2,350자(KS X 1001)+영문·기호만 담은 작은 사본이라 모두 합쳐 약 1MB. 목록에 없는 드문 글자는 기본 명조/고딕으로 보인다.
const FONT_BASE = "/fonts/share/";
const CSS = String.raw`
@font-face{font-family:'Pretendard Variable';src:url('/fonts/share/share-sans.woff2') format('woff2-variations');font-weight:45 920;font-style:normal;font-display:swap;}
@font-face{font-family:'Noto Serif KR';src:url('/fonts/share/share-serif-400.woff2') format('woff2');font-weight:400;font-style:normal;font-display:swap;}
@font-face{font-family:'Noto Serif KR';src:url('/fonts/share/share-serif-600.woff2') format('woff2');font-weight:600 700;font-style:normal;font-display:swap;}
:root{
  --bg:#0d0f13;--bg-2:#14171d;--ink:#f4efe6;--ink-dim:rgba(244,239,230,.68);--ink-faint:rgba(244,239,230,.42);
  --gold:#d8b97a;--paper:#f6f0e4;--paper-ink:#2a241b;--line:rgba(244,239,230,.12);
  --sans:'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","맑은 고딕",Roboto,sans-serif;
  --serif:'Noto Serif KR','Nanum Myeongjo',Georgia,"바탕",Batang,serif;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html{background:var(--bg);}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);-webkit-font-smoothing:antialiased;}
img{display:block;}

/* 표지 */
.cover{position:relative;min-height:100vh;min-height:100svh;display:flex;align-items:flex-end;overflow:hidden;background:#000;}
.cover-bg{position:absolute;inset:-4%;background-size:cover;background-position:center 40%;animation:kb 26s ease-in-out infinite alternate;}
.cover-scrim{position:absolute;inset:0;background:
  linear-gradient(180deg,rgba(13,15,19,.55) 0%,rgba(13,15,19,0) 28%,rgba(13,15,19,.30) 55%,rgba(13,15,19,.94) 100%);}
.cover-inner{position:relative;width:100%;max-width:760px;margin:0 auto;padding:0 26px 54px;}
.kicker{font-size:12.5px;letter-spacing:.18em;color:var(--gold);font-weight:600;margin-bottom:18px;}
.to{font-family:var(--serif);font-size:17px;color:var(--ink-dim);margin-bottom:10px;}
.title{font-family:var(--serif);font-weight:600;font-size:clamp(30px,8.2vw,52px);line-height:1.22;letter-spacing:-.012em;margin:0 0 14px;text-shadow:0 2px 24px rgba(0,0,0,.45);word-break:keep-all;}
.sub{font-size:14.5px;color:var(--ink-dim);margin-bottom:6px;}
.from{font-family:var(--serif);font-size:15px;color:var(--ink-dim);margin-top:18px;}
.open-btn{margin-top:30px;display:inline-flex;align-items:center;gap:10px;border:1px solid rgba(244,239,230,.55);background:rgba(13,15,19,.35);color:var(--ink);
  font:600 15px var(--sans);padding:13px 24px;border-radius:99px;cursor:pointer;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}
.open-btn:hover{background:rgba(244,239,230,.14);}
.scroll-hint{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);width:1px;height:30px;background:linear-gradient(var(--ink-faint),transparent);animation:hint 2.2s ease-in-out infinite;}
@keyframes kb{from{transform:scale(1.02) translate(0,0);}to{transform:scale(1.13) translate(-1.2%,-1%);}}
@keyframes hint{0%,100%{opacity:.2;transform:translateX(-50%) translateY(0);}50%{opacity:.8;transform:translateX(-50%) translateY(6px);}}

/* 편지 */
.letter-wrap{padding:64px 22px 30px;background:radial-gradient(ellipse at 50% 0%,#1b1f27 0%,var(--bg) 70%);}
.letter{max-width:560px;margin:0 auto;background:var(--paper);color:var(--paper-ink);border-radius:4px;padding:38px 32px 34px;
  box-shadow:0 30px 70px rgba(0,0,0,.55),0 2px 0 rgba(255,255,255,.4) inset;position:relative;}
.letter::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,transparent,#c9a75f,transparent);opacity:.7;}
.letter-to{font-family:var(--serif);font-size:16px;margin-bottom:18px;color:#6b5d44;}
.letter-body{font-family:var(--serif);font-size:16.5px;line-height:2;white-space:pre-wrap;word-break:keep-all;}
.letter-from{font-family:var(--serif);text-align:right;margin-top:26px;font-size:15.5px;color:#6b5d44;}

/* 재생 시작 */
.play-row{display:flex;flex-direction:column;align-items:center;gap:8px;padding:46px 22px 18px;}
.play-btn{display:inline-flex;align-items:center;gap:12px;border:0;background:var(--ink);color:#15171c;font:700 16px var(--sans);padding:16px 30px;border-radius:99px;cursor:pointer;box-shadow:0 10px 34px rgba(0,0,0,.45);}
.play-btn:active{transform:scale(.98);}
.play-btn svg{width:16px;height:16px;}
.play-meta{font-size:13px;color:var(--ink-faint);}

/* 갤러리 */
.gallery{max-width:1040px;margin:0 auto;padding:30px 12px 70px;}
.day{margin-top:34px;}
.day-head{display:flex;align-items:baseline;gap:12px;padding:0 4px 12px;}
.day-no{font-family:var(--serif);font-size:20px;font-weight:600;color:var(--gold);}
.day-date{font-size:13px;color:var(--ink-faint);}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;}
.tile{position:relative;overflow:hidden;border-radius:6px;background:var(--bg-2);cursor:pointer;aspect-ratio:4/5;}
.tile.feature{grid-column:1/-1;aspect-ratio:16/10;}
.tile img{width:100%;height:100%;object-fit:cover;transition:transform .6s cubic-bezier(.2,.7,.2,1);}
.tile:hover img{transform:scale(1.04);}
.tile .vbadge{position:absolute;left:8px;bottom:8px;display:flex;align-items:center;gap:5px;background:rgba(13,15,19,.62);color:#fff;font-size:11.5px;padding:4px 9px 4px 7px;border-radius:99px;backdrop-filter:blur(4px);}
.tile .vbadge svg{width:10px;height:10px;}
.tile .tcap{position:absolute;left:0;right:0;bottom:0;padding:26px 12px 10px;font-size:12.5px;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.6));opacity:0;transition:opacity .25s;}
.tile:hover .tcap{opacity:1;}
@media (min-width:700px){
  .grid{grid-template-columns:repeat(3,1fr);grid-auto-rows:clamp(200px,24vw,300px);grid-auto-flow:dense;gap:8px;}
  .tile,.tile.feature{aspect-ratio:auto;}
  .tile.feature{grid-column:span 2;grid-row:span 2;}
}
footer{padding:26px 20px 56px;text-align:center;color:var(--ink-faint);font-size:12.5px;line-height:1.8;}
footer a{color:var(--gold);text-decoration:none;}

/* 전체화면 재생(스토리 형식) */
.ov{position:fixed;inset:0;z-index:100;background:#000;display:none;touch-action:pan-y;user-select:none;-webkit-user-select:none;}
.ov.open{display:block;}
.stage{position:absolute;inset:0;overflow:hidden;}
.layer{position:absolute;inset:0;opacity:0;}
.layer .bg{position:absolute;inset:-6%;background-size:cover;background-position:center;filter:blur(34px) brightness(.55) saturate(1.1);transform:scale(1.1);}
.layer img.fg,.layer video.fg{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;will-change:transform;}
.bars{position:absolute;left:12px;right:12px;top:calc(env(safe-area-inset-top,0px) + 10px);display:flex;gap:3px;z-index:5;pointer-events:none;}
.bars i{flex:1;height:2.5px;background:rgba(255,255,255,.28);border-radius:2px;overflow:hidden;}
.bars i b{display:block;height:100%;width:0;background:#fff;}
.bars.one i{height:2.5px;}
.ov-top{position:absolute;left:0;right:0;top:calc(env(safe-area-inset-top,0px) + 20px);display:flex;justify-content:flex-end;gap:8px;padding:0 12px;z-index:6;}
.ov-btn{width:40px;height:40px;border:0;border-radius:50%;background:rgba(0,0,0,.38);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}
.ov-btn svg{width:17px;height:17px;}
.ov-btn.snd{display:none;}
.ov-btn.snd.show{display:flex;}
.ov-cap{position:absolute;left:0;right:0;bottom:0;padding:70px 22px calc(env(safe-area-inset-bottom,0px) + 26px);z-index:5;pointer-events:none;
  background:linear-gradient(transparent,rgba(0,0,0,.62));color:#fff;text-shadow:0 1px 10px rgba(0,0,0,.6);}
.ov-cap .c-day{font-family:var(--serif);font-size:22px;font-weight:600;}
.ov-cap .c-meta{font-size:13px;opacity:.82;margin-top:3px;}
.ov-cap .c-text{font-family:var(--serif);font-size:17px;line-height:1.7;margin-top:10px;max-width:560px;}
.zone{position:absolute;top:60px;bottom:90px;z-index:4;}
.zone.l{left:0;width:34%;}.zone.r{right:0;width:34%;}.zone.c{left:34%;right:34%;}
.nav{position:absolute;top:50%;transform:translateY(-50%);z-index:6;display:none;}
.nav.l{left:16px;}.nav.r{right:16px;}
@media (hover:hover) and (min-width:800px){.nav{display:flex;}}
.paused-badge{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:70px;height:70px;border-radius:50%;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:6;pointer-events:none;}
.paused-badge svg{width:26px;height:26px;fill:#fff;}
.ov.paused .paused-badge{display:flex;}
.end{position:absolute;inset:0;z-index:7;display:none;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:rgba(0,0,0,.72);text-align:center;padding:30px;}
.end.show{display:flex;}
.end .t{font-family:var(--serif);font-size:24px;}
.end .row{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}
.end button{border:1px solid rgba(255,255,255,.5);background:transparent;color:#fff;font:600 14px var(--sans);padding:11px 20px;border-radius:99px;cursor:pointer;}
.end button.primary{background:#fff;color:#111;border-color:#fff;}
@media (prefers-reduced-motion:reduce){.cover-bg{animation:none;}.scroll-hint{animation:none;}}
`;

// 받는 사람 브라우저에서 도는 코드. 템플릿 리터럴/백틱은 쓰지 않는다(위 문자열 안에 들어가므로).
const CLIENT_JS = String.raw`
(function(){
  var D = window.__SHARE__;
  var items = D.items, N = items.length;
  var ov = document.getElementById('ov'), stage = document.getElementById('stage');
  var barsEl = document.getElementById('bars'), capEl = document.getElementById('ovcap'), endEl = document.getElementById('end');
  var reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e){}
  var WD = ['일','월','화','수','목','금','토'];
  function fmtDate(iso){
    if(!iso) return '';
    var d = new Date(iso); if(isNaN(d.getTime())) return '';
    return (d.getMonth()+1) + '월 ' + d.getDate() + '일 (' + WD[d.getDay()] + ')';
  }
  function url(k){ return '/share/' + D.id + '/photo/' + encodeURIComponent(k); }
  function still(it){ return url(it.type === 'video' ? (it.poster || it.key) : it.key); }

  // ---- 두 겹으로 겹쳐 넘기는 장면 (사진은 천천히 움직이며 서로 녹아든다) ----
  var MOTIONS = [
    function(f){ return ['scale(1)','scale(1.10)',f]; },
    function(f){ return ['scale(1.11) translate(-1.2%,0)','scale(1.11) translate(1.2%,0)','50% 50%']; },
    function(f){ return ['scale(1.11)','scale(1)',f]; },
    function(f){ return ['scale(1.11) translate(1.2%,0)','scale(1.11) translate(-1.2%,0)','50% 50%']; },
    function(f){ return ['scale(1.02) translate(0,1.4%)','scale(1.10) translate(0,-1%)',f]; }
  ];
  function mkLayer(){
    var el = document.createElement('div'); el.className = 'layer';
    el.innerHTML = '<div class="bg"></div><img class="fg" alt="" draggable="false"><video class="fg" playsinline webkit-playsinline preload="auto" style="display:none"></video>';
    stage.appendChild(el);
    return {el: el, bg: el.querySelector('.bg'), img: el.querySelector('img.fg'), vid: el.querySelector('video.fg'), anim: null};
  }
  var L = [mkLayer(), mkLayer()], front = -1;
  var idx = -1, paused = false, timer = null, startedAt = 0, remain = 0, curDur = 0, token = 0, muted = false;
  var FADE = 1000, HOLD = 4300, VMAX = 30000;

  function buildBars(){
    barsEl.innerHTML = '';
    barsEl.className = 'bars' + (N > 40 ? ' one' : '');
    var n = N > 40 ? 1 : N;
    for(var i = 0; i < n; i++){ var s = document.createElement('i'); s.innerHTML = '<b></b>'; barsEl.appendChild(s); }
  }
  function setBars(i, frac){
    var segs = barsEl.children;
    if(segs.length === 1){ segs[0].firstChild.style.width = (((i + frac) / N) * 100) + '%'; return; }
    for(var k = 0; k < segs.length; k++){
      segs[k].firstChild.style.width = (k < i ? 100 : k === i ? Math.round(frac * 100) : 0) + '%';
    }
  }
  var dayOf = {};
  (function(){
    var days = [];
    items.forEach(function(it){ var d = (it.dt || '').slice(0, 10); if(d && days.indexOf(d) < 0) days.push(d); });
    days.sort(); days.forEach(function(d, i){ dayOf[d] = i + 1; });
    D.dayCount = days.length;
  })();
  function updSound(it){
    var b = document.getElementById('ovSound');
    b.classList.toggle('show', !!it && it.type === 'video');
    b.classList.toggle('muted', muted);
    b.querySelector('.on').style.display = muted ? 'none' : '';
    b.querySelector('.off').style.display = muted ? '' : 'none';
  }
  function setCap(it){
    var d = (it.dt || '').slice(0, 10), parts = [];
    var h = '';
    if(D.dayCount > 1 && dayOf[d]) h += '<div class="c-day">' + dayOf[d] + '일차</div>';
    var dd = fmtDate(it.dt); if(dd) parts.push(dd);
    if(it.place) parts.push(it.place);
    if(parts.length) h += '<div class="c-meta"></div>';
    if(it.caption) h += '<div class="c-text"></div>';
    capEl.innerHTML = h;
    var m = capEl.querySelector('.c-meta'); if(m) m.textContent = parts.join(' · ');
    var t = capEl.querySelector('.c-text'); if(t) t.textContent = it.caption;
  }

  function clearTimer(){ if(timer){ clearTimeout(timer); timer = null; } }
  function schedule(ms){
    clearTimer(); remain = ms; startedAt = Date.now();
    if(paused) return;
    timer = setTimeout(function(){ next(true); }, ms);
  }
  var raf = 0;
  function tickBar(){
    cancelAnimationFrame(raf);
    (function loop(){
      if(!ov.classList.contains('open') || idx < 0) return;
      var it = items[idx], frac = 0;
      if(it.type === 'video' && L[front].vid.duration){
        var v = L[front].vid; frac = Math.min(1, v.currentTime / Math.min(v.duration, VMAX / 1000));
      } else if(curDur){
        var elapsed = paused ? (curDur - remain) : (curDur - remain + (Date.now() - startedAt));
        frac = Math.max(0, Math.min(1, elapsed / curDur));
      }
      setBars(idx, frac);
      raf = requestAnimationFrame(loop);
    })();
  }

  var dims = {};
  function loadDims(it, cb){
    var u = still(it);
    if(dims[u]){ cb(dims[u]); return; }
    var im = new Image(), done = false;
    function fin(){ if(done) return; done = true; if(im.naturalWidth) dims[u] = [im.naturalWidth, im.naturalHeight]; cb(dims[u] || null); }
    im.onload = fin; im.onerror = fin; im.src = u;
    setTimeout(fin, 1800);
  }
  function preload(i){
    if(i < 0 || i >= N) return;
    loadDims(items[i], function(){});
  }
  // 움직임의 중심: 사진 속 얼굴 위치(없으면 가운데 위쪽). contain으로 여백이 생겨도 실제 사진 위의 점을 가리키도록 계산한다.
  function originFor(it){
    var d = dims[still(it)];
    if(typeof it.fx !== 'number' || typeof it.fy !== 'number') return '50% 42%';
    if(!d) return (it.fx * 100).toFixed(1) + '% ' + (it.fy * 100).toFixed(1) + '%';
    var W = stage.clientWidth || 1, H = stage.clientHeight || 1, sc = Math.min(W / d[0], H / d[1]), dw = d[0] * sc, dh = d[1] * sc;
    return Math.round((W - dw) / 2 + it.fx * dw) + 'px ' + Math.round((H - dh) / 2 + it.fy * dh) + 'px';
  }

  function show(i, instant){
    if(i < 0 || i >= N) return;
    endEl.classList.remove('show');
    var my = ++token;
    var it = items[i];
    var bi = front < 0 ? 0 : 1 - front, B = L[bi], F = front >= 0 ? L[front] : null;
    function go(){
      if(my !== token) return;
      if(!dims[still(it)] && !go.waited){ go.waited = true; loadDims(it, function(){ go(); }); return; }
      if(B.anim){ try{ B.anim.cancel(); }catch(e){} B.anim = null; }
      var isV = it.type === 'video';
      B.vid.pause(); B.vid.onended = null;
      B.bg.style.backgroundImage = 'url("' + still(it) + '")';
      B.img.style.display = isV ? 'none' : '';
      B.vid.style.display = isV ? '' : 'none';
      var total = isV ? VMAX : HOLD + FADE * 2;
      if(isV){
        B.vid.src = url(it.key); B.vid.poster = still(it); B.vid.muted = muted; B.vid.currentTime = 0;
      } else {
        B.img.src = url(it.key);
        var mv = MOTIONS[i % MOTIONS.length](originFor(it));
        B.img.style.transformOrigin = mv[2]; B.img.style.transform = mv[0];
        if(!reduced){ B.anim = B.img.animate([{transform: mv[0]}, {transform: mv[1]}], {duration: total, easing: 'cubic-bezier(.32,.04,.28,1)', fill: 'forwards'}); }
      }
      B.el.style.transition = 'none'; B.el.style.opacity = '0'; B.el.style.zIndex = '2';
      if(F) F.el.style.zIndex = '1';
      void B.el.offsetWidth;
      B.el.style.transition = (instant || front < 0) ? 'none' : 'opacity ' + FADE + 'ms cubic-bezier(.4,0,.2,1)';
      B.el.style.opacity = '1';
      front = bi; idx = i; setCap(it); updSound(it); preload(i + 1);
      if(F){
        setTimeout(function(){
          if(front === bi && F.vid){ F.vid.pause(); }
          if(front === bi){ F.el.style.transition = 'none'; F.el.style.opacity = '0'; F.el.style.zIndex = '0'; if(F.anim){ try{F.anim.cancel();}catch(e){} F.anim = null; } }
        }, (instant ? 0 : FADE) + 80);
      }
      if(isV){
        curDur = 0; clearTimer();
        var playIt = function(){
          var pr = B.vid.play();
          if(pr && pr.catch){ pr.catch(function(){ B.vid.muted = true; muted = true; updSound(it); var p2 = B.vid.play(); if(p2 && p2.catch) p2.catch(function(){}); }); }
        };
        if(!paused) playIt();
        B.vid.onended = function(){ if(my === token) next(true); };
        // 너무 긴 영상은 VMAX에서 자른다
        schedule(VMAX); curDur = VMAX;
        B.vid.onloadedmetadata = function(){ var d = Math.min(B.vid.duration * 1000, VMAX); if(my === token && isFinite(d)){ curDur = d; schedule(d + 400); } };
      } else {
        curDur = HOLD + FADE; schedule(curDur);
      }
      tickBar();
    }
    go();
  }
  function next(auto){
    if(idx + 1 >= N){
      if(auto){ finish(); } else { show(0); }
      return;
    }
    show(idx + 1);
  }
  function prev(){ if(idx > 0) show(idx - 1); else show(0, true); }
  function finish(){
    clearTimer(); cancelAnimationFrame(raf); setBars(N, 0);
    if(front >= 0){ L[front].vid.pause(); }
    endEl.classList.add('show');
  }
  function setPaused(p){
    if(p === paused) return;
    paused = p; ov.classList.toggle('paused', p);
    var it = items[idx]; if(!it) return;
    if(p){
      remain = Math.max(200, remain - (Date.now() - startedAt)); clearTimer();
      if(L[front].vid) L[front].vid.pause();
      var a = L[front].anim; if(a) a.pause();
    } else {
      startedAt = Date.now();
      timer = setTimeout(function(){ next(true); }, remain);
      if(it.type === 'video'){ var pr = L[front].vid.play(); if(pr && pr.catch) pr.catch(function(){}); }
      var b = L[front].anim; if(b) b.play();
    }
  }
  function openAt(i, autoplay){
    buildBars();
    ov.classList.add('open'); document.body.style.overflow = 'hidden';
    paused = false; ov.classList.remove('paused');
    front = -1; token++;
    L.forEach(function(l){ l.el.style.opacity = '0'; l.el.style.zIndex = '0'; l.vid.pause(); });
    show(i, true);
    if(!autoplay) setPaused(true);
  }
  function closeOv(){
    ov.classList.remove('open'); document.body.style.overflow = '';
    clearTimer(); cancelAnimationFrame(raf); token++;
    L.forEach(function(l){ l.vid.pause(); l.vid.removeAttribute('src'); l.img.removeAttribute('src'); });
    front = -1; idx = -1; endEl.classList.remove('show');
  }

  // 이벤트
  document.getElementById('playBtn').onclick = function(){ openAt(0, true); };
  var openBtn = document.getElementById('openBtn');
  if(openBtn) openBtn.onclick = function(){
    var t = document.getElementById(D.hasLetter ? 'letter' : 'playRow');
    if(t) t.scrollIntoView({behavior: 'smooth', block: 'start'});
  };
  document.getElementById('grid-root').addEventListener('click', function(e){
    var t = e.target.closest('.tile'); if(!t) return;
    openAt(parseInt(t.getAttribute('data-i'), 10) || 0, false);
  });
  document.getElementById('ovClose').onclick = closeOv;
  document.getElementById('ovSound').onclick = function(){
    muted = !muted; if(front >= 0){ L[front].vid.muted = muted; } updSound(items[idx]);
  };
  document.getElementById('zl').onclick = function(){ prev(); };
  document.getElementById('zr').onclick = function(){ next(false); };
  document.getElementById('zc').onclick = function(){ setPaused(!paused); };
  document.getElementById('navL').onclick = prev;
  document.getElementById('navR').onclick = function(){ next(false); };
  document.getElementById('endAgain').onclick = function(){ openAt(0, true); };
  document.getElementById('endClose').onclick = closeOv;
  document.addEventListener('keydown', function(e){
    if(!ov.classList.contains('open')) return;
    if(e.key === 'Escape') closeOv();
    else if(e.key === 'ArrowLeft') prev();
    else if(e.key === 'ArrowRight') next(false);
    else if(e.key === ' '){ e.preventDefault(); setPaused(!paused); }
  });
  // 좌우로 쓸어 넘기기
  var sx = null, sy = null;
  ov.addEventListener('touchstart', function(e){ if(e.touches.length === 1){ sx = e.touches[0].clientX; sy = e.touches[0].clientY; } }, {passive: true});
  ov.addEventListener('touchend', function(e){
    if(sx == null) return;
    var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
    if(Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5){ if(dx < 0) next(false); else prev(); e.preventDefault(); }
    else if(dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5){ closeOv(); }
  }, {passive: false});
  document.addEventListener('visibilitychange', function(){ if(document.hidden && ov.classList.contains('open')) setPaused(true); });
})();
`;

// 사진을 칸에 꽉 채워(cover) 보여줄 때 얼굴이 가장자리에 걸리거나 잘리지 않게, 얼굴이 칸의 (tx, ty) 지점에 오도록 위치를 계산한다.
// 사진이 칸보다 크게 잘리는 방향에서만 움직일 수 있고, 빈 곳이 드러나지 않도록 0~1로 제한한다.
const FOCUS_JS = String.raw`
(function(){
  function clamp(v){ return Math.max(0, Math.min(1, v)); }
  function pos(cw, ch, iw, ih, fx, fy, tx, ty){
    var s = Math.max(cw / iw, ch / ih), dw = iw * s, dh = ih * s;
    var X = dw > cw + 1 ? clamp((fx * dw - tx * cw) / (dw - cw)) : 0.5;
    var Y = dh > ch + 1 ? clamp((fy * dh - ty * ch) / (dh - ch)) : 0.5;
    return (X * 100).toFixed(1) + '% ' + (Y * 100).toFixed(1) + '%';
  }
  var jobs = [];
  function run(){ jobs.forEach(function(j){ j(); }); }
  document.querySelectorAll('.tile img[data-fx]').forEach(function(img){
    function go(){
      if(!img.naturalWidth) return;
      var box = img.parentNode; if(!box.clientWidth) return;
      img.style.objectPosition = pos(box.clientWidth, box.clientHeight, img.naturalWidth, img.naturalHeight, +img.dataset.fx, +img.dataset.fy, 0.5, 0.4);
    }
    jobs.push(go);
    if(img.complete) go(); else img.addEventListener('load', go);
  });
  var cv = document.querySelector('.cover-bg[data-fx]');
  if(cv){
    var im = new Image();
    function goc(){
      if(!im.naturalWidth) return;
      // 제목·버튼이 있는 아래쪽을 피해 얼굴이 위쪽(약 34%)에 오게 한다
      cv.style.backgroundPosition = pos(cv.offsetWidth, cv.offsetHeight, im.naturalWidth, im.naturalHeight, +cv.dataset.fx, +cv.dataset.fy, 0.5, 0.34);
    }
    jobs.push(goc); im.onload = goc; im.src = cv.dataset.src;
  }
  var t = null;
  window.addEventListener('resize', function(){ clearTimeout(t); t = setTimeout(run, 150); });
})();
`;

function ico(name) {
  const m = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path class="on" d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/><path class="off" d="M17 9l5 6M22 9l-5 6"/></svg>',
  };
  return m[name] || "";
}

function dayLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  const wd = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd})`;
}

function fmtDur(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return "";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function renderGrid(m) {
  const photos = m.photos || [];
  const base = `/share/${m.share_id}/photo/`;
  // 날짜별로 묶는다(날짜가 없으면 한 덩어리)
  const groups = [];
  const idxByDay = new Map();
  photos.forEach((p, i) => {
    const d = String(p.dt || "").slice(0, 10) || "";
    if (!idxByDay.has(d)) { idxByDay.set(d, groups.length); groups.push({ day: d, items: [] }); }
    groups[idxByDay.get(d)].items.push({ p, i });
  });
  const dated = groups.filter((g) => g.day).sort((a, b) => a.day.localeCompare(b.day));
  const undated = groups.filter((g) => !g.day);
  const ordered = dated.concat(undated);
  const multi = dated.length > 1;
  return ordered.map((g, gi) => {
    const head = multi && g.day
      ? `<div class="day-head"><span class="day-no">${dated.findIndex((x) => x.day === g.day) + 1}일차</span><span class="day-date">${escapeHtml(dayLabel(g.day))}</span></div>`
      : "";
    const tiles = g.items.map(({ p, i }, k) => {
      const isV = p.type === "video";
      const src = base + encodeURIComponent(isV ? (p.poster || p.key) : p.key);
      const feat = k === 0 && g.items.length > 2 ? " feature" : "";
      const badge = isV
        ? `<span class="vbadge">${ico("play")}${escapeHtml(fmtDur(p.duration))}</span>` : "";
      const fp = !isV ? focusPct(p) : null;
      return `<div class="tile${feat}" data-i="${i}"><img src="${src}"${fp ? ` style="object-position:${fp}" data-fx="${p.fx}" data-fy="${p.fy}"` : ""} loading="${gi === 0 && k < 2 ? "eager" : "lazy"}" alt="${escapeHtml(p.caption || "")}">${badge}${p.caption ? `<div class="tcap">${escapeHtml(p.caption)}</div>` : ""}</div>`;
    }).join("");
    return `<section class="day">${head}<div class="grid">${tiles}</div></section>`;
  }).join("");
}

export function renderSharePage(manifest, origin) {
  const m = manifest;
  const photos = m.photos || [];
  const ck = coverKey(m);
  const cvFocus = focusPct(coverItem(m)) || "center 40%";
  const coverUrl = ck ? `/share/${m.share_id}/photo/${encodeURIComponent(ck)}` : "";
  const kicker = kickerFor(m);
  const nPhotos = photos.filter((p) => p.type !== "video").length;
  const nVideos = photos.length - nPhotos;
  const countText = [nPhotos ? `사진 ${nPhotos}장` : "", nVideos ? `영상 ${nVideos}개` : ""].filter(Boolean).join(" · ");
  const hasLetter = !!(m.message && String(m.message).trim());
  const firstLine = hasLetter ? String(m.message).trim().split(/\n/)[0].slice(0, 90) : "";
  const ogDesc = firstLine || m.description || m.subtitle || "기억숲으로 만든 이야기예요.";
  const ogTitle = m.kind === "gift" && m.to_name
    ? `${m.to_name}님께 — ${m.title || "선물"}` : (m.title || "기억숲");
  const abs = (p) => (origin ? origin + p : p);

  const data = {
    id: m.share_id,
    hasLetter,
    items: photos.map((p) => ({
      key: p.key, type: p.type === "video" ? "video" : "photo", poster: p.poster || "",
      caption: p.caption || "", dt: p.dt || "", place: p.place || "", duration: p.duration || 0,
      fx: typeof p.fx === "number" ? p.fx : null, fy: typeof p.fy === "number" ? p.fy : null,
    })),
  };

  const toLine = m.to_name ? `<div class="to">To. ${escapeHtml(m.to_name)}</div>` : "";
  const fromLine = m.from_name ? `<div class="from">From. ${escapeHtml(m.from_name)}</div>` : "";
  const subs = [m.subtitle, countText].filter(Boolean).map((s) => `<div class="sub">${escapeHtml(s)}</div>`).join("");

  const letter = hasLetter ? `
  <div class="letter-wrap" id="letter">
    <div class="letter">
      ${m.to_name ? `<div class="letter-to">${escapeHtml(m.to_name)}에게</div>` : ""}
      <div class="letter-body">${escapeHtml(String(m.message).trim())}</div>
      ${m.from_name ? `<div class="letter-from">${escapeHtml(m.from_name)}가</div>` : ""}
    </div>
  </div>` : "";

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0d0f13">
<title>${escapeHtml(ogTitle)} — 기억숲</title>
<meta name="description" content="${escapeHtml(ogDesc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="기억숲">
<meta property="og:title" content="${escapeHtml(ogTitle)}">
<meta property="og:description" content="${escapeHtml(ogDesc)}">
${coverUrl ? `<meta property="og:image" content="${escapeHtml(abs(coverUrl))}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<link rel="preload" as="font" type="font/woff2" crossorigin href="${FONT_BASE}share-sans.woff2">
<link rel="preload" as="font" type="font/woff2" crossorigin href="${FONT_BASE}share-serif-600.woff2">
<style>${CSS}</style>
</head>
<body>
<header class="cover">
  <div class="cover-bg"${coverUrl ? ` style="background-image:url('${escapeHtml(coverUrl)}');background-position:${cvFocus}"${typeof (coverItem(m) || {}).fx === "number" ? ` data-fx="${coverItem(m).fx}" data-fy="${coverItem(m).fy}" data-src="${escapeHtml(coverUrl)}"` : ""}` : ""}></div>
  <div class="cover-scrim"></div>
  <div class="cover-inner">
    <div class="kicker">${escapeHtml(kicker)}</div>
    ${toLine}
    <h1 class="title">${escapeHtml(m.title || "기억숲")}</h1>
    ${subs}
    ${fromLine}
    <button class="open-btn" id="openBtn" type="button">${hasLetter ? "편지 열어보기" : "열어보기"}</button>
  </div>
  <div class="scroll-hint"></div>
</header>
${letter}
<div class="play-row" id="playRow">
  <button class="play-btn" id="playBtn" type="button">${ico("play")}처음부터 보기</button>
  <div class="play-meta">${escapeHtml(countText)}</div>
</div>
<main class="gallery" id="grid-root">${renderGrid(m)}</main>
<footer>
  ${m.from_name ? `${escapeHtml(m.from_name)}가 기억숲으로 만들어 보냈어요<br>` : ""}
  <a href="https://gieoksoop.com">기억숲 · LIFE ARCHIVE</a>
</footer>

<div class="ov" id="ov" role="dialog" aria-modal="true">
  <div class="stage" id="stage"></div>
  <div class="bars" id="bars"></div>
  <div class="ov-top"><button class="ov-btn snd" id="ovSound" type="button" aria-label="소리">${ico("sound")}</button><button class="ov-btn" id="ovClose" type="button" aria-label="닫기">${ico("close")}</button></div>
  <div class="zone l" id="zl"></div><div class="zone c" id="zc"></div><div class="zone r" id="zr"></div>
  <button class="ov-btn nav l" id="navL" type="button" aria-label="이전">${ico("prev")}</button>
  <button class="ov-btn nav r" id="navR" type="button" aria-label="다음">${ico("next")}</button>
  <div class="paused-badge">${ico("play")}</div>
  <div class="ov-cap" id="ovcap"></div>
  <div class="end" id="end">
    <div class="t">${m.kind === "gift" ? "함께한 시간이에요" : "여기까지예요"}</div>
    <div class="row"><button class="primary" id="endAgain" type="button">다시 보기</button><button id="endClose" type="button">닫기</button></div>
  </div>
</div>

<script>window.__SHARE__=${jsonForScript(data)};</script>
<script>${CLIENT_JS}</script>
<script>${FOCUS_JS}</script>
</body>
</html>`;
}
