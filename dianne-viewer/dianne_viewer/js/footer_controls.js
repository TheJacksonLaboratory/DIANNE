/**
 * footer_controls.js
 *
 * Persistent footer controls at the bottom of the viewer shell:
 *   - Clear all annotations button
 *   - Clear sample annotations button
 *   - About button
 *   - Demo button
 *   - Stop button (right-aligned)
 *
 * Exposes:
 *   createFooterControls({
 *     SAMPLES, ACTIVE_SAMPLE_REF,
 *     BASE_URL, STOP_URL,
 *     draw, strokesBySample,
 *     drawPredLayer, clearPredPoints,
 *     modalHelpers,
 *     log,
 *   })
 *   → (no public API after construction)
 */
function createFooterControls({
  SAMPLES, ACTIVE_SAMPLE_REF,
  BASE_URL, STOP_URL,
  draw, strokesBySample,
  drawPredLayer, clearPredPoints,
  modalHelpers,
  log,
}) {
  const makeSmallBtn = (title, innerHtml) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.style.cssText = [
      'font:12px monospace','padding:4px 6px','border-radius:6px','border:1px solid #333',
      'background:rgba(38,38,38,0.9)','color:#e6e6e6','cursor:pointer','display:flex','gap:6px','align-items:center'
    ].join(';');
    b.innerHTML = innerHtml;
    return b;
  };

  const clearAllBtn = makeSmallBtn('Clear all annotations',
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 17.25L8.5 10.75L14.5 16.75L8 23.25H2V17.25Z" fill="#fff" opacity="0.14"/><path d="M21.71 11.29L18.71 8.29C18.32 7.9 17.69 7.9 17.3 8.29L15.17 10.42L19.58 14.83L21.71 12.7C22.1 12.31 22.1 11.68 21.71 11.29Z" fill="#fff" opacity="0.9"/></svg> <span style="font-size:11px">Clear all</span>');
  clearAllBtn.dataset.demoId = 'clear-all-btn';
  clearAllBtn.addEventListener('click', async () => {
    const ok = await modalHelpers.showConfirm('Clear all annotations for all samples? This cannot be undone.');
    if (!ok) return;
    log('Clearing all annotations...');
    try {
      for (const s of SAMPLES) strokesBySample[s] = { strokes_positive: [], strokes_negative: [] };
      draw.setStrokes([], []);
      if (typeof draw.clear === 'function') draw.clear();
      clearPredPoints();
      drawPredLayer();

      await fetch(BASE_URL + '/click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) });
      const bySample = {};
      for (const s of SAMPLES) bySample[s] = { strokes_positive: [], strokes_negative: [] };
      await fetch(BASE_URL + '/strokes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by_sample: bySample }) });

      log('All annotations cleared');
    } catch (err) { log('Clear error: ' + err); }
  });

  const clearSampleBtn = makeSmallBtn('Clear annotations for sample',
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 17.25L8.5 10.75L14.5 16.75L8 23.25H2V17.25Z" fill="#fff" opacity="0.14"/><path d="M21.71 11.29L18.71 8.29C18.32 7.9 17.69 7.9 17.3 8.29L15.17 10.42L19.58 14.83L21.71 12.7C22.1 12.31 22.1 11.68 21.71 11.29Z" fill="#fff" opacity="0.9"/></svg> <span style="font-size:11px">Clear sample</span>');
  clearSampleBtn.dataset.demoId = 'clear-sample-btn';
  clearSampleBtn.addEventListener('click', async () => {
    const ACTIVE_SAMPLE = ACTIVE_SAMPLE_REF();
    const ok = await modalHelpers.showConfirm('Clear annotations for sample ' + ACTIVE_SAMPLE + '?');
    if (!ok) return;
    log('Clearing annotations for sample ' + ACTIVE_SAMPLE + '...');
    try {
      if (strokesBySample[ACTIVE_SAMPLE]) strokesBySample[ACTIVE_SAMPLE] = { strokes_positive: [], strokes_negative: [] };
      draw.setStrokes([], []);
      if (typeof draw.clear === 'function') draw.clear();
      clearPredPoints();
      drawPredLayer();

      await fetch(BASE_URL + '/strokes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strokes_positive: [], strokes_negative: [] }) });

      log('Annotations cleared for ' + ACTIVE_SAMPLE);
    } catch (err) { log('Clear error: ' + err); }
  });

  const aboutBtn = makeSmallBtn('About DIANNE', '<span style="font-size:11px">ⓘ About</span>');
  aboutBtn.dataset.demoId = 'about-btn';
  aboutBtn.addEventListener('click', () => modalHelpers.showAbout());

  const demoBtn = makeSmallBtn('Interactive tour of the UI', '<span style="font-size:11px">▷ Demo</span>');
  demoBtn.addEventListener('click', () => {
    if (window.__ivDemo && typeof window.__ivDemo.start === 'function') window.__ivDemo.start();
  });

  // ── Stop button (right-aligned) ────────────────────────────────────────────
  const stopViewerBtn = document.createElement('button');
  stopViewerBtn.type  = 'button';
  stopViewerBtn.title = 'Stop viewer';
  stopViewerBtn.style.cssText = [
    'font:12px monospace','padding:5px 10px','border-radius:6px',
    'border:1px solid #c0392b','background:rgba(38,38,38,0.9)',
    'color:#ff6666','cursor:pointer','display:flex','gap:6px','align-items:center',
    'margin-left:auto',
  ].join(';');
  stopViewerBtn.innerHTML = '<span style="font-size:13px">&#9632;</span><span style="font-size:11px">Stop</span>';
  stopViewerBtn.addEventListener('click', () => {
    const overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed','left:0','top:0','width:100%','height:100%',
      'display:flex','align-items:center','justify-content:center',
      'z-index:2147483649','background:rgba(0,0,0,0.55)',
    ].join(';');
    const box = document.createElement('div');
    box.style.cssText = [
      'min-width:260px','background:#1b1b1b','color:#eee',
      'border-radius:8px','border:1px solid #3a3a3a',
      'box-shadow:0 6px 24px rgba(0,0,0,0.8)',
      'padding:16px 18px','font:13px monospace',
    ].join(';');
    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:700;color:#ff6666;margin-bottom:10px;';
    titleEl.textContent = 'Stop viewer';
    const msgEl = document.createElement('div');
    msgEl.style.cssText = 'margin-bottom:12px;color:#ccc;';
    msgEl.textContent = 'Stop the viewer and shut down the server?';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:5px 10px;border-radius:6px;border:1px solid #555;background:#333;color:#bbb;cursor:pointer;font:12px monospace';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'Stop';
    okBtn.style.cssText = 'padding:5px 14px;border-radius:6px;border:none;background:#c0392b;color:#fff;cursor:pointer;font:12px monospace';
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    box.appendChild(titleEl);
    box.appendChild(msgEl);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    okBtn.focus();
    function _close() {
      overlay.remove();
      document.removeEventListener('keydown', _key, true);
      window.__iv_modal_visible = false;
      window.__iv_modal_cancel = null;
    }
    function _key(e) {
      if (e.key === 'Escape' || e.key === 'Esc') { e.stopImmediatePropagation(); e.preventDefault(); _close(); }
    }
    window.__iv_modal_visible = true;
    window.__iv_modal_cancel = _close;
    cancelBtn.addEventListener('click', _close);
    overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });
    document.addEventListener('keydown', _key, true);
    okBtn.addEventListener('click', () => {
      _close();
      fetch(STOP_URL).catch(() => {});
      const shell = document.getElementById('iv-shell');
      if (shell) shell.remove();
    });
  });

  // ── Assemble footer ────────────────────────────────────────────────────────
  const shell    = document.getElementById('iv-shell');
  const ivFooter = document.createElement('div');
  ivFooter.id = 'iv-footer';
  ivFooter.style.cssText = 'position:absolute;left:0;right:0;bottom:70px;height:56px;display:flex;align-items:center;padding-left:12px;gap:8px;z-index:2147483648;pointer-events:auto;background:transparent;';
  ivFooter.appendChild(clearAllBtn);
  ivFooter.appendChild(clearSampleBtn);
  ivFooter.appendChild(aboutBtn);
  ivFooter.appendChild(demoBtn);
  ivFooter.appendChild(stopViewerBtn);
  shell.appendChild(ivFooter);
}
