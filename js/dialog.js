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
      <div class="modal-actions" id="dlgActions"></div>
    </div>`;
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function openDialog({ title, message, icon, buttons }) {
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
