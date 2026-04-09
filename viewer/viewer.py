import json
from pathlib import Path
from IPython.display import display, HTML, Javascript
import ipywidgets as widgets

from viewer.tiff          import PyramidImage
from viewer.multichannel  import MultichannelImage
from viewer.server        import ViewerServer
from viewer.xetranscripts import XeniumTranscripts
from viewer.xencells      import XeniumCells

_JS_DIR = Path(__file__).parent / 'js'

# Configurable: milliseconds of loading-bar animation per cell in the inference sample.
# Examples: 5 000 cells → 5000 * 0.4 = 2 000 ms (2 s)
#           20 000 cells → 20000 * 0.4 = 8 000 ms (8 s)
INFERENCE_MS_PER_CELL = 0.15

def _read_js(name):
    return (_JS_DIR / name).read_text()


def _open_image(path):
    """
    Auto-detect channel count and return a MultichannelImage (C > 3) or
    a PyramidImage (C == 1 or 3 — standard RGB / greyscale histology).
    Opens the tifffile zarr store for a shape peek then instantiates the
    appropriate class (which will open the file a second time internally).
    """
    import tifffile, zarr
    store = tifffile.imread(str(path), aszarr=True)
    z     = zarr.open(store, mode='r')
    n_ch  = z['0'].shape[0]
    if n_ch > 3:
        return MultichannelImage(path)
    return PyramidImage(path)


