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
function createMultichannelTiles(tileLayer, baseUrl, meta, viewport, sampleName) {
  const root   = tileLayer.parentElement;
  const TILE   = meta.tile_size;
  const N_CH   = meta.n_channels;
  const CH_NAMES = meta.channel_names;
  const MAX_GRAY_CACHED = 100;   // per-channel tile count cap
  const MAX_COMP_CACHED = 80;    // composite tile canvas count cap

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

  // Per-channel state: enabled, display colour, brightness (0–1)
  const chState = Array.from({ length: N_CH }, (_, i) => ({
    enabled : i === 0,
    color   : DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    opacity : 1.0,
  }));

  // ── caches ────────────────────────────────────────────────────────────────
  // grayCache[ch] maps tileKey → { gray: Uint8Array(TILE²), lastUsed: number }
  const grayCache  = Array.from({ length: N_CH }, () => new Map());
  // in-flight AbortControllers per channel
  const inflights  = Array.from({ length: N_CH }, () => new Map());
  // compCache maps tileKey → HTMLCanvasElement (composited TILE×TILE)
  const compCache  = new Map();

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

    for (let ch = 0; ch < N_CH; ch++) {
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

      for (let i = 0; i < TILE * TILE; i++) {
        const v = gray[i] / 255;
        R[i] += v * cr;
        G[i] += v * cg;
        B[i] += v * cb;
      }
    }
    if (!any) return null;

    const pixels = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < TILE * TILE; i++) {
      pixels[i * 4]     = R[i] * 255;
      pixels[i * 4 + 1] = G[i] * 255;
      pixels[i * 4 + 2] = B[i] * 255;
      pixels[i * 4 + 3] = 255;
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
    if (compCache.size >= MAX_COMP_CACHED) compCache.clear();
    compCache.set(key, tc);
    return tc;
  }

  function invalidateComposites() {
    compCache.clear();
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
          evictGray(ch);
          scheduleRedraw();
          URL.revokeObjectURL(img.src);
        };
        img.src = URL.createObjectURL(blob);
      })
      .catch(() => { inflights[ch].delete(k); });
  }

  function evictGray(ch) {
    const cache = grayCache[ch];
    if (cache.size <= MAX_GRAY_CACHED) return;
    const sorted = [...cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k] of sorted.slice(0, cache.size - MAX_GRAY_CACHED)) {
      cache.delete(k);
      compCache.delete(k);
    }
  }

  // ── redraw ────────────────────────────────────────────────────────────────
  function redraw(transform) {
    const level = bestLevel(transform.scale);
    currentLevel = level;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const vis = visibleRange(level, transform, 0);
    for (let r = vis.r0; r <= vis.r1; r++) {
      for (let c = vis.c0; c <= vis.c1; c++) {
        const k  = tileKey(level, r, c);
        const tc = getComposite(k);
        if (!tc) continue;
        const { sx, sy, sw } = tileScreenRect(level, r, c, transform);
        ctx.drawImage(tc, sx, sy, sw, sw);
      }
    }

    // Fetch visible tiles + one-tile prefetch border for all enabled channels
    const visPre = visibleRange(level, transform, 1);
    for (let ch = 0; ch < N_CH; ch++) {
      if (!chState[ch].enabled) continue;
      // Abort in-flight requests for wrong levels
      for (const [k, ctrl] of inflights[ch]) {
        if (parseInt(k.split('-')[0], 10) !== level) {
          ctrl.abort();
          inflights[ch].delete(k);
        }
      }
      for (let r = visPre.r0; r <= visPre.r1; r++) {
        for (let c = visPre.c0; c <= visPre.c1; c++) {
          fetchTile(ch, level, r, c);
        }
      }
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

  const dropdown = document.createElement('div');
  dropdown.style.cssText = [
    'display:none', 'margin-top:4px',
    'background:rgba(12,12,12,0.92)', 'border:1px solid #444',
    'border-radius:6px', 'padding:6px 8px',
    'max-height:340px', 'overflow-y:auto', 'min-width:264px',
    'text-align:left',
  ].join(';');
  panel.appendChild(dropdown);

  toggleBtn.addEventListener('click', () => {
    const open = dropdown.style.display !== 'none';
    dropdown.style.display = open ? 'none' : 'block';
    toggleBtn.textContent  = open ? 'Channels \u25be' : 'Channels \u25b4';
  });

  for (let ch = 0; ch < N_CH; ch++) {
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex', 'align-items:center', 'gap:6px',
      'padding:4px 0',
      'border-bottom:1px solid #222',
    ].join(';');

    const chk = document.createElement('input');
    chk.type    = 'checkbox';
    chk.checked = chState[ch].enabled;
    chk.title   = `Toggle ${CH_NAMES[ch]}`;
    chk.style.cssText = 'cursor:pointer;flex-shrink:0;';

    const label = document.createElement('span');
    label.textContent = CH_NAMES[ch];
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

    row.appendChild(chk);
    row.appendChild(label);
    row.appendChild(swatch);
    row.appendChild(colorPicker);
    row.appendChild(opSlider);
    dropdown.appendChild(row);
  }

  root.appendChild(panel);

  // ── public API ────────────────────────────────────────────────────────────
  function _clearAllCaches() {
    for (let ch = 0; ch < N_CH; ch++) {
      for (const [, ctrl] of inflights[ch]) ctrl.abort();
      inflights[ch].clear();
      grayCache[ch].clear();
    }
    compCache.clear();
  }

  function setMeta(nextMeta) {
    currentMeta  = nextMeta;
    currentLevel = nextMeta.n_levels - 1;
    _clearAllCaches();
    scheduleRedraw();
  }

  function setSample(nextSample) {
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
