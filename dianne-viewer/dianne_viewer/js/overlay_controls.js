/**
 * overlay_controls.js
 *
 * Manages the overlay controls panel (opacity sliders, prob-color pickers),
 * the inference loading overlay/spinner, and the prediction-point overlay layer.
 *
 * Exposes:
 *   createOverlayControls({
 *     root, viewport, overlayControls, toolbar,
 *     BASE_URL, ACTIVE_SAMPLE_REF,
 *     SAMPLE_META, SAMPLE_SECONDARY_META,
 *     DRAW_ON_SECONDARY, SAMPLE_SECONDARY_MATRIX,
 *     SAMPLE_SIZES, settings,
 *     tileLayer, secondaryCanvas,
 *     HAS_RUN_INFERENCE,
 *     drawSecondaryLayer,
 *     setActiveSampleFn,
 *     annotations,
 *   })
 *   → {
 *       resizePredLayer, drawPredLayer,
 *       getSecondaryFetchEnabled, getSecondaryOpacity,
 *       updateOpacitySliderVisibility,
 *       showLoader, hideLoader,
 *       runInference,
 *       drawContourLayer, clearContours,
 *     }
 *
 * Also attaches window.ivSetOverlayPoints, window.ivClearOverlayPoints,
 * window.ivShowLoader, window.ivHideLoader.
 */