def create_viewer(samples, images, width="100%", height="700px", host=None, port=None,
                  xenium_mpp=0.2125, category_colors=None, max_cells=2000,
                  xenium_bundle_paths=None, matrices=None, annotations=None,
                  run_inference_fn=None, sample_sizes=None,
                  save_func=None, load_func=None, list_names_func=None):
    """
    Display a pan/zoom/draw viewer for a pyramidal OME-TIFF in JupyterLab.

    Controls
    --------
    ✥      pan tool       — drag to pan, scroll to zoom, double-click to reset
    draw+  positive draw  — freehand positive contour; undo / clear buttons in toolbar
    draw-  negative draw  — freehand negative contour; undo / clear buttons in toolbar
    ⊕      click tool     — single clicks recorded with image-space coordinates

    Parameters
    ----------
    samples : list of str | Path
    images : dict of str | Path
    width, height : CSS strings for the viewer div
    host : IP reachable from the browser (auto-detected if None)
    port : HTTP port for the tile/click server (random if None)
    xenium_bundle_paths : optional dict[sample] -> Xenium bundle path or None
    matrices : optional dict[sample] -> 3×3 CSV affine matrix path or None
    xenium_mpp : Xenium microns-per-pixel (default 1.0); scales coords after apply matrix
    annotations : optional dict[sample] -> cell-id->category mapping
    category_colors : optional dict mapping category names to hex colors
    max_cells : maximum number of cells to display per tile (default 2000)
    run_inference_fn : optional Python callable
        If provided, a green glowing ▶ button appears in the toolbar.  When clicked
        the viewer flushes strokes, then calls::

            result = run_inference_fn(
                strokes_by_sample=strokes_by_sample,  # dict[str, {...}]
                active_sample=active_sample,          # str
            )

        The callable must return a dict with at least keys ``xi``, ``yi``, ``pi``
        (equal-length iterables of image-space coords and probabilities) and may
        include ``sample``, ``delta``, ``alpha``, ``color_low``, ``color_high``.
    sample_sizes : optional dict[sample] -> int
        Number of cells per sample, used to time the loading animation
        (see ``INFERENCE_MS_PER_CELL`` in this module).  If omitted the
        animation uses a fixed 5 000-cell estimate.
    save_func : optional callable(name: str, strokes_by_sample: dict)
        Called when the user clicks Save and enters a name. Receives the
        classifier name chosen by the user and the current strokes dict
        (same structure as ``strokes_by_sample`` returned by create_viewer).
        Example::

            save_func=lambda name, drawings: dianne.saveGUIClassifier(
                clf, classifierPaths, name, samples,
                None, None, None, None, None, None,
                patchesCDFsMod, annotationsMod, drawings)

    load_func : optional callable(name: str, strokes_by_sample: dict)
        Called when the user picks a name from the Load dialog. Receives the
        name and the current strokes dict (for optional use).
    list_names_func : optional callable() -> list[str]
        Returns the list of saved classifier names shown in the Load picker.\n        If omitted the Load button will not appear.
    Returns
    -------
    clicks  : list of dicts  {img_x, img_y, vp_x, vp_y, zoom}
    strokes : dict with keys:
          - strokes_positive: [{id, points: [{x, y}, ...]}, ...]
          - strokes_negative: [{id, points: [{x, y}, ...]}, ...]
          image-space coords
    stop    : callable — shuts down the background HTTP server
    """
    if isinstance(samples, (list, tuple)):
      sample_list = [str(s) for s in samples]
    else:
      sample_list = [str(samples)]
    if not sample_list:
      raise ValueError('create_viewer requires at least one sample')

    missing = [s for s in sample_list if s not in images]
    if missing:
      raise KeyError(f'missing image path(s) for sample(s): {missing}')

    chosen_sample = sample_list[0]
    sample_images = {s: _open_image(images[s]) for s in sample_list}
    image         = sample_images[chosen_sample]
    is_multichannel = isinstance(image, MultichannelImage)

    if xenium_bundle_paths is None:
      xenium_bundle_paths = {}
    elif not isinstance(xenium_bundle_paths, dict):
      raise TypeError('xenium_bundle_paths must be a dict[sample] -> path|None')
    else:
      xenium_bundle_paths = {str(k): v for k, v in xenium_bundle_paths.items()}

    if matrices is None:
      matrices = {}
    elif not isinstance(matrices, dict):
      raise TypeError('matrices must be a dict[sample] -> matrix_csv_path|None')
    else:
      matrices = {str(k): v for k, v in matrices.items()}

    if annotations is None:
      annotations = {}
    elif not isinstance(annotations, dict):
      raise TypeError('annotations must be a dict[sample] -> cell_id_to_category')
    else:
      annotations = {str(k): v for k, v in annotations.items()}

    if sample_sizes is None:
      sample_sizes = {}
    elif not hasattr(sample_sizes, 'items'):
      raise TypeError('sample_sizes must be a dict[sample] -> int')
    else:
      sample_sizes = {
        str(k): int(v)
        for k, v in sample_sizes.items()
        if v is not None
      }

    xenium_by_sample = {}
    xenium_cells_by_sample = {}
    sample_xenium_meta = {s: None for s in sample_list}
    sample_cells_meta = {s: None for s in sample_list}

    for sample in sample_list:
      bundle_path = xenium_bundle_paths.get(sample)
      if bundle_path is None:
        continue

      matrix_path = matrices.get(sample)
      sample_annotations = annotations.get(sample)
      sample_colors = category_colors.get(sample) if isinstance(category_colors, dict) and sample in category_colors else category_colors

      sample_xenium = XeniumTranscripts(bundle_path, sample_images[sample].metadata,
                        matrix_path=matrix_path,
                        xenium_mpp=xenium_mpp)
      sample_cells = XeniumCells(bundle_path, sample_images[sample].metadata,
                     matrix_path=matrix_path,
                     xenium_mpp=xenium_mpp,
                     cell_id_to_category=sample_annotations,
                     category_colors=sample_colors,
                     max_cells=max_cells)
      xenium_by_sample[sample] = sample_xenium
      xenium_cells_by_sample[sample] = sample_cells
      sample_xenium_meta[sample] = sample_xenium.metadata
      sample_cells_meta[sample] = sample_cells.metadata

    server = ViewerServer(images=sample_images, chosen_sample=chosen_sample,
          host=host, port=port,
          xenium_by_sample=xenium_by_sample,
          xenium_cells_by_sample=xenium_cells_by_sample,
          run_inference_fn=run_inference_fn,
          sample_sizes=sample_sizes,
          save_fn=save_func,
          load_fn=load_func,
          list_names_fn=list_names_func)
    server.start()

    server.chosen_sample = chosen_sample

    # output widget for server-side log (optional, hidden by default)
    out = widgets.Output(layout=widgets.Layout(display='none'))

    meta_json = json.dumps(image.metadata)
    samples_json = json.dumps(sample_list)
    sample_meta_json = json.dumps({s: sample_images[s].metadata for s in sample_list})
    sample_xenium_meta_json = json.dumps(sample_xenium_meta)
    sample_cells_meta_json = json.dumps(sample_cells_meta)
    base_url  = server.base_url

    # inline all JS files
    js = '\n\n'.join(_read_js(f) for f in [
        'viewport.js',
        'tiles.js',
        'multichannel.js',
        'transcripts.js',
        'cells.js',
        'draw.js',
        'settings.js',
        'toolbar.js',
        'demo.js',
    ])

    html = """
<div id="iv-shell" style="
  width: __WIDTH__;
  height: __HEIGHT__;
  display: flex;
  align-items: stretch;
  gap: 0px;
  position: relative; /* anchor absolute footer controls */
">
  <div id="iv-samples" style="
    width: 10%;
    min-width: 170px;
    max-width: 260px;
    height: calc(100% - 58px);
    overflow-y: auto;
    background: #161616;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    box-sizing: border-box;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative; /* allow absolute footer controls */
  "></div>
  <div id="iv-main" style="
    width: 90%;
    min-width: 0;
    position: relative; /* allow absolute footer controls */
    display: flex; flex-direction: column; /* keep status bar at bottom */
  ">
<div id="iv-root" style="
  position: relative;
  width: 100%;
  flex: 1 1 auto;
  height: auto;
  overflow: hidden;
  background: #111;
  border: 1px solid #444;
  border-radius: 6px 6px 0 0;
"></div>
<div id="iv-status" style="
  font: 12px monospace;
  padding: 3px 8px;
  background: #1e1e1e;
  color: #4fc;
  border: 1px solid #444;
  border-top: none;
  border-radius: 0 0 6px 6px;
  margin-bottom: 2px;
">initializing…</div>
  </div>
</div>

<script>
(function () {
  const root     = document.getElementById('iv-root');
  const status   = document.getElementById('iv-status');
  const samplesRibbon = document.getElementById('iv-samples');
  const BASE_URL = __BASE_URL__;
  const SAMPLES  = __SAMPLES__;
  const SAMPLE_META = __SAMPLE_META__;
  const SAMPLE_XENIUM_META = __SAMPLE_XENIUM_META__;
  const SAMPLE_CELLS_META = __SAMPLE_CELLS_META__;
  const HAS_RUN_INFERENCE  = __HAS_RUN_INFERENCE__;
  const HAS_SAVE           = __HAS_SAVE__;
  const HAS_LOAD           = __HAS_LOAD__;
  const SAMPLE_SIZES       = __SAMPLE_SIZES__;
  const INFERENCE_MS_PER_CELL = __INFERENCE_MS_PER_CELL__;
  const MAX_CELLS              = __MAX_CELLS__;
  const IS_MULTICHANNEL    = __IS_MULTICHANNEL__;
  let ACTIVE_SAMPLE = SAMPLES[0];
  let META = SAMPLE_META[ACTIVE_SAMPLE] || __META__;

  function log(msg) { status.textContent = msg; }

  // reserve space at the bottom so persistent footers don't overlap content
  try {
    samplesRibbon.style.paddingBottom = '56px';
    document.getElementById('iv-main').style.paddingBottom = '56px';
  } catch (e) {}

  // tile layer
  const tileLayer = document.createElement('div');
  tileLayer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;';
  root.appendChild(tileLayer);

  // crosshair for click tool
  const cross = document.createElement('div');
  cross.style.cssText = [
    'position:absolute', 'pointer-events:none', 'display:none', 'z-index:4',
    'width:14px', 'height:14px', 'margin:-7px 0 0 -7px',
    'border-radius:50%', 'border:2px solid #ff0',
    'box-shadow:0 0 0 1px #000',
  ].join(';');
  root.appendChild(cross);

  // overlay controls (opacity + low/high color)
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
    '<span title="Overlay transparency">Opacity</span>',
    '<input id="iv-alpha" type="range" min="0" max="1" step="0.01" value="0.55" style="width:90px;">',
    '<span title="Low probability color">Low prob.</span>',
    '<input id="iv-low" type="color" value="#FFA500" style="width:24px;height:24px;border:none;background:none;padding:0;cursor:pointer;">',
    '<span title="High probability color">High prob.</span>',
    '<input id="iv-high" type="color" value="#0000FF" style="width:24px;height:24px;border:none;background:none;padding:0;cursor:pointer;">',
  ].join('');
  root.appendChild(overlayControls);

  // Fullscreen toggle button (expands iv-shell to fill the browser viewport)
  (function addFullscreenToggle() {
    const shell = document.getElementById('iv-shell');
    const samplesEl = document.getElementById('iv-samples');
    const rootEl = document.getElementById('iv-root');
    const ivMain = document.getElementById('iv-main');
    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.title = 'Toggle fullscreen';
    fsBtn.style.cssText = [
      'font:12px monospace','padding:6px 8px','border-radius:6px','border:1px solid #333',
      'background:#262626','color:#e6e6e6','cursor:pointer','display:flex','gap:6px','align-items:center'
    ].join(';');
    fsBtn.dataset.demoId = 'fs-btn';
    fsBtn.innerHTML = '<span style="font-size:12px">⛶</span>';

    let prev = null;
    function enterFs() {
      prev = {
        shellStyle: shell.getAttribute('style') || '',
        samplesStyle: samplesEl.getAttribute('style') || '',
        rootStyle: rootEl.getAttribute('style') || '',
        ivMainStyle: ivMain.getAttribute('style') || '',
        bodyOverflow: document.body.style.overflow || '',
      };
      shell.style.position = 'fixed';
      shell.style.left = '0';
      shell.style.top = '0';
      shell.style.width = '100vw';
      shell.style.height = '100vh';
      shell.style.zIndex = '2147483647';
      document.body.style.overflow = 'hidden';
      // set heights and padding so status bar and bottom buttons remain visible
      samplesEl.style.height = 'calc(100vh - 60px)';
      rootEl.style.height = 'calc(100vh - 56px)';
      samplesEl.style.paddingBottom = '56px';
      ivMain.style.paddingBottom = '56px';
      fsBtn.innerHTML = '<span style="font-size:12px">⤫</span>';
      resizePredLayer();
      // Esc key exits fullscreen
      document.addEventListener('keydown', onFsKeyDown);
    }

    function exitFs() {
      if (!prev) return;
      shell.setAttribute('style', prev.shellStyle);
      samplesEl.setAttribute('style', prev.samplesStyle);
      rootEl.setAttribute('style', prev.rootStyle);
      ivMain.setAttribute('style', prev.ivMainStyle);
      document.body.style.overflow = prev.bodyOverflow;
      prev = null;
      fsBtn.innerHTML = '<span style="font-size:12px">⛶</span>';
      resizePredLayer();
      document.removeEventListener('keydown', onFsKeyDown);
    }

    let active = false;
    fsBtn.addEventListener('click', () => {
      active = !active;
      if (active) enterFs(); else exitFs();
    });

    function onFsKeyDown(e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        // if a modal is open, cancel it first
        if (window.__iv_modal_visible && typeof window.__iv_modal_cancel === 'function') {
          window.__iv_modal_cancel();
          return;
        }
        if (active) {
          active = false;
          exitFs();
        }
      }
    }

    overlayControls.appendChild(fsBtn);
  })();

  // boot
  __JS__

  const l0       = META.levels[0];
  const viewport = createViewport(root, l0.width, l0.height);
  // In multichannel mode the channel panel occupies top-right (right:8px),
  // so shift the overlay controls panel leftward to avoid overlap.
  if (IS_MULTICHANNEL) { overlayControls.style.right = '104px'; }
  // Settings panel — gear button appended to overlayControls, panel hosted in root.
  const settings = createSettings(overlayControls, root, {
    inferMsPerCell: INFERENCE_MS_PER_CELL,
    maxCellsBoundaries: MAX_CELLS,
  });
  const tiles    = IS_MULTICHANNEL
      ? createMultichannelTiles(tileLayer, BASE_URL, META, viewport, ACTIVE_SAMPLE)
      : createTiles(tileLayer, BASE_URL, META, viewport, ACTIVE_SAMPLE, settings);
  // shared row: [cells button] [genes controls] — both top-right, side by side
  const rightControlsRow = document.createElement('div');
  rightControlsRow.dataset.ivUi = 'true';
  rightControlsRow.style.cssText = [
    'position:absolute', 'top:46px', 'right:8px', 'z-index:11',
    'display:flex', 'flex-direction:row', 'align-items:flex-start', 'gap:6px',
  ].join(';');
  root.appendChild(rightControlsRow);

  const transcripts = createXeTranscripts(
    root,
    BASE_URL,
    META,
    SAMPLE_XENIUM_META[ACTIVE_SAMPLE],
    viewport,
    log,
    rightControlsRow,
    ACTIVE_SAMPLE
  );
  const cells = createXeCells(
    root,
    BASE_URL,
    META,
    SAMPLE_CELLS_META[ACTIVE_SAMPLE],
    viewport,
    log,
    rightControlsRow,
    ACTIVE_SAMPLE,
    settings
  );
  const draw     = createDraw(root, viewport);
  const toolbar  = createToolbar(root, viewport, draw, BASE_URL,
    HAS_RUN_INFERENCE ? { onRun: runInference } : null,
    (HAS_SAVE || HAS_LOAD) ? {
      onSave: HAS_SAVE ? async function(name, btn) {
        if (btn) { btn.disabled = true; }
        // Flush current sample's strokes first so server has the latest drawings
        strokesBySample[ACTIVE_SAMPLE] = draw.getStrokes();
        try {
          await fetch(BASE_URL + '/strokes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ by_sample: strokesBySample }),
          });
        } catch (e) { /* non-fatal; save continues with whatever server already has */ }
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
          log(res.ok ? ('Loaded classifier: ' + name) : ('Load error: ' + (res.error || 'unknown')));
        }).catch(err => log('Load error: ' + err))
          .finally(() => { if (btn) btn.disabled = false; });
      } : null,
      listNames: HAS_LOAD ? function() {
        return fetch(BASE_URL + '/classifier_names')
          .then(r => r.json())
          .catch(() => []);
      } : null,
    } : null,
    settings
  );

  // per-sample stroke storage
  const strokesBySample = {};
  for (const sample of SAMPLES) {
    strokesBySample[sample] = { strokes_positive: [], strokes_negative: [] };
  }

  // prediction overlay layer (Python-driven)
  const predLayer = document.createElement('canvas');
  predLayer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;';
  root.appendChild(predLayer);
  const predCtx = predLayer.getContext('2d');
  let predPoints = [];

  // ── inference loading overlay ─────────────────────────────────────────────
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

  // ── run-inference handler (hoisted via `function` declaration) ────────────
  async function runInference(runBtn) {
    if (!HAS_RUN_INFERENCE) return;
    // 1. Flush current stokes to server
    strokesBySample[ACTIVE_SAMPLE] = draw.getStrokes();
    try {
      await fetch(BASE_URL + '/strokes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by_sample: strokesBySample }),
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
        const points = ov.xi.map((xi, i) => ({ xi, yi: ov.yi[i], pi: ov.pi[i] }));
        const style  = { delta: ov.style.delta, alpha: ov.style.alpha,
                         colorLow: ov.style.colorLow, colorHigh: ov.style.colorHigh };
        if (result.sample && result.sample !== ACTIVE_SAMPLE) setActiveSample(result.sample);
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
  let predStyle = {
    alpha: 0.55,
    delta: 28,
    colorLow: '#FFA500',
    colorHigh: '#0000FF',
  };

  const alphaSlider = overlayControls.querySelector('#iv-alpha');
  const lowColorPicker = overlayControls.querySelector('#iv-low');
  const highColorPicker = overlayControls.querySelector('#iv-high');

  function resizePredLayer() {
    predLayer.width = root.clientWidth;
    predLayer.height = root.clientHeight;
    drawPredLayer();
  }
  window.addEventListener('resize', resizePredLayer);
  resizePredLayer();

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
    const lo = parseHexColor(predStyle.colorLow) || { r: 11, g: 77, b: 255 };
    const hi = parseHexColor(predStyle.colorHigh) || { r: 255, g: 42, b: 42 };
    const r = Math.round(lo.r + (hi.r - lo.r) * p);
    const g = Math.round(lo.g + (hi.g - lo.g) * p);
    const b = Math.round(lo.b + (hi.b - lo.b) * p);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function syncOverlayControls() {
    alphaSlider.value = String(clamp01(predStyle.alpha));
    lowColorPicker.value = predStyle.colorLow;
    highColorPicker.value = predStyle.colorHigh;
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
    const delta = Math.max(1, Number(predStyle.delta) || 28);
    const half = delta / 2;
    const alpha = clamp01(predStyle.alpha);

    for (const pt of predPoints) {
      const x = Number(pt.xi);
      const y = Number(pt.yi);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const p = clamp01(pt.pi);

      const s0 = viewport.toScreenSpace(x - half, y - half);
      const s1 = viewport.toScreenSpace(x + half, y + half);
      const left = Math.min(s0.x, s1.x);
      const top = Math.min(s0.y, s1.y);
      const width = Math.abs(s1.x - s0.x);
      const height = Math.abs(s1.y - s0.y);

      if (left > predLayer.width || top > predLayer.height || left + width < 0 || top + height < 0) {
        continue;
      }

      predCtx.fillStyle = probColor(p, alpha);
      predCtx.fillRect(left, top, width, height);
    }
  }

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

  // Expose setActiveSample to window for external calls (e.g., set_overlay_points)
  window.setActiveSample = setActiveSample;
  // Expose inference loader for external control if needed
  window.ivShowLoader = showLoader;
  window.ivHideLoader = hideLoader;

  syncOverlayControls();

  function setActiveSample(sampleName) {
    if (!SAMPLE_META[sampleName]) return;
    const changed = sampleName !== ACTIVE_SAMPLE;
    if (changed) {
      // Save strokes from previous sample before switching
      strokesBySample[ACTIVE_SAMPLE] = draw.getStrokes();

      fetch(BASE_URL + '/choose_sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample: sampleName }),
      }).catch(() => {});

      ACTIVE_SAMPLE = sampleName;
      META = SAMPLE_META[sampleName];
      const l0Sample = META.levels[0];
      viewport.setImageSize(l0Sample.width, l0Sample.height, true);
      tiles.setSample(ACTIVE_SAMPLE);
      tiles.setMeta(META);
      transcripts.setContext(ACTIVE_SAMPLE, META, SAMPLE_XENIUM_META[ACTIVE_SAMPLE]);
      cells.setContext(ACTIVE_SAMPLE, META, SAMPLE_CELLS_META[ACTIVE_SAMPLE]);
      predPoints = [];
      drawPredLayer();

      // Load strokes for new sample
      const savedStrokes = strokesBySample[ACTIVE_SAMPLE];
      draw.setStrokes(savedStrokes.strokes_positive, savedStrokes.strokes_negative);
    }

    for (const card of samplesRibbon.querySelectorAll('[data-sample-card]')) {
      const isActive = card.dataset.sampleName === sampleName;
      card.style.outline = isActive ? '2px solid #53d9ff' : 'none';
      card.style.background = isActive ? '#272727' : '#1d1d1d';
    }
    log('Sample: ' + sampleName);
  }

  function buildSampleRibbon() {
    samplesRibbon.innerHTML = '';

    const legend = document.createElement('div');
    legend.style.cssText = [
      'display:flex', 'gap:6px', 'align-items:center', 'flex-wrap:wrap',
      'padding:2px 0 6px 0', 'border-bottom:1px solid #2f2f2f',
      'margin-bottom:2px',
    ].join(';');

    function makeLegendBadge(text, borderColor, fgColor, bgColor, title) {
      const b = document.createElement('span');
      b.textContent = text;
      b.title = title;
      b.style.cssText = [
        'font:10px monospace', 'padding:1px 6px', 'border-radius:999px',
        'border:1px solid ' + borderColor,
        'color:' + fgColor,
        'background:' + bgColor,
      ].join(';');
      return b;
    }

    // legend.appendChild(makeLegendBadge('XE', '#1f7a3a', '#8cffb1', 'rgba(31,122,58,0.2)', 'Xenium overlays available'));
    // legend.appendChild(makeLegendBadge('HE', '#555', '#bdbdbd', 'rgba(80,80,80,0.25)', 'H&E image only'));
    samplesRibbon.appendChild(legend);

    for (const sampleName of SAMPLES) {
      const hasXe = !!(SAMPLE_XENIUM_META[sampleName] || SAMPLE_CELLS_META[sampleName]);
      const card = document.createElement('button');
      card.dataset.sampleCard = 'true';
      card.dataset.sampleName = sampleName;
      card.type = 'button';
      card.style.cssText = [
        'width:100%', 'text-align:left', 'cursor:pointer',
        'border:1px solid #4a4a4a', 'border-radius:6px',
        'background:#1d1d1d', 'color:#e6e6e6', 'padding:6px',
        'display:flex', 'flex-direction:column', 'gap:6px',
      ].join(';');

      const thumbWrap = document.createElement('div');
      thumbWrap.style.cssText = [
        'width:100%', 'aspect-ratio:1/1', 'overflow:hidden',
        'position:relative', 'border-radius:4px', 'background:#0f0f0f',
        'border:1px solid #303030',
      ].join(';');
      const m = SAMPLE_META[sampleName];
      // Print number of levels for debugging; in practice we expect 4-6 levels for a typical pyramidal OME-TIFF
      console.log(`Sample ${sampleName} has ${m.n_levels} levels`);
      const thumbLevel = Math.max(2, Number(m.n_levels) - 1);
      console.log(`Using thumbnail level ${thumbLevel} for sample ${sampleName}`);
      const img = document.createElement('img');
      img.alt = sampleName;
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center center;display:block;';
      // Request a server-generated square thumbnail (256×256) of the full
      // lowest-resolution level so we always get the entire image resized
      // preserving aspect ratio.
      img.src = BASE_URL + '/thumb?sample=' + encodeURIComponent(sampleName)
        + '&level=' + thumbLevel + '&size=256';
      thumbWrap.appendChild(img);

      const label = document.createElement('div');
      label.textContent = sampleName;
      label.style.cssText = [
        'font:12px monospace', 'line-height:1.3',
        'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
      ].join(';');

      const badge = document.createElement('div');
      badge.textContent = hasXe ? 'XE' : 'HE';
      badge.title = hasXe ? 'Xenium overlays available' : 'H&E image only';
      badge.style.cssText = [
        'font:10px monospace', 'align-self:flex-start',
        'padding:1px 6px', 'border-radius:999px',
        'border:1px solid ' + (hasXe ? '#1f7a3a' : '#555'),
        'color:' + (hasXe ? '#8cffb1' : '#bdbdbd'),
        'background:' + (hasXe ? 'rgba(31,122,58,0.2)' : 'rgba(80,80,80,0.25)'),
      ].join(';');

      card.appendChild(thumbWrap);
      card.appendChild(label);
      card.appendChild(badge);
      card.addEventListener('click', () => setActiveSample(sampleName));
      samplesRibbon.appendChild(card);
    }
    setActiveSample(ACTIVE_SAMPLE);
  }

  buildSampleRibbon();

  // Add sample-area footer controls (bottom-left of iv-samples)
  // modal helper for custom confirm/dialog centered on screen
  function createModalHelpers() {
    const modalOverlay = document.createElement('div');
    modalOverlay.style.cssText = [
      'position:fixed','left:0','top:0','width:100%','height:100%','display:none',
      'align-items:center','justify-content:center','z-index:2147483650','background:rgba(0,0,0,0.4)'
    ].join(';');

    const modal = document.createElement('div');
    modal.style.cssText = [
      'min-width:260px','max-width:90%','background:#1b1b1b','color:#eee','padding:14px',
      'border-radius:8px','box-shadow:0 6px 20px rgba(0,0,0,0.6)','font:13px monospace'
    ].join(';');

    const titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:700;margin-bottom:8px;color:#53d9ff';
    titleEl.textContent = 'DIANNE';
    const msgEl = document.createElement('div');
    msgEl.style.cssText = 'margin-bottom:12px;white-space:normal;';

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.textContent = 'OK';
    okBtn.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid #333;background:#1f8cff;color:#fff;cursor:pointer';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid #333;background:#333;color:#ddd;cursor:pointer';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    modal.appendChild(titleEl);
    modal.appendChild(msgEl);
    modal.appendChild(buttons);
    modalOverlay.appendChild(modal);
    document.body.appendChild(modalOverlay);

    let currentClean = null;
    let currentResolve = null;

    // expose modal visibility and cancel helper on window so global handlers can use them
    window.__iv_modal_visible = false;
    window.__iv_modal_cancel = () => {
      if (currentClean && currentResolve) {
        currentClean();
        modalOverlay.style.display = 'none';
        currentResolve(false);
        currentClean = null;
        currentResolve = null;
        window.__iv_modal_visible = false;
      }
    };

    function showConfirm(message) {
      return new Promise(resolve => {
        msgEl.textContent = message;
        modalOverlay.style.display = 'flex';
        okBtn.focus();
        window.__iv_modal_visible = true;

        const clean = () => {
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          document.removeEventListener('keydown', onKey);
        };
        const onOk = () => { clean(); modalOverlay.style.display = 'none'; window.__iv_modal_visible = false; resolve(true); };
        const onCancel = () => { clean(); modalOverlay.style.display = 'none'; window.__iv_modal_visible = false; resolve(false); };
        const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Esc') { onCancel(); } };

        currentClean = clean;
        currentResolve = resolve;

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
      });
    }

    return { showConfirm };
  }

  const modalHelpers = createModalHelpers();

  // Add clear buttons into the overlay controls (top-right) to avoid overlap
  (function addClearButtonsToOverlay() {
    const makeSmallBtn = (title, innerHtml) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.style.cssText = [
        'font:12px monospace','padding:4px 6px','border-radius:6px','border:1px solid #333',
        'background:rgba(38,38,38,0.9)','color:#e6e6e6','cursor:pointer','display:flex','gap:6px','align-items:center'
      ].join(';');
      b.innerHTML = innerHtml;
      return b;
    };

    const clearAllBtn = makeSmallBtn('Clear all annotations', '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 17.25L8.5 10.75L14.5 16.75L8 23.25H2V17.25Z" fill="#fff" opacity="0.14"/><path d="M21.71 11.29L18.71 8.29C18.32 7.9 17.69 7.9 17.3 8.29L15.17 10.42L19.58 14.83L21.71 12.7C22.1 12.31 22.1 11.68 21.71 11.29Z" fill="#fff" opacity="0.9"/></svg> <span style="font-size:11px">Clear all</span>');
    clearAllBtn.dataset.demoId = 'clear-all-btn';
    clearAllBtn.addEventListener('click', async () => {
      const ok = await modalHelpers.showConfirm('Clear all annotations for all samples? This cannot be undone.');
      if (!ok) return;
      log('Clearing all annotations...');
      // Clear JS state and renderer immediately
      try {
        for (const s of SAMPLES) strokesBySample[s] = { strokes_positive: [], strokes_negative: [] };
        draw.setStrokes([], []);
        if (typeof draw.clear === 'function') draw.clear();
        predPoints = [];
        drawPredLayer();

        // Persist cleared state to server
        await fetch(BASE_URL + '/click', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) });
        const bySample = {};
        for (const s of SAMPLES) bySample[s] = { strokes_positive: [], strokes_negative: [] };
        await fetch(BASE_URL + '/strokes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by_sample: bySample }) });

        log('All annotations cleared');
      } catch (err) { log('Clear error: ' + err); }
    });

    const clearSampleBtn = makeSmallBtn('Clear annotations for sample', '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 17.25L8.5 10.75L14.5 16.75L8 23.25H2V17.25Z" fill="#fff" opacity="0.14"/><path d="M21.71 11.29L18.71 8.29C18.32 7.9 17.69 7.9 17.3 8.29L15.17 10.42L19.58 14.83L21.71 12.7C22.1 12.31 22.1 11.68 21.71 11.29Z" fill="#fff" opacity="0.9"/></svg> <span style="font-size:11px">Clear sample</span>');
    clearSampleBtn.dataset.demoId = 'clear-sample-btn';
    clearSampleBtn.addEventListener('click', async () => {
      const ok = await modalHelpers.showConfirm('Clear annotations for sample ' + ACTIVE_SAMPLE + '?');
      if (!ok) return;
      log('Clearing annotations for sample ' + ACTIVE_SAMPLE + '...');
      try {
        // Clear JS state and renderer immediately for the active sample
        if (strokesBySample[ACTIVE_SAMPLE]) strokesBySample[ACTIVE_SAMPLE] = { strokes_positive: [], strokes_negative: [] };
        draw.setStrokes([], []);
        if (typeof draw.clear === 'function') draw.clear();
        predPoints = [];
        drawPredLayer();

        // Persist cleared state to server
        await fetch(BASE_URL + '/strokes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ strokes_positive: [], strokes_negative: [] }) });

        log('Annotations cleared for ' + ACTIVE_SAMPLE);
      } catch (err) { log('Clear error: ' + err); }
    });

    // Modify bottom to move clear buttons up or down "bottom:70px;height:56px"
    // create persistent footer area at the bottom of the viewer (full width)
    const shell = document.getElementById('iv-shell');
    const ivFooter = document.createElement('div');
    ivFooter.id = 'iv-footer';
    ivFooter.style.cssText = 'position:absolute;left:0;right:0;bottom:70px;height:56px;display:flex;align-items:center;padding-left:12px;gap:8px;z-index:2147483648;pointer-events:auto;background:transparent;';
    ivFooter.appendChild(clearAllBtn);
    ivFooter.appendChild(clearSampleBtn);

    // ── About button ──────────────────────────────────────────────────────────
    const aboutBtn = makeSmallBtn('About DIANNE', '<span style="font-size:11px">ⓘ About</span>');
    aboutBtn.dataset.demoId = 'about-btn';
    aboutBtn.addEventListener('click', () => _showAbout());
    ivFooter.appendChild(aboutBtn);

    // ── Demo button ───────────────────────────────────────────────────────────
    const demoBtn = makeSmallBtn('Interactive tour of the UI', '<span style="font-size:11px">▷ Demo</span>');
    demoBtn.addEventListener('click', () => {
      if (window.__ivDemo && typeof window.__ivDemo.start === 'function') window.__ivDemo.start();
    });
    ivFooter.appendChild(demoBtn);

    shell.appendChild(ivFooter);

    // ── About modal ───────────────────────────────────────────────────────────
    function _showAbout() {
      const overlay = document.createElement('div');
      overlay.style.cssText = [
        'position:fixed','left:0','top:0','width:100%','height:100%',
        'display:flex','align-items:center','justify-content:center',
        'z-index:2147483649','background:rgba(0,0,0,0.55)',
      ].join(';');

      const box = document.createElement('div');
      box.style.cssText = [
        'min-width:320px','max-width:540px','background:#1b1b1b','color:#ddd',
        'border-radius:10px','border:1px solid #3a3a3a',
        'box-shadow:0 8px 32px rgba(0,0,0,0.8)',
        'padding:24px 28px','font:13px/1.6 monospace',
      ].join(';');

      box.innerHTML = [
        '<div style="font-size:20px;font-weight:700;color:#53d9ff;margin-bottom:4px;">DIANNE</div>',
        '<div style="color:#888;font-size:11px;margin-bottom:14px;letter-spacing:1px;">',
        '  GUI OF DIFFERENTIAL IMAGE ANNOTATOR ENVIRONMENT',
        '</div>',
        '<div style="margin-bottom:12px;">',
        '  Histology image annotation and classifier training in',
        '  Jupyter Notebook. Draw positive and negative contours on H&amp;E, optionally using Xenium transcript and cell overlays,',
        '  then train a classifier and visualise predictions — all without leaving the notebook.',
        '  images, train a tile-level classifier, and visualise probability',
        '  heatmaps.',
        '</div>',
        '<div style="border-top:1px solid #2e2e2e;padding-top:12px;margin-bottom:16px;color:#aaa;font-size:11px;">',
        '  Components: viewport &bull; tile pyramid &bull; draw overlay &bull;',
        '  Xenium transcripts &amp; cells &bull; inference pipeline',
        '</div>',
        '<div style="font-size:12px;color:#ccc;">',
        '  &copy; 2024&ndash;2026 <strong style="color:#eee;">The Jackson Laboratory</strong>',
        '  &nbsp;&mdash;&nbsp; All rights reserved.',
        '</div>',
        '<div style="display:flex;justify-content:flex-end;margin-top:18px;">',
        '  <button data-about-close',
        '    style="padding:6px 18px;border-radius:6px;border:none;',
        '           background:#1f8cff;color:#fff;cursor:pointer;font:13px monospace;">',
        '    Close',
        '  </button>',
        '</div>',
      ].join('');

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      function _close() {
        overlay.remove();
        document.removeEventListener('keydown', _onKey);
      }
      function _onKey(e) {
        if (e.key === 'Escape' || e.key === 'Esc') _close();
      }
      box.querySelector('[data-about-close]').addEventListener('click', _close);
      overlay.addEventListener('click', e => { if (e.target === overlay) _close(); });
      document.addEventListener('keydown', _onKey);
    }
  })();

  // removed duplicate main-area footer; using persistent bottom `iv-footer` instead

  // trigger initial tile load now that all listeners are wired
  tiles.update(viewport.getTransform());

  // crosshair on click-tool mouseup
  root.addEventListener('mouseup', e => {
    if (toolbar.getActiveTool() !== 'click') { cross.style.display = 'none'; return; }
    const r = root.getBoundingClientRect();
    cross.style.left    = (e.clientX - r.left) + 'px';
    cross.style.top     = (e.clientY - r.top)  + 'px';
    cross.style.display = 'block';
  });

  // flush all strokes from all samples to Python
  window.ivFlushStrokes = function() {
    // Save current sample's strokes before flushing
    strokesBySample[ACTIVE_SAMPLE] = draw.getStrokes();

    // Send all strokes organized by sample
    const payload = { by_sample: strokesBySample };

    // Count total strokes for log
    let totalPos = 0, totalNeg = 0;
    for (const sample in strokesBySample) {
      totalPos += (strokesBySample[sample].strokes_positive || []).length;
      totalNeg += (strokesBySample[sample].strokes_negative || []).length;
    }

    fetch(BASE_URL + '/strokes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    }).then(() => {
      log('All annotations transferred (' + totalPos + ' pos, ' + totalNeg + ' neg across all samples)');
    })
      .catch(err => log('Transfer error: ' + err));
  };

  // status bar
  viewport.onChange(t => {
    drawPredLayer();
    const lvl = META.levels;
    let level = META.n_levels - 1;
    for (let i = 0; i < META.n_levels; i++) {
      if (t.scale >= 1 / lvl[i].downsample) { level = i; break; }
    }
    log('sample ' + ACTIVE_SAMPLE + '  |  zoom ' + t.scale.toFixed(3) + 'x  |  level ' + level
      + '  (' + lvl[level].width + 'x' + lvl[level].height + ')');
  });

  log('Ready: ' + ACTIVE_SAMPLE);

  // ── guided demo ───────────────────────────────────────────────────────────
  window.__ivDemo = createDemo();
})();
</script>
""".replace('__WIDTH__',   width) \
   .replace('__HEIGHT__',  height) \
   .replace('__BASE_URL__', json.dumps(base_url)) \
   .replace('__SAMPLES__', samples_json) \
   .replace('__SAMPLE_META__', sample_meta_json) \
  .replace('__SAMPLE_XENIUM_META__', sample_xenium_meta_json) \
  .replace('__SAMPLE_CELLS_META__', sample_cells_meta_json) \
   .replace('__META__',    meta_json) \
   .replace('__HAS_RUN_INFERENCE__', 'true' if run_inference_fn is not None else 'false') \
   .replace('__HAS_SAVE__', 'true' if save_func is not None else 'false') \
   .replace('__HAS_LOAD__', 'true' if (load_func is not None and list_names_func is not None) else 'false') \
   .replace('__SAMPLE_SIZES__', json.dumps(sample_sizes or {})) \
   .replace('__INFERENCE_MS_PER_CELL__', str(INFERENCE_MS_PER_CELL)) \
   .replace('__MAX_CELLS__', str(max_cells)) \
   .replace('__IS_MULTICHANNEL__', 'true' if is_multichannel else 'false') \
   .replace('__JS__',      js)

    display(HTML(html))
    display(out)

    return server.clicks, server.strokes_by_sample, server.stop


