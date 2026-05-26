import json
from pathlib import Path
from IPython.display import display, HTML, Javascript
import ipywidgets as widgets

from viewer.tiff          import PyramidImage
from viewer.multichannel  import MultichannelImage
from viewer.monochannel   import MonochannelImage
from viewer.server        import ViewerServer
from viewer.xetranscripts import XeniumTranscripts
from viewer.xencells      import XeniumCells, XeniumCellsFast

_JS_DIR = Path(__file__).parent / 'js'

# Configurable: milliseconds of loading-bar animation per cell in the inference sample.
# Examples: 5 000 cells → 5000 * 0.4 = 2 000 ms (2 s)
#           20 000 cells → 20000 * 0.4 = 8 000 ms (8 s)
INFERENCE_MS_PER_CELL = 0.25

def _read_js(name):
    return (_JS_DIR / name).read_text()


def _open_image(path):
    """
    Auto-detect channel count / layout to choose the right image class.

    Decision table (based on zarr array shape at level 0):
      (H, W)          → MonochannelImage  — single-channel mask / heatmap
      (1, H, W)       → MonochannelImage  — explicit single-channel
      (H, W, 3)       → PyramidImage      — RGB channels-last
      (3, H, W)       → PyramidImage      — RGB channels-first
      everything else → MultichannelImage  — multiplex / IF
    """
    import tifffile, zarr, fsspec

    path_str = str(path)
    is_url = path_str.startswith('http://') or path_str.startswith('https://')
    if is_url:
        _fh  = fsspec.open(path_str, 'rb').open()
        _tif = tifffile.TiffFile(_fh)
        store = _tif.aszarr()
    else:
        store = tifffile.imread(str(path), aszarr=True)
    z = zarr.open(store, mode='r')
    arr0 = z["0"] if isinstance(z, zarr.Group) else z
    shape = arr0.shape
    # 2-D: (H, W) — single channel, no explicit channel axis
    if arr0.ndim == 2:
        return MonochannelImage(path, _zarr_store=store)
    # 3-D: inspect the channel axis
    if arr0.ndim == 3:
        # (1, H, W) — explicit single channel
        if shape[0] == 1:
            return MonochannelImage(path, _zarr_store=store)
        # (H, W, 3) — channels-last RGB
        if shape[2] in (3,) and shape[0] > 4:
            return PyramidImage(path, _zarr_store=store)
        # (3, H, W) — channels-first RGB
        if shape[0] in (3,):
            return PyramidImage(path, _zarr_store=store)
    return MultichannelImage(path, _zarr_store=store)


