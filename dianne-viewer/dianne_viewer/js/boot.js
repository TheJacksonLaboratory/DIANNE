/**
 * boot.js
 *
 * Top-level wiring: declares the constants injected by Python (BASE_URL,
 * SAMPLES, META, …), instantiates every createX() factory in the correct
 * dependency order, and wires cross-references between modules.
 *
 * All __TOKEN__ placeholders below are replaced by create_viewer() before
 * the script is delivered to the browser.
 */

// ── Injected constants ────────────────────────────────────────────────────
const BASE_URL                 = __BASE_URL__;
const SAMPLES                  = __SAMPLES__;
const SAMPLE_META              = __SAMPLE_META__;
const SAMPLE_XENIUM_META       = __SAMPLE_XENIUM_META__;
const SAMPLE_CELLS_META        = __SAMPLE_CELLS_META__;
const HAS_RUN_INFERENCE        = __HAS_RUN_INFERENCE__;
const HAS_SAVE                 = __HAS_SAVE__;
const HAS_LOAD                 = __HAS_LOAD__;
const SAMPLE_SIZES             = __SAMPLE_SIZES__;
const INFERENCE_MS_PER_CELL    = __INFERENCE_MS_PER_CELL__;
const MAX_CELLS                = __MAX_CELLS__;
const IS_MULTICHANNEL          = __IS_MULTICHANNEL__;
const IS_MONOCHANNEL           = __IS_MONOCHANNEL__;
const SAMPLE_IS_MONO           = __SAMPLE_IS_MONO__;
const MONO_META                = __MONO_META__;
const SAMPLE_SECONDARY_META    = __SAMPLE_SECONDARY_META__;
const SAMPLE_SECONDARY_MATRIX  = __SAMPLE_SECONDARY_MATRIX__;
const DRAW_ON_SECONDARY        = __DRAW_ON_SECONDARY__;
const TILE_SIZE                = __TILE_SIZE__;
const HAS_TILE_COORDS          = __HAS_TILE_COORDS__;
const HAS_VISIUM               = __HAS_VISIUM__;
const VISIUM_GENES_BY_SAMPLE   = __VISIUM_GENES_BY_SAMPLE__;
const SAMPLE_MAPPING           = __SAMPLE_MAPPING__;
const SAMPLE_METADATA          = __SAMPLE_METADATA__;
const _STOP_URL                = __STOP_URL__;

// ── Mutable session state ─────────────────────────────────────────────────
let ACTIVE_SAMPLE = SAMPLES[0];
let META          = SAMPLE_META[ACTIVE_SAMPLE] || __META__;
let ANNOTATION_LAYERS = [];  // loaded asynchronously via /annotation_layers

// ── DOM element references ────────────────────────────────────────────────
const root             = document.getElementById('iv-root');
const statusLeft       = document.getElementById('iv-status-left');
const statusCoord      = document.getElementById('iv-status-coord');
const statusPerf       = document.getElementById('iv-status-perf');
const gaugePendFill    = document.getElementById('iv-gauge-pend-fill');
const gaugePendTxt     = document.getElementById('iv-gauge-pend-txt');
const gaugeRxFill      = document.getElementById('iv-gauge-rx-fill');
const gaugeRxTxt       = document.getElementById('iv-gauge-rx-txt');
const samplesRibbon    = document.getElementById('iv-samples');

function log(msg) { statusLeft.textContent = msg; }

// ── Status-bar monitors ───────────────────────────────────────────────────
createNetworkGauges({ gaugePendFill, gaugePendTxt, gaugeRxFill, gaugeRxTxt });
createPerfMonitor({ statusPerf });

// reserve space at the bottom so persistent footers don't overlap content
try {
  samplesRibbon.style.paddingBottom = '56px';
  document.getElementById('iv-main').style.paddingBottom = '56px';
} catch (e) {}

