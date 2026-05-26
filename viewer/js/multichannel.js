/**
 * multichannel.js
 *
 * Tile fetcher and additive compositor for multichannel (multiplex IF) images.
 * Each channel is fetched independently from the server as a grayscale PNG tile
 * via GET /channel_tile?channel=N&level=L&row=R&col=C[&sample=S].
 *
 * Channels are composited onto a single <canvas> using additive (fluorescence-style)
 * blending.  Per-channel colour and opacity/brightness are configured in a floating
 * "Channels ▾" control panel that appears at the top-right of the viewer.
 *
 * The first channel is enabled by default; all others are off.
 *
 * Public API (drop-in replacement for the object returned by createTiles):
 *   tiles.update(transform)   — force a redraw at a given transform
 *   tiles.setMeta(nextMeta)   — switch image metadata (clears all caches)
 *   tiles.setSample(name)     — switch active sample name (clears tile caches)
 */
// ── dual-range slider helper (module-level so secondary channel panel can reuse it) ────
function createDualRangeSlider(rawMin, rawMax, defaultLo, defaultHi, onChange) {
  if (!document.querySelector('style[data-iv-dual-range]')) {
    const s = document.createElement('style');
    s.dataset.ivDualRange = '';
    s.textContent = [
      '.iv-dr{position:absolute;top:0;left:0;width:100%;height:20px;',
      'margin:0;padding:0;background:transparent;',
      '-webkit-appearance:none;appearance:none;pointer-events:none;}',
      '.iv-dr::-webkit-slider-runnable-track{background:transparent;height:4px;}',
      '.iv-dr::-moz-range-track{background:transparent;height:4px;}',
      '.iv-dr::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
      'width:11px;height:11px;border-radius:50%;',
      'background:#bbb;border:1.5px solid #777;',
      'cursor:pointer;pointer-events:all;margin-top:-3px;}',
      '.iv-dr::-moz-range-thumb{width:11px;height:11px;border-radius:50%;',
      'background:#bbb;border:1.5px solid #777;cursor:pointer;pointer-events:all;}',
    ].join('');
    document.head.appendChild(s);
  }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;width:96px;height:20px;flex-shrink:0;';

  const track = document.createElement('div');
  track.style.cssText = [
    'position:absolute', 'top:8px', 'left:4px', 'right:4px',
    'height:4px', 'background:#2a2a2a', 'border-radius:2px', 'pointer-events:none',
  ].join(';');
  const fill = document.createElement('div');
  fill.style.cssText = 'position:absolute;top:0;height:100%;background:#686868;border-radius:2px;';
  track.appendChild(fill);
  wrap.appendChild(track);

  const step = rawMax > rawMin ? (rawMax - rawMin) / 1000 : 1;

  const inputLo = document.createElement('input');
  inputLo.type      = 'range';
  inputLo.className = 'iv-dr';
  inputLo.style.zIndex = '2';

  const inputHi = document.createElement('input');
  inputHi.type      = 'range';
  inputHi.className = 'iv-dr';
  inputHi.style.zIndex = '3';

  for (const inp of [inputLo, inputHi]) {
    inp.min  = String(rawMin);
    inp.max  = String(rawMax);
    inp.step = String(step);
  }
  inputLo.value = String(Math.max(rawMin, Math.min(rawMax, defaultLo)));
  inputHi.value = String(Math.max(rawMin, Math.min(rawMax, defaultHi)));

  function updateFill() {
    const lo = parseFloat(inputLo.value);
    const hi = parseFloat(inputHi.value);
    const span = rawMax - rawMin;
    const loF  = span > 0 ? (lo - rawMin) / span : 0;
    const hiF  = span > 0 ? (hi - rawMin) / span : 1;
    fill.style.left  = (loF * 100).toFixed(2) + '%';
    fill.style.width = ((hiF - loF) * 100).toFixed(2) + '%';
    wrap.title = `min: ${lo.toFixed(1)}  max: ${hi.toFixed(1)}`;
  }

  inputLo.addEventListener('input', () => {
    if (parseFloat(inputLo.value) > parseFloat(inputHi.value))
      inputLo.value = inputHi.value;
    updateFill();
    onChange(parseFloat(inputLo.value), parseFloat(inputHi.value));
  });
  inputHi.addEventListener('input', () => {
    if (parseFloat(inputHi.value) < parseFloat(inputLo.value))
      inputHi.value = inputLo.value;
    updateFill();
    onChange(parseFloat(inputLo.value), parseFloat(inputHi.value));
  });

  wrap.appendChild(inputLo);
  wrap.appendChild(inputHi);
  updateFill();
  return wrap;
}