def create_viewer(samples, images, width="100%", height="700px", host=None, port=None,
                  xenium_mpp=0.2125, category_colors=None, max_cells=2000,
                  xenium_bundle_paths=None, matrices=None, annotations=None,
                  run_inference_fn=None, sample_sizes=None,
                  save_func=None, load_func=None, list_names_func=None,
                  secondary_images=None, secondary_matrices=None,
                  draw_on_secondary=False, visium_ads=None,
                  sample_mapping=None, fullscreen_on_load=True):
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
    draw_on_secondary : bool, default False
        When True, stroke coordinates sent to ``run_inference_fn`` are
        converted from primary-image pixel space to secondary-image pixel
        space via the inverse of the secondary affine matrix before being
        submitted to the server.  The visual display of strokes is
        unaffected.  Inference-result overlay points (``xi``, ``yi``) are
        assumed to be in secondary pixel space and are automatically
        transformed back to primary image space before rendering.
    Tile overlay (automatic)
        If ``run_inference_fn`` has a ``tile_coords`` attribute (a dict
        ``{sample: {'x': array, 'y': array}}``) and a ``tile_size``
        attribute (int, secondary-image pixels), the viewer automatically
        shows a "Tiles" toggle button.  Coordinates are in secondary-image
        pixel space and are transformed to primary-image space via the
        secondary affine matrix.  Populated automatically by
        ``dianne.makeRunFn(…)`` with no extra arguments needed.
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
    import time as _time
    from concurrent.futures import ThreadPoolExecutor, as_completed
    n_samples = len(sample_list)
    print(f'[DIANNE] Opening {n_samples} sample image(s) (parallel)…', flush=True)
    _t0 = _time.monotonic()
    sample_images = {}

    def _open_sample(s):
      img = _open_image(images[s])
      print(f' {s}', end='; ', flush=True)
      return s, img

    with ThreadPoolExecutor(max_workers=min(n_samples, 16)) as _pool:
      _futs = {_pool.submit(_open_sample, s): s for s in sample_list}
      for _fut in as_completed(_futs):
        s, img = _fut.result()
        sample_images[s] = img

    print(f'[DIANNE] Images loaded in {_time.monotonic()-_t0:.1f}s total', flush=True)
    print(f'[DIANNE] Loading layers…', flush=True)

    image         = sample_images[chosen_sample]
    is_multichannel = any(isinstance(img, MultichannelImage) for img in sample_images.values())
    is_monochannel  = any(isinstance(img, MonochannelImage)  for img in sample_images.values())
    # Use metadata from the first actual MonochannelImage, not from image (chosen sample),
    # which might be a PyramidImage even when another sample is monochannel.
    _mono_img = next((img for img in sample_images.values() if isinstance(img, MonochannelImage)), None)
    mono_meta = _mono_img.metadata if _mono_img is not None else None

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

    # ── normalise annotations + category_colors → ordered list of named layers ──
    # Each layer: {'name': str, 'data': {sample: cell_id->category}, 'colors': {cat: color}}
    # Accepts a plain dict (single layer, backward compat) or a list of dicts (multi-layer).
    def _norm_annotation_layers(ann, col):
      if ann is None:
        ann_list = [{}]
      elif isinstance(ann, list):
        ann_list = list(ann)
      else:
        ann_list = [ann]  # backward compat: wrap single dict
      if col is None:
        col_list = [{}] * len(ann_list)
      elif isinstance(col, list):
        col_list = list(col)
      else:
        col_list = [col] * len(ann_list)
      while len(col_list) < len(ann_list):
        col_list.append({})
      layers = []
      for i, (a, c) in enumerate(zip(ann_list, col_list)):
        a = a or {}
        if not isinstance(a, dict):
          raise TypeError(f'annotations layer {i} must be a dict[sample] -> cell_id_to_category')
        a = {str(k): v for k, v in a.items()}
        c = c or {}
        if hasattr(c, 'to_dict'):
          c = c.to_dict()
        if not hasattr(c, 'items'):
          c = {}
        # Per-sample colors support (backward compat): if keys match sample names, unwrap
        first_sample = next(iter(a), None)
        if first_sample and first_sample in c:
          c = c.get(first_sample) or c
        colors = {str(k): str(v) for k, v in c.items()}
        name = 'Annotations' if len(ann_list) == 1 else f'Layer {i}'
        layers.append({'name': name, 'data': a, 'colors': colors})
      return layers

    annotation_layers = _norm_annotation_layers(annotations, category_colors)
    _layer0 = annotation_layers[0]

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

    if secondary_images is None:
      secondary_images = {}
    elif not isinstance(secondary_images, dict):
      raise TypeError('secondary_images must be a dict[sample] -> path|None')
    else:
      secondary_images = {str(k): v for k, v in secondary_images.items() if v is not None}

    if secondary_matrices is None:
      secondary_matrices = {}
    elif not isinstance(secondary_matrices, dict):
      raise TypeError('secondary_matrices must be a dict[sample] -> matrix_csv_path|None')
    else:
      secondary_matrices = {str(k): v for k, v in secondary_matrices.items() if v is not None}

    # Open secondary images and build per-sample metadata / affine matrices
    secondary_sample_images = {}
    sample_secondary_meta   = {s: None for s in sample_list}
    sample_secondary_matrix = {s: None for s in sample_list}
    _sec_samples = [s for s in sample_list if secondary_images.get(s) is not None]
    if _sec_samples:
      def _open_sec(sample):
        return sample, _open_image(secondary_images[sample])
      with ThreadPoolExecutor(max_workers=min(len(_sec_samples), 16)) as _pool:
        for sample, img in _pool.map(_open_sec, _sec_samples):
          secondary_sample_images[sample] = img
          sample_secondary_meta[sample]   = img.metadata
    for sample in _sec_samples:
      mat_path = secondary_matrices.get(sample)
      if mat_path is not None:
        import numpy as _np
        _mat = _np.loadtxt(str(mat_path), delimiter=',')
        _M   = _mat[:2, :2].astype(float)
        _Tr  = _mat[:2, -1].astype(float)
        _Mi  = _np.linalg.inv(_M)
        sample_secondary_matrix[sample] = {
          'm00': float(_M[0, 0]),  'm01': float(_M[0, 1]),
          'm10': float(_M[1, 0]),  'm11': float(_M[1, 1]),
          'tx':  float(_Tr[0]),    'ty':  float(_Tr[1]),
          'mi00': float(_Mi[0, 0]), 'mi01': float(_Mi[0, 1]),
          'mi10': float(_Mi[1, 0]), 'mi11': float(_Mi[1, 1]),
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
      sample_annotations = _layer0['data'].get(sample)
      sample_colors = _layer0['colors']

      sample_xenium = XeniumTranscripts(bundle_path, sample_images[sample].metadata,
                        matrix_path=matrix_path,
                        xenium_mpp=xenium_mpp)
      _fast_zip = Path(bundle_path) / 'cells_fast.zarr.zip'
      if _fast_zip.exists():
        sample_cells = XeniumCellsFast(_fast_zip, sample_images[sample].metadata,
                       matrix_path=matrix_path,
                       xenium_mpp=xenium_mpp,
                       cell_id_to_category=sample_annotations,
                       category_colors=sample_colors,
                       max_cells=max_cells)
      else:
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
          list_names_fn=list_names_func,
          secondary_images=secondary_sample_images)
    # annotation_layers_json is built later; attach placeholder now, replace after build
    server._annotation_layers_json = '[]'

    # ── store tile_coords_fn on server for lazy per-sample serving ────────────
    # Derived from run_inference_fn.tile_coords / .tile_size when available.
    _tile_coords_fn = None
    tile_size = None
    if run_inference_fn is not None and hasattr(run_inference_fn, 'tile_coords'):
      _tc = run_inference_fn.tile_coords  # dict {sample: {'x': array, 'y': array}}
      _tile_coords_fn = lambda s, _tc=_tc: _tc[s]
      tile_size = getattr(run_inference_fn, 'tile_size', None)
    server._tile_coords_fn = _tile_coords_fn
    server._tile_size      = tile_size

    # ── store visium_ads on server ────────────────────────────────────────────
    if visium_ads is not None:
      if not isinstance(visium_ads, dict):
        raise TypeError('visium_ads must be a dict[sample] -> AnnData')
      server._visium_ads = {str(k): v for k, v in visium_ads.items()}
    # Build per-sample gene list for JS (only the var_names as list of strings)
    _visium_genes_by_sample = {}
    for _s, _ad in server._visium_ads.items():
      try:
        _visium_genes_by_sample[_s] = list(_ad.var_names)
      except Exception:
        pass
    _has_visium = bool(_visium_genes_by_sample)

    server.start()
    server.chosen_sample = chosen_sample

    # output widget for server-side log (optional, hidden by default)
    out = widgets.Output(layout=widgets.Layout(display='none'))

    meta_json = json.dumps(image.metadata)
    samples_json = json.dumps(sample_list)
    sample_meta_json = json.dumps({s: sample_images[s].metadata for s in sample_list})
    sample_xenium_meta_json = json.dumps(sample_xenium_meta)
    sample_cells_meta_json       = json.dumps(sample_cells_meta)
    sample_secondary_meta_json   = json.dumps(sample_secondary_meta)
    sample_secondary_matrix_json = json.dumps(sample_secondary_matrix)
    base_url  = server.base_url

    def _ann_to_json_str(ann):
      """Convert a per-sample annotation to a JSON object string without building a Python dict."""
      import pandas as _pd
      if ann is None:
        return '{}'
      # pd.Series (index = cell_id, values = category) — to_json uses C-level ujson
      if isinstance(ann, _pd.Series):
        return ann.astype(str).to_json()
      # pd.Categorical (positional, no index) — wrap in Series with RangeIndex
      if isinstance(ann, _pd.Categorical):
        return _pd.Series(ann.astype(str)).to_json()
      # plain dict or other mapping
      if hasattr(ann, 'to_dict'):
        ann = ann.to_dict()
      if hasattr(ann, 'items'):
        return json.dumps({str(k): str(v) for k, v in ann.items()})
      return json.dumps({str(i): str(v) for i, v in enumerate(ann)})

    def _layer_to_json_str(layer):
      """Serialize a layer to a JSON string, using fast per-sample ujson paths."""
      parts = []
      for s, ann in layer['data'].items():
        parts.append(json.dumps(str(s)) + ':' + _ann_to_json_str(ann))
      ann_by_sample = '{' + ','.join(parts) + '}'
      return ('{"name":' + json.dumps(layer['name']) +
              ',"colors":' + json.dumps(layer['colors']) +
              ',"annotations_by_sample":' + ann_by_sample + '}')

    _ts = _time.monotonic()
    annotation_layers_json = '[' + ','.join(_layer_to_json_str(l) for l in annotation_layers) + ']'
    print(f'[DIANNE] annotation_layers_json: {_time.monotonic()-_ts:.2f}s', flush=True)
    server._annotation_layers_json = annotation_layers_json

    # inline all JS files
    _ts = _time.monotonic()
    js = '\n\n'.join(_read_js(f) for f in [
      'viewport.js',
      'tiles.js',
      'multichannel.js',
      'monochannel2d.js',
      'transcripts.js',
      'cells.js',
      'patches.js',
      'visium.js',
      'draw.js',
      'settings.js',
      'toolbar.js',
      'demo.js',
    ])
    # Inject JS to auto-enter fullscreen if requested
    if fullscreen_on_load:
      js += """
      ;(function _autoFullscreen() {
        // DOMContentLoaded has already fired in Jupyter; poll for the button instead
        var _attempts = 0;
        var _poll = setInterval(function() {
          var fsBtn = document.querySelector('[data-demo-id="fs-btn"]');
          if (fsBtn) { clearInterval(_poll); fsBtn.click(); return; }
          if (++_attempts > 600) clearInterval(_poll);  // give up after 60 s
        }, 100);
      })();
      """

    _ts = _time.monotonic()
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
  display: flex;
  justify-content: space-between;
  align-items: center;