// ── Tile layer ────────────────────────────────────────────────────────────
const tileLayer = document.createElement('div');
tileLayer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;';
root.appendChild(tileLayer);
// secLayer is created after viewport + settings are ready; see below.

// crosshair for click tool
const cross = document.createElement('div');
cross.style.cssText = [
  'position:absolute', 'pointer-events:none', 'display:none', 'z-index:4',
  'width:14px', 'height:14px', 'margin:-7px 0 0 -7px',
  'border-radius:50%', 'border:2px solid #ff0',
  'box-shadow:0 0 0 1px #000',
].join(';');
root.appendChild(cross);

// ── Overlay controls panel (top-right) ────────────────────────────────────
const overlayControls = document.createElement('div');
overlayControls.dataset.ivUi = 'true';
overlayControls.style.cssText = [
  'position:absolute', 'top:8px', 'right:8px', 'z-index:11',
  'display:flex', 'align-items:center', 'gap:6px',
  'padding:4px 6px', 'border-radius:6px',
  'background:rgba(0,0,0,0.55)', 'color:#eee',
  'font:12px monospace',
].join(';');
overlayControls.innerHTML = [
  '<span id="iv-primary-opacity-wrap" title="Primary image opacity" style="display:none;align-items:center;gap:4px;">',
  '  <span>Primary</span>',
  '  <input id="iv-primary-opacity" type="range" min="0" max="1" step="0.01" value="1" style="width:80px;">',
  '</span>',
  '<span id="iv-secondary-opacity-wrap" title="Secondary image opacity" style="display:none;align-items:center;gap:4px;">',
  '  <input id="iv-secondary-enabled" type="checkbox" checked title="Enable secondary image fetching (uncheck to stop fetching for better network performance)" style="cursor:pointer;margin:0 2px 0 0;">',
  '  <span>Secondary</span>',
  '  <input id="iv-secondary-opacity" type="range" min="0" max="1" step="0.01" value="1" style="width:80px;">',
  '</span>',
  '<span title="Overlay transparency">Prob. Opacity</span>',
  '<input id="iv-alpha" type="range" min="0" max="1" step="0.01" value="0.55" style="width:90px;">',
  '<span title="Low probability color">Low prob.</span>',
  '<input id="iv-low" type="color" value="#FFA500" style="width:24px;height:24px;border:none;background:none;padding:0;cursor:pointer;">',
  '<span title="High probability color">High prob.</span>',
  '<input id="iv-high" type="color" value="#0000FF" style="width:24px;height:24px;border:none;background:none;padding:0;cursor:pointer;">',
].join('');
root.appendChild(overlayControls);

// ── Coord-transform helpers (used by overlay_controls + setActiveSample) ──
function _primToSec(mat, x, y) {
  var dx = x - mat.tx, dy = y - mat.ty;
  return { x: mat.mi00 * dx + mat.mi01 * dy,
           y: mat.mi10 * dx + mat.mi11 * dy };
}
function _secToPrim(mat, x, y) {
  return { x: mat.m00 * x + mat.m01 * y + mat.tx,
           y: mat.m10 * x + mat.m11 * y + mat.ty };
}
function _tfmStrokeList(list, fn) {
  return list.map(function(s) {
    return Object.assign({}, s, { points: s.points.map(function(p) { return fn(p.x, p.y); }) });
  });
}
function _buildServerStrokesPayload() {
  var out = {};
  for (var _s in strokesBySample) {
    var _raw = strokesBySample[_s];
    var _mat = DRAW_ON_SECONDARY && SAMPLE_SECONDARY_MATRIX[_s];
    if (_mat) {
      out[_s] = {
        strokes_positive: _tfmStrokeList(_raw.strokes_positive, function(x, y) { return _primToSec(_mat, x, y); }),
        strokes_negative: _tfmStrokeList(_raw.strokes_negative, function(x, y) { return _primToSec(_mat, x, y); }),
      };
    } else {
      out[_s] = _raw;
    }
  }
  return out;
}