def set_overlay_points(xi, yi=None, pi=None, sample=None, delta=28, alpha=0.55,
                       color_low='#0b4dff', color_high='#ff2a2a'):
    """
    Push prediction points into the active viewer overlay layer.

    Parameters
    ----------
    xi, yi, pi : arrays of equal length in image coordinates with probabilities in [0, 1].
                 For backward compatibility you may pass a single iterable of
                 dicts {xi, yi, pi} as the first argument and leave yi/pi as None.
    sample : optional sample name to switch to before setting overlay points
    delta : side length of each heatmap square tile in image pixels
    alpha : overlay transparency in [0, 1]
    color_low, color_high : hex colors used for p=0 and p=1 interpolation
    """
    if yi is None and pi is None:
        points = list(xi)
    else:
        if yi is None or pi is None:
            raise ValueError('set_overlay_points requires xi, yi, pi arrays of equal length')
        xs = list(xi)
        ys = list(yi)
        ps = list(pi)
        if not (len(xs) == len(ys) == len(ps)):
            raise ValueError('xi, yi, pi must have the same length')
        points = [
            {'xi': float(x), 'yi': float(y), 'pi': float(p)}
            for x, y, p in zip(xs, ys, ps)
        ]

    payload = json.dumps(points)
    style = json.dumps({
        'delta': delta,
        'alpha': alpha,
        'colorLow': color_low,
        'colorHigh': color_high,
    })

    sample_switch_js = ''
    if sample is not None:
        sample_js = json.dumps(str(sample))
        sample_switch_js = f'  if (typeof window.setActiveSample === "function") {{\n    window.setActiveSample({sample_js});\n  }}\n'

    display(Javascript(
        f"""
(function () {{
{sample_switch_js}  if (typeof window.ivSetOverlayPoints !== 'function') {{
    console.warn('Viewer overlay API is not available. Run create_viewer(...) first.');
    return;
  }}
  window.ivSetOverlayPoints(__POINTS__, __STYLE__);
}})();
""".replace('__POINTS__', payload).replace('__STYLE__', style)
    ))


def clear_overlay_points():
    """Clear the active viewer overlay layer."""
    display(Javascript(
        """
(function () {
  if (typeof window.ivClearOverlayPoints === 'function') {
    window.ivClearOverlayPoints();
  }
})();
"""
    ))
