/**
 * monochannel2d.js
 * ─────────────────
 * Client-side rendering of single-channel (monochannel) image pyramids.
 *
 * Tiles are fetched as uint8 greyscale PNG from /mono_tile.
 * Pixel value 0 is always transparent.
 * A 256-entry RGBA look-up table (LUT) is fetched from /mono_lut and applied
 * to the raw grey data in an offscreen canvas to produce the final image.
 *
 * Two rendering modes:
 *   'palette' — discrete label → colour mapping (good for masks/annotations)
 *   'cmap'    — continuous colourmap with user-adjustable vmin/vmax (heatmaps)
 *
 * The primary tile layer div is hidden when this module is active; this canvas
 * replaces it visually.
 *
 * Exposes:
 *   createMono2D(monoCanvas, baseUrl, monoMeta, viewport, settings, getActiveSample, isSampleMono)
 *     → { setDisplaySettings, getDisplaySettings, getState, setState,
 *          setSample, redraw }
 */
function createMono2D(monoCanvas, baseUrl, monoMeta, viewport, settings, getActiveSample, isSampleMono) {
  const ctx = monoCanvas.getContext('2d');
  // isSampleMono(name) → bool — guards all fetches; defaults to always-true if omitted
  if (typeof isSampleMono !== 'function') isSampleMono = () => true;

  let ACTIVE_SAMPLE = getActiveSample();

  // ── display settings (see monochannel.py defaults) ──────────────────────────
  let _mode    = monoMeta.default_mode    || 'palette';        // 'palette' | 'cmap'
  let _cmap    = monoMeta.default_cmap    || 'viridis';
  let _palette = monoMeta.default_palette || 'tab20';
  let _colors  = monoMeta.default_colors  || 'sequential';     // 'sequential' | 'random'
  let _vmin    = (monoMeta.default_vmin != null) ? monoMeta.default_vmin : 0;
  let _vmax    = (monoMeta.default_vmax != null) ? monoMeta.default_vmax : 1;
  let _reversed = false;

  // Per-sample saved settings (restored when the user returns to a sample)
  const _settingsBySample = {};

  // ── LUT state ────────────────────────────────────────────────────────────────
  // Raw 256×4 RGBA from /mono_lut, keyed by cmap name
  const _rawLutCache = {};
  // Built display LUT for current settings (Uint8ClampedArray length 256*4)
  let _lut    = null;
  let _lutKey = null;  // string fingerprint of current settings

  // ── tile cache ───────────────────────────────────────────────────────────────
  // key → Uint8Array(TILE*TILE) of grey values
  const _tileCache = new Map();
  const _inFlight  = new Map();   // key → AbortController

  const TILE = monoMeta.tile_size;

  // ── LUT helpers ──────────────────────────────────────────────────────────────

  /**
   * Fetch the raw 256-entry RGBA LUT for a cmap name from the server.
   * Returns a Uint8Array of length 256*4.
   */
  async function _fetchRawLut(name) {
    if (_rawLutCache[name]) return _rawLutCache[name];
    const r = await fetch(
      baseUrl + '/mono_lut?cmap=' + encodeURIComponent(name)
    );
    if (!r.ok) throw new Error('LUT fetch failed: ' + r.status);
    const { lut } = await r.json();   // list of 256 [R,G,B,A] entries
    const arr = new Uint8Array(lut.length * 4);
    for (let i = 0; i < lut.length; i++) {
      arr[i * 4]     = lut[i][0];
      arr[i * 4 + 1] = lut[i][1];
      arr[i * 4 + 2] = lut[i][2];
      arr[i * 4 + 3] = lut[i][3];
    }
    _rawLutCache[name] = arr;
    return arr;
  }

  /**
   * Rebuild the display LUT from the current settings.
   * Index 0 is always [0,0,0,0] (transparent).
   */
  async function _buildLut() {
    const key = [_mode, _cmap, _palette, _colors, _vmin, _vmax, _reversed].join('|');
    if (key === _lutKey && _lut) return;
    _lutKey = key;

    const lut = new Uint8ClampedArray(256 * 4);
    lut[3] = 0; // index 0 → transparent (all four bytes default-zero already)

    const rawName = _mode === 'cmap' ? _cmap : _palette;
    const rawFetched = await _fetchRawLut(rawName);
    // Optionally reverse the LUT (entries 0-255; keep index 0 transparent later)
    let raw;
    if (_reversed) {
      raw = new Uint8Array(rawFetched.length);
      for (let i = 0; i < 256; i++) {
        const src = (255 - i) * 4;
        const dst = i * 4;
        raw[dst]     = rawFetched[src];
        raw[dst + 1] = rawFetched[src + 1];
        raw[dst + 2] = rawFetched[src + 2];
        raw[dst + 3] = rawFetched[src + 3];
      }
    } else {
      raw = rawFetched;
    }

    if (_mode === 'palette') {
      // Build N distinct palette colours by sampling the 256-entry raw LUT
      // at N evenly-spaced positions (N <= 255 unique label values).
      const N = 255;
      const paletteColors = [];
      for (let i = 0; i < N; i++) {
        // Use positions [1..255] so qualitative maps (tab10, tab20) aren't
        // sampled at 0 and 1 which can be the same hue.
        const pos = N > 1 ? i / (N - 1) : 0;
        const idx = Math.min(255, Math.round(pos * 255));
        paletteColors.push([raw[idx * 4], raw[idx * 4 + 1], raw[idx * 4 + 2]]);
      }
      if (_colors === 'random') {
        // Deterministic per-session shuffle using a simple LCG seeded from cmap name
        let seed = 0;
        for (let ci = 0; ci < rawName.length; ci++) seed = (seed * 31 + rawName.charCodeAt(ci)) | 0;
        seed = Math.abs(seed) + 1;
        for (let i = N - 1; i > 0; i--) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const j = seed % (i + 1);
          const tmp = paletteColors[i];
          paletteColors[i] = paletteColors[j];
          paletteColors[j] = tmp;
        }
      }
      for (let v = 1; v < 256; v++) {
        const c = paletteColors[(v - 1) % N];
        const b = v * 4;
        lut[b]     = c[0];
        lut[b + 1] = c[1];
        lut[b + 2] = c[2];
        lut[b + 3] = 255;
      }
    } else {
      // cmap mode: pixel value v in [1..254] encodes original float value.
      // monochannel.py maps non-zero floats: p1 -> 1, p99 -> 254.
      // Re-map using user vmin/vmax expressed in data units.
      const p1 = (monoMeta.p1 != null) ? monoMeta.p1 : monoMeta.data_min;
      const p99 = (monoMeta.p99 != null) ? monoMeta.p99 : monoMeta.data_max;
      const encSpan = Math.max(p99 - p1, 1e-9);  // encoding span matches monochannel.py
      const vmn = _vmin, vmx = _vmax;
      const dispSpan = Math.max(vmx - vmn, 1e-9);
      for (let v = 1; v < 255; v++) {
        // Decode: v=1 → p1, v=254 → p99 (linear)
        const origVal = p1 + (v - 1) / 253.0 * encSpan;
        // Map into display window [vmn, vmx] → LUT index [0..255]
        const t = Math.max(0, Math.min(1, (origVal - vmn) / dispSpan));
        const lutIdx = Math.round(t * 255);
        const b = v * 4;
        lut[b]     = raw[lutIdx * 4];
        lut[b + 1] = raw[lutIdx * 4 + 1];
        lut[b + 2] = raw[lutIdx * 4 + 2];
        lut[b + 3] = 255;
      }
    }

    _lut = lut;
  }

  // ── tile fetching ─────────────────────────────────────────────────────────────

  function _tileKey(sample, level, row, col) {
    return sample + '|' + level + '|' + row + '|' + col;
  }

  function _fetchTile(sample, level, row, col) {
    const k = _tileKey(sample, level, row, col);
    if (_tileCache.has(k) || _inFlight.has(k)) return;

    const ctrl = new AbortController();
    _inFlight.set(k, ctrl);

    fetch(
      baseUrl + '/mono_tile?sample=' + encodeURIComponent(sample)
        + '&level=' + level + '&row=' + row + '&col=' + col,
      { signal: ctrl.signal }
    )
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(blob => createImageBitmap(blob))
      .then(bmp => {
        const tmp = document.createElement('canvas');
        tmp.width = tmp.height = TILE;
        tmp.getContext('2d').drawImage(bmp, 0, 0, TILE, TILE);
        const id = tmp.getContext('2d').getImageData(0, 0, TILE, TILE);
        const gray = new Uint8Array(TILE * TILE);
        for (let i = 0; i < TILE * TILE; i++) gray[i] = id.data[i * 4]; // R = grey
        bmp.close && bmp.close();
        _inFlight.delete(k);
        _tileCache.set(k, gray);
        _redraw();
      })
      .catch(() => { _inFlight.delete(k); });
  }

  function _clearTileCache() {
    for (const ctrl of _inFlight.values()) ctrl.abort();
    _inFlight.clear();
    _tileCache.clear();
  }

  // ── drawing ───────────────────────────────────────────────────────────────────

  // Offscreen canvas for LUT application (reused each frame)
  const _offscreen = document.createElement('canvas');
  _offscreen.width = _offscreen.height = TILE;
  const _offCtx = _offscreen.getContext('2d');

  function _applyLutTile(gray) {
    // Build RGBA from grey values using the current LUT
    const rgba = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < TILE * TILE; i++) {
      const v = gray[i];
      const li = v * 4;
      rgba[i * 4]     = _lut[li];
      rgba[i * 4 + 1] = _lut[li + 1];
      rgba[i * 4 + 2] = _lut[li + 2];
      rgba[i * 4 + 3] = _lut[li + 3];
    }
    return rgba;
  }

  function _redraw() {
    ctx.clearRect(0, 0, monoCanvas.width, monoCanvas.height);
    // Do not fetch tiles for non-monochannel samples
    if (!isSampleMono(ACTIVE_SAMPLE)) return;
    if (!_lut) return;

    const t = viewport.getTransform();
    const { scale, ox, oy } = t;
    const vpW = monoCanvas.width;
    const vpH = monoCanvas.height;
    const levels = monoMeta.levels;
    const nLevels = monoMeta.n_levels;
    const sens = settings ? settings.get('levelSensitivity') : 1.0;

    let level = nLevels - 1;
    for (let i = 0; i < nLevels; i++) {
      if (scale >= sens / levels[i].downsample) { level = i; break; }
    }

    const lm = levels[level];
    const l0 = levels[0];
    const ds = l0.width / lm.width;

    // Visible tile range in level coordinates
    const x0 = Math.max(0, -ox / scale);
    const y0 = Math.max(0, -oy / scale);
    const x1 = Math.min(lm.width * ds, (vpW - ox) / scale);
    const y1 = Math.min(lm.height * ds, (vpH - oy) / scale);
    const c0 = Math.max(0, Math.floor(x0 / (TILE * ds)));
    const r0 = Math.max(0, Math.floor(y0 / (TILE * ds)));
    const c1 = Math.min(lm.n_tiles_x - 1, Math.floor(x1 / (TILE * ds)));
    const r1 = Math.min(lm.n_tiles_y - 1, Math.floor(y1 / (TILE * ds)));

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const k = _tileKey(ACTIVE_SAMPLE, level, row, col);
        const gray = _tileCache.get(k);
        if (!gray) { _fetchTile(ACTIVE_SAMPLE, level, row, col); continue; }

        const rgba = _applyLutTile(gray);
        _offCtx.putImageData(new ImageData(rgba, TILE, TILE), 0, 0);

        const sx = Math.floor(col * TILE * ds * scale + ox);
        const sy = Math.floor(row * TILE * ds * scale + oy);
        // Ceil to next tile boundary to avoid sub-pixel gaps between tiles.
        const sx1 = Math.floor((col + 1) * TILE * ds * scale + ox) + 1;
        const sy1 = Math.floor((row + 1) * TILE * ds * scale + oy) + 1;
        ctx.drawImage(_offscreen, sx, sy, sx1 - sx, sy1 - sy);
      }
    }
  }

  // ── public API ────────────────────────────────────────────────────────────────

  /**
   * Update display settings and re-render.
   * Any subset of { mode, cmap, palette, colors, vmin, vmax } may be passed.
   */
  async function setDisplaySettings(s) {
    let changed = false;
    if (s.mode    !== undefined && s.mode    !== _mode)    { _mode    = s.mode;           changed = true; }
    if (s.cmap    !== undefined && s.cmap    !== _cmap)    { _cmap    = s.cmap;           changed = true; }
    if (s.palette !== undefined && s.palette !== _palette) { _palette = s.palette;        changed = true; }
    if (s.colors  !== undefined && s.colors  !== _colors)  { _colors  = s.colors;         changed = true; }
    if (s.vmin     !== undefined && Number(s.vmin) !== _vmin)       { _vmin     = Number(s.vmin);   changed = true; }
    if (s.vmax     !== undefined && Number(s.vmax) !== _vmax)       { _vmax     = Number(s.vmax);   changed = true; }
    if (s.reversed !== undefined && !!s.reversed  !== _reversed)   { _reversed = !!s.reversed;     changed = true; }
    if (changed) {
      _lut = null; // invalidate
      await _buildLut();
      _redraw();
    }
  }

  function getDisplaySettings() {
    return { mode: _mode, cmap: _cmap, palette: _palette, colors: _colors, vmin: _vmin, vmax: _vmax, reversed: _reversed };
  }

  function getState()    { return getDisplaySettings(); }
  function setState(s)   { if (s) setDisplaySettings(s); }

  function setSample(name) {
    // Save settings for the outgoing sample
    _settingsBySample[ACTIVE_SAMPLE] = getDisplaySettings();
    // Abort any in-flight requests for the old sample
    for (const ctrl of _inFlight.values()) ctrl.abort();
    _inFlight.clear();
    ACTIVE_SAMPLE = name;
    // If this sample has no mono data, just clear the canvas and stop
    const ctx2 = monoCanvas.getContext('2d');
    ctx2.clearRect(0, 0, monoCanvas.width, monoCanvas.height);
    // Restore settings for the incoming sample (if previously visited)
    const saved = _settingsBySample[name];
    if (saved) {
      _mode = saved.mode; _cmap = saved.cmap; _palette = saved.palette;
      _colors = saved.colors; _vmin = saved.vmin; _vmax = saved.vmax;
      _reversed = !!saved.reversed;
      _lut = null;
    }
    _buildLut().then(() => _redraw()).catch(err => console.warn('[mono2d] LUT build failed:', err));
  }

  // Hook into viewport change events so the canvas stays in sync
  viewport.onChange(_redraw);

  // Initial build and draw
  _buildLut().then(() => _redraw()).catch(err => console.warn('[mono2d] LUT build failed:', err));

  return {
    setDisplaySettings,
    getDisplaySettings,
    getState,
    setState,
    setSample,
    redraw: _redraw,
  };
}