// ── Viewport ──────────────────────────────────────────────────────────────
const l0       = META.levels[0];
const viewport = createViewport(root, l0.width, l0.height);

// ── Settings ──────────────────────────────────────────────────────────────
if (IS_MULTICHANNEL) { overlayControls.style.right = '104px'; }
const settings = createSettings(overlayControls, root, {
  inferMsPerCell: INFERENCE_MS_PER_CELL,
  maxCellsBoundaries: MAX_CELLS,
});

// ── Secondary image layer (created after viewport+settings; inserted before tileLayer) ─
// _overlayCtrlApi must be declared before createSecondaryLayer because its constructor
// immediately calls _resizeSecCanvas → getSecondaryFetchEnabled, which closes over this var.
let _overlayCtrlApi = null;
const secLayer = createSecondaryLayer({
  root, viewport, settings,
  ACTIVE_SAMPLE_REF: () => ACTIVE_SAMPLE,
  SAMPLE_SECONDARY_META,
  SAMPLE_SECONDARY_MATRIX,
  getSecondaryFetchEnabled: () => _overlayCtrlApi ? _overlayCtrlApi.getSecondaryFetchEnabled() : true,
  BASE_URL,
});
// createSecondaryLayer inserts its canvas into root; move tileLayer back to end
// so the secondary canvas stacks beneath tiles.
root.appendChild(tileLayer);

// ── Tiles ─────────────────────────────────────────────────────────────────
const tiles = IS_MULTICHANNEL
    ? createMultichannelTiles(tileLayer, BASE_URL, META, viewport, ACTIVE_SAMPLE)
    : createTiles(tileLayer, BASE_URL, META, viewport, ACTIVE_SAMPLE, settings);

// ── Monochannel image canvas ───────────────────────────────────────────────
let mono2d = null;
const monoCanvas = document.createElement('canvas');
monoCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;pointer-events:none;';
root.appendChild(monoCanvas);
if (IS_MONOCHANNEL && MONO_META) {
  new ResizeObserver(() => {
    monoCanvas.width  = root.clientWidth  || 1;
    monoCanvas.height = root.clientHeight || 1;
    if (mono2d) mono2d.redraw();
  }).observe(root);
  monoCanvas.width  = root.clientWidth  || 1;
  monoCanvas.height = root.clientHeight || 1;
  mono2d = createMono2D(
    monoCanvas, BASE_URL, MONO_META, viewport, settings,
    () => ACTIVE_SAMPLE,
    s => !!(SAMPLE_IS_MONO[s])
  );
}
function _updateMonoLayerVisibility() {
  const isMono = !!(IS_MONOCHANNEL && MONO_META && SAMPLE_IS_MONO[ACTIVE_SAMPLE]);
  tileLayer.style.display  = isMono ? 'none' : '';
  monoCanvas.style.display = isMono ? ''     : 'none';
}
_updateMonoLayerVisibility();

// ── Spatial hover / cells / transcripts / patches / visium / draw ─────────
const rightControlsRow = document.createElement('div');
rightControlsRow.dataset.ivUi = 'true';
rightControlsRow.style.cssText = [
  'position:absolute', 'top:46px', 'right:8px', 'z-index:11',
  'display:flex', 'flex-direction:row', 'align-items:flex-start', 'gap:6px',
].join(';');
root.appendChild(rightControlsRow);

const hoverInteraction = createHoverInteraction(root, viewport, BASE_URL);
hoverInteraction.clearSample(ACTIVE_SAMPLE);
hoverInteraction.setHasTranscripts(!!(SAMPLE_XENIUM_META[ACTIVE_SAMPLE] &&
  SAMPLE_XENIUM_META[ACTIVE_SAMPLE].genes &&
  SAMPLE_XENIUM_META[ACTIVE_SAMPLE].genes.length));