function createOverlayControls({
  root, viewport, overlayControls, toolbar,
  BASE_URL, ACTIVE_SAMPLE_REF,
  SAMPLE_META, SAMPLE_SECONDARY_META,
  DRAW_ON_SECONDARY, SAMPLE_SECONDARY_MATRIX,
  SAMPLE_SIZES, settings,
  tileLayer, secondaryCanvas,
  HAS_RUN_INFERENCE,
  drawSecondaryLayer,
  setActiveSampleFn,
  strokesBySample,
  buildServerStrokesPayload,
  annotations,
}) {
  // ── primary / secondary opacity sliders ────────────────────────────────────
  const _primaryOpacityWrap   = overlayControls.querySelector('#iv-primary-opacity-wrap');
  const _primaryOpacitySlider = overlayControls.querySelector('#iv-primary-opacity');
  const _secondaryOpacityWrap     = overlayControls.querySelector('#iv-secondary-opacity-wrap');
  const _secondaryOpacitySlider   = overlayControls.querySelector('#iv-secondary-opacity');
  const _secondaryEnabledCheckbox = overlayControls.querySelector('#iv-secondary-enabled');
  let _secondaryFetchEnabled = true;

  function updateOpacitySliderVisibility() {
    const hasSecondary = !!(SAMPLE_SECONDARY_META[ACTIVE_SAMPLE_REF()]);
    const isSecMC = hasSecondary && !!(SAMPLE_SECONDARY_META[ACTIVE_SAMPLE_REF()].n_channels);
    const isSampleMC = !!(SAMPLE_META[ACTIVE_SAMPLE_REF()] && SAMPLE_META[ACTIVE_SAMPLE_REF()].n_channels);
    _primaryOpacityWrap.style.display   = (!isSampleMC && hasSecondary) ? 'flex' : 'none';
    _secondaryOpacityWrap.style.display = (hasSecondary && !isSecMC) ? 'flex' : 'none';
    toolbar.setSecChVisible(isSecMC);
  }

  _primaryOpacitySlider.addEventListener('input', () => {
    tileLayer.style.opacity = _primaryOpacitySlider.value;
  });
  _secondaryOpacitySlider.addEventListener('input', () => {
    secondaryCanvas.style.opacity = _secondaryOpacitySlider.value;
  });
  _secondaryEnabledCheckbox.addEventListener('change', () => {
    _secondaryFetchEnabled = _secondaryEnabledCheckbox.checked;
    if (!_secondaryFetchEnabled) {
      // clear canvas; secondary_layer handles its own in-flight abort on next drawSecondaryLayer call
      const _ctx = secondaryCanvas.getContext('2d');
      if (_ctx) _ctx.clearRect(0, 0, secondaryCanvas.width, secondaryCanvas.height);
    } else {
      drawSecondaryLayer(viewport.getTransform());
    }
  });

  // ── prediction overlay layer ───────────────────────────────────────────────
  const predLayer = document.createElement('canvas');
  predLayer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;';
  root.appendChild(predLayer);
  const predCtx = predLayer.getContext('2d');
  let predPoints = [];

  // ── contour preview layer ("show contours" eye button) ─────────────────────
  const contourLayer = document.createElement('canvas');
  contourLayer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;';
  root.appendChild(contourLayer);
  const contourCtx = contourLayer.getContext('2d');
  let contourGeoJSON = null;   // last-fetched contours (image-px space), or null
  let contoursVisible = false;

  let predStyle = {
    alpha: 0.55,
    delta: 28,
    colorLow: '#FFA500',
    colorHigh: '#0000FF',
  };

  const alphaSlider    = overlayControls.querySelector('#iv-alpha');
  const lowColorPicker = overlayControls.querySelector('#iv-low');
  const highColorPicker= overlayControls.querySelector('#iv-high');

  function resizePredLayer() {
    predLayer.width  = root.clientWidth;
    predLayer.height = root.clientHeight;
    contourLayer.width  = root.clientWidth;
    contourLayer.height = root.clientHeight;
    drawPredLayer();
    drawContourLayer();
  }

  function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function parseHexColor(hex) {
    if (typeof hex !== 'string') return null;
    const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
    if (!m) return null;
    const s = m[1];
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }

  function probColor(p, alpha) {
    const lo = parseHexColor(predStyle.colorLow)  || { r: 11, g: 77, b: 255 };
    const hi = parseHexColor(predStyle.colorHigh) || { r: 255, g: 42, b: 42 };
    const r = Math.round(lo.r + (hi.r - lo.r) * p);
    const g = Math.round(lo.g + (hi.g - lo.g) * p);
    const b = Math.round(lo.b + (hi.b - lo.b) * p);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function syncOverlayControls() {
    alphaSlider.value       = String(clamp01(predStyle.alpha));
    lowColorPicker.value    = predStyle.colorLow;
    highColorPicker.value   = predStyle.colorHigh;
  }

  alphaSlider.addEventListener('input', () => {
    predStyle.alpha = clamp01(alphaSlider.value);
    drawPredLayer();
  });
  lowColorPicker.addEventListener('input', () => {
    predStyle.colorLow = lowColorPicker.value;
    drawPredLayer();
  });
  highColorPicker.addEventListener('input', () => {
    predStyle.colorHigh = highColorPicker.value;
    drawPredLayer();
  });

  function drawPredLayer() {
    predCtx.clearRect(0, 0, predLayer.width, predLayer.height);
    const delta = Math.max(1, Number(predStyle.delta) || 1);
    const half  = delta / 2;
    const alpha = clamp01(predStyle.alpha);

    for (const pt of predPoints) {
      const x = Number(pt.xi);
      const y = Number(pt.yi);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const p = clamp01(pt.pi);

      const s0 = viewport.toScreenSpace(x - half, y - half);
      const s1 = viewport.toScreenSpace(x + half, y + half);
      const left   = Math.min(s0.x, s1.x);
      const top    = Math.min(s0.y, s1.y);
      const width  = Math.abs(s1.x - s0.x);
      const height = Math.abs(s1.y - s0.y);

      if (left > predLayer.width || top > predLayer.height ||
          left + width < 0 || top + height < 0) continue;

      predCtx.fillStyle = probColor(p, alpha);
      predCtx.fillRect(left, top, width, height);
    }
  }

  // ── contour extraction ("show contours" eye button / "Add" button) ─────────
  // Both buttons act on the already-computed inference overlay (predPoints +
  // predStyle.delta, already in primary image-pixel space — see runInference
  // below) rather than re-running inference: the server rebuilds a downsampled
  // probability mask directly from those points (dianne_viewer.contours.
  // make_prob_mask_from_points) and extracts contours from it via
  // dianne_utils.mask.extractContoursForQuPath. Threshold/sigma/min-area are
  // user-tunable in the Settings panel (probContourThreshold/Sigma/MinArea).
  const contourShowBtn = overlayControls.querySelector('#iv-contour-show');
  const contourAddBtn  = overlayControls.querySelector('#iv-contour-add');

  function drawContourLayer() {
    contourCtx.clearRect(0, 0, contourLayer.width, contourLayer.height);
    if (!contoursVisible || !contourGeoJSON) return;
    contourCtx.lineWidth = 2;
    contourCtx.strokeStyle = '#00ff88';
    for (const feat of (contourGeoJSON.features || [])) {
      const rings = feat.geometry && feat.geometry.coordinates;
      if (!rings) continue;
      for (const ring of rings) {
        if (!ring || ring.length < 2) continue;
        contourCtx.beginPath();
        ring.forEach((c, i) => {
          const s = viewport.toScreenSpace(c[0], c[1]);
          if (i === 0) contourCtx.moveTo(s.x, s.y); else contourCtx.lineTo(s.x, s.y);
        });
        contourCtx.stroke();
      }
    }
  }

  function clearContours() {
    contourGeoJSON = null;
    contoursVisible = false;
    if (contourShowBtn) contourShowBtn.style.opacity = '0.6';
    drawContourLayer();
  }

  async function _fetchContours() {
    if (!predPoints.length) { log('Run inference first to generate contours.'); return null; }
    const sample = ACTIVE_SAMPLE_REF();
    const meta = SAMPLE_META[sample];
    const level0 = meta && meta.levels && meta.levels[0];
    if (!level0) { log('Missing image dimensions for contour extraction.'); return null; }
    try {
      const resp = await fetch(BASE_URL + '/annotations/contours', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          xi: predPoints.map(pt => pt.xi),
          yi: predPoints.map(pt => pt.yi),
          pi: predPoints.map(pt => pt.pi),
          delta: predStyle.delta,
          cutoff: clamp01(settings.get('probContourThreshold')),
          sigma: settings.get('probContourSigma'),
          min_area: settings.get('probContourMinArea'),
          full_width: level0.width,
          full_height: level0.height,
        }),
      });
      const result = await resp.json();
      if (!result.ok) { log('Contour extraction error: ' + (result.error || 'unknown')); return null; }
      contourGeoJSON = result.geojson;
      return contourGeoJSON;
    } catch (err) {
      log('Contour extraction request failed: ' + err);
      return null;
    }
  }

  // Live-refresh the preview if it's currently shown and the user tweaks
  // threshold/sigma/min-area (or resets settings) in the Settings panel.
  settings.onChange((key) => {
    if (!contoursVisible) return;
    if (key !== null && key !== 'probContourThreshold' && key !== 'probContourSigma' && key !== 'probContourMinArea') return;
    _fetchContours().then(geojson => { if (geojson) drawContourLayer(); });
  });

  if (contourShowBtn) {
    contourShowBtn.style.opacity = '0.6';
    contourShowBtn.addEventListener('click', async () => {
      if (contoursVisible) {
        contoursVisible = false;
        contourShowBtn.style.opacity = '0.6';
        drawContourLayer();
        return;
      }
      const geojson = await _fetchContours();
      if (!geojson) return;
      contoursVisible = true;
      contourShowBtn.style.opacity = '1';
      drawContourLayer();
      const n = (geojson.features || []).length;
      log('Showing ' + n + ' contour' + (n === 1 ? '' : 's') + ' at threshold ' + settings.get('probContourThreshold'));
    });
  }

  if (contourAddBtn) {
    contourAddBtn.addEventListener('click', async () => {
      const geojson = contourGeoJSON || await _fetchContours();
      if (!geojson) return;
      const sample = ACTIVE_SAMPLE_REF();
      // One annotation per GeoJSON feature (each feature's own rings are
      // already correctly outer+holes, per region, from the server's contour
      // hierarchy) — built directly via makeAnnotation rather than
      // buildAnnotationsFromRings, which would otherwise assign every region
      // a shared group_id (since it groups whenever it returns >1 piece),
      // making unrelated regions delete together as if they were one shape.
      const anns = [];
      for (const feat of (geojson.features || [])) {
        const coords = feat.geometry && feat.geometry.coordinates;
        if (!coords) continue;
        const rings = coords.filter(r => r && r.length >= 3).map(ring => ring.map(c => ({ x: c[0], y: c[1] })));
        if (!rings.length) continue;
        const ann = annotations.makeAnnotation({ sample, rings, cls: 'positive' });
        annotations.recomputeMetrics(ann);
        anns.push(ann);
      }
      if (!anns.length) { log('No contours to add.'); return; }
      annotations.addAnnotationGroup(sample, 'library', anns);
      // Turn off the temporary contour preview now that the same shapes
      // exist as real draft annotations, so the two don't overlay.
      if (contoursVisible) {
        contoursVisible = false;
        if (contourShowBtn) contourShowBtn.style.opacity = '0.6';
        drawContourLayer();
      }
      log('Added ' + anns.length + ' draft annotation' + (anns.length === 1 ? '' : 's') + ' from contours.');
    });
  }

  // ── inference loading overlay ──────────────────────────────────────────────
  const inferenceLoader = document.createElement('div');
  inferenceLoader.style.cssText = [
    'position:absolute', 'top:0', 'left:0', 'width:100%', 'height:100%',
    'display:none', 'align-items:center', 'justify-content:center',
    'z-index:50', 'background:rgba(0,0,0,0.42)', 'pointer-events:all',
  ].join(';');
  const _loaderCircumference = 2 * Math.PI * 30;  // r=30 → ≈188.5
  inferenceLoader.innerHTML = [
    '<div style="display:flex;flex-direction:column;align-items:center;gap:14px;">',
      '<svg width="88" height="88" viewBox="0 0 88 88" style="transform:rotate(-90deg)">',
        '<circle cx="44" cy="44" r="30" fill="none" stroke="#2a2a2a" stroke-width="9"/>',
        '<circle id="iv-loader-arc" cx="44" cy="44" r="30" fill="none"',
               'stroke="#00ff88" stroke-width="9" stroke-linecap="round"',
               'stroke-dasharray="' + _loaderCircumference.toFixed(2) + '"',
               'stroke-dashoffset="' + _loaderCircumference.toFixed(2) + '"/>',
      '</svg>',
      '<div id="iv-loader-pct" style="color:#00ff88;font:700 20px monospace;letter-spacing:2px;">0%</div>',
      '<div style="color:#aaa;font:12px monospace;">Training &amp; running inference…</div>',
    '</div>',
  ].join('');
  root.appendChild(inferenceLoader);

  let _loaderRaf = null;

  function showLoader(durationMs) {
    inferenceLoader.style.display = 'flex';
    const arc  = inferenceLoader.querySelector('#iv-loader-arc');
    const pct  = inferenceLoader.querySelector('#iv-loader-pct');
    const circ = _loaderCircumference;
    if (arc)  { arc.style.strokeDashoffset = String(circ); }
    if (pct)  { pct.textContent = '0%'; }
    let startTime = null;
    function step(ts) {
      if (!startTime) startTime = ts;
      const progress = Math.min((ts - startTime) / Math.max(durationMs, 1), 1);
      if (arc)  arc.style.strokeDashoffset = String(circ * (1 - progress));
      if (pct)  pct.textContent = Math.round(progress * 100) + '%';
      if (progress < 1) _loaderRaf = requestAnimationFrame(step);
    }
    _loaderRaf = requestAnimationFrame(step);
  }

  function hideLoader() {
    if (_loaderRaf) { cancelAnimationFrame(_loaderRaf); _loaderRaf = null; }
    inferenceLoader.style.display = 'none';
    const arc = inferenceLoader.querySelector('#iv-loader-arc');
    const pct = inferenceLoader.querySelector('#iv-loader-pct');
    if (arc) arc.style.strokeDashoffset = String(_loaderCircumference);
    if (pct) pct.textContent = '0%';
  }

  // ── run-inference handler ──────────────────────────────────────────────────
  function _primToSec(mat, x, y) {
    var dx = x - mat.tx, dy = y - mat.ty;
    return { x: mat.mi00 * dx + mat.mi01 * dy,
             y: mat.mi10 * dx + mat.mi11 * dy };
  }
  function _secToPrim(mat, x, y) {
    return { x: mat.m00 * x + mat.m01 * y + mat.tx,
             y: mat.m10 * x + mat.m11 * y + mat.ty };
  }

  async function runInference(runBtn) {
    if (!HAS_RUN_INFERENCE) return;
    const ACTIVE_SAMPLE = ACTIVE_SAMPLE_REF();
    // 1. Flush current strokes to server (converting to secondary space if needed)
    strokesBySample[ACTIVE_SAMPLE] = toolbar.draw.getStrokes();
    try {
      await fetch(BASE_URL + '/strokes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by_sample: buildServerStrokesPayload() }),
      });
    } catch (e) {
      log('Flush error: ' + e);
      return;
    }
    // 2. Time the loading animation based on sample size
    const hasSampleSize = SAMPLE_SIZES
      && Object.prototype.hasOwnProperty.call(SAMPLE_SIZES, ACTIVE_SAMPLE);
    const sampleCellCount = hasSampleSize ? Number(SAMPLE_SIZES[ACTIVE_SAMPLE]) : NaN;
    const nCells = Number.isFinite(sampleCellCount) ? sampleCellCount : 5000;
    const durationMs = nCells * settings.get('inferMsPerCell');
    console.log('Running inference on sample "' + ACTIVE_SAMPLE + '" with ' + nCells + ' cells; showing loader for ~' + durationMs.toFixed(0) + ' ms');
    if (runBtn) { runBtn.disabled = true; runBtn.style.opacity = '0.5'; runBtn.style.boxShadow = 'none'; }
    showLoader(durationMs);
    log('Running inference on ' + ACTIVE_SAMPLE + '…');
    try {
      const resp = await fetch(BASE_URL + '/run_inference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_sample: ACTIVE_SAMPLE }),
      });
      const result = await resp.json();
      hideLoader();
      if (result.ok) {
        const ov = result.overlay;
        let points = ov.xi.map((xi, i) => ({ xi, yi: ov.yi[i], pi: ov.pi[i] }));
        const style  = { delta: ov.style.delta, alpha: ov.style.alpha,
                         colorLow: ov.style.colorLow, colorHigh: ov.style.colorHigh };
        // If DRAW_ON_SECONDARY, inference returns coords in secondary space;
        // transform back to primary image space for display.
        if (DRAW_ON_SECONDARY) {
          const _ovSample = result.sample || ACTIVE_SAMPLE;
          const _ovMat = SAMPLE_SECONDARY_MATRIX[_ovSample];
          if (_ovMat) {
            points = points.map(pt => {
              const p = _secToPrim(_ovMat, pt.xi, pt.yi);
              return { xi: p.x, yi: p.y, pi: pt.pi };
            });
            // delta is in secondary pixel units; scale to primary pixel units.
            const _det = _ovMat.m00 * _ovMat.m11 - _ovMat.m01 * _ovMat.m10;
            style.delta = style.delta * Math.sqrt(Math.abs(_det));
          }
        }
        if (result.sample && result.sample !== ACTIVE_SAMPLE) setActiveSampleFn(result.sample);
        window.ivSetOverlayPoints(points, style);
        log('Inference complete: ' + points.length + ' points on ' + (result.sample || ACTIVE_SAMPLE));
      } else {
        log('Inference error: ' + (result.error || 'unknown'));
      }
    } catch (err) {
      hideLoader();
      log('Inference request failed: ' + err);
    } finally {
      if (runBtn) { runBtn.disabled = false; runBtn.style.opacity = '1'; runBtn.style.boxShadow = '0 0 8px 2px rgba(0,255,136,0.65)'; }
    }
  }

  // ── window API ─────────────────────────────────────────────────────────────
  window.ivSetOverlayPoints = function(points, style) {
    predPoints = Array.isArray(points) ? points : [];
    if (style && typeof style === 'object') {
      predStyle = { ...predStyle, ...style };
    }
    syncOverlayControls();
    drawPredLayer();
    log('Overlay updated (' + predPoints.length + ' points)');
  };

  window.ivClearOverlayPoints = function() {
    predPoints = [];
    drawPredLayer();
    log('Overlay cleared');
  };

  window.ivShowLoader = showLoader;
  window.ivHideLoader = hideLoader;

  syncOverlayControls();

  return {
    resizePredLayer,
    drawPredLayer,
    getSecondaryFetchEnabled: () => _secondaryFetchEnabled,
    updateOpacitySliderVisibility,
    showLoader,
    hideLoader,
    runInference,
    clearPredPoints: () => { predPoints = []; },
    drawContourLayer,
    clearContours,
  };
}
