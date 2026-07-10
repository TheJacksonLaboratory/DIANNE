/**
 * secondary_layer.js
 *
 * Manages the secondary image canvas: RGB tile cache, multichannel channel
 * state (_secChState), composite building, drawing (_drawSecondaryLayer),
 * and the secondary-channel dropdown panel.
 *
 * Exposes:
 *   createSecondaryLayer({
 *     root, viewport, settings,
 *     ACTIVE_SAMPLE_REF,
 *     SAMPLE_SECONDARY_META, SAMPLE_SECONDARY_MATRIX,
 *     getSecondaryFetchEnabled,
 *     BASE_URL,
 *   })
 *   → {
 *       secondaryCanvas, secCtx,
 *       drawSecondaryLayer,
 *       initSecChState, buildSecChPanel,
 *       getSecChDropdown,
 *       getSecRgbInFlight, getSecChInFlight,
 *       secCompCache,
 *     }
 */
function createSecondaryLayer({
  root, viewport, settings,
  ACTIVE_SAMPLE_REF,
  SAMPLE_SECONDARY_META, SAMPLE_SECONDARY_MATRIX,
  getSecondaryFetchEnabled,
  BASE_URL,
}) {
  // secondary image canvas — inserted before tileLayer so it renders behind primary tiles
  const secondaryCanvas = document.createElement('canvas');
  secondaryCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;';
  root.appendChild(secondaryCanvas);
  const secCtx = secondaryCanvas.getContext('2d');

  // RGB secondary: one img per tile
  const _secRgbCache    = new Map();
  const _secRgbInFlight = new Map();
  // Multichannel secondary state
  const SEC_CH_COLORS = ['#4488ff','#00ff44','#ff2222','#ffff00','#00ffff','#ff00ff','#ff8800','#ff0088'];
  let _secChState    = [];
  let _secGrayCache  = [];
  let _secChInFlight = [];
  const _secCompCache = new Map();

  function initSecChState() {
    const ACTIVE_SAMPLE = ACTIVE_SAMPLE_REF();
    for (const m of _secChInFlight) for (const ctrl of m.values()) ctrl.abort();
    _secChInFlight = [];
    for (const [, en] of _secRgbCache) { if (en.img && en.img.src.startsWith('blob:')) URL.revokeObjectURL(en.img.src); }
    _secRgbCache.clear();
    for (const ctrl of _secRgbInFlight.values()) ctrl.abort();
    _secRgbInFlight.clear();
    _secCompCache.clear();
    const secMeta = SAMPLE_SECONDARY_META[ACTIVE_SAMPLE];
    if (!secMeta || !secMeta.n_channels) { _secChState = []; _secGrayCache = []; return; }
    const N = secMeta.n_channels;
    _secChState = Array.from({length: N}, (_, i) => ({
      enabled: i === 0,
      color: SEC_CH_COLORS[i % SEC_CH_COLORS.length],
      opacity: 1.0,
      intensityMin: secMeta.channel_ranges[i][0],
      intensityMax: secMeta.channel_ranges[i][1],
    }));
    _secGrayCache  = Array.from({length: N}, () => new Map());
    _secChInFlight = Array.from({length: N}, () => new Map());
  }

  function _buildSecComposite(key, secMeta) {
    const N = _secChState.length;
    const T = secMeta.tile_size;
    const R = new Float32Array(T * T), G = new Float32Array(T * T), B = new Float32Array(T * T);
    let any = false;
    for (let ch = 0; ch < N; ch++) {
      if (!_secChState[ch].enabled) continue;
      const entry = _secGrayCache[ch].get(key);
      if (!entry) continue;
      any = true;
      entry.lastUsed = Date.now();
      const hex = _secChState[ch].color.replace('#', '');
      const cr = parseInt(hex.slice(0,2),16)/255 * _secChState[ch].opacity;
      const cg = parseInt(hex.slice(2,4),16)/255 * _secChState[ch].opacity;
      const cb = parseInt(hex.slice(4,6),16)/255 * _secChState[ch].opacity;
      const gray = entry.gray;
      const [p1, p99] = secMeta.channel_ranges[ch];
      const span = p99 - p1;
      const lo8 = Math.max(0, Math.min(255, (_secChState[ch].intensityMin - p1) / span * 255));
      const hi8 = Math.max(0, Math.min(255, (_secChState[ch].intensityMax - p1) / span * 255));
      const win = Math.max(1, hi8 - lo8);
      for (let i = 0; i < T * T; i++) {
        const v = Math.max(0, Math.min(1, (gray[i] - lo8) / win));
        R[i] += v * cr; G[i] += v * cg; B[i] += v * cb;
      }
    }
    if (!any) return null;
    const pixels = new Uint8ClampedArray(T * T * 4);
    for (let i = 0; i < T * T; i++) {
      const r = Math.min(255, R[i]*255), g = Math.min(255, G[i]*255), b = Math.min(255, B[i]*255);
      pixels[i*4] = r; pixels[i*4+1] = g; pixels[i*4+2] = b;
      pixels[i*4+3] = Math.min(255, Math.max(r, g, b));
    }
    const tc = document.createElement('canvas');
    tc.width = tc.height = T;
    tc.getContext('2d').putImageData(new ImageData(pixels, T, T), 0, 0);
    return tc;
  }

  function _resizeSecCanvas() {
    secondaryCanvas.width  = root.clientWidth  || 1;
    secondaryCanvas.height = root.clientHeight || 1;
    drawSecondaryLayer(viewport.getTransform());
  }
  new ResizeObserver(_resizeSecCanvas).observe(root);
  _resizeSecCanvas();

  function drawSecondaryLayer(t) {
    const ACTIVE_SAMPLE = ACTIVE_SAMPLE_REF();
    const { scale, ox, oy } = t;
    const secMeta = SAMPLE_SECONDARY_META[ACTIVE_SAMPLE];
    secCtx.clearRect(0, 0, secondaryCanvas.width, secondaryCanvas.height);
    if (!secMeta || !getSecondaryFetchEnabled()) return;
    const isSecMC = !!(secMeta.n_channels);
    const mat     = SAMPLE_SECONDARY_MATRIX[ACTIVE_SAMPLE];
    const SECTILE = secMeta.tile_size;
    let secLevel = secMeta.n_levels - 1;
    const _secSens = settings ? settings.get('levelSensitivity') : 1.0;
    for (let i = 0; i < secMeta.n_levels; i++) {
      if (scale >= _secSens / secMeta.levels[i].downsample) { secLevel = i; break; }
    }
    const lm    = secMeta.levels[secLevel];
    const l0sec = secMeta.levels[0];
    const dsSec = l0sec.width / lm.width;
    const vpW = secondaryCanvas.width, vpH = secondaryCanvas.height;
    let c0, r0, c1, r1;
    if (mat) {
      const corners = [
        viewport.toImageSpace(0,0),   viewport.toImageSpace(vpW,0),
        viewport.toImageSpace(0,vpH), viewport.toImageSpace(vpW,vpH),
      ];
      const sxs = corners.map(p => mat.mi00*(p.x-mat.tx) + mat.mi01*(p.y-mat.ty));
      const sys = corners.map(p => mat.mi10*(p.x-mat.tx) + mat.mi11*(p.y-mat.ty));
      const minSX = Math.min(...sxs)/dsSec, maxSX = Math.max(...sxs)/dsSec;
      const minSY = Math.min(...sys)/dsSec, maxSY = Math.max(...sys)/dsSec;
      c0 = Math.max(0, Math.floor(minSX/SECTILE) - 1);
      r0 = Math.max(0, Math.floor(minSY/SECTILE) - 1);
      c1 = Math.min(lm.n_tiles_x - 1, Math.ceil(maxSX/SECTILE));
      r1 = Math.min(lm.n_tiles_y - 1, Math.ceil(maxSY/SECTILE));
    } else {
      const x0 = Math.max(0, (-ox/scale)/dsSec), y0 = Math.max(0, (-oy/scale)/dsSec);
      const x1 = Math.min(lm.width,  ((vpW-ox)/scale)/dsSec);
      const y1 = Math.min(lm.height, ((vpH-oy)/scale)/dsSec);
      c0 = Math.max(0, Math.floor(x0/SECTILE)); r0 = Math.max(0, Math.floor(y0/SECTILE));
      c1 = Math.min(lm.n_tiles_x - 1, Math.floor(x1/SECTILE));
      r1 = Math.min(lm.n_tiles_y - 1, Math.floor(y1/SECTILE));
    }
    // Extra fractional pixel added to tile size to prevent sub-pixel stitching gaps (no-matrix path).
    const _SEC_OVERLAP = 1;
    const _applyTileTransform = (row, col) => {
      if (mat) {
        const a  = mat.m00*SECTILE*dsSec*scale, b  = mat.m10*SECTILE*dsSec*scale;
        const cm = mat.m01*SECTILE*dsSec*scale, d  = mat.m11*SECTILE*dsSec*scale;
        const e  = (mat.m00*col*SECTILE*dsSec + mat.m01*row*SECTILE*dsSec + mat.tx)*scale + ox;
        const f  = (mat.m10*col*SECTILE*dsSec + mat.m11*row*SECTILE*dsSec + mat.ty)*scale + oy;
        secCtx.setTransform(a, b, cm, d, e, f);
      } else {
        const sx  = Math.floor(col*SECTILE*dsSec*scale + ox);
        const sy  = Math.floor(row*SECTILE*dsSec*scale + oy);
        const sw  = Math.floor((col+1)*SECTILE*dsSec*scale + ox) + _SEC_OVERLAP - sx;
        const sh  = Math.floor((row+1)*SECTILE*dsSec*scale + oy) + _SEC_OVERLAP - sy;
        secCtx.setTransform(sw, 0, 0, sh, sx, sy);
      }
    };
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const k = ACTIVE_SAMPLE + '|' + secLevel + '|' + row + '|' + col;
        if (isSecMC) {
          const N = _secChState.length;
          for (let ch = 0; ch < N; ch++) {
            if (!_secChState[ch].enabled) continue;
            if (_secGrayCache[ch].has(k) || _secChInFlight[ch].has(k)) continue;
            const ctrl = new AbortController();
            _secChInFlight[ch].set(k, ctrl);
            fetch(BASE_URL + '/secondary_channel_tile?sample=' + encodeURIComponent(ACTIVE_SAMPLE)
                + '&channel=' + ch + '&level=' + secLevel + '&row=' + row + '&col=' + col,
              { signal: ctrl.signal })
              .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
              .then(blob => {
                _secChInFlight[ch].delete(k);
                const img = new Image();
                img.onload = () => {
                  const T2 = secMeta.tile_size;
                  const tmp = document.createElement('canvas');
                  tmp.width = tmp.height = T2;
                  tmp.getContext('2d').drawImage(img, 0, 0, T2, T2);
                  const id = tmp.getContext('2d').getImageData(0, 0, T2, T2);
                  const gray = new Uint8Array(T2 * T2);
                  for (let i = 0; i < gray.length; i++) gray[i] = id.data[i * 4];
                  _secGrayCache[ch].set(k, { gray, lastUsed: Date.now() });
                  _secCompCache.delete(k);
                  drawSecondaryLayer(viewport.getTransform());
                  URL.revokeObjectURL(img.src);
                };
                img.src = URL.createObjectURL(blob);
              })
              .catch(() => { _secChInFlight[ch].delete(k); });
          }
          let tc = _secCompCache.get(k);
          if (!tc) {
            tc = _buildSecComposite(k, secMeta);
            if (tc) { if (_secCompCache.size > 200) _secCompCache.clear(); _secCompCache.set(k, tc); }
          }
          if (!tc) continue;
          secCtx.save(); _applyTileTransform(row, col); secCtx.drawImage(tc, 0, 0, 1, 1); secCtx.restore();
        } else {
          if (_secRgbCache.size > 300) {
            let ev = 0;
            for (const [rk, en] of _secRgbCache) {
              if (ev >= 100) break;
              if (en.img && en.img.src.startsWith('blob:')) URL.revokeObjectURL(en.img.src);
              _secRgbCache.delete(rk); ev++;
            }
          }
          let entry = _secRgbCache.get(k);
          if (!entry) {
            const ctrl = new AbortController();
            _secRgbInFlight.set(k, ctrl);
            const img = new Image();
            entry = { img, ready: false };
            _secRgbCache.set(k, entry);
            fetch(BASE_URL + '/secondary_tile?sample=' + encodeURIComponent(ACTIVE_SAMPLE)
                + '&level=' + secLevel + '&row=' + row + '&col=' + col
                + '&quality=' + Math.round(settings.get('jpegQuality')),
              { signal: ctrl.signal })
              .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
              .then(blob => {
                _secRgbInFlight.delete(k);
                img.onload = () => { entry.ready = true; drawSecondaryLayer(viewport.getTransform()); };
                img.src = URL.createObjectURL(blob);
              })
              .catch(() => { _secRgbInFlight.delete(k); });
            continue;
          }
          if (!entry.ready) continue;
          secCtx.save(); _applyTileTransform(row, col); secCtx.drawImage(entry.img, 0, 0, 1, 1); secCtx.restore();
        }
      }
    }
  }

  // ── secondary channel dropdown panel ──────────────────────────────────────
  const _secChDropdown = document.createElement('div');
  _secChDropdown.style.cssText = [
    'display:none',
    'background:rgba(12,12,12,0.92)','border:1px solid #444',
    'border-radius:6px','padding:6px 8px',
    'max-height:340px','overflow-y:auto','min-width:340px','text-align:left',
  ].join(';');

  function buildSecChPanel() {
    const ACTIVE_SAMPLE = ACTIVE_SAMPLE_REF();
    _secChDropdown.innerHTML = '';
    const secMeta = SAMPLE_SECONDARY_META[ACTIVE_SAMPLE];
    if (!secMeta || !_secChState.length) return;
    const N = _secChState.length;
    const chNames = secMeta.channel_names || Array.from({length: N}, (_, i) => 'Ch ' + i);
    for (let ch = 0; ch < N; ch++) {
      const rowEl = document.createElement('div');
      rowEl.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #222;';
      const chk = document.createElement('input');
      chk.type = 'checkbox'; chk.checked = _secChState[ch].enabled;
      chk.title = 'Toggle ' + chNames[ch];
      chk.style.cssText = 'cursor:pointer;flex-shrink:0;';
      const labelEl = document.createElement('span');
      labelEl.textContent = chNames[ch];
      labelEl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ddd;';
      const swatch = document.createElement('span');
      swatch.style.cssText = 'display:inline-block;width:10px;height:10px;border-radius:50%;\
        border:1px solid #666;flex-shrink:0;background:' + _secChState[ch].color + ';';
      const colorPick = document.createElement('input');
      colorPick.type = 'color'; colorPick.value = _secChState[ch].color;
      colorPick.style.cssText = 'width:22px;height:22px;border:none;background:none;padding:0;cursor:pointer;flex-shrink:0;';
      const opSlider = document.createElement('input');
      opSlider.type = 'range'; opSlider.min = '0'; opSlider.max = '1'; opSlider.step = '0.05';
      opSlider.value = String(_secChState[ch].opacity);
      opSlider.title = 'Channel brightness';
      opSlider.style.cssText = 'width:64px;flex-shrink:0;';
      const [rawMin, rawMax] = secMeta.channel_full_ranges[ch];
      const rangeSlider = createDualRangeSlider(
        rawMin, rawMax,
        _secChState[ch].intensityMin, _secChState[ch].intensityMax,
        (lo, hi) => {
          _secChState[ch].intensityMin = lo; _secChState[ch].intensityMax = hi;
          _secCompCache.clear(); drawSecondaryLayer(viewport.getTransform());
        });
      chk.addEventListener('change', () => {
        _secChState[ch].enabled = chk.checked;
        _secCompCache.clear(); drawSecondaryLayer(viewport.getTransform());
      });
      colorPick.addEventListener('input', () => {
        _secChState[ch].color = colorPick.value; swatch.style.background = colorPick.value;
        _secCompCache.clear(); drawSecondaryLayer(viewport.getTransform());
      });
      opSlider.addEventListener('input', () => {
        _secChState[ch].opacity = parseFloat(opSlider.value);
        _secCompCache.clear(); drawSecondaryLayer(viewport.getTransform());
      });
      rowEl.appendChild(chk); rowEl.appendChild(labelEl); rowEl.appendChild(swatch);
      rowEl.appendChild(colorPick); rowEl.appendChild(opSlider); rowEl.appendChild(rangeSlider);
      _secChDropdown.appendChild(rowEl);
    }
  }

  return {
    secondaryCanvas,
    secCtx,
    drawSecondaryLayer,
    initSecChState,
    buildSecChPanel,
    getSecChDropdown: () => _secChDropdown,
    getSecRgbInFlight: () => _secRgbInFlight,
    getSecChInFlight: () => _secChInFlight,
    secCompCache: _secCompCache,
  };
}