const _hoverCellCallbacks = {
  onCellsLoaded: (cells, sample, tileKey) => hoverInteraction.addCells(cells, sample, tileKey),
  onSampleChanged: (sample) => {},
};
const _hoverTxCallbacks = {
  onTranscriptsLoaded: (pts, sample, tileKey) => hoverInteraction.addTranscripts(pts, sample, tileKey),
  onSampleChanged: (sample) => {},
};

const transcripts = createXeTranscripts(
  root, BASE_URL, META, SAMPLE_XENIUM_META[ACTIVE_SAMPLE],
  viewport, log, rightControlsRow, ACTIVE_SAMPLE, _hoverTxCallbacks
);
const cells = createXeCells(
  root, BASE_URL, META, SAMPLE_CELLS_META[ACTIVE_SAMPLE],
  viewport, log, rightControlsRow, ACTIVE_SAMPLE, settings,
  ANNOTATION_LAYERS, _hoverCellCallbacks
);
const patches = HAS_TILE_COORDS
  ? createPatchOverlay(root, viewport, settings)
  : null;
if (patches) patches.setContext(ACTIVE_SAMPLE, BASE_URL, TILE_SIZE, SAMPLE_SECONDARY_MATRIX[ACTIVE_SAMPLE]);
const visiumOverlay = HAS_VISIUM
  ? createVisiumOverlay(root, viewport, VISIUM_GENES_BY_SAMPLE)
  : null;
if (visiumOverlay) visiumOverlay.setContext(ACTIVE_SAMPLE, BASE_URL);
const draw = createDraw(root, viewport);
hoverInteraction.setDrawRef(draw);

// ── per-sample stroke storage ──────────────────────────────────────────────
const strokesBySample = {};
const viewportStateBySample  = {};
const transcriptStateBySample = {};
const cellStateBySample = {};
for (const sample of SAMPLES) {
  strokesBySample[sample] = { strokes_positive: [], strokes_negative: [] };
}

// ── Toolbar ────────────────────────────────────────────────────────────────
const toolbar = createToolbar(root, viewport, draw, BASE_URL,
  HAS_RUN_INFERENCE ? { onRun: (btn) => _overlayCtrlApi.runInference(btn) } : null,
  (HAS_SAVE || HAS_LOAD) ? {
    onSave: HAS_SAVE ? async function(name, btn) {
      if (btn) { btn.disabled = true; }
      strokesBySample[ACTIVE_SAMPLE] = draw.getStrokes();
      try {
        await fetch(BASE_URL + '/strokes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ by_sample: _buildServerStrokesPayload() }),
        });
      } catch (e) {}
      fetch(BASE_URL + '/save_classifier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }).then(r => r.json()).then(res => {
        log(res.ok ? ('Saved classifier: ' + name) : ('Save error: ' + (res.error || 'unknown')));
      }).catch(err => log('Save error: ' + err))
        .finally(() => { if (btn) btn.disabled = false; });
    } : null,
    onLoad: HAS_LOAD ? function(name, btn) {
      if (btn) { btn.disabled = true; }
      fetch(BASE_URL + '/load_classifier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }).then(r => r.json()).then(res => {
        if (res.ok) {
          log('Loaded classifier: ' + name);
          const bySample = res.strokes_by_sample || {};
          for (const [s, sd] of Object.entries(bySample)) {
            const mat  = DRAW_ON_SECONDARY && SAMPLE_SECONDARY_MATRIX[s];
            const toP  = mat ? (list => _tfmStrokeList(list, (x, y) => _secToPrim(mat, x, y))) : (list => list);
            strokesBySample[s] = {
              strokes_positive: toP(sd.strokes_positive || []),
              strokes_negative: toP(sd.strokes_negative || []),
            };
          }
          const activeSd = strokesBySample[ACTIVE_SAMPLE] || { strokes_positive: [], strokes_negative: [] };
          draw.setStrokes(activeSd.strokes_positive, activeSd.strokes_negative);
        } else {
          log('Load error: ' + (res.error || 'unknown'));
        }
      }).catch(err => log('Load error: ' + err))
        .finally(() => { if (btn) btn.disabled = false; });
    } : null,
    listNames: HAS_LOAD ? function() {
      return fetch(BASE_URL + '/classifier_names').then(r => r.json()).catch(() => []);
    } : null,
  } : null,
  settings,
  patches,
  visiumOverlay,
  (IS_MONOCHANNEL && mono2d) ? { mono2d, monoMeta: MONO_META, isSampleMono: s => !!(SAMPLE_IS_MONO[s]) } : null,
  { dropdown: secLayer.getSecChDropdown() },
  hoverInteraction
);
toolbar.setMonoActive(!!(IS_MONOCHANNEL && SAMPLE_IS_MONO[ACTIVE_SAMPLE]));
// Expose draw on toolbar for overlay_controls reference
toolbar.draw = draw;

