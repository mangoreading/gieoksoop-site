// ============================================================
// 기억숲 — 언어 전환 (자리만 마련해둔 상태)
// 지금은 한국어 버전만 있고, 영문 버전은 한글판이 다 정리된 뒤
// 전체 페이지를 한 번에 번역해서 채울 예정입니다.
//
// 영문 번역을 넣을 때는:
//   1) 번역 대상 텍스트에 data-i18n="키" 속성을 달고
//   2) 이 파일에 다국어 딕셔너리(예: const dict = { ko: {...}, en: {...} })를 추가한 뒤
//   3) setLang() 안에서 dict[lang][key] 값으로 textContent를 갈아끼우면 됩니다.
// 지금 버튼은 자리만 잡아둔 것이라 "EN"을 눌러도 안내 메시지만 뜹니다.
// ============================================================

export function initLangToggle() {
  document.querySelectorAll('.lang-toggle').forEach((toggle) => {
    const enBtn = toggle.querySelector('[data-lang-btn="en"]');
    const koBtn = toggle.querySelector('[data-lang-btn="ko"]');
    const toast = toggle.querySelector('.lang-toast');

    if (enBtn) {
      enBtn.addEventListener('click', () => {
        if (!toast) return;
        toast.textContent = 'English version is coming soon!';
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2200);
      });
    }
    if (koBtn) {
      koBtn.addEventListener('click', () => {
        // 이미 한국어 버전이므로 아무 동작 없음(자리만 유지)
      });
    }
  });
}