"><span id="iv-status-left">initializing…</span><span id="iv-status-coord" style="color:#8cf;margin-left:12px;white-space:nowrap;"></span><span id="iv-status-net" style="display:inline-flex;align-items:center;gap:5px;font-size:10px;white-space:nowrap;margin-left:12px;" title="↑ pending tile requests  ↓ data received last 60 s"><span style="color:#fa6;">↑</span><span style="display:inline-block;width:32px;height:5px;background:#2a2a2a;border-radius:3px;overflow:hidden;vertical-align:middle;"><span id="iv-gauge-pend-fill" style="display:block;height:100%;width:0%;background:#fa6;border-radius:3px;transition:width 0.4s;"></span></span><span id="iv-gauge-pend-txt" style="color:#888;min-width:14px;">0</span><span style="color:#4fa;margin-left:3px;">↓</span><span style="display:inline-block;width:32px;height:5px;background:#2a2a2a;border-radius:3px;overflow:hidden;vertical-align:middle;"><span id="iv-gauge-rx-fill" style="display:block;height:100%;width:0%;background:#4fa;border-radius:3px;transition:width 0.4s;"></span></span><span id="iv-gauge-rx-txt" style="color:#888;min-width:32px;">–</span></span><span id="iv-status-perf" style="color:#666;font-size:11px;white-space:nowrap;"></span></div>
  </div>
</div>