// ── Overlay controls (pred layer + opacity sliders + inference) ────────────
secLayer.initSecChState();
secLayer.buildSecChPanel();
_overlayCtrlApi = createOverlayControls({
  root, viewport, overlayControls, toolbar,
  BASE_URL,
  ACTIVE_SAMPLE_REF: () => ACTIVE_SAMPLE,
  SAMPLE_META, SAMPLE_SECONDARY_META,
  DRAW_ON_SECONDARY, SAMPLE_SECONDARY_MATRIX,
  SAMPLE_SIZES, settings,
  tileLayer, secondaryCanvas: secLayer.secondaryCanvas,
  HAS_RUN_INFERENCE,
  drawSecondaryLayer: (t) => secLayer.drawSecondaryLayer(t),
  setActiveSampleFn: (s) => setActiveSample(s),
  strokesBySample,
  buildServerStrokesPayload: _buildServerStrokesPayload,
});
window.addEventListener('resize', _overlayCtrlApi.resizePredLayer);
_overlayCtrlApi.resizePredLayer();

// ── Fullscreen ────────────────────────────────────────────────────────────
createFullscreen({
  overlayControls,
  resizePredLayer: _overlayCtrlApi.resizePredLayer,
});

// ── setActiveSample ────────────────────────────────────────────────────────
let _metadataPanel = null;  // declared here to avoid TDZ when setActiveSample is called during ribbon init
function setActiveSample(sampleName) {
  if (!SAMPLE_META[sampleName]) return;
  const changed = sampleName !== ACTIVE_SAMPLE;
  if (changed) {
    strokesBySample[ACTIVE_SAMPLE] = draw.getStrokes();
    viewportStateBySample[ACTIVE_SAMPLE] = viewport.getTransform();
    if (typeof cells.getState === 'function')
      cellStateBySample[ACTIVE_SAMPLE] = cells.getState();
    if (typeof transcripts.getState === 'function')
      transcriptStateBySample[ACTIVE_SAMPLE] = transcripts.getState();

    fetch(BASE_URL + '/choose_sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sample: sampleName }),
    }).catch(() => {});

    ACTIVE_SAMPLE = sampleName;
    META = SAMPLE_META[sampleName];
    const l0Sample = META.levels[0];

    hoverInteraction.clearSample(sampleName);
    hoverInteraction.setHasTranscripts(!!(SAMPLE_XENIUM_META[sampleName] &&
      SAMPLE_XENIUM_META[sampleName].genes &&
      SAMPLE_XENIUM_META[sampleName].genes.length));

    tiles.setSample(ACTIVE_SAMPLE);
    tiles.setMeta(META);

    const savedVP = viewportStateBySample[sampleName];
    if (savedVP) {
      viewport.setImageSize(l0Sample.width, l0Sample.height, false);
      viewport.setTransform(savedVP.scale, savedVP.ox, savedVP.oy);
    } else {
      viewport.setImageSize(l0Sample.width, l0Sample.height, true);
    }
    for (const ctrl of secLayer.getSecRgbInFlight().values()) ctrl.abort();
    secLayer.getSecRgbInFlight().clear();
    for (const m of secLayer.getSecChInFlight()) { for (const ctrl of m.values()) ctrl.abort(); m.clear(); }
    secLayer.secCompCache.clear();
    secLayer.initSecChState();
    secLayer.buildSecChPanel();
    transcripts.setContext(ACTIVE_SAMPLE, META, SAMPLE_XENIUM_META[ACTIVE_SAMPLE],
      transcriptStateBySample[sampleName] || null);
    cells.setContext(ACTIVE_SAMPLE, META, SAMPLE_CELLS_META[ACTIVE_SAMPLE],
      cellStateBySample[sampleName] || null);
    if (patches) patches.setContext(ACTIVE_SAMPLE, BASE_URL, TILE_SIZE, SAMPLE_SECONDARY_MATRIX[ACTIVE_SAMPLE]);
    if (visiumOverlay) visiumOverlay.setContext(ACTIVE_SAMPLE, BASE_URL);
    if (mono2d) mono2d.setSample(ACTIVE_SAMPLE);
    _updateMonoLayerVisibility();
    if (toolbar && typeof toolbar.setMonoActive === 'function')
      toolbar.setMonoActive(!!(SAMPLE_IS_MONO[ACTIVE_SAMPLE]));
    _overlayCtrlApi.clearPredPoints();
    _overlayCtrlApi.drawPredLayer();
    secLayer.drawSecondaryLayer(viewport.getTransform());
    _overlayCtrlApi.updateOpacitySliderVisibility();

    const savedStrokes = strokesBySample[ACTIVE_SAMPLE];
    draw.setStrokes(savedStrokes.strokes_positive, savedStrokes.strokes_negative);
  }

  for (const card of samplesRibbon.querySelectorAll('[data-sample-card]')) {
    const isActive = card.dataset.sampleName === sampleName;
    card.style.outline   = isActive ? '2px solid #53d9ff' : 'none';
    card.style.background= isActive ? '#272727' : '#1d1d1d';
  }
  log('Sample: ' + sampleName + (SAMPLE_MAPPING[sampleName] ? ' (' + SAMPLE_MAPPING[sampleName] + ')' : ''));

  // Sync metadata panel row highlights
  if (_metadataPanel) _metadataPanel.syncActiveSample();
}

