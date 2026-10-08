// 기억숲 홈페이지 방문 집계 비콘 (2026.10.08)
// - 쿠키·로컬 저장소에 방문자 식별자를 저장하지 않는다. 보내는 값은 "어느 페이지인지(경로),
//   어디서 왔는지(리퍼러·utm_source), 이번 방문의 첫 페이지인지" 뿐이다.
// - 서버(gieoksoop-pilot /stats/hit)는 IP·UA로 하루 단위로만 바뀌는 익명 해시를 만들어
//   "하루 방문자 수"를 세고, 원본 IP는 저장하지 않는다. 자세한 내용은 개인정보처리방침 참고.
// - 브라우저의 추적 거부(DNT / Global Privacy Control)를 존중한다.
// - 운영자 본인 방문을 빼고 싶으면 이 브라우저에서 주소 끝에 ?nostats=1 을 붙여 한 번 접속
//   (다시 집계하려면 ?nostats=0).
(function () {
  try {
    var host = location.hostname;
    if (host !== 'gieoksoop.com' && host !== 'www.gieoksoop.com') return;

    var ls = null;
    try { ls = window.localStorage; } catch (e) {}
    var q = new URLSearchParams(location.search);
    if (ls && q.get('nostats') === '1') ls.setItem('gs_nostats', '1');
    if (ls && q.get('nostats') === '0') ls.removeItem('gs_nostats');
    if (ls && ls.getItem('gs_nostats') === '1') return;

    if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;

    var entry = 0;
    try {
      if (!sessionStorage.getItem('gs_s')) { sessionStorage.setItem('gs_s', '1'); entry = 1; }
    } catch (e) {}

    var body = JSON.stringify({
      p: location.pathname,
      r: document.referrer || '',
      u: q.get('utm_source') || '',
      e: entry
    });
    var url = 'https://gieoksoop-pilot.mangoreading-it.workers.dev/stats/hit';
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    } else {
      fetch(url, { method: 'POST', body: body, headers: { 'content-type': 'text/plain' }, keepalive: true });
    }
  } catch (e) { /* 집계 실패는 사이트 동작에 영향을 주지 않는다 */ }
})();
