/**
 * patches.js
 *
 * Semi-transparent tile overlay drawn directly onto a canvas layer.
 * Coordinates (secondary-image pixel centers) are fetched lazily per sample
 * from GET /tile_coords?sample=X → {"x":[…],"y":[…]} and transformed to
 * primary-image space using the secondary→primary affine matrix.
 *
 * Exposes:
 *   patches.setContext(sample, baseUrl, tileSize, secondaryMatrix)
 *   patches.setEnabled(bool)
 *   patches.isEnabled()          → bool
 *   patches.toggleBtn            → <button> element appended to toolbar
 */
function createPatchOverlay(container, viewport, settings) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:3;';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let enabled = false;
  let currentSample = null;
  let currentBaseUrl = null;
  let currentPatchSize = 256;
  let currentSecMatrix = null;  // secondary→primary affine (from SAMPLE_SECONDARY_MATRIX)
  const coordCache = {};  // sample → { xArr: Float32Array, yArr: Float32Array } in PRIMARY space

  // ── Toggle button ──────────────────────────────────────────────────────────
  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = 'Tiles';
  toggleBtn.title = 'Toggle patch/tile overlay (unchecked by default)';
  toggleBtn.dataset.ivUi = 'true';
  toggleBtn.style.cssText = [
    'background:transparent', 'border:1px solid #888',
    'color:#eee', 'border-radius:4px', 'padding:2px 7px',
    'cursor:pointer', 'font-size:13px', 'line-height:1.4',
    'opacity:0.45',
  ].join(';');
  toggleBtn.addEventListener('click', () => setEnabled(!enabled));

  function _syncBtn() {
    toggleBtn.style.background = enabled ? 'rgba(255,255,255,0.2)' : 'transparent';
    toggleBtn.style.opacity     = enabled ? '1' : '0.45';
  }

  // ── Canvas sizing ──────────────────────────────────────────────────────────
  function _resizeCanvas() {
    const w = container.clientWidth  || container.offsetWidth  || 1;
    const h = container.clientHeight || container.offsetHeight || 1;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w;
      canvas.height = h;
    }
  }

  // ── Draw ───────────────────────────────────────────────────────────────────
  function draw() {
    _resizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!enabled) return;
    const coords = coordCache[currentSample];
    if (!coords) return;

    const { scale, ox, oy } = viewport.getTransform();
    const half   = currentPatchSize / 2;
    const margin = half + 2;
    const xMin = (-ox - margin) / scale;
    const xMax = (canvas.width  - ox + margin) / scale;
    const yMin = (-oy - margin) / scale;
    const yMax = (canvas.height - oy + margin) / scale;

    const opacity = (settings && settings.get('patchOpacity') != null)
      ? settings.get('patchOpacity') : 0.35;

    const fillColor   = 'rgba(255,200,0,' + opacity + ')';
    const strokeColor = 'rgba(255,200,0,' + Math.min(1, opacity * 2 + 0.15) + ')';
    ctx.fillStyle   = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth   = Math.max(0.5, Math.min(2, scale));

    const rectW = currentPatchSize * scale;
    const rectH = rectW;

    const xs = coords.xArr;
    const ys = coords.yArr;
    const n  = xs.length;

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const cx = xs[i];
      const cy = ys[i];
      if (cx < xMin || cx > xMax || cy < yMin || cy > yMax) continue;
      const sx = cx * scale + ox - rectW / 2;
      const sy = cy * scale + oy - rectH / 2;
      ctx.rect(sx, sy, rectW, rectH);
    }
    ctx.fill();
    ctx.stroke();
  }

  // ── Fetch coords ────────────────────────────────────────────────────────────
  function _applySecondaryMatrix(xs, ys, mat) {
    // mat = {m00, m01, m10, m11, tx, ty} — maps secondary px → primary px
    // x_prim = m00*x_sec + m01*y_sec + tx
    // y_prim = m10*x_sec + m11*y_sec + ty
    const n = xs.length;
    const xOut = new Float32Array(n);
    const yOut = new Float32Array(n);
    const { m00, m01, m10, m11, tx, ty } = mat;
    for (let i = 0; i < n; i++) {
      xOut[i] = m00 * xs[i] + m01 * ys[i] + tx;
      yOut[i] = m10 * xs[i] + m11 * ys[i] + ty;
    }
    return { xArr: xOut, yArr: yOut };
  }

  function _fetchCoords(sample, baseUrl, secMatrix) {
    if (coordCache[sample]) { draw(); return; }
    const url = baseUrl + '/tile_coords?sample=' + encodeURIComponent(sample);
    fetch(url)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || !data.x) return;
        const rawX = new Float32Array(data.x);
        const rawY = new Float32Array(data.y);
        // Apply secondary→primary transform if matrix is available
        if (secMatrix && secMatrix.m00 != null) {
          coordCache[sample] = _applySecondaryMatrix(rawX, rawY, secMatrix);
        } else {
          coordCache[sample] = { xArr: rawX, yArr: rawY };
        }
        if (sample === currentSample) draw();
      })
      .catch(() => {});
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  function setContext(sample, baseUrl, patchSize, secMatrix) {
    currentSample    = sample;
    currentBaseUrl   = baseUrl;
    currentSecMatrix = secMatrix || null;
    if (patchSize != null) currentPatchSize = patchSize;
    _fetchCoords(sample, baseUrl, currentSecMatrix);
    draw();
  }

  function setEnabled(val) {
    enabled = !!val;
    _syncBtn();
    draw();
  }

  viewport.onChange(() => draw());
  if (settings) {
    settings.onChange(key => {
      if (key === null || key === 'patchOpacity') { if (enabled) draw(); }
    });
  }

  return { setContext, setEnabled, isEnabled: () => enabled, toggleBtn, draw };
}