// Expose to window for external callers
window.setActiveSample = setActiveSample;

// ── Sample ribbon ──────────────────────────────────────────────────────────
_overlayCtrlApi.updateOpacitySliderVisibility();

const sampleRibbonApi = createSampleRibbon({
  samplesRibbon, root, viewport,
  SAMPLES, SAMPLE_META, SAMPLE_XENIUM_META, SAMPLE_CELLS_META,
  SAMPLE_MAPPING, SAMPLE_METADATA,
  BASE_URL,
  ACTIVE_SAMPLE_REF: () => ACTIVE_SAMPLE,
  setActiveSampleFn: setActiveSample,
});
sampleRibbonApi.buildSampleRibbon();

// ── Metadata panel (tab strip + panel) ────────────────────────────────────
_metadataPanel = createMetadataPanel({
  samplesRibbon, root,
  SAMPLES, SAMPLE_META, SAMPLE_METADATA,
  BASE_URL,
  ACTIVE_SAMPLE_REF: () => ACTIVE_SAMPLE,
  setActiveSampleFn: setActiveSample,
  onFilterChange: (samples) => sampleRibbonApi.setVisibleSamples(samples),
  onSampleSelect: (name) => sampleRibbonApi.scrollToSample(name),
  scrollRibbonToSample: (name) => sampleRibbonApi.scrollToSample(name),
});

// ── Modals ────────────────────────────────────────────────────────────────
const modalHelpers = createModalHelpers();

