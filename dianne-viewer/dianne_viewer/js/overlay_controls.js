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
 *     HAS_RUN_SEARCH,
 *     drawSecondaryLayer,
 *     setActiveSampleFn,
 *     scrollSampleRibbonFn,
 *     annotations,
 *     onAnnotationsAdded,
 *   })
 *   → {
 *       resizePredLayer, drawPredLayer,
 *       getSecondaryFetchEnabled, getSecondaryOpacity,
 *       updateOpacitySliderVisibility,
 *       showLoader, hideLoader,
 *       runInference, runSubtileInference, runSearch,
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
  HAS_RUN_SUBTILE_INFERENCE,
  HAS_RUN_SEARCH,
  drawSecondaryLayer,
  setActiveSampleFn,
  scrollSampleRibbonFn,
  strokesBySample,
  buildServerStrokesPayload,
  annotations,
  onAnnotationsAdded,
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
  let highlightedContourIdx = null;  // index into contourGeoJSON.features, or null

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

  // Points below this probability are skipped entirely (not just drawn very
  // faint) — keeps the low-confidence majority of tiles/subtiles from
  // washing out the overlay with low-alpha noise.
  const MIN_HEATMAP_PROB = 0.25;

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
      if (p < MIN_HEATMAP_PROB) continue;

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

  function _strokeContourFeature(feat, color, width) {
    const rings = feat.geometry && feat.geometry.coordinates;
    if (!rings) return;
    contourCtx.lineWidth = width;
    contourCtx.strokeStyle = color;
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

  function drawContourLayer() {
    contourCtx.clearRect(0, 0, contourLayer.width, contourLayer.height);
    if (!contoursVisible || !contourGeoJSON) return;
    const feats = contourGeoJSON.features || [];
    // Draw the highlighted contour (if any) last so it renders on top of
    // any overlapping neighbors.
    feats.forEach((feat, idx) => {
      if (idx !== highlightedContourIdx) _strokeContourFeature(feat, '#00ff88', 2);
    });
    if (highlightedContourIdx !== null && feats[highlightedContourIdx]) {
      _strokeContourFeature(feats[highlightedContourIdx], '#ffdd00', 3.5);
    }
  }

  // Euclidean distance from point (px,py) to segment (ax,ay)-(bx,by), for
  // contour double-click hit-testing.
  function _distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  const CONTOUR_HIT_PX = 8;  // max screen-space distance (px) counted as a hit

  // Returns the index of the contour feature whose ring passes closest to
  // (vpX, vpY) (viewport/screen space, same as drawContourLayer draws in),
  // within CONTOUR_HIT_PX, or null if none is close enough.
  function _hitTestContour(vpX, vpY) {
    if (!contourGeoJSON) return null;
    let bestIdx = null;
    let bestDist = CONTOUR_HIT_PX;
    (contourGeoJSON.features || []).forEach((feat, idx) => {
      const rings = feat.geometry && feat.geometry.coordinates;
      if (!rings) return;
      for (const ring of rings) {
        if (!ring || ring.length < 2) continue;
        const pts = ring.map(c => viewport.toScreenSpace(c[0], c[1]));
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          const d = _distToSegment(vpX, vpY, a.x, a.y, b.x, b.y);
          if (d < bestDist) { bestDist = d; bestIdx = idx; }
        }
      }
    });
    return bestIdx;
  }

  function clearContours() {
    contourGeoJSON = null;
    contoursVisible = false;
    highlightedContourIdx = null;
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
      highlightedContourIdx = null;  // fresh data — any prior selection index is stale
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

  // A handful of red-halo pulses on the eye button when a fetch legitimately
  // returns zero contours (e.g. probContourMinArea/Sigma tuned for tile-level
  // deltas filtering out finer subtile-level predictions) — otherwise the
  // only feedback is a log line that's easy to miss, and the click looks
  // like it did nothing at all.
  function _blinkContourWarn() {
    if (!contourShowBtn) return;
    let n = 0;
    const iv = setInterval(() => {
      contourShowBtn.style.boxShadow = (n % 2 === 0) ? '0 0 8px 3px rgba(255,40,40,0.9)' : 'none';
      if (++n >= 6) { clearInterval(iv); contourShowBtn.style.boxShadow = 'none'; }
    }, 180);
  }

  if (contourShowBtn) {
    contourShowBtn.style.opacity = '0.6';
    contourShowBtn.addEventListener('click', async () => {
      if (contoursVisible) {
        contoursVisible = false;
        highlightedContourIdx = null;
        contourShowBtn.style.opacity = '0.6';
        drawContourLayer();
        return;
      }
      const geojson = await _fetchContours();
      if (!geojson) return;
      const n = (geojson.features || []).length;
      if (n === 0) {
        log('No contours found at threshold ' + settings.get('probContourThreshold') +
            ' — try lowering probContourMinArea/probContourSigma in Settings (subtile-level predictions are finer-grained than tile-level).');
        _blinkContourWarn();
        return;
      }
      contoursVisible = true;
      contourShowBtn.style.opacity = '1';
      drawContourLayer();
      log('Showing ' + n + ' contour' + (n === 1 ? '' : 's') + ' at threshold ' + settings.get('probContourThreshold'));
    });
  }

  // Builds one draft annotation per GeoJSON feature (each feature's own
  // rings are already correctly outer+holes, per region, from the server's
  // contour hierarchy) — via makeAnnotation directly rather than
  // buildAnnotationsFromRings, which would otherwise assign every region a
  // shared group_id (since it groups whenever it returns >1 piece), making
  // unrelated regions delete together as if they were one shape.
  function _annotationsFromFeatures(feats, sample) {
    const anns = [];
    for (const feat of feats) {
      const coords = feat.geometry && feat.geometry.coordinates;
      if (!coords) continue;
      const rings = coords.filter(r => r && r.length >= 3).map(ring => ring.map(c => ({ x: c[0], y: c[1] })));
      if (!rings.length) continue;
      const ann = annotations.makeAnnotation({ sample, rings, cls: 'positive' });
      annotations.recomputeMetrics(ann);
      anns.push(ann);
    }
    return anns;
  }

  if (contourAddBtn) {
    contourAddBtn.addEventListener('click', async () => {
      const sample = ACTIVE_SAMPLE_REF();

      // A single contour is highlighted (double-clicked) — add just that
      // one, leave the rest of the temporary preview showing.
      if (highlightedContourIdx !== null && contourGeoJSON &&
          contourGeoJSON.features && contourGeoJSON.features[highlightedContourIdx]) {
        const idx = highlightedContourIdx;
        const feat = contourGeoJSON.features[idx];
        const anns = _annotationsFromFeatures([feat], sample);
        if (!anns.length) { log('No contour to add.'); return; }
        annotations.addAnnotationGroup(sample, 'library', anns);
        if (typeof onAnnotationsAdded === 'function') onAnnotationsAdded(anns.map(a => a.id));
        contourGeoJSON.features.splice(idx, 1);
        highlightedContourIdx = null;
        // Nothing left in the preview — same cleanup as the "add all" path.
        if (!contourGeoJSON.features.length) {
          contoursVisible = false;
          if (contourShowBtn) contourShowBtn.style.opacity = '0.6';
        }
        drawContourLayer();
        log('Added 1 draft annotation from the highlighted contour (' +
            contourGeoJSON.features.length + ' remaining).');
        return;
      }

      // No highlight — add every contour currently in the preview (existing
      // behavior), then turn the temporary preview off entirely.
      const geojson = contourGeoJSON || await _fetchContours();
      if (!geojson) return;
      const anns = _annotationsFromFeatures(geojson.features || [], sample);
      if (!anns.length) { log('No contours to add.'); return; }
      annotations.addAnnotationGroup(sample, 'library', anns);
      if (typeof onAnnotationsAdded === 'function') onAnnotationsAdded(anns.map(a => a.id));
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

  // ── contour selection: double-click to highlight, Delete to remove,
  //    Escape to de-highlight ─────────────────────────────────────────────────
  root.addEventListener('dblclick', e => {
    if (!contoursVisible || !contourGeoJSON) return;
    if (e.target && e.target.closest && e.target.closest('[data-iv-ui="true"]')) return;
    const rect = root.getBoundingClientRect();
    const vpX = e.clientX - rect.left, vpY = e.clientY - rect.top;
    const idx = _hitTestContour(vpX, vpY);
    if (idx !== null) {
      highlightedContourIdx = idx;
      drawContourLayer();
    }
  });

  document.addEventListener('keydown', e => {
    if (highlightedContourIdx === null) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Escape') {
      highlightedContourIdx = null;
      drawContourLayer();
      e.stopImmediatePropagation();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (contourGeoJSON && contourGeoJSON.features) {
        contourGeoJSON.features.splice(highlightedContourIdx, 1);
      }
      highlightedContourIdx = null;
      drawContourLayer();
      e.stopImmediatePropagation();
    }
  });

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
      '<div id="iv-loader-phase" style="color:#00ff88;font:12px monospace;text-align:center;max-width:260px;">Training &amp; running inference…</div>',
    '</div>',
  ].join('');
  root.appendChild(inferenceLoader);

  let _loaderRaf = null;
  // Polled while the loader is up (GET /inference_progress) so a run that
  // reports real phases/fractions (currently only run_subtile_inference —
  // see makeSubtileRunFn's progress_cb) can show "computing features" vs
  // "running GPU inference" instead of one opaque time-estimated spinner.
  // A run that never reports a real fraction (plain run_inference, or the
  // subtile run's training/inference phases) just falls back to the
  // time-based ring estimate already running; polling only overrides the
  // ring when a fraction is actually known.
  let _progressPollTimer = null;

  function _pollInferenceProgress() {
    fetch(BASE_URL + '/inference_progress').then(r => r.json()).then(p => {
      if (!p || !p.active) return;
      const arc   = inferenceLoader.querySelector('#iv-loader-arc');
      const pct   = inferenceLoader.querySelector('#iv-loader-pct');
      const phase = inferenceLoader.querySelector('#iv-loader-phase');
      if (phase && p.message) phase.textContent = p.message;
      if (typeof p.fraction === 'number') {
        const circ = _loaderCircumference;
        if (arc) arc.style.strokeDashoffset = String(circ * (1 - p.fraction));
        if (pct) pct.textContent = Math.round(p.fraction * 100) + '%';
      }
    }).catch(() => {});
  }

  function showLoader(durationMs) {
    inferenceLoader.style.display = 'flex';
    const arc   = inferenceLoader.querySelector('#iv-loader-arc');
    const pct   = inferenceLoader.querySelector('#iv-loader-pct');
    const phase = inferenceLoader.querySelector('#iv-loader-phase');
    const circ  = _loaderCircumference;
    if (arc)   { arc.style.strokeDashoffset = String(circ); }
    if (pct)   { pct.textContent = '0%'; }
    if (phase) { phase.textContent = 'Training & running inference…'; }
    let startTime = null;
    function step(ts) {
      if (!startTime) startTime = ts;
      const progress = Math.min((ts - startTime) / Math.max(durationMs, 1), 1);
      if (arc)  arc.style.strokeDashoffset = String(circ * (1 - progress));
      if (pct)  pct.textContent = Math.round(progress * 100) + '%';
      if (progress < 1) _loaderRaf = requestAnimationFrame(step);
    }
    _loaderRaf = requestAnimationFrame(step);
    if (_progressPollTimer) clearInterval(_progressPollTimer);
    _progressPollTimer = setInterval(_pollInferenceProgress, 400);
    _pollInferenceProgress();
  }

  function hideLoader() {
    if (_loaderRaf) { cancelAnimationFrame(_loaderRaf); _loaderRaf = null; }
    if (_progressPollTimer) { clearInterval(_progressPollTimer); _progressPollTimer = null; }
    inferenceLoader.style.display = 'none';
    const arc   = inferenceLoader.querySelector('#iv-loader-arc');
    const pct   = inferenceLoader.querySelector('#iv-loader-pct');
    const phase = inferenceLoader.querySelector('#iv-loader-phase');
    if (arc)   arc.style.strokeDashoffset = String(_loaderCircumference);
    if (pct)   pct.textContent = '0%';
    if (phase) phase.textContent = 'Training & running inference…';
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

  // Flush every sample's current in-memory strokes to the server (converting
  // to secondary space if needed) — the shared first step of Run/Run subtile/
  // Search, all of which train on srv.strokes_by_sample server-side.
  async function _flushStrokes() {
    const ACTIVE_SAMPLE = ACTIVE_SAMPLE_REF();
    strokesBySample[ACTIVE_SAMPLE] = toolbar.draw.getStrokes();
    await fetch(BASE_URL + '/strokes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ by_sample: buildServerStrokesPayload() }),
    });
  }

  // Set while a run/search POST is in flight so Esc can abort it client-side
  // and tell the server to cooperatively cancel the matching worker-thread
  // call (see POST /cancel_inference) — otherwise the server keeps running
  // (and its single-slot inference queue stays blocked) after the client
  // gives up waiting.
  let _activeInferenceAbort = null;

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !_activeInferenceAbort) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    _activeInferenceAbort.abort();
    fetch(BASE_URL + '/cancel_inference', { method: 'POST' }).catch(() => {});
  });

  // Apply a run_inference-style overlay ({xi,yi,pi,style}) to the prediction
  // layer, transforming secondary → primary image space first when
  // DRAW_ON_SECONDARY. Shared by runInference/runSubtileInference and
  // Search's patch-restricted preview overlay. Returns the point count.
  function _applyOverlayResult(ov, sample) {
    let points = ov.xi.map((xi, i) => ({ xi, yi: ov.yi[i], pi: ov.pi[i] }));
    const style = { delta: ov.style.delta, alpha: ov.style.alpha,
                     colorLow: ov.style.colorLow, colorHigh: ov.style.colorHigh };
    if (DRAW_ON_SECONDARY) {
      const mat = SAMPLE_SECONDARY_MATRIX[sample];
      if (mat) {
        points = points.map(pt => {
          const p = _secToPrim(mat, pt.xi, pt.yi);
          return { xi: p.x, yi: p.y, pi: pt.pi };
        });
        const det = mat.m00 * mat.m11 - mat.m01 * mat.m10;
        style.delta = style.delta * Math.sqrt(Math.abs(det));
      }
    }
    window.ivSetOverlayPoints(points, style);
    return points.length;
  }

  async function _runInferenceRequest(endpoint, runBtn) {
    const ACTIVE_SAMPLE = ACTIVE_SAMPLE_REF();
    // 1. Flush current strokes to server
    try {
      await _flushStrokes();
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
    // The about-to-run heatmap will replace predPoints, so any temporary
    // contour preview (drawn from the *old* predPoints via the "eyes"
    // button) would no longer match — turn it off rather than leave a
    // stale overlay next to the new heatmap.
    clearContours();
    showLoader(durationMs);
    toolbar.setInputLocked(true);
    log('Running inference on ' + ACTIVE_SAMPLE + '… (Esc to cancel)');
    _activeInferenceAbort = new AbortController();
    try {
      const resp = await fetch(BASE_URL + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active_sample: ACTIVE_SAMPLE }),
        signal: _activeInferenceAbort.signal,
      });
      const result = await resp.json();
      hideLoader();
      if (result.cancelled) {
        log('Inference cancelled.');
      } else if (result.ok) {
        if (result.sample && result.sample !== ACTIVE_SAMPLE) setActiveSampleFn(result.sample);
        const n = _applyOverlayResult(result.overlay, result.sample || ACTIVE_SAMPLE);
        log('Inference complete: ' + n + ' points on ' + (result.sample || ACTIVE_SAMPLE));
      } else {
        log('Inference error: ' + (result.error || 'unknown'));
      }
    } catch (err) {
      hideLoader();
      log(err && err.name === 'AbortError' ? 'Inference cancelled.' : 'Inference request failed: ' + err);
    } finally {
      _activeInferenceAbort = null;
      toolbar.setInputLocked(false);
      if (runBtn) { runBtn.disabled = false; runBtn.style.opacity = '1'; runBtn.style.boxShadow = '0 0 8px 2px rgba(0,255,136,0.65)'; }
    }
  }

  function runInference(runBtn) {
    if (!HAS_RUN_INFERENCE) return;
    return _runInferenceRequest('/run_inference', runBtn);
  }

  // Same overlay/contour pipeline as runInference — only the server-side
  // classifier training + inference granularity differs (see
  // dianne_utils.utils.makeSubtileRunFn / the "Run subtile" toolbar button,
  // gated by the "Enable subtile inference" Settings-panel checkbox).
  function runSubtileInference(runBtn) {
    if (!HAS_RUN_SUBTILE_INFERENCE) return;
    return _runInferenceRequest('/run_subtile_inference', runBtn);
  }

  // Search: re-train the classifier on the latest +/- annotations (across
  // every sample) and jump to an uncurated patch it's proposed for review —
  // see dianne_utils.utils.makeSearchFn / the '/search' route.
  async function runSearch(searchBtn) {
    if (!HAS_RUN_SEARCH) return;
    try {
      await _flushStrokes();
    } catch (e) {
      log('Flush error: ' + e);
      return;
    }
    if (searchBtn) { searchBtn.disabled = true; searchBtn.style.opacity = '0.5'; }
    clearContours();
    showLoader(4000);
    toolbar.setInputLocked(true);
    log('Searching for an uncurated patch to review… (Esc to cancel)');
    _activeInferenceAbort = new AbortController();
    try {
      const resp = await fetch(BASE_URL + '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: _activeInferenceAbort.signal,
      });
      const result = await resp.json();
      hideLoader();
      if (result.cancelled) {
        log('Search cancelled.');
      } else if (result.ok) {
        const sample = result.sample;
        let { x0, y0, x1, y1 } = result.bbox;
        // bbox is in the same coordinate space as run_inference_fn's xi/yi —
        // transform secondary → primary the same way that overlay does.
        if (DRAW_ON_SECONDARY) {
          const mat = SAMPLE_SECONDARY_MATRIX[sample];
          if (mat) {
            const p0 = _secToPrim(mat, x0, y0);
            const p1 = _secToPrim(mat, x1, y1);
            x0 = Math.min(p0.x, p1.x); x1 = Math.max(p0.x, p1.x);
            y0 = Math.min(p0.y, p1.y); y1 = Math.max(p0.y, p1.y);
          }
        }
        if (sample !== ACTIVE_SAMPLE_REF()) setActiveSampleFn(sample);
        viewport.fitBBox(x0, y0, x1, y1);
        if (typeof scrollSampleRibbonFn === 'function') scrollSampleRibbonFn(sample);
        // bbox coords are already transformed above; the overlay (in the same
        // secondary/primary space run_inference_fn returns) is transformed
        // independently by _applyOverlayResult.
        if (result.overlay) _applyOverlayResult(result.overlay, sample);
        log('Search: proposed a patch on ' + sample + ' (p=' + result.probability.toFixed(2) + ')');
      } else {
        log('Search: ' + (result.error || 'no proposal'));
      }
    } catch (err) {
      hideLoader();
      log(err && err.name === 'AbortError' ? 'Search cancelled.' : 'Search request failed: ' + err);
    } finally {
      _activeInferenceAbort = null;
      toolbar.setInputLocked(false);
      if (searchBtn) { searchBtn.disabled = false; searchBtn.style.opacity = '1'; }
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
    runSubtileInference,
    runSearch,
    clearPredPoints: () => { predPoints = []; },
    drawContourLayer,
    clearContours,
  };
}
