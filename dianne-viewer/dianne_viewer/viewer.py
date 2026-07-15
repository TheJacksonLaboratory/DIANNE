import json
from pathlib import Path
from IPython.display import display, HTML, Javascript
import ipywidgets as widgets

from .tiff          import PyramidImage
from .multichannel  import MultichannelImage
from .monochannel   import MonochannelImage
from .server        import ViewerServer
from .xetranscripts import XeniumTranscripts
from .xencells      import XeniumCells, XeniumCellsFast

_JS_DIR   = Path(__file__).parent / 'js'
_HTML_DIR = Path(__file__).parent / 'html'


def _read_html(name: str) -> str:
    """Read an HTML template from the html/ directory."""
    return (_HTML_DIR / name).read_text()


def _render(template: str, **values: str) -> str:
    """Replace ``__KEY__`` tokens in *template* with the corresponding values.

    Raises ``KeyError`` if a requested token is not found in the template,
    which helps catch typos early.
    """
    for key, val in values.items():
        token = f'__{key.upper()}__'
        if token not in template:
            raise KeyError(f'template is missing placeholder {token}')
        template = template.replace(token, val)
    return template


# Configurable: milliseconds of loading-bar animation per cell in the inference sample.
# Examples: 5 000 cells → 5000 * 0.4 = 2 000 ms (2 s)
#           20 000 cells → 20000 * 0.4 = 8 000 ms (8 s)
INFERENCE_MS_PER_CELL = 0.25

# Registry of active viewer servers (port -> ViewerServer).
# Used to prevent launching multiple viewers in the same notebook session.
_active_viewers: dict = {}


def _register_viewer(server):
    """Track a newly started viewer server."""
    _active_viewers[server.port] = server


def _unregister_viewer(server):
    """Remove a stopped viewer server from the registry."""
    _active_viewers.pop(server.port, None)


def _has_active_viewer():
    """Return True if any tracked viewer server is still running."""
    dead = [port for port, srv in _active_viewers.items()
            if getattr(srv, '_stopped', False) or not srv._thread.is_alive()]
    for port in dead:
        _active_viewers.pop(port, None)
    return bool(_active_viewers)


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


def _fetch_xe_zip(bundle_path, fname, fs=None, s3=None, s3_bucket=None):
    """Return a metadata dict for lazy access to *fname* inside *bundle_path*, or None if not found.

    Priority: fs (s3fs / any fsspec) > s3+s3_bucket (boto3, credentials extracted to s3fs) > local Path.
    Both remote paths use s3fs for seekable range-request access — no full download.
    """
    full = str(bundle_path).rstrip('/') + '/' + fname
    # fs (s3fs / any fsspec): lazy seekable access via range requests
    if fs is not None:
        if not fs.exists(full):
            return None
        return {'type': 'fsspec', 'url': None, 'fs': fs, 'path': full}
    if s3 is not None and s3_bucket is not None:
        # Build an s3fs from the boto3 client's credentials so we get seekable range-request access
        # instead of non-seekable presigned HTTP URLs.
        try:
            import s3fs as _s3fs
            _creds = s3._request_signer._credentials.get_frozen_credentials()
            _s3_fs = _s3fs.S3FileSystem(
                key=_creds.access_key,
                secret=_creds.secret_key,
                token=_creds.token,
            )
            key = full.lstrip('/')
            s3_path = f's3://{s3_bucket}/{key}'
            if not _s3_fs.exists(s3_path):
                return None
            return {'type': 'fsspec', 'url': None, 'fs': _s3_fs, 'path': s3_path}
        except Exception as _e:
            import warnings
            warnings.warn(f'[DIANNE] s3fs construction from boto3 credentials failed for {full}: {_e}')
            return None
    p = Path(bundle_path) / fname
    if p.exists():
        return {'type': 'local', 'url': None, 'fs': None, 'path': str(p)}
    return None