// ── Footer controls ───────────────────────────────────────────────────────
createFooterControls({
  SAMPLES,
  ACTIVE_SAMPLE_REF: () => ACTIVE_SAMPLE,
  BASE_URL,
  STOP_URL: _STOP_URL,
  draw, strokesBySample,
  drawPredLayer:   _overlayCtrlApi.drawPredLayer,
  clearPredPoints: _overlayCtrlApi.clearPredPoints,
  modalHelpers,
  log,
});

// ── Root event listeners ──────────────────────────────────────────────────
// crosshair on click-tool mouseup
root.addEventListener('mouseup', e => {
  if (toolbar.getActiveTool() !== 'click') { cross.style.display = 'none'; return; }
  const r = root.getBoundingClientRect();
  cross.style.left    = (e.clientX - r.left) + 'px';
  cross.style.top     = (e.clientY - r.top)  + 'px';
  cross.style.display = 'block';
});

// coordinate display
root.addEventListener('mousemove', e => {
  const r   = root.getBoundingClientRect();
  const vpX = e.clientX - r.left;
  const vpY = e.clientY - r.top;
  const img = viewport.toImageSpace(vpX, vpY);
  const ix  = Math.round(img.x);
  const iy  = Math.round(img.y);
  statusCoord.textContent = 'x: ' + ix + '  y: ' + iy;
});
root.addEventListener('mouseleave', () => { statusCoord.textContent = ''; });

// ── flush strokes (window API) ─────────────────────────────────────────────
window.ivFlushStrokes = function() {
  strokesBySample[ACTIVE_SAMPLE] = draw.getStrokes();
  const payload = { by_sample: strokesBySample };
  let totalPos = 0, totalNeg = 0;
  for (const sample in strokesBySample) {
    totalPos += (strokesBySample[sample].strokes_positive || []).length;
    totalNeg += (strokesBySample[sample].strokes_negative || []).length;
  }
  fetch(BASE_URL + '/strokes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(() => {
    log('All annotations transferred (' + totalPos + ' pos, ' + totalNeg + ' neg across all samples)');
  }).catch(err => log('Transfer error: ' + err));
};

// ── status bar — viewport onChange ─────────────────────────────────────────
viewport.onChange(t => {
  secLayer.drawSecondaryLayer(t);
  _overlayCtrlApi.drawPredLayer();
  sampleRibbonApi.updateThumbOverlays();
  const lvl  = META.levels;
  const sens = settings ? settings.get('levelSensitivity') : 1.0;
  const level = (tiles && tiles.getLevel) ? tiles.getLevel() : (() => {
    let l = META.n_levels - 1;
    for (let i = 0; i < META.n_levels; i++) {
      if (t.scale >= sens / lvl[i].downsample) { l = i; break; }
    }
    return l;
  })();
  const _mappedName = SAMPLE_MAPPING[ACTIVE_SAMPLE] ? ' (' + SAMPLE_MAPPING[ACTIVE_SAMPLE] + ')' : '';
  log('sample ' + ACTIVE_SAMPLE + _mappedName + '  |  zoom ' + t.scale.toFixed(3) + 'x  |  level ' + level
    + '  (' + lvl[level].width + 'x' + lvl[level].height + ')');
});

// ── Trigger initial tile load ──────────────────────────────────────────────
tiles.update(viewport.getTransform());
secLayer.drawSecondaryLayer(viewport.getTransform());

log('Ready: ' + ACTIVE_SAMPLE);

// ── Async annotation layers ────────────────────────────────────────────────
fetch(BASE_URL + '/annotation_layers')
  .then(r => r.json())
  .then(layers => {
    ANNOTATION_LAYERS = layers;
    cells.setAnnotationLayers(layers);
  })
  .catch(() => {});

// ── Guided demo ────────────────────────────────────────────────────────────
window.__ivDemo = createDemo();