<script>
(function () {
  const root     = document.getElementById('iv-root');
  const status   = document.getElementById('iv-status');
  const statusLeft  = document.getElementById('iv-status-left');
  const statusCoord    = document.getElementById('iv-status-coord');
  const statusPerf      = document.getElementById('iv-status-perf');
  const gaugePendFill   = document.getElementById('iv-gauge-pend-fill');
  const gaugePendTxt    = document.getElementById('iv-gauge-pend-txt');
  const gaugeRxFill     = document.getElementById('iv-gauge-rx-fill');
  const gaugeRxTxt      = document.getElementById('iv-gauge-rx-txt');
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
  const IS_MONOCHANNEL     = __IS_MONOCHANNEL__;
  const SAMPLE_IS_MONO     = __SAMPLE_IS_MONO__;
  const MONO_META          = __MONO_META__;
  const SAMPLE_SECONDARY_META   = __SAMPLE_SECONDARY_META__;
  const SAMPLE_SECONDARY_MATRIX = __SAMPLE_SECONDARY_MATRIX__;
  const DRAW_ON_SECONDARY        = __DRAW_ON_SECONDARY__;
  const TILE_SIZE                = __TILE_SIZE__;
  const HAS_TILE_COORDS          = __HAS_TILE_COORDS__;
  const HAS_VISIUM               = __HAS_VISIUM__;
  const VISIUM_GENES_BY_SAMPLE   = __VISIUM_GENES_BY_SAMPLE__;
  const SAMPLE_MAPPING           = __SAMPLE_MAPPING__;
  let ANNOTATION_LAYERS          = [];  // loaded asynchronously via /annotation_layers
  let ACTIVE_SAMPLE = SAMPLES[0];
  let META = SAMPLE_META[ACTIVE_SAMPLE] || __META__;

  function log(msg) { statusLeft.textContent = msg; }

  // ── secondary ↔ primary coord helpers (active when DRAW_ON_SECONDARY) ──────
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
  // Returns a transformed copy of strokesBySample suitable for the server.
  // When DRAW_ON_SECONDARY is true, each sample's strokes are converted
  // from primary→secondary pixel space using the per-sample inverse matrix.
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

  // ── network gauges (pending requests + data received last 60 s) ───────────
  (function () {
    let pending = 0;
    const rxLog = [];          // [{time, bytes}]
    let pendPeak = 8;          // soft-max for pending gauge; grows automatically
    let rxPeak   = 4194304;    // soft-max for rx gauge, starts at 4 MB/min

    function fmtBytes(b) {
      if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
      if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MB';
      if (b >= 1024)       return (b / 1024).toFixed(0) + ' kB';
      return b + ' B';
    }

    // Monkey-patch window.fetch to count in-flight requests and log response sizes.
    // pending is decremented as soon as response headers arrive (TTFB) — this
    // correctly handles all response types (blob, json, text, …) without
    // needing to know which body-consuming method the caller will use.
    // Bytes are tracked only for blob() responses (tile images dominate traffic).
    const _origFetch = window.fetch;
    window.fetch = function (input, init) {
      pending++;
      return _origFetch.call(this, input, init).then(function (resp) {
        pending = Math.max(0, pending - 1);   // server responded (headers received)
        // wrap blob() to record transferred bytes
        const _origBlob = resp.blob.bind(resp);
        resp.blob = function () {
          return _origBlob().then(function (b) {
            rxLog.push({ time: Date.now(), bytes: b.size });
            return b;
          });
        };
        return resp;
      }, function (err) {
        // fetch rejected: network error or AbortError
        pending = Math.max(0, pending - 1);
        throw err;
      });
    };

    setInterval(function () {
      // pending gauge
      pendPeak = Math.max(pendPeak * 0.98, pending, 4);
      gaugePendFill.style.width = Math.min(100, pending / pendPeak * 100) + '%';
      gaugePendTxt.textContent  = String(pending);

      // rx/min gauge — rolling 60 s window
      const now = Date.now();
      while (rxLog.length && rxLog[0].time < now - 60000) rxLog.shift();
      const rxBytes = rxLog.reduce(function (s, e) { return s + e.bytes; }, 0);
      rxPeak = Math.max(rxPeak * 0.99, rxBytes, 524288);  // floor 512 kB
      gaugeRxFill.style.width = Math.min(100, rxBytes / rxPeak * 100) + '%';
      gaugeRxTxt.textContent  = fmtBytes(rxBytes);
    }, 500);
  })();

  // ── lightweight perf monitor (heap memory + FPS) ──────────────────────────
  (function () {
    const hasMem = !!(window.performance && performance.memory);
    const frameTimes = [];
    const WIN = 60;  // rolling window of N rAF timestamps
    function rafTick(now) {
      frameTimes.push(now);
      if (frameTimes.length > WIN) frameTimes.shift();
      requestAnimationFrame(rafTick);
    }
    requestAnimationFrame(rafTick);
    function fmtMB(b) { return (b / 1048576).toFixed(0) + ' MB'; }
    function curFps() {
      if (frameTimes.length < 2) return 0;
      const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
      return span > 0 ? Math.round((frameTimes.length - 1) * 1000 / span) : 0;
    }
    setInterval(function () {
      const parts = [];
      if (hasMem) {
        parts.push('heap ' + fmtMB(performance.memory.usedJSHeapSize) +
                   ' / ' + fmtMB(performance.memory.totalJSHeapSize));
      }
      parts.push(curFps() + ' fps');
      statusPerf.textContent = parts.join('  |  ');
    }, 2000);
  })();

  // reserve space at the bottom so persistent footers don't overlap content
  try {
    samplesRibbon.style.paddingBottom = '56px';
    document.getElementById('iv-main').style.paddingBottom = '56px';
  } catch (e) {}

  // secondary image canvas — inserted before tileLayer so it renders behind primary tiles
  const secondaryCanvas = document.createElement('canvas');
  secondaryCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;';
  root.appendChild(secondaryCanvas);
  const secCtx = secondaryCanvas.getContext('2d');

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

  // primary-image opacity slider — shown only when primary is RGB (not multichannel) and a secondary exists
  const _primaryOpacityWrap   = overlayControls.querySelector('#iv-primary-opacity-wrap');
  const _primaryOpacitySlider = overlayControls.querySelector('#iv-primary-opacity');
  // secondary-image opacity slider — shown whenever a secondary image exists for the active sample
  const _secondaryOpacityWrap      = overlayControls.querySelector('#iv-secondary-opacity-wrap');
  const _secondaryOpacitySlider    = overlayControls.querySelector('#iv-secondary-opacity');
  const _secondaryEnabledCheckbox  = overlayControls.querySelector('#iv-secondary-enabled');
  let _secondaryFetchEnabled = true;

  function _updateOpacitySliderVisibility() {
    const hasSecondary = !!(SAMPLE_SECONDARY_META[ACTIVE_SAMPLE]);
    const isSecMC = hasSecondary && !!(SAMPLE_SECONDARY_META[ACTIVE_SAMPLE].n_channels);
    const isSampleMC = !!(META.n_channels);
    _primaryOpacityWrap.style.display   = (!isSampleMC && hasSecondary) ? 'flex' : 'none';
    _secondaryOpacityWrap.style.display = (hasSecondary && !isSecMC) ? 'flex' : 'none';
    _secChPanelWrap.style.display       = isSecMC ? 'block' : 'none';
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
      // abort all in-flight secondary requests and clear canvas
      for (const m of _secChInFlight) for (const ctrl of m.values()) ctrl.abort();
      for (const ctrl of _secRgbInFlight.values()) ctrl.abort();
      _secRgbInFlight.clear();
      secCtx.clearRect(0, 0, secondaryCanvas.width, secondaryCanvas.height);
    } else {
      _drawSecondaryLayer(viewport.getTransform());
    }
  });

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

  // ── monochannel image canvas (single-channel masks / heatmaps) ───────────
  // Overlaid above the tile layer; the tile layer is hidden in monochannel mode.
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
  // Set initial per-sample visibility (chosen sample may not be monochannel)
  function _updateMonoLayerVisibility() {
    const isMono = !!(IS_MONOCHANNEL && MONO_META && SAMPLE_IS_MONO[ACTIVE_SAMPLE]);
    tileLayer.style.display  = isMono ? 'none'  : '';
    monoCanvas.style.display = isMono ? ''      : 'none';
  }
  _updateMonoLayerVisibility();

  // ── secondary image layer ─────────────────────────────────────────────────
  // RGB secondary: one img per tile
  const _secRgbCache    = new Map();
  const _secRgbInFlight = new Map();
  // Multichannel secondary state
  const SEC_CH_COLORS = ['#4488ff','#00ff44','#ff2222','#ffff00','#00ffff','#ff00ff','#ff8800','#ff0088'];
  let _secChState    = [];
  let _secGrayCache  = [];
  let _secChInFlight = [];
  const _secCompCache = new Map();

  function _initSecChState() {
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
    _drawSecondaryLayer(viewport.getTransform());
  }
  new ResizeObserver(_resizeSecCanvas).observe(root);
  _resizeSecCanvas();

  function _drawSecondaryLayer(t) {
    const { scale, ox, oy } = t;
    const secMeta = SAMPLE_SECONDARY_META[ACTIVE_SAMPLE];
    secCtx.clearRect(0, 0, secondaryCanvas.width, secondaryCanvas.height);
    if (!secMeta || !_secondaryFetchEnabled) return;
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
      const x1 = Math.min(lm.width, ((vpW-ox)/scale)/dsSec);
      const y1 = Math.min(lm.height, ((vpH-oy)/scale)/dsSec);
      c0 = Math.max(0, Math.floor(x0/SECTILE)); r0 = Math.max(0, Math.floor(y0/SECTILE));
      c1 = Math.min(lm.n_tiles_x - 1, Math.floor(x1/SECTILE));
      r1 = Math.min(lm.n_tiles_y - 1, Math.floor(y1/SECTILE));
    }
    const _applyTileTransform = (row, col) => {
      if (mat) {
        const a  = mat.m00*SECTILE*dsSec*scale, b  = mat.m10*SECTILE*dsSec*scale;
        const cm = mat.m01*SECTILE*dsSec*scale, d  = mat.m11*SECTILE*dsSec*scale;
        const e  = (mat.m00*col*SECTILE*dsSec + mat.m01*row*SECTILE*dsSec + mat.tx)*scale + ox;
        const f  = (mat.m10*col*SECTILE*dsSec + mat.m11*row*SECTILE*dsSec + mat.ty)*scale + oy;
        secCtx.setTransform(a, b, cm, d, e, f);
      } else {
        const sx = col*SECTILE*dsSec*scale + ox, sy = row*SECTILE*dsSec*scale + oy;
        const sw = SECTILE*dsSec*scale;
        secCtx.setTransform(sw, 0, 0, sw, sx, sy);
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
                  _drawSecondaryLayer(viewport.getTransform());
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
                img.onload = () => { entry.ready = true; _drawSecondaryLayer(viewport.getTransform()); };
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

  // ── secondary channel panel (multichannel secondary only) ─────────────────────
  const _secChPanelWrap = document.createElement('div');
  _secChPanelWrap.dataset.ivUi = 'true';
  _secChPanelWrap.style.cssText = [
    'position:absolute','top:48px','left:8px','z-index:12',
    'font:12px monospace','text-align:left','display:none',
  ].join(';');
  const _secChToggleBtn = document.createElement('button');
  _secChToggleBtn.textContent = 'Sec.Ch \u25be';
  _secChToggleBtn.title = 'Secondary image channel controls';
  _secChToggleBtn.style.cssText = [
    'background:rgba(0,0,0,0.60)','border:1px solid #555',
    'color:#eee','border-radius:6px','padding:4px 8px',
    'cursor:pointer','font:12px monospace','white-space:nowrap',
  ].join(';');
  _secChPanelWrap.appendChild(_secChToggleBtn);
  const _secChDropdown = document.createElement('div');
  _secChDropdown.style.cssText = [
    'display:none','margin-top:4px',
    'background:rgba(12,12,12,0.92)','border:1px solid #444',
    'border-radius:6px','padding:6px 8px',
    'max-height:340px','overflow-y:auto','min-width:340px','text-align:left',
  ].join(';');
  _secChPanelWrap.appendChild(_secChDropdown);
  _secChToggleBtn.addEventListener('click', () => {
    const open = _secChDropdown.style.display !== 'none';
    _secChDropdown.style.display = open ? 'none' : 'block';
    _secChToggleBtn.textContent  = open ? 'Sec.Ch \u25be' : 'Sec.Ch \u25b4';
  });
  root.appendChild(_secChPanelWrap);

  function _buildSecChPanel() {
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
          _secCompCache.clear(); _drawSecondaryLayer(viewport.getTransform());
        });
      chk.addEventListener('change', () => {
        _secChState[ch].enabled = chk.checked;
        _secCompCache.clear(); _drawSecondaryLayer(viewport.getTransform());
      });
      colorPick.addEventListener('input', () => {
        _secChState[ch].color = colorPick.value; swatch.style.background = colorPick.value;
        _secCompCache.clear(); _drawSecondaryLayer(viewport.getTransform());
      });
      opSlider.addEventListener('input', () => {
        _secChState[ch].opacity = parseFloat(opSlider.value);
        _secCompCache.clear(); _drawSecondaryLayer(viewport.getTransform());
      });
      rowEl.appendChild(chk); rowEl.appendChild(labelEl); rowEl.appendChild(swatch);
      rowEl.appendChild(colorPick); rowEl.appendChild(opSlider); rowEl.appendChild(rangeSlider);
      _secChDropdown.appendChild(rowEl);
    }
  }


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
    settings,
    ANNOTATION_LAYERS
  );
  const patches = HAS_TILE_COORDS
    ? createPatchOverlay(root, viewport, settings)
    : null;
  if (patches) patches.setContext(ACTIVE_SAMPLE, BASE_URL, TILE_SIZE, SAMPLE_SECONDARY_MATRIX[ACTIVE_SAMPLE]);
  const visiumOverlay = HAS_VISIUM
    ? createVisiumOverlay(root, viewport, VISIUM_GENES_BY_SAMPLE)
    : null;
  if (visiumOverlay) visiumOverlay.setContext(ACTIVE_SAMPLE, BASE_URL);
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
            body: JSON.stringify({ by_sample: _buildServerStrokesPayload() }),
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
          if (res.ok) {
            log('Loaded classifier: ' + name);
            const bySample = res.strokes_by_sample || {};
            for (const [s, sd] of Object.entries(bySample)) {
              const mat = DRAW_ON_SECONDARY && SAMPLE_SECONDARY_MATRIX[s];
              const toP = mat ? (list => _tfmStrokeList(list, (x, y) => _secToPrim(mat, x, y))) : (list => list);
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
        return fetch(BASE_URL + '/classifier_names')
          .then(r => r.json())
          .catch(() => []);
      } : null,
    } : null,
    settings,
    patches,
    visiumOverlay,
    (IS_MONOCHANNEL && mono2d) ? { mono2d, monoMeta: MONO_META, isSampleMono: s => !!(SAMPLE_IS_MONO[s]) } : null
  );
  // Initialise 2D Options button visibility for the starting sample
  toolbar.setMonoActive(!!(IS_MONOCHANNEL && SAMPLE_IS_MONO[ACTIVE_SAMPLE]));

  // per-sample stroke storage
  const strokesBySample = {};
  // per-sample viewport / overlay state for persistence across sample switches
  const viewportStateBySample = {};
  const transcriptStateBySample = {};
  const cellStateBySample = {};
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
    // 1. Flush current strokes to server (converting to secondary space if needed)
    strokesBySample[ACTIVE_SAMPLE] = draw.getStrokes();
    try {
      await fetch(BASE_URL + '/strokes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ by_sample: _buildServerStrokesPayload() }),
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
            // sqrt(|det(M)|) is the linear scale factor of the affine's linear part.
            const _det = _ovMat.m00 * _ovMat.m11 - _ovMat.m01 * _ovMat.m10;
            style.delta = style.delta * Math.sqrt(Math.abs(_det));
          }
        }
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
    const delta = Math.max(1, Number(predStyle.delta) || 1);
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
  _updateOpacitySliderVisibility();
  _initSecChState();
  _buildSecChPanel();

  function setActiveSample(sampleName) {
    if (!SAMPLE_META[sampleName]) return;
    const changed = sampleName !== ACTIVE_SAMPLE;
    if (changed) {
      // Save strokes from previous sample before switching
      strokesBySample[ACTIVE_SAMPLE] = draw.getStrokes();

      // Save viewport, cells, transcripts state for the current (outgoing) sample
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

      // Update tiles meta/sample BEFORE resizing viewport so that the
      // onChange listener always sees a level index valid for the new META.
      tiles.setSample(ACTIVE_SAMPLE);
      tiles.setMeta(META);

      // Restore viewport: reset if first visit, else restore saved transform
      const savedVP = viewportStateBySample[sampleName];
      if (savedVP) {
        viewport.setImageSize(l0Sample.width, l0Sample.height, false);
        viewport.setTransform(savedVP.scale, savedVP.ox, savedVP.oy);
      } else {
        viewport.setImageSize(l0Sample.width, l0Sample.height, true);
      }
      for (const ctrl of _secRgbInFlight.values()) ctrl.abort();
      _secRgbInFlight.clear();
      for (const m of _secChInFlight) { for (const ctrl of m.values()) ctrl.abort(); m.clear(); }
      _secCompCache.clear();
      _initSecChState();
      _buildSecChPanel();
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
      predPoints = [];
      drawPredLayer();
      _drawSecondaryLayer(viewport.getTransform());
      _updateOpacitySliderVisibility();

      // Load strokes for new sample
      const savedStrokes = strokesBySample[ACTIVE_SAMPLE];
      draw.setStrokes(savedStrokes.strokes_positive, savedStrokes.strokes_negative);
    }

    for (const card of samplesRibbon.querySelectorAll('[data-sample-card]')) {
      const isActive = card.dataset.sampleName === sampleName;
      card.style.outline = isActive ? '2px solid #53d9ff' : 'none';
      card.style.background = isActive ? '#272727' : '#1d1d1d';
    }
    log('Sample: ' + sampleName + (SAMPLE_MAPPING[sampleName] ? ' (' + SAMPLE_MAPPING[sampleName] + ')' : ''));
  }

  // per-sample thumbnail overlay canvases (keyed by sample name)
  const thumbCanvases = {};

  // Helper: map a level-0 image coordinate to thumb container CSS pixel
  function _imgToThumbPx(imgX, imgY, sampleMeta, thumbLevel, containerW) {
    const THUMB_SIZE = 256;
    const lMeta = sampleMeta.levels[thumbLevel];
    const l0    = sampleMeta.levels[0];
    const ts    = Math.min(THUMB_SIZE / lMeta.width, THUMB_SIZE / lMeta.height);
    const newW  = Math.round(lMeta.width  * ts);
    const newH  = Math.round(lMeta.height * ts);
    const offX  = Math.floor((THUMB_SIZE - newW) / 2);
    const offY  = Math.floor((THUMB_SIZE - newH) / 2);
    const lvlX  = imgX * lMeta.width  / l0.width;
    const lvlY  = imgY * lMeta.height / l0.height;
    return {
      x: (lvlX * ts + offX) * containerW / THUMB_SIZE,
      y: (lvlY * ts + offY) * containerW / THUMB_SIZE,
    };
  }

  // Helper: compute image area bounds (in CSS px) within a thumb container
  function _thumbImageArea(sampleMeta, thumbLevel, containerW) {
    const THUMB_SIZE = 256;
    const lMeta = sampleMeta.levels[thumbLevel];
    const ts    = Math.min(THUMB_SIZE / lMeta.width, THUMB_SIZE / lMeta.height);
    const newW  = Math.round(lMeta.width  * ts);
    const newH  = Math.round(lMeta.height * ts);
    const offX  = Math.floor((THUMB_SIZE - newW) / 2);
    const offY  = Math.floor((THUMB_SIZE - newH) / 2);
    return {
      x0: offX * containerW / THUMB_SIZE,
      y0: offY * containerW / THUMB_SIZE,
      x1: (offX + newW) * containerW / THUMB_SIZE,
      y1: (offY + newH) * containerW / THUMB_SIZE,
    };
  }

  // Redraw viewport rectangle on the active sample's thumb canvas
  function updateThumbOverlays() {
    for (const [sampleName, canvas] of Object.entries(thumbCanvases)) {
      const ctx2 = canvas.getContext('2d');
      ctx2.clearRect(0, 0, canvas.width, canvas.height);
      if (sampleName !== ACTIVE_SAMPLE) continue;

      const m = SAMPLE_META[sampleName];
      const thumbLevel = Math.max(2, Number(m.n_levels) - 1);
      const containerW = canvas.width;   // square container
      const area = _thumbImageArea(m, thumbLevel, containerW);

      // visible rectangle in image coords
      const vpW = root.clientWidth;
      const vpH = root.clientHeight;
      const tl  = viewport.toImageSpace(0, 0);
      const br  = viewport.toImageSpace(vpW, vpH);

      const p0 = _imgToThumbPx(tl.x, tl.y, m, thumbLevel, containerW);
      const p1 = _imgToThumbPx(br.x, br.y, m, thumbLevel, containerW);

      // Clip rect to image area — skip drawing if no overlap
      const cx0 = Math.max(p0.x, area.x0);
      const cy0 = Math.max(p0.y, area.y0);
      const cx1 = Math.min(p1.x, area.x1);
      const cy1 = Math.min(p1.y, area.y1);
      if (cx0 >= cx1 || cy0 >= cy1) continue;

      ctx2.save();
      ctx2.beginPath();
      ctx2.rect(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
      ctx2.clip();
      ctx2.strokeStyle = 'rgba(255,55,55,0.92)';
      ctx2.lineWidth = 1.5;
      ctx2.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      ctx2.restore();
    }
  }

  function buildSampleRibbon() {
    samplesRibbon.innerHTML = '';
    let thumbObserver = null;
    if ('IntersectionObserver' in window) {
      thumbObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const wrap = entry.target;
          const img = wrap.querySelector('img[data-thumb-src]');
          if (!img || img.dataset.thumbLoaded === '1') {
            observer.unobserve(wrap);
            continue;
          }
          img.src = img.dataset.thumbSrc;
          img.dataset.thumbLoaded = '1';
          observer.unobserve(wrap);
        }
      }, {
        root: samplesRibbon,
        rootMargin: '120px 0px',
        threshold: 0.01,
      });
    }

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
      img.loading = 'lazy';
      img.decoding = 'async';
      img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;object-position:center center;display:block;';
      // Request a server-generated square thumbnail (256×256) of the full
      // lowest-resolution level so we always get the entire image resized
      // preserving aspect ratio.
      img.dataset.thumbSrc = BASE_URL + '/thumb?sample=' + encodeURIComponent(sampleName)
        + '&level=' + thumbLevel + '&size=256';
      img.dataset.thumbLoaded = '0';
      if (!thumbObserver) {
        img.src = img.dataset.thumbSrc;
        img.dataset.thumbLoaded = '1';
      }
      thumbWrap.appendChild(img);
      if (thumbObserver) thumbObserver.observe(thumbWrap);

      // Overlay canvas for viewport rectangle
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width  = 1;
      thumbCanvas.height = 1;
      thumbCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;';
      thumbWrap.appendChild(thumbCanvas);

      // Size canvas to match rendered container once layout is settled
      const resizeThumbCanvas = () => {
        const w = thumbWrap.clientWidth;
        if (w > 0 && (thumbCanvas.width !== w || thumbCanvas.height !== w)) {
          thumbCanvas.width  = w;
          thumbCanvas.height = w;
          updateThumbOverlays();
        }
      };
      new ResizeObserver(resizeThumbCanvas).observe(thumbWrap);
      thumbCanvases[sampleName] = thumbCanvas;

      const label = document.createElement('div');
      label.textContent = sampleName;
      label.style.cssText = [
        'font:12px monospace', 'line-height:1.3',
        'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
      ].join(';');

      if (SAMPLE_MAPPING[sampleName]) {
        const sublabel = document.createElement('div');
        sublabel.textContent = '(' + SAMPLE_MAPPING[sampleName] + ')';
        sublabel.style.cssText = [
          'font:11px monospace', 'line-height:1.3', 'color:#aaa',
          'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
        ].join(';');
        label.appendChild(sublabel);
      }

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

      // Click: switch sample; if already active and click was inside thumb image area, navigate there.
      // If switching to a different sample, just restore its last state (don't jump to click position).
      card.addEventListener('click', e => {
        const thumbRect = thumbWrap.getBoundingClientRect();
        const inThumb = (e.clientX >= thumbRect.left && e.clientX <= thumbRect.right &&
                         e.clientY >= thumbRect.top  && e.clientY <= thumbRect.bottom);

        const wasSampleAlreadyActive = (sampleName === ACTIVE_SAMPLE);
        setActiveSample(sampleName);

        if (inThumb && wasSampleAlreadyActive) {
          // Map click position to level-0 image coordinates
          const clickX = e.clientX - thumbRect.left;
          const clickY = e.clientY - thumbRect.top;
          const containerW = thumbRect.width;
          const THUMB_SIZE = 256;
          const lMeta = m.levels[thumbLevel];
          const l0    = m.levels[0];
          const ts    = Math.min(THUMB_SIZE / lMeta.width, THUMB_SIZE / lMeta.height);
          const newW  = Math.round(lMeta.width  * ts);
          const newH  = Math.round(lMeta.height * ts);
          const offX  = Math.floor((THUMB_SIZE - newW) / 2);
          const offY  = Math.floor((THUMB_SIZE - newH) / 2);
          const jpegX = clickX * THUMB_SIZE / containerW;
          const jpegY = clickY * THUMB_SIZE / containerW;
          const lvlX  = (jpegX - offX) / ts;
          const lvlY  = (jpegY - offY) / ts;
          const imgX  = Math.max(0, Math.min(l0.width,  lvlX * l0.width  / lMeta.width));
          const imgY  = Math.max(0, Math.min(l0.height, lvlY * l0.height / lMeta.height));

          // Pan viewport so the clicked image point is centered
          const t  = viewport.getTransform();
          const vpW = root.clientWidth;
          const vpH = root.clientHeight;
          const newOx = vpW / 2 - imgX * t.scale;
          const newOy = vpH / 2 - imgY * t.scale;
          viewport.panBy(newOx - t.ox, newOy - t.oy);
        }
      });

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
  _drawSecondaryLayer(viewport.getTransform());

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
    _drawSecondaryLayer(t);
    drawPredLayer();
    updateThumbOverlays();
    const lvl = META.levels;
    const level = (tiles && tiles.getLevel) ? tiles.getLevel() : (() => {
      let l = META.n_levels - 1;
      const sens = settings ? settings.get('levelSensitivity') : 1.0;
      for (let i = 0; i < META.n_levels; i++) {
        if (t.scale >= sens / lvl[i].downsample) { l = i; break; }
      }
      return l;
    })();
    const _mappedName = SAMPLE_MAPPING[ACTIVE_SAMPLE] ? ' (' + SAMPLE_MAPPING[ACTIVE_SAMPLE] + ')' : '';
    log('sample ' + ACTIVE_SAMPLE + _mappedName + '  |  zoom ' + t.scale.toFixed(3) + 'x  |  level ' + level
      + '  (' + lvl[level].width + 'x' + lvl[level].height + ')');
  });

  // coordinate display — update on mouse move over main image
  root.addEventListener('mousemove', e => {
    const r = root.getBoundingClientRect();
    const vpX = e.clientX - r.left;
    const vpY = e.clientY - r.top;
    const img = viewport.toImageSpace(vpX, vpY);
    const ix = Math.round(img.x);
    const iy = Math.round(img.y);
    statusCoord.textContent = 'x: ' + ix + '  y: ' + iy;
  });
  root.addEventListener('mouseleave', () => { statusCoord.textContent = ''; });

  log('Ready: ' + ACTIVE_SAMPLE);

  // ── async annotation layers fetch ─────────────────────────────────────────
  // Annotations are large; served from HTTP server to avoid bloating the HTML.
  fetch(BASE_URL + '/annotation_layers')
    .then(r => r.json())
    .then(layers => {
      ANNOTATION_LAYERS = layers;
      cells.setAnnotationLayers(layers);
    })
    .catch(() => {});  // non-fatal if no annotations

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
   .replace('__IS_MONOCHANNEL__', 'true' if is_monochannel else 'false') \
   .replace('__SAMPLE_IS_MONO__', json.dumps({s: isinstance(img, MonochannelImage) for s, img in sample_images.items()})) \
   .replace('__MONO_META__', json.dumps(mono_meta) if mono_meta else 'null') \
   .replace('__SAMPLE_SECONDARY_META__',   sample_secondary_meta_json) \
   .replace('__SAMPLE_SECONDARY_MATRIX__', sample_secondary_matrix_json) \
   .replace('__DRAW_ON_SECONDARY__', 'true' if draw_on_secondary else 'false') \
   .replace('__HAS_TILE_COORDS__', 'true' if _tile_coords_fn else 'false') \
   .replace('__TILE_SIZE__', str(tile_size) if tile_size is not None else 'null') \
   .replace('__HAS_VISIUM__', 'true' if _has_visium else 'false') \
   .replace('__VISIUM_GENES_BY_SAMPLE__', json.dumps(_visium_genes_by_sample)) \
   .replace('__SAMPLE_MAPPING__', json.dumps({str(k): str(v) for k, v in sample_mapping.items()} if sample_mapping else {})) \
   .replace('__JS__',      js)
    # print(f'[DIANNE] HTML build: {_time.monotonic()-_ts:.2f}s', flush=True)

    _ts = _time.monotonic()
    display(HTML(html))
    # print(f'[DIANNE] display(HTML): {_time.monotonic()-_ts:.2f}s', flush=True)
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
