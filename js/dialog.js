// 공용 알림/확인 모달 -- window.alert()/window.confirm()을 대신한다.
// site.css의 .modal-overlay/.modal-box 스타일을 그대로 재사용해서, 페이지
// 톤에 맞는 작은 모달로 안내/확인을 띄운다. 필요할 때 지연 생성(lazy)한다.

let overlayEl = null;

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement('div');
  overlayEl.className = 'modal-overlay';
  overlayEl.innerHTML = `
    <div class="modal-box" style="max-width:380px;" role="dialog" aria-modal="true">
      <div class="dialog-icon" id="dlgIcon" style="display:none;"></div>
      <h3 id="dlgTitle"></h3>
      <p class="desc" id="dlgMessage" style="white-space:pre-line;"></p>
      <div class="summary-box" id="dlgSummary" style="display:none;"></div>
      <div class="modal-actions" id="dlgActions"></div>
    </div>`;
  document.body.appendChild(overlayEl);
  return overlayEl;
}

// rows: [{ k, v, strong? }] -- 결제 확인/영수증처럼 key-value 요약을 보여줄 때 쓴다.
// textContent만 사용해서 안전하게 렌더링한다.
export function renderSummaryRows(container, rows) {
  container.innerHTML = '';
  (rows || []).forEach((r) => {
    const row = document.createElement('div');
    row.className = 'row' + (r.strong ? ' total' : '');
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = r.k;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = r.v;
    row.appendChild(k);
    row.appendChild(v);
    container.appendChild(row);
  });
}

function openDialog({ title, message, icon, buttons, summaryRows }) {
  const overlay = ensureOverlay();
  const iconEl = overlay.querySelector('#dlgIcon');
  if (icon) {
    iconEl.style.display = 'flex';
    iconEl.className = 'dialog-icon ' + icon.type;
    iconEl.textContent = icon.glyph;
  } else {
    iconEl.style.display = 'none';
  }
  overlay.querySelector('#dlgTitle').textContent = title || '';
  overlay.querySelector('#dlgMessage').textContent = message || '';
  const summaryEl = overlay.querySelector('#dlgSummary');
  if (summaryRows && summaryRows.length) {
    renderSummaryRows(summaryEl, summaryRows);
    summaryEl.style.display = '';
  } else {
    summaryEl.style.display = 'none';
  }
  const actions = overlay.querySelector('#dlgActions');
  actions.innerHTML = '';

  return new Promise((resolve) => {
    function close(result) {
      overlay.classList.remove('open');
      overlay.removeEventListener('click', onOverlayClick);
      resolve(result);
    }
    function onOverlayClick(e) {
      // 바깥 영역 클릭은 취소(false)로 처리 -- 버튼이 하나뿐이면 그 값으로 처리.
      if (e.target === overlay) close(buttons.length === 1 ? buttons[0].value : false);
    }
    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = b.className || 'btn btn-primary btn-sm';
      btn.textContent = b.label;
      btn.addEventListener('click', () => close(b.value));
      actions.appendChild(btn);
    });
    overlay.addEventListener('click', onOverlayClick);
    overlay.classList.add('open');
    const firstBtn = actions.querySelector('button:last-child');
    if (firstBtn) firstBtn.focus();
  });
}

// window.alert() 대체. 확인 버튼 하나짜리 안내 모달.
export function showAlert(message, opts = {}) {
  return openDialog({
    title: opts.title || '알림',
    message,
    icon: opts.icon,
    summaryRows: opts.summaryRows,
    buttons: [{ label: opts.okText || '확인', className: 'btn btn-primary btn-sm', value: true }],
  });
}

// window.confirm() 대체. Promise<boolean> 반환.
export function showConfirm(message, opts = {}) {
  return openDialog({
    title: opts.title || '확인',
    message,
    icon: opts.icon,
    buttons: [
      { label: opts.cancelText || '취소', className: 'btn btn-outline btn-sm', value: false },
      {
        label: opts.okText || '확인',
        className: opts.danger ? 'btn btn-danger btn-sm' : 'btn btn-primary btn-sm',
        value: true,
      },
    ],
  });
}

// 결제 완료 등, 금액/플랜/다음 결제일 같은 요약 정보를 함께 보여주는 완료 안내.
// summaryRows: [{ k, v, strong? }]
export function showReceipt(message, summaryRows, opts = {}) {
  return openDialog({
    title: opts.title || '완료',
    message,
    icon: opts.icon || { type: 'success', glyph: '✓' },
    summaryRows,
    buttons: [{ label: opts.okText || '확인', className: 'btn btn-primary btn-sm', value: true }],
  });
}

// 결제/카드 처리 실패 시 "다시 시도" 버튼을 함께 보여주는 에러 모달.
// Promise<boolean> 반환 -- true면 재시도를 선택한 것.
export function showRetryableError(message, opts = {}) {
  return openDialog({
    title: opts.title || '오류',
    message,
    icon: opts.icon || { type: 'error', glyph: '!' },
    buttons: [
      { label: opts.closeText || '닫기', className: 'btn btn-outline btn-sm', value: false },
      { label: opts.retryText || '다시 시도', className: 'btn btn-primary btn-sm', value: true },
    ],
  });
}

// 버튼에 로딩 상태(스피너 + 비활성화)를 적용/해제한다. 텍스트는 그대로 두고
// 시각적으로만 숨긴 뒤 스피너를 보여줘서, 버튼 크기가 흔들리지 않게 한다.
export function setBtnLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.classList.add('btn-loading');
  } else {
    btn.disabled = false;
    btn.classList.remove('btn-loading');
  }
}

let pgDimEl = null;

function ensurePgDim() {
  if (pgDimEl) return pgDimEl;
  pgDimEl = document.createElement('div');
  pgDimEl.className = 'pg-dim-layer';
  document.body.appendChild(pgDimEl);
  return pgDimEl;
}

// PG(포트원) 결제창을 여는 동안 우리 페이지 배경을 어둡게 깐다. PG 위젯 자체에는
// 이 옵션이 없어서(KG이니시스는 무시), css의 .pg-dim-layer가 결제창보다 낮은
// z-index로 깔려 결제창은 선명하게, 배경만 어두워 보이게 한다.
export function setPgDim(show) {
  ensurePgDim().classList.toggle('show', show);
}