function createMultichannelTiles(tileLayer, baseUrl, meta, viewport, sampleName) {
  const root   = tileLayer.parentElement;
  const TILE   = meta.tile_size;
  const MAX_GRAY_TOTAL  = 500;   // total gray tiles across ALL channels (not per-channel)
  const MAX_COMP_CACHED = 60;    // composite tile canvas count cap

  let currentMeta    = meta;
  let activeSample   = sampleName;
  let currentLevel   = meta.n_levels - 1;
  let pendingXform   = null;
  let frameRequested = false;

  // ── default fluorescence channel colours ──────────────────────────────────
  const DEFAULT_COLORS = [
    '#4488ff',  // blue  — DAPI / nuclear stain
    '#00ff44',  // green
    '#ff2222',  // red
    '#ffff00',  // yellow
    '#00ffff',  // cyan
    '#ff00ff',  // magenta
    '#ff8800',  // orange
    '#ff0088',  // pink
  ];

  // Per-sample channel state cache — persists across sample switches
  const chStateCache = {};

  // Per-channel state — rebuilt on every setMeta call
  // Per-channel state: enabled, display colour, brightness (0–1), intensity window (raw units)
  let chState = Array.from({ length: meta.n_channels }, (_, i) => ({
    enabled      : i === 0,
    color        : DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    opacity      : 1.0,
    intensityMin : meta.channel_ranges[i][0],   // p1 raw default
    intensityMax : meta.channel_ranges[i][1],   // p99 raw default
  }));

  // ── caches ────────────────────────────────────────────────────────────────
  // grayCache[ch] maps tileKey → { gray: Uint8Array(TILE²), lastUsed: number }
  let grayCache  = Array.from({ length: meta.n_channels }, () => new Map());
  // in-flight AbortControllers per channel
  let inflights  = Array.from({ length: meta.n_channels }, () => new Map());
  // compCache maps tileKey → HTMLCanvasElement (composited TILE×TILE)
  const compCache  = new Map();
  // tile keys currently needed by the viewport (updated every redraw)
  let wantedKeys = new Set();

  // ── RGB fallback (for samples without channels) ───────────────────────────
  let _rgbMode       = (meta.n_channels || 0) === 0;
  const _rgbCache    = new Map();   // tileKey → HTMLImageElement
  const _rgbInflight = new Map();   // tileKey → AbortController

  // ── main composite canvas ─────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;z-index:0;pointer-events:none;';
  canvas.width  = root.clientWidth  || 1;
  canvas.height = root.clientHeight || 1;
  root.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // Resize the canvas whenever the container resizes
  const ro = new ResizeObserver(() => {
    canvas.width  = root.clientWidth  || 1;
    canvas.height = root.clientHeight || 1;
    scheduleRedraw();
  });
  ro.observe(root);

  // ── coordinate helpers ────────────────────────────────────────────────────
  function bestLevel(scale) {
    for (let i = 0; i < currentMeta.n_levels; i++) {
      if (scale >= 1 / currentMeta.levels[i].downsample) return i;
    }
    return currentMeta.n_levels - 1;
  }

  function visibleRange(level, transform, pad) {
    const { scale, ox, oy } = transform;
    const lm = currentMeta.levels[level];
    const l0 = currentMeta.levels[0];
    const cw = canvas.width, ch = canvas.height;
    const ds = l0.width / lm.width;

    const x0 = Math.max(0, (-ox / scale) / ds);
    const y0 = Math.max(0, (-oy / scale) / ds);
    const x1 = Math.min(lm.width,  ((cw - ox) / scale) / ds);
    const y1 = Math.min(lm.height, ((ch - oy) / scale) / ds);

    return {
      c0: Math.max(0,              Math.floor(x0 / TILE) - pad),
      r0: Math.max(0,              Math.floor(y0 / TILE) - pad),
      c1: Math.min(lm.n_tiles_x - 1, Math.ceil(x1 / TILE) - 1 + pad),
      r1: Math.min(lm.n_tiles_y - 1, Math.ceil(y1 / TILE) - 1 + pad),
    };
  }

  const tileKey = (l, r, c) => `${l}-${r}-${c}`;

  function tileScreenRect(level, row, col, transform) {
    const { scale, ox, oy } = transform;
    const l0 = currentMeta.levels[0];
    const lm = currentMeta.levels[level];
    const ds = l0.width / lm.width;
    const sx = col * TILE * ds * scale + ox;
    const sy = row * TILE * ds * scale + oy;
    const sw = TILE * ds * scale;
    return { sx, sy, sw };
  }

  // ── composite builder ─────────────────────────────────────────────────────
  // Build an RGBA TILE×TILE canvas from the cached grayscale data for all
  // enabled channels using additive (fluorescence) blending.
  function buildComposite(key) {
    const R = new Float32Array(TILE * TILE);
    const G = new Float32Array(TILE * TILE);
    const B = new Float32Array(TILE * TILE);
    let any = false;

    for (let ch = 0; ch < chState.length; ch++) {
      if (!chState[ch].enabled) continue;
      const entry = grayCache[ch].get(key);
      if (!entry) continue;
      any = true;
      entry.lastUsed = Date.now();

      const hex = chState[ch].color.replace('#', '');
      const cr  = parseInt(hex.slice(0, 2), 16) / 255 * chState[ch].opacity;
      const cg  = parseInt(hex.slice(2, 4), 16) / 255 * chState[ch].opacity;
      const cb  = parseInt(hex.slice(4, 6), 16) / 255 * chState[ch].opacity;
      const gray = entry.gray;

      // The server encodes: gray8 = clamp((raw - p1) / (p99 - p1), 0, 1) * 255
      // The user sets a display window [vmin, vmax] in raw units.
      // We want: v = clamp((raw - vmin) / (vmax - vmin), 0, 1)
      // Substituting raw ≈ gray8/255*(p99-p1)+p1:
      //   v = clamp(a*gray8 + b, 0, 1)
      // where:
      //   a = (p99 - p1) / (255 * winSpan)
      //   b = (p1 - vmin) / winSpan
      const [p1, p99]  = currentMeta.channel_ranges[ch];
      const winSpan    = (chState[ch].intensityMax - chState[ch].intensityMin) || 1;
      const a          = (p99 - p1) / (255 * winSpan);
      const b          = (p1 - chState[ch].intensityMin) / winSpan;

      for (let i = 0; i < TILE * TILE; i++) {
        const v = Math.max(0, Math.min(1, a * gray[i] + b));
        R[i] += v * cr;
        G[i] += v * cg;
        B[i] += v * cb;
      }
    }
    if (!any) return null;

    const pixels = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < TILE * TILE; i++) {
      const r = R[i] * 255;
      const g = G[i] * 255;
      const b = B[i] * 255;
      pixels[i * 4]     = r;
      pixels[i * 4 + 1] = g;
      pixels[i * 4 + 2] = b;
      pixels[i * 4 + 3] = Math.min(255, Math.max(r, g, b));
    }
    const tc = document.createElement('canvas');
    tc.width = tc.height = TILE;
    tc.getContext('2d').putImageData(new ImageData(pixels, TILE, TILE), 0, 0);
    return tc;
  }

  function getComposite(key) {
    if (compCache.has(key)) return compCache.get(key);
    const tc = buildComposite(key);
    if (!tc) return null;
    const enabledCount = chState.filter(s => s.enabled).length || 1;
    const compFloor = wantedKeys.size + 10;
    const compCap = Math.max(MAX_COMP_CACHED, compFloor);
    if (compCache.size >= compCap) {
      // Evict oldest entry that is not in the current viewport.
      for (const k of compCache.keys()) {
        if (!wantedKeys.has(k)) { compCache.delete(k); break; }
      }
    }
    compCache.set(key, tc);
    return tc;
  }

  function invalidateComposites() {
    compCache.clear();
  }

  // ── RGB tile fetcher (fallback when n_channels === 0) ───────────────────
  function fetchRgbTile(level, row, col) {
    const k = tileKey(level, row, col);
    if (_rgbCache.has(k) || _rgbInflight.has(k)) return;
    const ctrl = new AbortController();
    _rgbInflight.set(k, ctrl);
    const sq  = activeSample ? `&sample=${encodeURIComponent(activeSample)}` : '';
    const url = `${baseUrl}/tile?level=${level}&row=${row}&col=${col}${sq}`;
    fetch(url, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then(blob => {
        _rgbInflight.delete(k);
        const img = new Image();
        img.onload = () => { _rgbCache.set(k, img); scheduleRedraw(); };
        img.src = URL.createObjectURL(blob);
      })
      .catch(() => { _rgbInflight.delete(k); });
  }

  // ── tile fetcher ──────────────────────────────────────────────────────────
  function fetchTile(ch, level, row, col) {
    const k = tileKey(level, row, col);
    if (grayCache[ch].has(k) || inflights[ch].has(k)) return;

    const ctrl = new AbortController();
    inflights[ch].set(k, ctrl);

    const sq  = activeSample ? `&sample=${encodeURIComponent(activeSample)}` : '';
    const url = `${baseUrl}/channel_tile?channel=${ch}&level=${level}&row=${row}&col=${col}${sq}`;

    fetch(url, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then(blob => {
        inflights[ch].delete(k);
        const img = new Image();
        img.onload = () => {
          // Extract the R channel from the decoded grayscale PNG as a Uint8Array
          const tmp = document.createElement('canvas');
          tmp.width = tmp.height = TILE;
          tmp.getContext('2d').drawImage(img, 0, 0, TILE, TILE);
          const id   = tmp.getContext('2d').getImageData(0, 0, TILE, TILE);
          const gray = new Uint8Array(TILE * TILE);
          for (let i = 0; i < TILE * TILE; i++) gray[i] = id.data[i * 4];

          grayCache[ch].set(k, { gray, lastUsed: Date.now() });
          compCache.delete(k);   // force rebuild of composite for this tile
          evictGray();
          scheduleRedraw();
          URL.revokeObjectURL(img.src);
        };
        img.src = URL.createObjectURL(blob);
      })
      .catch(() => { inflights[ch].delete(k); });
  }

  function evictGray() {
    let total = 0;
    for (const m of grayCache) total += m.size;
    const enabledCount = chState.filter(s => s.enabled).length || 1;
    const grayFloor = wantedKeys.size * enabledCount + 10;
    const grayMax = Math.max(MAX_GRAY_TOTAL, grayFloor);
    if (total <= grayMax) return;
    // Collect all entries across every channel, evict LRU first.
    // Never evict a tile whose key is currently needed by the viewport.
    const all = [];
    for (let ch = 0; ch < chState.length; ch++)
      for (const [k, v] of grayCache[ch]) all.push({ ch, k, t: v.lastUsed });
    all.sort((a, b) => a.t - b.t);
    let toRemove = total - grayMax;
    for (const e of all) {
      if (toRemove <= 0) break;
      if (wantedKeys.has(e.k)) continue;
      grayCache[e.ch].delete(e.k);
      compCache.delete(e.k);
      toRemove--;
    }
  }

  // ── redraw ────────────────────────────────────────────────────────────────
  function redraw(transform) {
    const level = bestLevel(transform.scale);
    currentLevel = level;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const visOnly = visibleRange(level, transform, 0);
    const visPre  = visibleRange(level, transform, 1);
    wantedKeys = new Set();
    for (let r = visPre.r0; r <= visPre.r1; r++)
      for (let c = visPre.c0; c <= visPre.c1; c++)
        wantedKeys.add(tileKey(level, r, c));

    if (_rgbMode) {
      // ── RGB fallback: draw cached JPEG tiles directly ─────────────────────
      for (let r = visOnly.r0; r <= visOnly.r1; r++) {
        for (let c = visOnly.c0; c <= visOnly.c1; c++) {
          const k = tileKey(level, r, c);
          const img = _rgbCache.get(k);
          if (img) {
            const { sx, sy, sw } = tileScreenRect(level, r, c, transform);
            ctx.drawImage(img, sx, sy, sw, sw);
          }
        }
      }
      // Abort stale RGB inflights
      for (const [k, ctrl] of [..._rgbInflight]) {
        if (parseInt(k.split('-')[0], 10) !== level || !wantedKeys.has(k)) {
          ctrl.abort();
          _rgbInflight.delete(k);
        }
      }
      for (let r = visOnly.r0; r <= visOnly.r1; r++)
        for (let c = visOnly.c0; c <= visOnly.c1; c++)
          fetchRgbTile(level, r, c);
      for (let r = visPre.r0; r <= visPre.r1; r++)
        for (let c = visPre.c0; c <= visPre.c1; c++)
          fetchRgbTile(level, r, c);
      return;
    }

    const vis = visOnly;
    for (let r = vis.r0; r <= vis.r1; r++) {
      for (let c = vis.c0; c <= vis.c1; c++) {
        const k  = tileKey(level, r, c);
        const tc = getComposite(k);
        if (!tc) continue;
        const { sx, sy, sw } = tileScreenRect(level, r, c, transform);
        ctx.drawImage(tc, sx, sy, sw, sw);
      }
    }

    // Abort stale inflight requests: wrong level OR outside visible+prefetch set.
    // Then fetch visible tiles first (phase 1) and prefetch border second (phase 2).
    for (let ch = 0; ch < chState.length; ch++) {
      if (!chState[ch].enabled) continue;
      // Abort inflight requests that are stale (wrong level or no longer wanted)
      for (const [k, ctrl] of [...inflights[ch]]) {
        if (parseInt(k.split('-')[0], 10) !== level || !wantedKeys.has(k)) {
          ctrl.abort();
          inflights[ch].delete(k);
        }
      }
      // Phase 1: strictly visible tiles
      for (let r = visOnly.r0; r <= visOnly.r1; r++)
        for (let c = visOnly.c0; c <= visOnly.c1; c++)
          fetchTile(ch, level, r, c);
      // Phase 2: prefetch border
      for (let r = visPre.r0; r <= visPre.r1; r++)
        for (let c = visPre.c0; c <= visPre.c1; c++)
          fetchTile(ch, level, r, c);
    }
  }

  function scheduleRedraw() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      redraw(pendingXform || viewport.getTransform());
      pendingXform = null;
    });
  }

  viewport.onChange(t => { pendingXform = t; scheduleRedraw(); });

  // ── channel control panel ─────────────────────────────────────────────────
  // Positioned at top-right of the viewer root element.
  // The drop-down list contains one row per channel with:
  //   [checkbox] [name] [colour picker] [brightness slider]
  const panel = document.createElement('div');
  panel.dataset.ivUi = 'true';
  panel.dataset.demoId = 'channel-panel';
  panel.style.cssText = [
    'position:absolute', 'top:8px', 'right:8px', 'z-index:12',
    'font:12px monospace', 'text-align:right',
  ].join(';');

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Channels \u25be';
  toggleBtn.title = 'Show / hide channel controls';
  toggleBtn.style.cssText = [
    'background:rgba(0,0,0,0.60)', 'border:1px solid #555',
    'color:#eee', 'border-radius:6px', 'padding:4px 8px',
    'cursor:pointer', 'font:12px monospace', 'white-space:nowrap',
  ].join(';');
  panel.appendChild(toggleBtn);

  // createDualRangeSlider is now module-level (defined above createMultichannelTiles).
  // Keep a local alias so the rest of this closure can call it without change.
  // (The function identifier is already in scope via the module-level declaration.)
  void createDualRangeSlider; // reference to suppress unused-var linters
  function _localDualRangeAlias(rawMin, rawMax, defaultLo, defaultHi, onChange) {
    if (!document.querySelector('style[data-iv-dual-range]')) {
      const s = document.createElement('style');
      s.dataset.ivDualRange = '';
      s.textContent = [
        '.iv-dr{position:absolute;top:0;left:0;width:100%;height:20px;',
        'margin:0;padding:0;background:transparent;',
        '-webkit-appearance:none;appearance:none;pointer-events:none;}',
        '.iv-dr::-webkit-slider-runnable-track{background:transparent;height:4px;}',
        '.iv-dr::-moz-range-track{background:transparent;height:4px;}',
        '.iv-dr::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
        'width:11px;height:11px;border-radius:50%;',
        'background:#bbb;border:1.5px solid #777;',
        'cursor:pointer;pointer-events:all;margin-top:-3px;}',
        '.iv-dr::-moz-range-thumb{width:11px;height:11px;border-radius:50%;',
        'background:#bbb;border:1.5px solid #777;cursor:pointer;pointer-events:all;}',
      ].join('');
      document.head.appendChild(s);
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:96px;height:20px;flex-shrink:0;';

    const track = document.createElement('div');
    track.style.cssText = [
      'position:absolute', 'top:8px', 'left:4px', 'right:4px',
      'height:4px', 'background:#2a2a2a', 'border-radius:2px', 'pointer-events:none',
    ].join(';');
    const fill = document.createElement('div');
    fill.style.cssText = 'position:absolute;top:0;height:100%;background:#686868;border-radius:2px;';
    track.appendChild(fill);
    wrap.appendChild(track);

    const step = rawMax > rawMin ? (rawMax - rawMin) / 1000 : 1;

    const inputLo = document.createElement('input');
    inputLo.type      = 'range';
    inputLo.className = 'iv-dr';
    inputLo.style.zIndex = '2';

    const inputHi = document.createElement('input');
    inputHi.type      = 'range';
    inputHi.className = 'iv-dr';
    inputHi.style.zIndex = '3';

    for (const inp of [inputLo, inputHi]) {
      inp.min  = String(rawMin);
      inp.max  = String(rawMax);
      inp.step = String(step);
    }
    inputLo.value = String(Math.max(rawMin, Math.min(rawMax, defaultLo)));
    inputHi.value = String(Math.max(rawMin, Math.min(rawMax, defaultHi)));

    function updateFill() {
      const lo = parseFloat(inputLo.value);
      const hi = parseFloat(inputHi.value);
      const span = rawMax - rawMin;
      const loF  = span > 0 ? (lo - rawMin) / span : 0;
      const hiF  = span > 0 ? (hi - rawMin) / span : 1;
      fill.style.left  = (loF * 100).toFixed(2) + '%';
      fill.style.width = ((hiF - loF) * 100).toFixed(2) + '%';
      wrap.title = `min: ${lo.toFixed(1)}  max: ${hi.toFixed(1)}`;
    }

    inputLo.addEventListener('input', () => {
      if (parseFloat(inputLo.value) > parseFloat(inputHi.value))
        inputLo.value = inputHi.value;
      updateFill();
      onChange(parseFloat(inputLo.value), parseFloat(inputHi.value));
    });
    inputHi.addEventListener('input', () => {
      if (parseFloat(inputHi.value) < parseFloat(inputLo.value))
        inputHi.value = inputLo.value;
      updateFill();
      onChange(parseFloat(inputLo.value), parseFloat(inputHi.value));
    });

    wrap.appendChild(inputLo);
    wrap.appendChild(inputHi);
    updateFill();
    return wrap;
  }
  // End of _localDualRangeAlias — replace all internal calls with the module-level function.
  // (This local alias is never actually called; the code below uses createDualRangeSlider directly.)

  const dropdown = document.createElement('div');
  dropdown.style.cssText = [
    'display:none', 'margin-top:4px',
    'background:rgba(12,12,12,0.92)', 'border:1px solid #444',
    'border-radius:6px', 'padding:6px 8px',
    'max-height:340px', 'overflow-y:auto', 'min-width:340px',
    'text-align:left',
  ].join(';');
  panel.appendChild(dropdown);

  function _closeChannelsPanel() {
    dropdown.style.display = 'none';
    toggleBtn.textContent  = 'Channels \u25be';
    document.removeEventListener('keydown', _channelsPanelKeydown, true);
  }
  function _channelsPanelKeydown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      _closeChannelsPanel();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }
  toggleBtn.addEventListener('click', () => {
    const open = dropdown.style.display !== 'none';
    if (open) {
      _closeChannelsPanel();
    } else {
      dropdown.style.display = 'block';
      toggleBtn.textContent  = 'Channels \u25b4';
      document.addEventListener('keydown', _channelsPanelKeydown, true);
    }
  });

  function _buildChannelPanel(m) {
    // Rebuild chState/grayCache/inflights for the new channel count
    const nCh = m.n_channels || 0;
    // Abort any in-flight requests from before rebuild
    for (let ch = 0; ch < inflights.length; ch++)
      for (const [, ctrl] of inflights[ch]) ctrl.abort();

    // Build default state, then restore saved state for this sample if available
    const defaultState = Array.from({ length: nCh }, (_, i) => ({
      enabled      : i === 0,
      color        : DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      opacity      : 1.0,
      intensityMin : m.channel_ranges[i][0],
      intensityMax : m.channel_ranges[i][1],
    }));
    const saved = chStateCache[activeSample];
    chState = (saved && saved.length === nCh)
      ? saved.map((s, i) => Object.assign({}, defaultState[i], s))
      : defaultState;

    grayCache = Array.from({ length: nCh }, () => new Map());
    inflights = Array.from({ length: nCh }, () => new Map());
    compCache.clear();
    _rgbMode = nCh === 0;

    // Hide panel when there are no channels (e.g. RGB image)
    panel.style.display = nCh > 0 ? '' : 'none';
    dropdown.innerHTML  = '';
    _closeChannelsPanel();

    const chNames = m.channel_names || Array.from({ length: nCh }, (_, i) => 'Channel ' + i);
    const channelFullRanges = m.channel_full_ranges || [];

    for (let ch = 0; ch < nCh; ch++) {
      const row = document.createElement('div');
      row.style.cssText = [
        'display:flex', 'align-items:center', 'gap:6px',
        'padding:4px 0',
        'border-bottom:1px solid #222',
      ].join(';');

      const chk = document.createElement('input');
      chk.type    = 'checkbox';
      chk.checked = chState[ch].enabled;
      chk.title   = `Toggle ${chNames[ch]}`;
      chk.style.cssText = 'cursor:pointer;flex-shrink:0;';

      const label = document.createElement('span');
      label.textContent = chNames[ch];
      label.style.cssText = [
        'flex:1', 'min-width:0', 'overflow:hidden',
        'text-overflow:ellipsis', 'white-space:nowrap', 'color:#ddd',
      ].join(';');

      // Small colour swatch driven by the colour picker
      const swatch = document.createElement('span');
      swatch.style.cssText = [
        'display:inline-block', 'width:10px', 'height:10px',
        'border-radius:50%', 'border:1px solid #666', 'flex-shrink:0',
        'background:' + chState[ch].color,
      ].join(';');

      const colorPicker = document.createElement('input');
      colorPicker.type  = 'color';
      colorPicker.value = chState[ch].color;
      colorPicker.title = 'Channel colour';
      colorPicker.style.cssText = [
        'width:22px', 'height:22px', 'border:none', 'background:none',
        'padding:0', 'cursor:pointer', 'flex-shrink:0',
      ].join(';');

      const opSlider = document.createElement('input');
      opSlider.type  = 'range';
      opSlider.min   = '0';
      opSlider.max   = '1';
      opSlider.step  = '0.05';
      opSlider.value = String(chState[ch].opacity);
      opSlider.title = 'Brightness / contribution';
      opSlider.style.cssText = 'width:64px;flex-shrink:0;';

      // ── event listeners ────────────────────────────────────────────────────
      chk.addEventListener('change', () => {
        chState[ch].enabled = chk.checked;
        invalidateComposites();
        scheduleRedraw();
      });

      colorPicker.addEventListener('input', () => {
        chState[ch].color = colorPicker.value;
        swatch.style.background = colorPicker.value;
        invalidateComposites();
        scheduleRedraw();
      });

      opSlider.addEventListener('input', () => {
        chState[ch].opacity = parseFloat(opSlider.value);
        invalidateComposites();
        scheduleRedraw();
      });

      const [rawMin, rawMax] = channelFullRanges[ch] || [0, 255];
      const rangeSlider = createDualRangeSlider(rawMin, rawMax, chState[ch].intensityMin, chState[ch].intensityMax, (lo, hi) => {
        chState[ch].intensityMin = lo;
        chState[ch].intensityMax = hi;
        invalidateComposites();
        scheduleRedraw();
      });

      row.appendChild(chk);
      row.appendChild(label);
      row.appendChild(swatch);
      row.appendChild(colorPicker);
      row.appendChild(opSlider);
      row.appendChild(rangeSlider);
      dropdown.appendChild(row);
    }
  }

  _buildChannelPanel(meta);

  root.appendChild(panel);

  // ── public API ────────────────────────────────────────────────────────────
  function _clearAllCaches() {
    for (let ch = 0; ch < inflights.length; ch++) {
      for (const [, ctrl] of inflights[ch]) ctrl.abort();
      inflights[ch].clear();
      grayCache[ch].clear();
    }
    compCache.clear();
    for (const ctrl of _rgbInflight.values()) ctrl.abort();
    _rgbInflight.clear();
    _rgbCache.clear();
  }

  function setMeta(nextMeta) {
    currentMeta  = nextMeta;
    currentLevel = nextMeta.n_levels - 1;
    _buildChannelPanel(nextMeta);
    scheduleRedraw();
  }

  function setSample(nextSample) {
    // Save current channel state for the outgoing sample
    if (activeSample && chState.length > 0)
      chStateCache[activeSample] = chState.map(s => Object.assign({}, s));
    activeSample = nextSample;
    _clearAllCaches();
    scheduleRedraw();
  }

  scheduleRedraw();

  return {
    update   : scheduleRedraw,
    setMeta,
    setSample,
    // setLevel stub for API compatibility with tiles.js
    setLevel : () => {},
  };
}