def create_viewer(samples, images, width="100%", height="700px", host=None, port=None,
                  xenium_mpp=0.2125, category_colors=None, max_cells=2000,
                  mpp=None,
                  xenium_bundle_paths=None, matrices=None, annotations=None,
                  run_inference_fn=None, sample_sizes=None,
                  save_func=None, load_func=None, list_names_func=None,
                  secondary_images=None, secondary_matrices=None,
                  draw_on_secondary=False, visium_ads=None,
                  sample_mapping=None, fullscreen_on_load=True,
                  sample_metadata=None, fs=None, s3=None, s3_bucket=None):
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
    sample_metadata : dict[str, dict[str, Any]], optional
        Per-sample metadata shown as a hover tooltip on sample thumbnails and
        in a searchable/filterable "Metadata" tab next to the sample ribbon.
        Keys are sample names (same keys as ``samples``); values are flat
        ``dict[str, Any]`` of key/value pairs (strings, numbers, bools — no
        nesting for v1).  Samples with no metadata entry show no tooltip.
        Example::

            sample_metadata={
                'SampleA': {'Condition': 'KO', 'Age': 12, 'Sex': 'F'},
                'SampleB': {'Condition': 'WT', 'Age': 10, 'Sex': 'M'},
            }

        If omitted or ``None``, the "Metadata" tab is hidden entirely.
    """
    if _has_active_viewer():
      display(HTML(
        '<div style="font-family:sans-serif;color:#c0392b;padding:12px;border:1px solid #c0392b;'
        'border-radius:6px;background:#fdf3f3">'
        '<b>Could not launch the viewer.</b> '
        'Please clear all the viewer instances in this notebook.</div>'
      ))
      return [], {}, lambda: None

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
    print(f'[DIANNE] Opening {n_samples} image(s)…', flush=True)
    _t0 = _time.monotonic()
    sample_images = {}

    def _open_sample(s):
      img = _open_image(images[s])
      if n_samples<=50:
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

    if sample_metadata is None:
      sample_metadata = {}
    elif not isinstance(sample_metadata, dict):
      raise TypeError('sample_metadata must be a dict[sample] -> dict[str, Any]')
    else:
      sample_metadata = {str(k): (v if isinstance(v, dict) else {}) for k, v in sample_metadata.items()}
    sample_metadata_json = json.dumps(
      {s: sample_metadata.get(s, {}) for s in sample_list}, default=str
    )

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

      # Collect metadata for lazy xenium zip access (no full download)
      _xe_zips = {}
      for _fname in ['cells.zarr.zip', 'transcripts.zarr.zip']:
        _meta = _fetch_xe_zip(bundle_path, _fname, fs=fs, s3=s3, s3_bucket=s3_bucket)
        if _meta is not None:
          _xe_zips[_fname] = _meta
        #   print(f'[DIANNE] found {_fname} for {sample} ({_meta["type"]})', flush=True)
      if not _xe_zips:
        # print(f'[DIANNE] no xenium files found for {sample} at {bundle_path}, skipping', flush=True)
        continue

      matrix_path = matrices.get(sample)
      sample_annotations = _layer0['data'].get(sample)
      sample_colors = _layer0['colors']

      sample_xenium = XeniumTranscripts(bundle_path, sample_images[sample].metadata,
                        matrix_path=matrix_path,
                        xenium_mpp=xenium_mpp,
                        _zip_content=_xe_zips.get('transcripts.zarr.zip'))
      if 'cells_fast.zarr.zip' in _xe_zips:
        sample_cells = XeniumCellsFast(bundle_path, sample_images[sample].metadata,
                       matrix_path=matrix_path,
                       xenium_mpp=xenium_mpp,
                       cell_id_to_category=sample_annotations,
                       category_colors=sample_colors,
                       max_cells=max_cells,
                       _zip_content=_xe_zips['cells_fast.zarr.zip'])
      else:
        sample_cells = XeniumCells(bundle_path, sample_images[sample].metadata,
                       matrix_path=matrix_path,
                       xenium_mpp=xenium_mpp,
                       cell_id_to_category=sample_annotations,
                       category_colors=sample_colors,
                       max_cells=max_cells,
                       _zip_content=_xe_zips.get('cells.zarr.zip'))
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
    _register_viewer(server)
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
      # Core rendering primitives
      'viewport.js',
      'tiles.js',
      'multichannel.js',
      'monochannel2d.js',
      'transcripts.js',
      'cells.js',
      'patches.js',
      'visium.js',
      'draw.js',
      'hover.js',
      'settings.js',
      'toolbar.js',
      'demo.js',
      # Extracted UI modules (Part 1b refactor)
      'scalebar.js',
      'network_gauges.js',
      'perf_monitor.js',
      'secondary_layer.js',
      'overlay_controls.js',
      'fullscreen.js',
      'sample_ribbon.js',
      'modals.js',
      'footer_controls.js',
      'metadata_panel.js',
      # Boot: wires everything together (must be last)
      'boot.js',
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

    _stop_url = f'{base_url}/stop'

    _ts = _time.monotonic()
    html = _render(
      _read_html('shell.html'),
      js                   = js,
      width   = width,
      height  = height,
      base_url= json.dumps(base_url),
      samples = samples_json,
      sample_meta          = sample_meta_json,
      sample_xenium_meta   = sample_xenium_meta_json,
      sample_cells_meta    = sample_cells_meta_json,
      meta                 = meta_json,
      has_run_inference    = 'true' if run_inference_fn is not None else 'false',
      has_save             = 'true' if save_func is not None else 'false',
      has_load             = 'true' if (load_func is not None and list_names_func is not None) else 'false',
      sample_sizes         = json.dumps(sample_sizes or {}),
      inference_ms_per_cell= str(INFERENCE_MS_PER_CELL),
      max_cells            = str(max_cells),
      is_multichannel      = 'true' if is_multichannel else 'false',
      is_monochannel       = 'true' if is_monochannel else 'false',
      sample_is_mono       = json.dumps({s: isinstance(img, MonochannelImage) for s, img in sample_images.items()}),
      mono_meta            = json.dumps(mono_meta) if mono_meta else 'null',
      sample_secondary_meta   = sample_secondary_meta_json,
      sample_secondary_matrix = sample_secondary_matrix_json,
      draw_on_secondary    = 'true' if draw_on_secondary else 'false',
      has_tile_coords      = 'true' if _tile_coords_fn else 'false',
      tile_size            = str(tile_size) if tile_size is not None else 'null',
      has_visium           = 'true' if _has_visium else 'false',
      visium_genes_by_sample = json.dumps(_visium_genes_by_sample),
      sample_mapping       = json.dumps({str(k): str(v) for k, v in sample_mapping.items()} if sample_mapping else {}),
      sample_metadata      = sample_metadata_json,
      mpp                  = str(float(mpp)) if mpp is not None else 'null',
      stop_url             = json.dumps(_stop_url),
    )
    # print(f'[DIANNE] HTML build: {_time.monotonic()-_ts:.2f}s', flush=True)

    _ts = _time.monotonic()
    display(HTML(html))
    # print(f'[DIANNE] display(HTML): {_time.monotonic()-_ts:.2f}s', flush=True)
    display(out)

    # Auto-stop when the cell output is cleared: watch for the viewer root div
    # being disconnected from the DOM and call the server's /stop endpoint.
    _stop_url = f'{base_url}/stop'
    display(Javascript(f"""
(function () {{
  var _stopUrl = {json.dumps(_stop_url)};
  var _root = document.getElementById('iv-shell');
  if (!_root) return;
  var _obs = new MutationObserver(function () {{
    if (!document.body.contains(_root)) {{
      _obs.disconnect();
      fetch(_stopUrl).catch(function () {{}});
    }}
  }});
  _obs.observe(document.body, {{ childList: true, subtree: true }});
}})();
"""))

    _orig_stop = server.stop
    def _stop_and_unregister():
        _unregister_viewer(server)
        _orig_stop()
    server.stop = _stop_and_unregister

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
