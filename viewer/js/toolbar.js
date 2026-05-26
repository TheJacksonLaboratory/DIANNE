/**
 * toolbar.js
 *
 * Owns the tool buttons DOM and all mouse event routing.
 * This is the ONLY place that attaches mousedown/mousemove/mouseup/wheel
 * to the container. Based on active tool it delegates to:
 *   - viewport  (pan tool)
 *   - draw      (draw tool)
 *   - baseUrl   (click tool → POST /click)
 *
 * Button layout (vertical groups):
 *   Row 1  — pan ✥ | draw+ | draw-
 *   Row 2* — brush-mode | color-picker | undo
 *   Row 3* — Width [slider]
 *   Row 4* — Smoothing [slider]
 *   Row 5  — flush ⬇ | visibility 👀 | tiles
 *   Row 6  — save 💾 | load 📂 | inference ▶   (only if any are enabled)
 *   Row 7† — [2D Options] [genes]
 *
 *   *  Only visible while a draw tool is active.
 *   †  Only present when a monochannel image and/or visium overlay is active.
 *
 * Exposes:
 *   toolbar.getActiveTool()   → 'pan' | 'draw_positive' | 'draw_negative' | 'click'
 *   toolbar.setTool(name)
 */

function createToolbar(container, viewport, draw, baseUrl, runInferenceOptions, saveLoadOptions, settings, patchOverlay, visiumOverlay, monoOptions) {
  const ZOOM_SPEED = 0.001;

  let activeTool = 'pan';

  // ── Shared button style helpers ────────────────────────────────────────────
  const _btnCss = [
    'background:transparent', 'border:1px solid #888',
    'color:#eee', 'border-radius:4px', 'padding:2px 7px',
    'cursor:pointer', 'font-size:13px', 'line-height:1.4',
  ].join(';');

  function _mkRow(extraCss) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:row;gap:4px;align-items:center;' + (extraCss || '');
    return row;
  }

  // ── Build toolbar container (vertical column of rows) ──────────────────────
  const bar = document.createElement('div');
  bar.dataset.ivUi = 'true';
  bar.style.cssText = [
    'position:absolute', 'top:8px', 'left:8px', 'z-index:10',
    'display:flex', 'flex-direction:column', 'gap:4px',
    'background:rgba(0,0,0,0.55)',
    'padding:4px 6px', 'border-radius:6px',
  ].join(';');
  container.appendChild(bar);

  // ── Row 1: pan / draw+ / draw- ────────────────────────────────────────────
  const toolRow = _mkRow();
  bar.appendChild(toolRow);

  const tools = [
    { name: 'pan',           label: '✥',     title: 'Pan / zoom' },
    { name: 'draw_positive', label: 'draw+', title: 'Draw positive contour' },
    { name: 'draw_negative', label: 'draw-', title: 'Draw negative contour' },
    // { name: 'click',         label: '⊕',     title: 'Click to record point' },
  ];

  const buttons = {};
  for (const t of tools) {
    const btn = document.createElement('button');
    btn.textContent = t.label;
    btn.title       = t.title;
    btn.style.cssText = _btnCss;
    btn.addEventListener('click', () => setTool(t.name));
    btn.dataset.demoId = 'tool-' + t.name.replace(/_/g, '-');
    toolRow.appendChild(btn);
    buttons[t.name] = btn;
  }

  // ── Rows 2–4: draw-mode controls (hidden unless draw tool active) ──────────

  // Row 2: brush mode | color picker | undo
  const drawRow2 = _mkRow();
  drawRow2.style.display = 'none';
  bar.appendChild(drawRow2);

  const brushModeBtn = document.createElement('button');
  brushModeBtn.textContent = '∿';
  brushModeBtn.title = 'Brush mode: line';
  brushModeBtn.dataset.brushModeBtn = '';
  brushModeBtn.dataset.demoId = 'brush-mode-btn';
  brushModeBtn.style.cssText = [
    'background:rgba(255,255,255,0.15)', 'border:1px solid #aaa',
    'color:#eee', 'border-radius:4px', 'padding:2px 7px',
    'cursor:pointer', 'font-size:14px', 'line-height:1.3',
  ].join(';');
  drawRow2.appendChild(brushModeBtn);

  const colorPicker = document.createElement('input');
  colorPicker.type = 'color';
  colorPicker.value = '#ff2222';
  colorPicker.title = 'Stroke color';
  colorPicker.dataset.demoId = 'color-picker';
  colorPicker.style.cssText = 'width:26px;height:26px;border:none;background:none;cursor:pointer;padding:0;';
  drawRow2.appendChild(colorPicker);

  const undoBtn = document.createElement('button');
  undoBtn.textContent = '↩';
  undoBtn.title = 'Undo last stroke';
  undoBtn.dataset.demoId = 'undo-btn';
  undoBtn.style.cssText = _btnCss;
  drawRow2.appendChild(undoBtn);

  // clearBtn — kept hidden for backward compat (demo scripts may look for it)
  const clearBtn = document.createElement('button');
  clearBtn.textContent = '✕';
  clearBtn.title = 'Clear all strokes';
  clearBtn.style.cssText = _btnCss + ';display:none;';
  drawRow2.appendChild(clearBtn);

  // Row 3: Width slider
  const drawRow3 = _mkRow();
  drawRow3.style.display = 'none';
  bar.appendChild(drawRow3);

  const widthLabel = document.createElement('span');
  widthLabel.textContent = 'Width';
  widthLabel.style.cssText = 'color:#ddd;font-size:11px;white-space:nowrap;';
  drawRow3.appendChild(widthLabel);

  const widthSlider = document.createElement('input');
  widthSlider.type = 'range';
  widthSlider.min = '1'; widthSlider.max = '10'; widthSlider.step = '1'; widthSlider.value = '2';
  widthSlider.title = 'Stroke width (px)';
  widthSlider.dataset.demoId = 'width-slider';
  widthSlider.style.cssText = 'width:100px;';
  drawRow3.appendChild(widthSlider);

  // Row 4: Smoothing slider
  const drawRow4 = _mkRow();
  drawRow4.style.display = 'none';
  bar.appendChild(drawRow4);

  const smoothLabel = document.createElement('span');
  smoothLabel.textContent = 'Smoothing';
  smoothLabel.style.cssText = 'color:#ddd;font-size:11px;white-space:nowrap;';
  drawRow4.appendChild(smoothLabel);

  const smoothSlider = document.createElement('input');
  smoothSlider.type = 'range';
  smoothSlider.min = '0'; smoothSlider.max = '1'; smoothSlider.step = '0.05'; smoothSlider.value = '0.35';
  smoothSlider.title = 'Stroke smoothing';
  smoothSlider.dataset.demoId = 'smooth-slider';
  smoothSlider.style.cssText = 'width:75px;';
  drawRow4.appendChild(smoothSlider);

  // ── Row 5: action buttons (always visible) ─────────────────────────────────
  const actionRow = _mkRow();
  bar.appendChild(actionRow);

  // flush button
  const flushBtn = document.createElement('button');
  flushBtn.textContent = '⬇';
  flushBtn.title = 'Send strokes to Python';
  flushBtn.dataset.demoId = 'flush-btn';
  flushBtn.style.cssText = _btnCss + ';font-size:15px;';
  flushBtn.addEventListener('click', () => window.ivFlushStrokes());
  actionRow.appendChild(flushBtn);

  // annotations visibility toggle
  let annotationsVisible = true;
  const toggleAnnotBtn = document.createElement('button');
  toggleAnnotBtn.textContent = '👀';
  toggleAnnotBtn.title = 'Toggle annotations visibility';
  toggleAnnotBtn.dataset.demoId = 'toggle-annot-btn';
  toggleAnnotBtn.style.cssText = [
    'background:rgba(255,255,255,0.2)', 'border:1px solid #888',
    'color:#eee', 'border-radius:4px', 'padding:2px 7px',
    'cursor:pointer', 'font-size:13px', 'line-height:1.4',
  ].join(';');
  toggleAnnotBtn.addEventListener('click', () => {
    annotationsVisible = !annotationsVisible;
    draw.setVisible(annotationsVisible);
    toggleAnnotBtn.style.background = annotationsVisible ? 'rgba(255,255,255,0.2)' : 'transparent';
    toggleAnnotBtn.style.opacity = annotationsVisible ? '1' : '0.45';
  });
  actionRow.appendChild(toggleAnnotBtn);

  // Tiles (patch overlay) toggle
  if (patchOverlay) {
    actionRow.appendChild(patchOverlay.toggleBtn);
  }

  // ── Row 6 (save row) — built lazily; appended to bar only if non-empty ───
  const _saveRow = _mkRow();

  // Save button (optional)
  if (saveLoadOptions && typeof saveLoadOptions.onSave === 'function') {
    const saveBtn = document.createElement('button');
    saveBtn.title = 'Save classifier';
    saveBtn.textContent = '💾';
    saveBtn.dataset.demoId = 'save-btn';
    saveBtn.style.cssText = _btnCss + ';font-size:14px;';
    saveBtn.addEventListener('click', () => {
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
      box.innerHTML = '<div style="font-weight:700;color:#53d9ff;margin-bottom:10px;">Save classifier</div>';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Classifier name…';
      input.style.cssText = 'width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #555;border-radius:4px;padding:5px 6px;font:13px monospace;margin-bottom:12px;outline:none;';
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'padding:5px 10px;border-radius:6px;border:1px solid #555;background:#333;color:#bbb;cursor:pointer;font:12px monospace';
      const okBtn = document.createElement('button');
      okBtn.textContent = 'Save';
      okBtn.style.cssText = 'padding:5px 14px;border-radius:6px;border:none;background:#1f8cff;color:#fff;cursor:pointer;font:12px monospace';
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(okBtn);
      box.appendChild(input);
      box.appendChild(btnRow);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      input.focus();
      function _close() { overlay.remove(); document.removeEventListener('keydown', _key); }
      function _submit() {
        const name = input.value.trim();
        _close();
        if (name) saveLoadOptions.onSave(name, saveBtn);
      }
      function _key(e) {
        if (e.key === 'Enter') _submit();
        else if (e.key === 'Escape' || e.key === 'Esc') _close();
      }
      cancelBtn.addEventListener('click', _close);
      okBtn.addEventListener('click', _submit);
      overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });
      document.addEventListener('keydown', _key);
    });
    _saveRow.appendChild(saveBtn);
  }

  // Load button (optional)
  if (saveLoadOptions &&
      typeof saveLoadOptions.onLoad === 'function' &&
      typeof saveLoadOptions.listNames === 'function') {
    const loadBtn = document.createElement('button');
    loadBtn.title = 'Load classifier';
    loadBtn.textContent = '📂';
    loadBtn.dataset.demoId = 'load-btn';
    loadBtn.style.cssText = _btnCss + ';font-size:14px;';
    loadBtn.addEventListener('click', async () => {
      const names = await saveLoadOptions.listNames();
      if (!names || !names.length) { alert('No saved classifiers found.'); return; }
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
      box.innerHTML = '<div style="font-weight:700;color:#53d9ff;margin-bottom:10px;">Load classifier</div>';
      const select = document.createElement('select');
      select.style.cssText = 'width:100%;background:#111;color:#eee;border:1px solid #555;border-radius:4px;padding:4px;font:13px monospace;margin-bottom:12px;';
      for (const n of names) {
        const opt = document.createElement('option');
        opt.value = n; opt.textContent = n;
        select.appendChild(opt);
      }
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'padding:5px 10px;border-radius:6px;border:1px solid #555;background:#333;color:#bbb;cursor:pointer;font:12px monospace';
      const okBtn = document.createElement('button');
      okBtn.textContent = 'Load';
      okBtn.style.cssText = 'padding:5px 14px;border-radius:6px;border:none;background:#1f8cff;color:#fff;cursor:pointer;font:12px monospace';
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(okBtn);
      box.appendChild(select);
      box.appendChild(btnRow);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      function _close() { overlay.remove(); document.removeEventListener('keydown', _key); }
      function _key(e) { if (e.key === 'Escape' || e.key === 'Esc') _close(); }
      cancelBtn.addEventListener('click', _close);
      overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });
      document.addEventListener('keydown', _key);
      okBtn.addEventListener('click', () => {
        const chosen = select.value;
        _close();
        if (chosen) saveLoadOptions.onLoad(chosen, loadBtn);
      });
    });
    _saveRow.appendChild(loadBtn);
  }

  // Run inference button (optional)
  if (runInferenceOptions && typeof runInferenceOptions.onRun === 'function') {
    const runBtn = document.createElement('button');
    runBtn.title = 'Train classifier & run inference on active sample';
    runBtn.style.cssText = [
      'width:26px', 'height:26px', 'border-radius:50%', 'border:none',
      'background:radial-gradient(circle, #00ff88 0%, #00cc55 100%)',
      'cursor:pointer', 'font-size:11px', 'padding:0',
      'box-shadow:0 0 8px 2px rgba(0,255,136,0.65)',
      'transition:box-shadow 0.2s, opacity 0.2s',
      'display:flex', 'align-items:center', 'justify-content:center',
      'color:#003322', 'font-weight:700',
    ].join(';');
    runBtn.textContent = '▶';
    runBtn.dataset.demoId = 'run-inference-btn';
    runBtn.addEventListener('mouseenter', () => {
      if (!runBtn.disabled) runBtn.style.boxShadow = '0 0 14px 5px rgba(0,255,136,0.95)';
    });
    runBtn.addEventListener('mouseleave', () => {
      if (!runBtn.disabled) runBtn.style.boxShadow = '0 0 8px 2px rgba(0,255,136,0.65)';
    });
    runBtn.addEventListener('click', () => {
      if (!runBtn.disabled) runInferenceOptions.onRun(runBtn);
    });
    _saveRow.appendChild(runBtn);
  }

  // ── Append row 6 if it has any buttons ──────────────────────────────────────
  if (_saveRow.children.length > 0) bar.appendChild(_saveRow);

  // ── Row 7: 2D Options (monochannel) and/or Genes (visium) ─────────────────
  if ((monoOptions && monoOptions.mono2d && monoOptions.monoMeta) || visiumOverlay) {
    const { mono2d, monoMeta, isSampleMono } = monoOptions || {};

    const monoRow = _mkRow('position:relative;');
    bar.appendChild(monoRow);

    // 2D Options button — only when mono2d is present
    let monoBtn = null;
    if (mono2d) {
      monoBtn = document.createElement('button');
      monoBtn.textContent = '2D Options ▾';
      monoBtn.title = '2D display options (colourmap / palette)';
      monoBtn.dataset.demoId = 'mono-options-btn';
      monoBtn.style.cssText = [
        'background:rgba(80,130,255,0.18)', 'border:1px solid #5599ff',
        'color:#aac8ff', 'border-radius:4px', 'padding:2px 8px',
        'cursor:pointer', 'font-size:12px', 'line-height:1.4', 'white-space:nowrap',
      ].join(';');
      monoRow.appendChild(monoBtn);
    }

    // Genes button — always right of 2D Options when visiumOverlay is present
    if (visiumOverlay) monoRow.appendChild(visiumOverlay.genesBtn);

    // ── 2D Options dropdown panel ───────────────────────────────────────────────
    if (!mono2d) {
      // Genes-only row — nothing more needed
      monoRow.dataset.monoRowEl = 'true';
      monoRow._setActive = function() {}; // genes visibility managed externally
    } else {
    const monoPanel = document.createElement('div');
    monoPanel.dataset.ivUi = 'true';
    monoPanel.style.cssText = [
      'display:none', 'position:absolute', 'top:100%', 'left:0', 'margin-top:4px',
      'background:rgba(12,12,18,0.97)', 'border:1px solid #3a4a6a',
      'border-radius:8px', 'padding:10px 12px', 'z-index:20',
      'min-width:270px', 'box-shadow:0 6px 24px rgba(0,0,0,0.8)',
      'font:12px monospace', 'color:#dde',
    ].join(';');
    monoRow.appendChild(monoPanel);

    // Helper: label row
    function _panelLabel(text) {
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = 'color:#7a9fc8;font-size:11px;margin:8px 0 3px 0;text-transform:uppercase;letter-spacing:0.05em;';
      return el;
    }
    // Helper: radio-style toggle button pair
    function _radioGroup(options, initial, onChange) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:4px;';
      const btns = {};
      for (const { value, label } of options) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = [
          'padding:2px 8px', 'border-radius:4px', 'cursor:pointer',
          'font:12px monospace', 'border:1px solid #556',
          'color:#cce', 'transition:background 0.1s',
        ].join(';');
        b.style.background = value === initial ? 'rgba(85,153,255,0.35)' : 'rgba(255,255,255,0.06)';
        b.addEventListener('click', (function(val) {
          return function() {
            for (const bb of Object.values(btns)) bb.style.background = 'rgba(255,255,255,0.06)';
            btns[val].style.background = 'rgba(85,153,255,0.35)';
            onChange(val);
          };
        })(value));
        btns[value] = b;
        wrap.appendChild(b);
      }
      return { el: wrap, btns, setActive(v) {
        for (const [vk, bb] of Object.entries(btns))
          bb.style.background = vk === v ? 'rgba(85,153,255,0.35)' : 'rgba(255,255,255,0.06)';
      }};
    }
    // Helper: cmap <select>, filtered to the supplied list
    function _cmapSelect(names, initial) {
      const sel = document.createElement('select');
      sel.style.cssText = 'width:100%;background:#111;color:#dde;border:1px solid #445;border-radius:4px;padding:3px 4px;font:12px monospace;';
      for (const name of (names || [])) {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        if (name === initial) opt.selected = true;
        sel.appendChild(opt);
      }
      return sel;
    }

    // Read current settings
    const cur = mono2d.getDisplaySettings();
    const allCmaps    = monoMeta.all_cmaps    || [];
    const allPalettes = monoMeta.all_palettes || allCmaps;

    // Mode toggle
    monoPanel.appendChild(_panelLabel('Mode'));
    const modeToggle = _radioGroup(
      [{ value: 'palette', label: 'Palette (labels)' }, { value: 'cmap', label: 'Heatmap (cmap)' }],
      cur.mode,
      v => { mono2d.setDisplaySettings({ mode: v }); _updatePanelVisibility(v); }
    );
    monoPanel.appendChild(modeToggle.el);

    // ── Palette section ──────────────────────────────────────────────────────
    const palSection = document.createElement('div');
    monoPanel.appendChild(palSection);

    palSection.appendChild(_panelLabel('Palette source'));
    const palSelect = _cmapSelect(allPalettes, cur.palette);
    palSelect.addEventListener('change', () => mono2d.setDisplaySettings({ palette: palSelect.value }));
    palSection.appendChild(palSelect);

    palSection.appendChild(_panelLabel('Color order'));
    const colorsToggle = _radioGroup(
      [{ value: 'sequential', label: 'Sequential' }, { value: 'random', label: 'Random' }],
      cur.colors,
      v => mono2d.setDisplaySettings({ colors: v })
    );
    palSection.appendChild(colorsToggle.el);

    // ── Cmap section ─────────────────────────────────────────────────────────
    const cmapSection = document.createElement('div');
    monoPanel.appendChild(cmapSection);

    cmapSection.appendChild(_panelLabel('Colormap'));
    const cmapSelect = _cmapSelect(allCmaps, cur.cmap);
    cmapSelect.addEventListener('change', () => mono2d.setDisplaySettings({ cmap: cmapSelect.value }));
    cmapSection.appendChild(cmapSelect);

    cmapSection.appendChild(_panelLabel('Display range'));
    const rangeRow = document.createElement('div');
    rangeRow.style.cssText = 'display:flex;gap:6px;align-items:center;';

    const vminLabel = document.createElement('span');
    vminLabel.textContent = 'Min';
    vminLabel.style.cssText = 'color:#9ab;font-size:11px;';
    const vminInput = document.createElement('input');
    vminInput.type = 'number'; vminInput.step = 'any';
    vminInput.value = String(cur.vmin);
    vminInput.style.cssText = 'width:80px;background:#111;color:#dde;border:1px solid #445;border-radius:4px;padding:2px 4px;font:12px monospace;';
    vminInput.title = 'Minimum display value (data units)';

    const vmaxLabel = document.createElement('span');
    vmaxLabel.textContent = 'Max';
    vmaxLabel.style.cssText = 'color:#9ab;font-size:11px;';
    const vmaxInput = document.createElement('input');
    vmaxInput.type = 'number'; vmaxInput.step = 'any';
    vmaxInput.value = String(cur.vmax);
    vmaxInput.style.cssText = 'width:80px;background:#111;color:#dde;border:1px solid #445;border-radius:4px;padding:2px 4px;font:12px monospace;';
    vmaxInput.title = 'Maximum display value (data units)';

    function _applyRange() {
      const mn = parseFloat(vminInput.value);
      const mx = parseFloat(vmaxInput.value);
      if (Number.isFinite(mn) && Number.isFinite(mx) && mn < mx)
        mono2d.setDisplaySettings({ vmin: mn, vmax: mx });
    }
    vminInput.addEventListener('change', _applyRange);
    vmaxInput.addEventListener('change', _applyRange);

    // Data range hint
    const rangeHint = document.createElement('div');
    rangeHint.style.cssText = 'color:#668;font-size:10px;margin-top:2px;';
    const _fmtN = v => (v != null && Number.isFinite(Number(v))) ? Number(v).toPrecision(4) : '?';
    rangeHint.textContent = 'Data: [' + _fmtN(monoMeta.data_min) + ', ' + _fmtN(monoMeta.data_max) + ']';

    rangeRow.appendChild(vminLabel); rangeRow.appendChild(vminInput);
    rangeRow.appendChild(vmaxLabel); rangeRow.appendChild(vmaxInput);
    cmapSection.appendChild(rangeRow);
    cmapSection.appendChild(rangeHint);

    // Show/hide palette vs cmap sections based on mode
    function _updatePanelVisibility(mode) {
      palSection.style.display  = mode === 'palette' ? 'block' : 'none';
      cmapSection.style.display = mode === 'cmap'    ? 'block' : 'none';
    }
    _updatePanelVisibility(cur.mode);

    // Also sync panel controls when mono2d settings change externally (e.g. sample switch)
    function _syncPanelFromSettings() {
      const s = mono2d.getDisplaySettings();
      modeToggle.setActive(s.mode);
      palSelect.value  = s.palette;
      cmapSelect.value = s.cmap;
      colorsToggle.setActive(s.colors);
      vminInput.value = String(s.vmin);
      vmaxInput.value = String(s.vmax);
      _updatePanelVisibility(s.mode);
    }

    // Toggle panel open/close
    let _monoPanelOpen = false;
    function _closeMonoPanel() {
      _monoPanelOpen = false;
      monoPanel.style.display = 'none';
      monoBtn.textContent = '2D Options ▾';
      monoBtn.style.background = 'rgba(80,130,255,0.18)';
      document.removeEventListener('keydown', _monoPanelKeydown, true);
    }
    function _openMonoPanel() {
      _syncPanelFromSettings();
      _monoPanelOpen = true;
      monoPanel.style.display = 'block';
      monoBtn.textContent = '2D Options ▴';
      monoBtn.style.background = 'rgba(85,153,255,0.35)';
      document.addEventListener('keydown', _monoPanelKeydown, true);
    }
    function _monoPanelKeydown(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        _closeMonoPanel();
        e.stopImmediatePropagation();  // prevent fullscreen Esc handler from also firing
        e.preventDefault();
      }
    }
    monoBtn.addEventListener('click', () => {
      if (_monoPanelOpen) _closeMonoPanel(); else _openMonoPanel();
    });

    // setActive controls visibility of the monoBtn; the row stays visible if genes are present.
    monoRow.dataset.monoRowEl = 'true';
    monoRow._setActive = function(active) {
      monoBtn.style.display = active ? '' : 'none';
      if (!active) _closeMonoPanel();
      // Only hide the whole row if genes are also absent
      const hasGenes = !!(visiumOverlay && visiumOverlay.genesBtn &&
                          visiumOverlay.genesBtn.parentNode === monoRow);
      monoRow.style.display = (active || hasGenes) ? 'flex' : 'none';
    };
    // Initial state — setMonoActive() will be called by viewer immediately after creation.
    } // end else (mono2d present)
  }

  // Expose setMonoActive so setActiveSample can toggle the 2D Options row
  function setMonoActive(active) {
    const monoRow = bar.querySelector('[data-mono-row-el]');
    if (monoRow && typeof monoRow._setActive === 'function') monoRow._setActive(active);
  }

  // ── Draw mode controls wiring ──────────────────────────────────────────────

  brushModeBtn.addEventListener('click', () => {
    const next = (typeof draw.getBrushMode === 'function' && draw.getBrushMode() === 'noodle')
      ? 'line' : 'noodle';
    if (typeof draw.setBrushMode === 'function') draw.setBrushMode(next);
    _syncBrushModeBtn(next);
    _syncWidthSlider(next);
    container.style.cursor = 'none';
  });

  function _syncBrushModeBtn(bm) {
    if (bm === 'noodle') {
      brushModeBtn.textContent = '∿';
      brushModeBtn.title       = 'Brush mode: disk (noodle) — click for line';
      brushModeBtn.style.background = 'rgba(255,255,100,0.20)';
    } else {
      brushModeBtn.textContent = '⬤';
      brushModeBtn.title       = 'Brush mode: line — click for disk (noodle)';
      brushModeBtn.style.background = 'rgba(255,255,255,0.15)';
    }
  }

  function _syncWidthSlider(bm) {
    if (bm === 'noodle') {
      widthSlider.min   = '50';
      widthSlider.max   = '2000';
      widthSlider.step  = '20';
      widthSlider.title = 'Disk radius (px)';
      widthSlider.value = String(
        (typeof draw.getNoodleRadius === 'function') ? draw.getNoodleRadius() : 300
      );
    } else {
      widthSlider.min   = '1';
      widthSlider.max   = '10';
      widthSlider.step  = '1';
      widthSlider.title = 'Stroke width (px)';
      widthSlider.value = String(
        (typeof draw.getWidth === 'function') ? draw.getWidth() : 2
      );
    }
  }

  colorPicker.addEventListener('input',  () => draw.setColor(colorPicker.value));
  widthSlider.addEventListener('input',  () => {
    const bm = (typeof draw.getBrushMode === 'function') ? draw.getBrushMode() : 'line';
    if (bm === 'noodle') {
      if (typeof draw.setNoodleRadius === 'function') draw.setNoodleRadius(Number(widthSlider.value));
    } else {
      draw.setWidth(Number(widthSlider.value));
    }
  });
  smoothSlider.addEventListener('input', () => {
    if (typeof draw.setSmoothing === 'function') draw.setSmoothing(Number(smoothSlider.value));
  });
  undoBtn.addEventListener('click', () => draw.undoLast());
  clearBtn.addEventListener('click', () => draw.clear());

  function _isDrawTool(name) {
    return name === 'draw_positive' || name === 'draw_negative';
  }

  function _isUiEventTarget(target) {
    return Boolean(target && target.closest && target.closest('[data-iv-ui="true"]'));
  }

  function setTool(name) {
    activeTool = name;
    for (const [n, btn] of Object.entries(buttons)) {
      btn.style.background = (n === name) ? 'rgba(255,255,255,0.2)' : 'transparent';
    }
    const showDraw = _isDrawTool(name) ? 'flex' : 'none';
    drawRow2.style.display = showDraw;
    drawRow3.style.display = showDraw;
    drawRow4.style.display = showDraw;
    if (_isDrawTool(name)) {
      draw.setMode(name === 'draw_negative' ? 'negative' : 'positive');
      if (typeof draw.getColor === 'function') colorPicker.value = draw.getColor();
      if (typeof draw.getSmoothing === 'function') smoothSlider.value = String(draw.getSmoothing());
      const bm = (typeof draw.getBrushMode === 'function') ? draw.getBrushMode() : 'line';
      _syncBrushModeBtn(bm);
      _syncWidthSlider(bm);
    }
    container.style.cursor =
      name === 'pan'        ? 'grab' :
      _isDrawTool(name)     ? 'none' :
      'cell';
  }

  setTool('pan');   // initial state


  let panning = false, panX = 0, panY = 0, panOx = 0, panOy = 0;
  let drawing  = false;
  let cmdPanning = false;  // Cmd/Meta held in draw mode → temporary pan
  let mouseDownPos = null;
  const clicks = [];

  container.addEventListener('mousedown', e => {
    if (_isUiEventTarget(e.target)) return;
    if (e.button !== 0) return;
    mouseDownPos = { x: e.clientX, y: e.clientY };
    const { x: vpX, y: vpY } = _toVP(e);

    if (activeTool === 'pan') {
      panning = true;
      panX = e.clientX; panY = e.clientY;
      const t = viewport.getTransform();
      panOx = t.ox; panOy = t.oy;
      container.style.cursor = 'grabbing';
    } else if (_isDrawTool(activeTool)) {
      if (e.metaKey) {
        // Command held → temporary pan
        cmdPanning = true;
        panX = e.clientX; panY = e.clientY;
        container.style.cursor = 'grabbing';
      } else {
        drawing = true;
        draw.onMouseDown(vpX, vpY);
      }
    }
  });

  window.addEventListener('mousemove', e => {
    if (activeTool === 'pan' && panning) {
      viewport.panBy(e.clientX - panX, e.clientY - panY);
      panX = e.clientX; panY = e.clientY;
    } else if (_isDrawTool(activeTool)) {
      if (cmdPanning) {
        viewport.panBy(e.clientX - panX, e.clientY - panY);
        panX = e.clientX; panY = e.clientY;
      } else {
        // always forward to draw for cursor tracking; draw.onMouseMove internally
        // skips point recording when no active stroke
        draw.onMouseMove(..._toVPArr(e));
      }
    }
  });

  container.addEventListener('mouseleave', () => {
    if (typeof draw.onMouseLeave === 'function') draw.onMouseLeave();
  });

  window.addEventListener('mouseup', e => {
    if (activeTool === 'pan' && panning) {
      panning = false;
      container.style.cursor = 'grab';
    } else if (_isDrawTool(activeTool)) {
      if (cmdPanning) {
        cmdPanning = false;
        container.style.cursor = 'none';
      } else if (drawing) {
        drawing = false;
        draw.onMouseUp();
      }
    } else if (activeTool === 'click') {
      // only fire if not dragged
      if (mouseDownPos && _dist(e, mouseDownPos) < 4) {
        const [vpX, vpY] = _toVPArr(e);
        _sendClick(vpX, vpY);
      }
    }
    mouseDownPos = null;
  });

  // Cmd key held/released in draw mode → update cursor in real time
  document.addEventListener('keydown', e => {
    if (e.key === 'Meta' && _isDrawTool(activeTool) && !drawing) {
      container.style.cursor = 'grab';
    }
  });
  document.addEventListener('keyup', e => {
    if (e.key === 'Meta' && _isDrawTool(activeTool)) {
      cmdPanning = false;
      container.style.cursor = 'none';
    }
  });

  // double-click → select contour under cursor; no fallback zoom-reset
  container.addEventListener('dblclick', e => {
    if (_isUiEventTarget(e.target)) return;
    if (typeof draw.hitTestStroke === 'function') {
      const [vpX, vpY] = _toVPArr(e);
      const hitId = draw.hitTestStroke(vpX, vpY);
      if (hitId !== null) {
        draw.selectStroke(hitId);
      }
    }
    // viewport.reset() intentionally removed — dblclick miss no longer resets zoom
  });

  // Escape → deselect (if selection exists, consumes the event so fullscreen is not also exited)
  // Delete → remove selected contour
  document.addEventListener('keydown', e => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Escape') {
      if (typeof draw.hasSelection === 'function' && draw.hasSelection()) {
        draw.clearSelection();
        e.stopImmediatePropagation();  // prevent fullscreen Escape handler from firing
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (typeof draw.deleteSelected === 'function') draw.deleteSelected();
    }
  });

  // wheel → zoom in any mode
  container.addEventListener('wheel', e => {
    if (_isUiEventTarget(e.target)) return;
    e.preventDefault();
    const [vpX, vpY] = _toVPArr(e);
    const zs = settings ? settings.get('zoomSpeed') : ZOOM_SPEED;
    viewport.zoomAt(vpX, vpY, -e.deltaY * zs);
  }, { passive: false });

  // ── click → POST to server ─────────────────────────────────────────────────
  function _sendClick(vpX, vpY) {
    const img  = viewport.toImageSpace(vpX, vpY);
    const t    = viewport.getTransform();
    clicks.push({
      img_x: Math.round(img.x),
      img_y: Math.round(img.y),
      vp_x:  Math.round(vpX),
      vp_y:  Math.round(vpY),
      zoom:  parseFloat(t.scale.toFixed(4)),
    });

    fetch(`${baseUrl}/click`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clicks }),
    }).catch(() => {});
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function _toVP(e) {
    const r = container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function _toVPArr(e) {
    const r = container.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  function _dist(a, b) {
    return Math.hypot(a.clientX - b.x, a.clientY - b.y);
  }

  return {
    getActiveTool: () => activeTool,
    setTool,
    setMonoActive,
  };
}