/**
 * modals.js
 *
 * Reusable modal helpers (confirm dialog) and the About modal.
 *
 * Exposes:
 *   createModalHelpers()
 *   → { showConfirm, showAbout }
 */
function createModalHelpers() {
  const modalOverlay = document.createElement('div');
  modalOverlay.style.cssText = [
    'position:fixed','left:0','top:0','width:100%','height:100%','display:none',
    'align-items:center','justify-content:center','z-index:2147483650','background:rgba(0,0,0,0.4)'
  ].join(';');

  const modal = document.createElement('div');
  modal.style.cssText = [
    'min-width:260px','max-width:90%','background:#1b1b1b','color:#eee','padding:14px',
    'border-radius:8px','box-shadow:0 6px 20px rgba(0,0,0,0.6)','font:13px monospace'
  ].join(';');

  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-weight:700;margin-bottom:8px;color:#53d9ff';
  titleEl.textContent = 'DIANNE';
  const msgEl = document.createElement('div');
  msgEl.style.cssText = 'margin-bottom:12px;white-space:normal;';

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.textContent = 'OK';
  okBtn.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid #333;background:#1f8cff;color:#fff;cursor:pointer';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid #333;background:#333;color:#ddd;cursor:pointer';

  buttons.appendChild(cancelBtn);
  buttons.appendChild(okBtn);
  modal.appendChild(titleEl);
  modal.appendChild(msgEl);
  modal.appendChild(buttons);
  modalOverlay.appendChild(modal);
  document.body.appendChild(modalOverlay);

  let currentClean = null;
  let currentResolve = null;

  window.__iv_modal_visible = false;
  window.__iv_modal_cancel = () => {
    if (currentClean && currentResolve) {
      currentClean();
      modalOverlay.style.display = 'none';
      currentResolve(false);
      currentClean = null;
      currentResolve = null;
      window.__iv_modal_visible = false;
    }
  };

  function showConfirm(message) {
    return new Promise(resolve => {
      msgEl.textContent = message;
      modalOverlay.style.display = 'flex';
      okBtn.focus();
      window.__iv_modal_visible = true;

      const clean = () => {
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKey);
      };
      const onOk     = () => { clean(); modalOverlay.style.display = 'none'; window.__iv_modal_visible = false; resolve(true); };
      const onCancel = () => { clean(); modalOverlay.style.display = 'none'; window.__iv_modal_visible = false; resolve(false); };
      const onKey    = (e) => { if (e.key === 'Escape' || e.key === 'Esc') { onCancel(); } };

      currentClean   = clean;
      currentResolve = resolve;

      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      document.addEventListener('keydown', onKey);
    });
  }

  function showAbout() {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed','left:0','top:0','width:100%','height:100%',
      'display:flex','align-items:center','justify-content:center',
      'z-index:2147483649','background:rgba(0,0,0,0.55)',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
      'min-width:320px','max-width:540px','background:#1b1b1b','color:#ddd',
      'border-radius:10px','border:1px solid #3a3a3a',
      'box-shadow:0 8px 32px rgba(0,0,0,0.8)',
      'padding:24px 28px','font:13px/1.6 monospace',
    ].join(';');

    box.innerHTML = [
      '<div style="font-size:20px;font-weight:700;color:#53d9ff;margin-bottom:4px;">DIANNE</div>',
      '<div style="color:#888;font-size:11px;margin-bottom:14px;letter-spacing:1px;">',
      '  GUI OF DIFFERENTIAL IMAGE ANNOTATOR ENVIRONMENT',
      '</div>',
      '<div style="margin-bottom:12px;">',
      '  Histology image annotation and classifier training in',
      '  Jupyter Notebook. Draw positive and negative contours on H&amp;E, optionally using Xenium transcript and cell overlays,',
      '  then train a classifier and visualise predictions — all without leaving the notebook.',
      '  images, train a tile-level classifier, and visualise probability',
      '  heatmaps.',
      '</div>',
      '<div style="border-top:1px solid #2e2e2e;padding-top:12px;margin-bottom:16px;color:#aaa;font-size:11px;">',
      '  Components: viewport &bull; tile pyramid &bull; draw overlay &bull;',
      '  Xenium transcripts &amp; cells &bull; inference pipeline',
      '</div>',
      '<div style="font-size:12px;color:#ccc;">',
      '  &copy; 2024&ndash;2026 <strong style="color:#eee;">The Jackson Laboratory</strong>',
      '  &nbsp;&mdash;&nbsp; All rights reserved.',
      '</div>',
      '<div style="display:flex;justify-content:flex-end;margin-top:18px;">',
      '  <button data-about-close',
      '    style="padding:6px 18px;border-radius:6px;border:none;',
      '           background:#1f8cff;color:#fff;cursor:pointer;font:13px monospace;">',
      '    Close',
      '  </button>',
      '</div>',
    ].join('');

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function _close() {
      overlay.remove();
      document.removeEventListener('keydown', _onKey);
    }
    function _onKey(e) {
      if (e.key === 'Escape' || e.key === 'Esc') _close();
    }
    box.querySelector('[data-about-close]').addEventListener('click', _close);
    overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });
    document.addEventListener('keydown', _onKey);
  }

  return { showConfirm, showAbout };
}
