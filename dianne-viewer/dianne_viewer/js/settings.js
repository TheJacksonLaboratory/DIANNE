/**
 * settings.js
 *
 * Gear button (⚙) + floating settings panel, appended to the overlay-controls
 * bar. Persists values to localStorage between sessions and notifies registered
 * listeners on every change.
 *
 * Exposes:
 *   settings.get(key)       → current value
 *   settings.set(key, val)  → update + persist + notify listeners
 *   settings.onChange(fn)   → register callback  fn(key, val)
 *                             key === null signals a full reset
 */
function createSettings(toolbarEl, rootEl, defaults) {
  const LS_KEY = 'ivViewerSettings';

  const DEFAULTS = Object.assign({
    zoomSpeed          : 0.001,      // zoom factor per mouse-wheel deltaY unit
    levelSensitivity   : 1.0,        // multiplier for pyramid level-switch threshold
    tileCacheSize      : 300,        // max image tile blobs held in browser memory
    prefetchBorder     : 1,          // extra tile rows/cols loaded outside viewport
    renderQuality      : 'pixelated',// CSS image-rendering for tile <img> elements
    jpegQuality        : 90,         // JPEG compression quality for image tiles (1–95)
    cellCacheSize      : 500,        // max cell JSON tile responses in memory
    maxCellsBoundaries : 10000,       // force dots when visible cell count exceeds this (0 = off)
    inferMsPerCell     : 0.25,       // loader animation ms per cell in inference sample
    patchOpacity       : 0.35,       // semi-transparency of the patch/tile overlay (0–1)
  }, defaults || {});

  // Load persisted values; only accept keys/types that exist in DEFAULTS.
  let vals = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      for (const k of Object.keys(DEFAULTS)) {
        if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) vals[k] = saved[k];
      }
    }
  } catch (e) {}

  const listeners = [];

  function get(key) { return vals[key]; }

  function set(key, value) {
    vals[key] = value;
    try { localStorage.setItem(LS_KEY, JSON.stringify(vals)); } catch (e) {}
    for (const fn of listeners) fn(key, value);
  }

  function onChange(fn) { listeners.push(fn); }

  // ── Gear button ─────────────────────────────────────────────────────────────
  const gearBtn = document.createElement('button');
  gearBtn.type = 'button';
  gearBtn.title = 'Viewer settings';
  gearBtn.dataset.demoId = 'settings-btn';
  gearBtn.dataset.ivUi = 'true';
  gearBtn.style.cssText = [
    'font:12px monospace', 'padding:5px 7px', 'border-radius:6px',
    'border:1px solid #333', 'background:#262626', 'color:#e6e6e6',
    'cursor:pointer', 'display:flex', 'align-items:center', 'line-height:1',
  ].join(';');
  gearBtn.innerHTML = '<span style="font-size:14px">⚙</span>';
  toolbarEl.appendChild(gearBtn);

  // ── Panel ────────────────────────────────────────────────────────────────────
  // Panel lives in rootEl (not toolbarEl) so it is not cropped by the flex
  // container or the toolbar's stacking context.
  const panel = document.createElement('div');
  panel.dataset.ivUi = 'true';
  panel.style.cssText = [
    'position:absolute', 'z-index:20',
    'min-width:318px', 'max-height:78vh', 'overflow-y:auto',
    'background:#1b1b1b', 'color:#ddd',
    'border-radius:8px', 'border:1px solid #3a3a3a',
    'box-shadow:0 6px 28px rgba(0,0,0,0.88)',
    'font:12px monospace', 'display:none',
  ].join(';');
  // Prevent scrolling inside the panel from triggering viewer zoom.
  panel.addEventListener('wheel', e => e.stopPropagation());
  rootEl.appendChild(panel);

  function _reposition() {
    const btnRect  = gearBtn.getBoundingClientRect();
    const rootRect = rootEl.getBoundingClientRect();
    const top   = btnRect.bottom - rootRect.top + 4;
    const right = rootRect.right - btnRect.right;
    panel.style.top   = Math.max(4, Math.round(top))   + 'px';
    panel.style.right = Math.max(4, Math.round(right)) + 'px';
  }

  // ── UI helpers ───────────────────────────────────────────────────────────────
  function _makeSectionHeader(label) {
    const h = document.createElement('div');
    h.style.cssText = [
      'padding:8px 12px 4px', 'font-weight:700', 'font-size:11px',
      'color:#53d9ff', 'letter-spacing:0.5px',
      'border-bottom:1px solid #2a2a2a',
    ].join(';');
    h.textContent = label;
    return h;
  }

  function _makeRow(label, controlEl, hint) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 12px;min-height:28px;';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'flex:0 0 178px;color:#bbb;font-size:11px;';
    lbl.textContent = label;
    if (hint) lbl.title = hint;
    row.appendChild(lbl);
    row.appendChild(controlEl);
    return row;
  }

  function _makeHint(text) {
    const d = document.createElement('div');
    d.style.cssText = 'padding:0 14px 6px;font-size:10px;color:#555;';
    d.textContent = text;
    return d;
  }

  function _makeSlider({ key, min, max, step, format }) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;';
    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = String(min);
    slider.max   = String(max);
    slider.step  = String(step);
    slider.value = String(vals[key]);
    slider.style.cssText = 'flex:1;min-width:72px;cursor:pointer;';
    const badge = document.createElement('span');
    badge.style.cssText = 'min-width:42px;text-align:right;color:#8cf;font-size:11px;white-space:nowrap;';
    const fmt = format || (v => String(Math.round(v)));
    badge.textContent = fmt(Number(vals[key]));
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      badge.textContent = fmt(v);
      set(key, v);
    });
    wrap.appendChild(slider);
    wrap.appendChild(badge);
    return wrap;
  }

  function _makeNumber({ key, min, max, step }) {
    const inp = document.createElement('input');
    inp.type  = 'number';
    inp.min   = String(min);
    inp.max   = String(max);
    inp.step  = String(step);
    inp.value = String(vals[key]);
    inp.style.cssText = [
      'width:88px', 'background:#111', 'color:#ddd',
      'border:1px solid #444', 'border-radius:4px',
      'padding:2px 6px', 'font:12px monospace',
    ].join(';');
    inp.addEventListener('change', () => {
      const v = Math.max(Number(inp.min), Math.min(Number(inp.max), Number(inp.value)));
      inp.value = String(v);
      set(key, v);
    });
    return inp;
  }

  function _makeSelect({ key, options }) {
    const sel = document.createElement('select');
    sel.style.cssText = [
      'flex:1', 'background:#111', 'color:#ddd',
      'border:1px solid #444', 'border-radius:4px',
      'padding:2px 6px', 'font:12px monospace', 'cursor:pointer',
    ].join(';');
    for (const [value, label] of options) {
      const opt = document.createElement('option');
      opt.value       = value;
      opt.textContent = label;
      if (vals[key] === value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => set(key, sel.value));
    return sel;
  }

  // ── Panel builder (called on init and on reset) ──────────────────────────────
  function _buildPanel() {
    panel.innerHTML = '';

    // Sticky title bar
    const titleRow = document.createElement('div');
    titleRow.style.cssText = [
      'display:flex', 'align-items:center', 'justify-content:space-between',
      'padding:10px 12px 8px', 'border-bottom:1px solid #2a2a2a',
      'font-size:13px', 'font-weight:700', 'color:#eee',
      'position:sticky', 'top:0', 'background:#1b1b1b', 'z-index:1',
    ].join(';');
    const titleSpan = document.createElement('span');
    titleSpan.textContent = '⚙ Settings';
    const closeX = document.createElement('button');
    closeX.textContent = '✕';
    closeX.title = 'Close';
    closeX.style.cssText = [
      'background:transparent', 'border:none', 'color:#777',
      'cursor:pointer', 'font-size:14px', 'padding:0 2px', 'line-height:1',
    ].join(';');
    closeX.addEventListener('click', () => { panel.style.display = 'none'; });
    titleRow.appendChild(titleSpan);
    titleRow.appendChild(closeX);
    panel.appendChild(titleRow);

    // ── Navigation ─────────────────────────────────────────────────────────────
    panel.appendChild(_makeSectionHeader('Navigation'));

    panel.appendChild(_makeRow(
      'Scroll / zoom speed',
      _makeSlider({ key: 'zoomSpeed', min: 0.0002, max: 0.005, step: 0.0001,
        format: v => v.toFixed(4) }),
      'Zoom factor applied per mouse-wheel deltaY unit. Default: 0.001'));

    panel.appendChild(_makeRow(
      'Level switch threshold',
      _makeSlider({ key: 'levelSensitivity', min: 0.25, max: 3.0, step: 0.05,
        format: v => v.toFixed(2) }),
      'Controls when the viewer switches to the next pyramid resolution.\n' +
      'Low = load higher-res tiles earlier (sharper, more requests).\n' +
      'High = stay on lower-res tiles longer (faster, coarser).'));
    panel.appendChild(_makeHint('◄ Sharper / more data ──────── Faster / coarser ►'));

    // ── Tile cache ─────────────────────────────────────────────────────────────
    panel.appendChild(_makeSectionHeader('Tile Cache'));

    panel.appendChild(_makeRow(
      'Max cached tiles',
      _makeSlider({ key: 'tileCacheSize', min: 50, max: 1000, step: 10,
        format: v => String(Math.round(v)) }),
      'Number of decoded image tiles kept in browser memory.\nHigher = faster panning, more RAM used.'));

    panel.appendChild(_makeRow(
      'Prefetch border (tiles)',
      _makeSlider({ key: 'prefetchBorder', min: 0, max: 3, step: 1,
        format: v => String(Math.round(v)) }),
      'Extra rows/columns of tiles loaded beyond the visible viewport.\n' +
      '0 = no prefetch, 1 = default 1-tile border, 3 = aggressive.'));

    panel.appendChild(_makeRow(
      'Render quality',
      _makeSelect({
        key: 'renderQuality',
        options: [
          ['pixelated', 'Pixelated (crisp pixel edges)'],
          ['smooth',    'Smooth (bilinear / anti-aliased)'],
        ],
      }),
      'CSS image-rendering applied to each tile img when zoomed in.'));

    panel.appendChild(_makeRow(
      'JPEG tile quality',
      _makeSlider({ key: 'jpegQuality', min: 10, max: 95, step: 5,
        format: v => String(Math.round(v)) }),
      'Server-side JPEG compression quality for RGB image tiles.\n' +
      'Lower = smaller network payload, faster loading, more artifacts.\n' +
      'Higher = better fidelity, larger transfers. Change takes effect on next tile fetch.'));
    panel.appendChild(_makeHint('\u25c4 Smaller / faster ────────────────── Sharper / larger ►'));

    // ── Cell overlay ───────────────────────────────────────────────────────────
    panel.appendChild(_makeSectionHeader('Cell Overlay'));

    panel.appendChild(_makeRow(
      'Max cached cell tiles',
      _makeSlider({ key: 'cellCacheSize', min: 50, max: 500, step: 10,
        format: v => String(Math.round(v)) }),
      'Max cell JSON tile responses kept in browser memory.'));

    panel.appendChild(_makeRow(
      'Max cells → boundaries',
      _makeNumber({ key: 'maxCellsBoundaries', min: 0, max: 100000, step: 500 }),
      'When the total number of visible cells exceeds this threshold, all cells\n' +
      'are rendered as dots instead of boundary polygons (faster, less detail).\n' +
      '0 = always honour the server decision.'));
    panel.appendChild(_makeHint('0 = always honour server  •  suggested: 2 000 – 10 000'));

    // ── Inference loader ───────────────────────────────────────────────────────
    panel.appendChild(_makeSectionHeader('Inference Loader'));

    panel.appendChild(_makeRow(
      'Animation ms / cell',
      _makeNumber({ key: 'inferMsPerCell', min: 0, max: 5.0, step: 0.01 }),
      'Progress-bar animation duration = n_cells × this value (ms).\n' +
      'Tune to match actual inference wall-clock speed.\n' +
      'Example: 5 000 cells × 0.15 ms = 0.75 s'));
    panel.appendChild(_makeHint('Matches server-side INFERENCE_MS_PER_CELL'));

    // ── Patch overlay ──────────────────────────────────────────────────────────
    panel.appendChild(_makeSectionHeader('Patch Overlay'));

    panel.appendChild(_makeRow(
      'Patch opacity',
      _makeSlider({ key: 'patchOpacity', min: 0, max: 1, step: 0.05,
        format: v => v.toFixed(2) }),
      'Fill opacity for the Tiles overlay rectangles (0 = invisible, 1 = solid).'));

    // ── Sticky footer with reset button ────────────────────────────────────────
    const footer = document.createElement('div');
    footer.style.cssText = [
      'padding:8px 12px 10px', 'border-top:1px solid #2a2a2a',
      'display:flex', 'justify-content:flex-end',
      'position:sticky', 'bottom:0', 'background:#1b1b1b',
    ].join(';');
    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.title = 'Restore all settings to built-in defaults (clears saved values)';
    resetBtn.style.cssText = [
      'padding:4px 10px', 'border-radius:4px', 'border:1px solid #555',
      'background:#333', 'color:#bbb', 'cursor:pointer', 'font:11px monospace',
    ].join(';');
    resetBtn.addEventListener('click', () => {
      Object.assign(vals, DEFAULTS);
      try { localStorage.removeItem(LS_KEY); } catch (e) {}
      for (const fn of listeners) fn(null, null);  // null key = full reset signal
      _buildPanel();
      _reposition();
    });
    footer.appendChild(resetBtn);
    panel.appendChild(footer);
  }

  _buildPanel();

  // ── Toggle ───────────────────────────────────────────────────────────────────
  gearBtn.addEventListener('click', e => {
    e.stopPropagation();
    const opening = panel.style.display === 'none';
    panel.style.display = opening ? 'block' : 'none';
    if (opening) _reposition();
  });

  document.addEventListener('click', e => {
    if (panel.style.display === 'none') return;
    if (!panel.contains(e.target) && e.target !== gearBtn) panel.style.display = 'none';
  });

  return { get, set, onChange };
}
