import json
from pathlib import Path
from IPython.display import display, HTML, Javascript
import ipywidgets as widgets

from viewer.tiff   import PyramidImage
from viewer.server import ViewerServer
from viewer.xetranscripts import XeniumTranscripts

_JS_DIR = Path(__file__).parent / 'js'

def _read_js(name):
    return (_JS_DIR / name).read_text()


def create_viewer(image_path, width="100%", height="700px", host=None, port=None,
                  xenium_bundle_path=None, matrix_csv=None, xenium_mpp=1.0):
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
    image_path : str | Path
    width, height : CSS strings for the viewer div
    host : IP reachable from the browser (auto-detected if None)
    port : HTTP port for the tile/click server (random if None)
    xenium_bundle_path : optional path to a Xenium bundle with transcripts.zarr.zip
    matrix_csv : optional path to a 3×3 CSV affine matrix (H&E px → Xenium µm)
    xenium_mpp : Xenium microns-per-pixel (default 1.0); scales coords after apply matrix

    Returns
    -------
    clicks  : list of dicts  {img_x, img_y, vp_x, vp_y, zoom}
    strokes : dict with keys:
          - strokes_positive: [{id, points: [{x, y}, ...]}, ...]
          - strokes_negative: [{id, points: [{x, y}, ...]}, ...]
          image-space coords
    stop    : callable — shuts down the background HTTP server
    """
    image  = PyramidImage(image_path)
    xenium = XeniumTranscripts(xenium_bundle_path, image.metadata,
                               matrix_path=matrix_csv,
                               xenium_mpp=xenium_mpp) if xenium_bundle_path else None
    server = ViewerServer(image, host=host, port=port, xenium=xenium)
    server.start()

    # output widget for server-side log (optional, hidden by default)
    out = widgets.Output(layout=widgets.Layout(display='none'))

    meta_json = json.dumps(image.metadata)
    xenium_meta_json = json.dumps(xenium.metadata) if xenium else 'null'
    base_url  = server.base_url

    # inline all JS files
    js = '\n\n'.join(_read_js(f) for f in [
        'viewport.js',
        'tiles.js',
      'transcripts.js',
        'draw.js',
        'toolbar.js',
    ])

    html = """
<div id="iv-root" style="
  position: relative;
  width: __WIDTH__;
  height: __HEIGHT__;
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
  margin-bottom: 6px;
">initializing…</div>

<script>
(function () {
  const root     = document.getElementById('iv-root');
  const status   = document.getElementById('iv-status');
  const BASE_URL = __BASE_URL__;
  const META     = __META__;
  const XENIUM_META = __XENIUM_META__;

  function log(msg) { status.textContent = msg; }

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
    '<span title="Overlay transparency">a</span>',
    '<input id="iv-alpha" type="range" min="0" max="1" step="0.01" value="0.55" style="width:90px;">',
    '<span title="Low probability color">low</span>',
    '<input id="iv-low" type="color" value="#0b4dff" style="width:24px;height:24px;border:none;background:none;padding:0;cursor:pointer;">',
    '<span title="High probability color">high</span>',
    '<input id="iv-high" type="color" value="#ff2a2a" style="width:24px;height:24px;border:none;background:none;padding:0;cursor:pointer;">',
  ].join('');
  root.appendChild(overlayControls);

  // boot
  __JS__

  const l0       = META.levels[0];
  const viewport = createViewport(root, l0.width, l0.height);
  const tiles    = createTiles(tileLayer, BASE_URL, META, viewport);
  const transcripts = XENIUM_META
    ? createXeTranscripts(root, BASE_URL, META, XENIUM_META, viewport, log)
    : null;
  const draw     = createDraw(root, viewport);
  const toolbar  = createToolbar(root, viewport, draw, BASE_URL);

  // prediction overlay layer (Python-driven)
  const predLayer = document.createElement('canvas');
  predLayer.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;';
  root.appendChild(predLayer);
  const predCtx = predLayer.getContext('2d');
  let predPoints = [];
  let predStyle = {
    alpha: 0.55,
    delta: 28,
    colorLow: '#0b4dff',
    colorHigh: '#ff2a2a',
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

  syncOverlayControls();

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

  // flush strokes to Python
  window.ivFlushStrokes = function() {
    const s = draw.getStrokes();
    fetch(BASE_URL + '/strokes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(s),
    }).then(() => {
      const pos = (s.strokes_positive || []).length;
      const neg = (s.strokes_negative || []).length;
      log('Annotations transferred (+ ' + pos + ', - ' + neg + ')');
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
    log('zoom ' + t.scale.toFixed(3) + 'x  |  level ' + level
      + '  (' + lvl[level].width + 'x' + lvl[level].height + ')');
  });

  log('Ready');
})();
</script>
""".replace('__WIDTH__',   width) \
   .replace('__HEIGHT__',  height) \
   .replace('__BASE_URL__', json.dumps(base_url)) \
   .replace('__META__',    meta_json) \
  .replace('__XENIUM_META__', xenium_meta_json) \
   .replace('__JS__',      js)

    display(HTML(html))
    display(out)

    return server.clicks, server.strokes, server.stop


def set_overlay_points(xi, yi=None, pi=None, delta=28, alpha=0.55,
                       color_low='#0b4dff', color_high='#ff2a2a'):
    """
    Push prediction points into the active viewer overlay layer.

    Parameters
    ----------
    xi, yi, pi : arrays of equal length in image coordinates with probabilities in [0, 1].
                 For backward compatibility you may pass a single iterable of
                 dicts {xi, yi, pi} as the first argument and leave yi/pi as None.
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
    display(Javascript(
        """
(function () {
  if (typeof window.ivSetOverlayPoints !== 'function') {
    console.warn('Viewer overlay API is not available. Run create_viewer(...) first.');
    return;
  }
  window.ivSetOverlayPoints(__POINTS__, __STYLE__);
})();
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
