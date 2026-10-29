"""
affine_aligner.py — interactive affine alignment of two images in a Jupyter notebook.

Usage
-----
    from affine_aligner import alignAffine, loadAffine, applyAffine

    alignAffine(fixed_img, moving_img,
                fixed_scale=8, moving_scale=4,        # downsample factors of the arrays you pass
                savepath='./affine/', name='sampleA')

    M = loadAffine('./affine/sampleA.affine.csv')      # 2x3, moving_full -> fixed_full
    pts_fixed = applyAffine(M, pts_moving)             # Nx2 pixel coords, full resolution

The *fixed* image is drawn as-is. The *moving* image is drawn on top of it inside an
affine-movable frame with a transparency slider. Adjust the frame until the two images
line up, then press "Save affine" (or Ctrl/Cmd+S).

Scaling factors
---------------
`fixed_scale` / `moving_scale` are the downsample factors of the arrays you supply:
    full_resolution_pixel = supplied_pixel * scale
The frame math is done in the downsampled space of the fixed image; the saved matrix
is converted to full resolution, so it maps *full-res moving pixels -> full-res fixed
pixels* regardless of how heavily each input was downsampled.

Frame controls (mouse)
----------------------
  drag inside frame ............ translate
  corner handles (squares) ..... scale about the opposite corner (Shift: uniform, Alt: about centre)
  edge handles (diamonds) ...... shear along that edge
  round knob above top edge .... rotate about the frame centre
  drag on background ........... pan the view
  mouse wheel .................. zoom the view (about cursor)

Keyboard (while the cursor is over the canvas)
----------------------------------------------
  arrows        nudge 1 px (Shift: 10 px)        q / e   rotate 0.25 deg (Shift: 2.5 deg)
  + / -         scale 0.5 % (Shift: 5 %)         f       fit both images in view
  r             reset frame                      Ctrl+S  save
  [ / ]         transparency down / up           b       cycle blend mode

Output files (in `savepath`)
----------------------------
  <name>.affine.csv          2x3 matrix M, moving_full -> fixed_full   (the main deliverable)
  <name>.affine_inv.csv      2x3 matrix,   fixed_full  -> moving_full
  <name>.affine.json         full state (M, scales, image shapes) — reloaded automatically
                             the next time alignAffine() is called with the same name.

Either image may cover a larger physical area than the other: the canvas is a
pannable/zoomable viewport, so the frame can extend well past the fixed image
and vice versa.
"""

import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.parse import urlparse

import numpy as np
from IPython.display import HTML, display
from PIL import Image
import tifffile
import cv2

def prepSlideData(slide, L=2, size=1024):
    with tifffile.TiffFile(slide) as tf:
        fshape = tf.series[0].pages[0].shape
    thumb = tifffile.imread(slide, level=L)
    h, w = thumb.shape[:2]
    if max(h, w)>size:
        if h>w:
            h_ = size
            w_ = int(w*size/h)
        else:
            h_ = int(h*size/w)
            w_ = size
        thumb = cv2.resize(thumb, (w_, h_), fx=0, fy=0, interpolation=cv2.INTER_AREA)
    scale = fshape[0] / thumb.shape[0]
    return {'thumb': thumb, 'scale': scale, 'fshape': fshape}

# ────────────────────────────────────────────────────────────────────────────
# small public helpers
# ────────────────────────────────────────────────────────────────────────────

def loadAffine(csv_path: str) -> np.ndarray:
    """Read a 2x3 affine matrix saved by alignAffine()."""
    M = np.loadtxt(csv_path, delimiter=',', dtype=np.float64)
    assert M.shape == (2, 3), f'expected a 2x3 matrix in {csv_path}, got {M.shape}'
    return M


def applyAffine(M: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Apply a 2x3 affine matrix to an Nx2 array of (x, y) points."""
    pts = np.asarray(pts, dtype=np.float64)
    return pts @ M[:, :2].T + M[:, 2]


def invertAffine(M: np.ndarray) -> np.ndarray:
    """Invert a 2x3 affine matrix (returns 2x3)."""
    H = np.vstack([np.asarray(M, dtype=np.float64), [0.0, 0.0, 1.0]])
    return np.linalg.inv(H)[:2, :]


# ────────────────────────────────────────────────────────────────────────────
# internals
# ────────────────────────────────────────────────────────────────────────────

def _as_rgb_uint8(arr: np.ndarray) -> np.ndarray:
    """Coerce any HxW / HxWx1 / HxWx3 / HxWx4 array to contiguous HxWx3 uint8."""
    arr = np.asarray(arr)
    if arr.dtype != np.uint8:
        a = arr.astype(np.float64)
        if np.nanmax(a) <= 1.0:
            a = a * 255.0
        arr = np.clip(np.nan_to_num(a), 0, 255).astype(np.uint8)
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    elif arr.shape[-1] == 1:
        arr = np.repeat(arr, 3, axis=-1)
    elif arr.shape[-1] == 4:
        arr = arr[..., :3]
    return np.ascontiguousarray(arr)


def _down_to_full(A, t, fixed_scale, moving_scale):
    """(A, t) in downsampled space  ->  2x3 full-res matrix (moving_full -> fixed_full)."""
    A = np.asarray(A, dtype=np.float64).reshape(2, 2)
    t = np.asarray(t, dtype=np.float64).reshape(2)
    r = fixed_scale / moving_scale
    return np.hstack([A * r, (t * fixed_scale)[:, None]])


def _full_to_down(M, fixed_scale, moving_scale):
    """Inverse of _down_to_full."""
    M = np.asarray(M, dtype=np.float64).reshape(2, 3)
    A = M[:, :2] * (moving_scale / fixed_scale)
    t = M[:, 2] / fixed_scale
    return A, t


def _decompose(M):
    """Rotation (deg), scale (sx, sy), shear and translation from a 2x3 affine."""
    a, b, c, d = M[0, 0], M[0, 1], M[1, 0], M[1, 1]
    sx = float(np.hypot(a, c))
    theta = float(np.degrees(np.arctan2(c, a)))
    shear = float((a * b + c * d) / (sx * sx)) if sx > 0 else 0.0
    sy = float((a * d - b * c) / sx) if sx > 0 else 0.0
    return {'rotation_deg': theta, 'scale_x': sx, 'scale_y': sy,
            'shear': shear, 'tx': float(M[0, 2]), 'ty': float(M[1, 2])}


# ────────────────────────────────────────────────────────────────────────────
# the app
# ────────────────────────────────────────────────────────────────────────────

def alignAffine(
    fixed: np.ndarray,
    moving: np.ndarray,
    fixed_scale: float = 1.0,
    moving_scale: float = 1.0,
    savepath: str = './affine/',
    name: str = 'alignment',
    canvas_w: int = 1000,
    canvas_h: int = 720,
    init='physical',
    alpha: float = 0.5,
):
    """
    Show the interactive aligner.

    fixed, moving   : HxW[x3] arrays (downsampled is fine; see fixed_scale / moving_scale)
    fixed_scale     : downsample factor of `fixed`  (full = supplied * fixed_scale)
    moving_scale    : downsample factor of `moving` (full = supplied * moving_scale)
    savepath, name  : where and under which stem the CSV/JSON files are written
    canvas_w/h      : viewport size in CSS pixels
    init            : starting frame if no saved state exists for `name`:
                        'physical'  — assume both full-res images share the same µm/px:
                                      moving is scaled by moving_scale/fixed_scale and
                                      centred on the fixed image (default)
                        'identity'  — moving pixel (0,0) on fixed pixel (0,0), scale 1
                        2x3 array   — a full-res moving_full -> fixed_full matrix to start from
    alpha           : initial transparency of the moving image (0..1)
    """
    savepath = savepath.rstrip('/')
    os.makedirs(savepath, exist_ok=True)

    fixed_scale = float(fixed_scale)
    moving_scale = float(moving_scale)
    imgs = [_as_rgb_uint8(fixed), _as_rgb_uint8(moving)]
    sizes = [(int(im.shape[1]), int(im.shape[0])) for im in imgs]  # (w, h)
    FW, FH = sizes[0]
    MW, MH = sizes[1]

    csv_path = os.path.join(savepath, f'{name}.affine.csv')
    inv_path = os.path.join(savepath, f'{name}.affine_inv.csv')
    json_path = os.path.join(savepath, f'{name}.affine.json')

    # ── initial frame (downsampled fixed-image space) ────────────────────────
    def _init_from_param():
        if isinstance(init, str) and init == 'identity':
            return np.eye(2), np.zeros(2)
        if isinstance(init, str) and init == 'physical':
            A0 = np.eye(2) * (moving_scale / fixed_scale)
            t0 = np.array([FW / 2, FH / 2]) - A0 @ np.array([MW / 2, MH / 2])
            return A0, t0
        return _full_to_down(np.asarray(init, dtype=np.float64), fixed_scale, moving_scale)

    A_init, t_init = _init_from_param()
    A_start, t_start = A_init, t_init
    loaded_from_disk = False
    if os.path.isfile(json_path):
        try:
            with open(json_path) as fh:
                st = json.load(fh)
            A_start, t_start = _full_to_down(np.asarray(st['M_full']), fixed_scale, moving_scale)
            loaded_from_disk = True
        except Exception:
            pass

    # ── lazily encoded images ────────────────────────────────────────────────
    _png_cache: dict[int, bytes] = {}
    _cache_lock = threading.Lock()

    def _encode(idx: int) -> bytes:
        with _cache_lock:
            if idx not in _png_cache:
                buf = BytesIO()
                Image.fromarray(imgs[idx]).save(buf, format='PNG', compress_level=3)
                _png_cache[idx] = buf.getvalue()
            return _png_cache[idx]

    # ── tiny HTTP server ─────────────────────────────────────────────────────
    with socket.socket() as s:
        s.bind(('', 0))
        port = s.getsockname()[1]

    _save_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, body: bytes, ctype='application/json', cache='no-store'):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', cache)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_OPTIONS(self):
            self._send(b'')

        def do_GET(self):
            path = urlparse(self.path).path
            if path.startswith('/image/'):
                try:
                    idx = int(path.rsplit('/', 1)[-1])
                    body = _encode(idx)
                except Exception:
                    self.send_response(404); self.end_headers(); return
                self._send(body, 'image/png', 'public, max-age=604800, immutable')
            else:
                self.send_response(404); self.end_headers()

        def do_POST(self):
            n = int(self.headers.get('Content-Length', 0))
            try:
                payload = json.loads(self.rfile.read(n))
                action = payload.get('action', 'save')
                if action == 'save':
                    self._handle_save(payload)
                else:
                    self._send(json.dumps({'ok': False, 'error': f'unknown action {action}'}).encode())
            except Exception as e:
                self._send(json.dumps({'ok': False, 'error': str(e)}).encode())

        def _handle_save(self, payload):
            M = _down_to_full(payload['A'], payload['t'], fixed_scale, moving_scale)
            Minv = invertAffine(M)
            state = {
                'name': name,
                'M_full': M.tolist(),
                'M_full_inverse': Minv.tolist(),
                'direction': 'moving_full -> fixed_full',
                'fixed_scale': fixed_scale,
                'moving_scale': moving_scale,
                'fixed_shape_supplied': [FH, FW],
                'moving_shape_supplied': [MH, MW],
                'decomposition': _decompose(M),
            }
            with _save_lock:
                np.savetxt(csv_path, M, delimiter=',', fmt='%.10f')
                np.savetxt(inv_path, Minv, delimiter=',', fmt='%.10f')
                with open(json_path, 'w') as fh:
                    json.dump(state, fh, indent=2)
            self._send(json.dumps({'ok': True, 'file': csv_path}).encode())

        def log_message(self, *a):
            pass

    host = socket.gethostbyname(socket.gethostname())
    srv = ThreadingHTTPServer((host, port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # ── HTML + JS ────────────────────────────────────────────────────────────
    root_id = f'aa-root-{port}'

    css = f"""
<style>
  #{root_id} {{
    --bg:#1a1a2e; --panel:#22223a; --accent:#e94560; --accent2:#0f3460;
    --text:#eaeaea; --muted:#8892a4; --radius:6px;
    --font:'JetBrains Mono','Fira Code','Consolas',monospace;
    font-family:var(--font); background:var(--bg); color:var(--text);
    padding:16px; border-radius:10px; display:inline-flex; flex-direction:column;
    gap:10px; user-select:none;
  }}
  #{root_id} * {{ box-sizing:border-box; margin:0; padding:0; }}
  #{root_id} .aa-header {{ display:flex; align-items:center; gap:12px; }}
  #{root_id} .aa-title {{ font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); }}
  #{root_id} .aa-name {{ font-size:13px; background:var(--accent2); padding:3px 10px; border-radius:var(--radius); }}
  #{root_id} .aa-legend {{ margin-left:auto; font-size:11px; color:var(--muted); display:flex; gap:14px; }}
  #{root_id} .aa-legend i {{ display:inline-block; width:10px; height:10px; margin-right:5px; vertical-align:-1px; }}
  #{root_id} .aa-canvas-wrap {{
    position:relative; border:1.5px solid var(--accent2); border-radius:var(--radius);
    overflow:hidden; cursor:default; background:#111;
  }}
  #{root_id} canvas {{ display:block; outline:none; }}
  #{root_id} .aa-toolbar {{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }}
  #{root_id} .aa-btn {{
    font-family:var(--font); font-size:12px; letter-spacing:.06em; padding:6px 14px;
    border:none; border-radius:var(--radius); cursor:pointer; transition:filter .15s;
    background:var(--accent2); color:var(--text);
  }}
  #{root_id} .aa-btn:hover {{ filter:brightness(1.15); }}
  #{root_id} .aa-btn:active {{ filter:brightness(.9); }}
  #{root_id} .aa-btn.primary {{ background:var(--accent); color:#fff; }}
  #{root_id} .aa-btn.quiet {{ background:#2a2a4a; color:var(--muted); }}
  #{root_id} label {{ display:flex; align-items:center; gap:6px; font-size:11px; color:var(--muted); }}
  #{root_id} input[type=range] {{ accent-color:var(--accent); width:140px; }}
  #{root_id} input[type=checkbox] {{ accent-color:var(--accent); width:14px; height:14px; cursor:pointer; }}
  #{root_id} select {{
    font-family:var(--font); font-size:11px; background:var(--panel); color:var(--text);
    border:1px solid var(--accent2); border-radius:var(--radius); padding:3px 6px;
  }}
  #{root_id} .aa-status {{ font-size:11px; color:var(--muted); min-height:16px; }}
  #{root_id} .aa-readout {{
    display:grid; grid-template-columns:auto auto; gap:6px 24px; font-size:11px;
    background:var(--panel); border:1px solid var(--accent2); border-radius:var(--radius); padding:8px 12px;
  }}
  #{root_id} .aa-readout pre {{
    font-family:var(--font); font-size:11px; line-height:1.5;
    background:var(--panel); color:#f4f4f4; white-space:pre; overflow-x:auto;
  }}
  #{root_id} .aa-readout .k {{ color:var(--muted); }}
  #{root_id} .aa-hint {{ font-size:10px; color:var(--muted); line-height:1.6; max-width:{canvas_w}px; }}
</style>
<div id="{root_id}">
  <div class="aa-header">
    <span class="aa-title">Affine Aligner</span>
    <span class="aa-name">{name}</span>
    <span class="aa-legend">
      <span><i style="background:#4fc3f7"></i>fixed {FW}×{FH} (×{fixed_scale:g})</span>
      <span><i style="background:#ffb300"></i>moving {MW}×{MH} (×{moving_scale:g})</span>
    </span>
  </div>
  <div class="aa-canvas-wrap"><canvas class="aa-canvas" tabindex="0"></canvas></div>
  <div class="aa-toolbar">
    <button class="aa-btn primary aa-save">Save affine</button>
    <button class="aa-btn aa-fit">Fit view</button>
    <button class="aa-btn quiet aa-reset">Reset frame</button>
    <label>opacity <input type="range" class="aa-alpha" min="0" max="1" step="0.01" value="{alpha}"></label>
    <label>blend <select class="aa-blend">
      <option value="source-over">normal</option>
      <option value="difference">difference</option>
      <option value="multiply">multiply</option>
      <option value="screen">screen</option>
    </select></label>
    <label><input type="checkbox" class="aa-smooth" checked> smooth</label>
    <label><input type="checkbox" class="aa-frame" checked> frame</label>
  </div>
  <div class="aa-status">Loading…</div>
  <div class="aa-readout">
    <div><span class="k">M (moving_full → fixed_full)</span><pre class="aa-matrix">—</pre></div>
    <div><span class="k">decomposition</span><pre class="aa-decomp">—</pre></div>
  </div>
  <div class="aa-hint">
    Drag inside the frame to move · corner squares scale (Shift uniform, Alt about centre) · edge diamonds shear ·
    round knob rotates · drag background to pan · wheel to zoom · arrows nudge · q/e rotate · +/- scale · f fit · r reset · Ctrl+S save
  </div>
</div>
"""

    js = (
        "<script>\n(function(){\n"
        f"  const ROOT_ID = {json.dumps(root_id)};\n"
        f"  const SRV = 'http://' + {json.dumps(host)} + ':' + {port};\n"
        f"  const FW = {FW}, FH = {FH}, MW = {MW}, MH = {MH};\n"
        f"  const CW = {int(canvas_w)}, CH = {int(canvas_h)};\n"
        f"  const FS = {fixed_scale}, MS = {moving_scale};\n"
        f"  const A_INIT = {json.dumps(A_init.tolist())}, T_INIT = {json.dumps(t_init.tolist())};\n"
        f"  const A_START = {json.dumps(A_start.tolist())}, T_START = {json.dumps(t_start.tolist())};\n"
        f"  const LOADED = {json.dumps(loaded_from_disk)};\n"
        f"  const CSV_PATH = {json.dumps(csv_path)};\n"
        + r"""
  const ROOT = document.getElementById(ROOT_ID);
  const $ = sel => ROOT.querySelector(sel);
  const cv = $('.aa-canvas'); cv.width = CW; cv.height = CH;
  const ctx = cv.getContext('2d');
  const statusEl = $('.aa-status'), matEl = $('.aa-matrix'), decEl = $('.aa-decomp');
  const alphaEl = $('.aa-alpha'), blendEl = $('.aa-blend'), smoothEl = $('.aa-smooth'), frameEl = $('.aa-frame');

  // ── state ──────────────────────────────────────────────────────────
  // A (2x2) and t (2): moving-downsampled px -> fixed-downsampled px ("world" space).
  let A = A_START.map(r => r.slice()), t = T_START.slice();
  let view = {z: 1, ox: 0, oy: 0};          // canvas = world * z + o
  let alpha = parseFloat(alphaEl.value);
  let dirty = false;
  const im = {fixed: null, moving: null};

  // ── linear algebra ─────────────────────────────────────────────────
  const mul = (P, Q) => [[P[0][0]*Q[0][0] + P[0][1]*Q[1][0], P[0][0]*Q[0][1] + P[0][1]*Q[1][1]],
                         [P[1][0]*Q[0][0] + P[1][1]*Q[1][0], P[1][0]*Q[0][1] + P[1][1]*Q[1][1]]];
  const inv = P => { const d = P[0][0]*P[1][1] - P[0][1]*P[1][0];
                     return [[ P[1][1]/d, -P[0][1]/d], [-P[1][0]/d, P[0][0]/d]]; };
  const mv  = (P, p) => [P[0][0]*p[0] + P[0][1]*p[1], P[1][0]*p[0] + P[1][1]*p[1]];
  const rot = th => [[Math.cos(th), -Math.sin(th)], [Math.sin(th), Math.cos(th)]];

  const movToWorld = p => { const q = mv(A, p); return [q[0] + t[0], q[1] + t[1]]; };
  const worldToMov = p => mv(inv(A), [p[0] - t[0], p[1] - t[1]]);
  const worldToCanvas = p => [p[0]*view.z + view.ox, p[1]*view.z + view.oy];
  const canvasToWorld = p => [(p[0] - view.ox)/view.z, (p[1] - view.oy)/view.z];
  const movToCanvas = p => worldToCanvas(movToWorld(p));

  const LOCAL = {
    corners: [[0,0],[MW,0],[MW,MH],[0,MH]],
    mids:    [[MW/2,0],[MW,MH/2],[MW/2,MH],[0,MH/2]],   // top, right, bottom, left
    center:  [MW/2, MH/2],
  };

  // Re-express A' with a chosen local pivot held fixed in world space.
  function setAKeepingPivot(Anew, localPivot) {
    const worldPivot = movToWorld(localPivot);
    A = Anew;
    const q = mv(A, localPivot);
    t = [worldPivot[0] - q[0], worldPivot[1] - q[1]];
  }

  // ── view ───────────────────────────────────────────────────────────
  function fitView() {
    const pts = [[0,0],[FW,0],[FW,FH],[0,FH], ...LOCAL.corners.map(movToWorld)];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const bw = Math.max(x1 - x0, 1), bh = Math.max(y1 - y0, 1);
    view.z  = Math.min(CW / bw, CH / bh) * 0.9;
    view.ox = CW/2 - (x0 + bw/2) * view.z;
    view.oy = CH/2 - (y0 + bh/2) * view.z;
    draw();
  }

  // ── drawing ────────────────────────────────────────────────────────
  function handles() {
    const corners = LOCAL.corners.map(movToCanvas);
    const mids    = LOCAL.mids.map(movToCanvas);
    const center  = movToCanvas(LOCAL.center);
    let dx = mids[0][0] - center[0], dy = mids[0][1] - center[1];
    const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
    const knob = [mids[0][0] + dx*28, mids[0][1] + dy*28];
    return {corners, mids, center, knob, topMid: mids[0]};
  }

  function draw() {
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, CW, CH);
    ctx.imageSmoothingEnabled = smoothEl.checked;
    const {z, ox, oy} = view;
    if (im.fixed) { ctx.setTransform(z, 0, 0, z, ox, oy); ctx.drawImage(im.fixed, 0, 0); }
    if (im.moving) {
      ctx.globalAlpha = alpha; ctx.globalCompositeOperation = blendEl.value;
      // canvas setTransform(a,b,c,d,e,f): x' = a x + c y + e ; y' = b x + d y + f
      ctx.setTransform(z*A[0][0], z*A[1][0], z*A[0][1], z*A[1][1], z*t[0] + ox, z*t[1] + oy);
      ctx.drawImage(im.moving, 0, 0);
    }
    ctx.setTransform(1,0,0,1,0,0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

    // fixed-image outline
    const fc = [[0,0],[FW,0],[FW,FH],[0,FH]].map(worldToCanvas);
    ctx.beginPath(); fc.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
    ctx.setLineDash([6, 4]); ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);

    if (!frameEl.checked) { updateReadout(); return; }
    const h = handles();
    // frame
    ctx.beginPath(); h.corners.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4; ctx.stroke();
    ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 2; ctx.stroke();
    // rotation stem + knob
    ctx.beginPath(); ctx.moveTo(h.topMid[0], h.topMid[1]); ctx.lineTo(h.knob[0], h.knob[1]);
    ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(h.knob[0], h.knob[1], 7, 0, 2*Math.PI);
    ctx.fillStyle = '#ffb300'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5; ctx.stroke();
    // corner squares
    h.corners.forEach(p => { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000';
      ctx.fillRect(p[0]-6, p[1]-6, 12, 12); ctx.strokeRect(p[0]-6, p[1]-6, 12, 12); });
    // edge diamonds
    h.mids.forEach(p => { ctx.beginPath(); ctx.moveTo(p[0], p[1]-7); ctx.lineTo(p[0]+7, p[1]);
      ctx.lineTo(p[0], p[1]+7); ctx.lineTo(p[0]-7, p[1]); ctx.closePath();
      ctx.fillStyle = '#ffb300'; ctx.fill(); ctx.strokeStyle = '#000'; ctx.stroke(); });
    // centre cross
    ctx.beginPath(); ctx.moveTo(h.center[0]-6, h.center[1]); ctx.lineTo(h.center[0]+6, h.center[1]);
    ctx.moveTo(h.center[0], h.center[1]-6); ctx.lineTo(h.center[0], h.center[1]+6);
    ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 1.5; ctx.stroke();
    updateReadout();
  }

  function fullMatrix() {
    const r = FS / MS;
    return [[A[0][0]*r, A[0][1]*r, t[0]*FS], [A[1][0]*r, A[1][1]*r, t[1]*FS]];
  }
  function updateReadout() {
    const M = fullMatrix();
    const f = v => (v >= 0 ? ' ' : '') + v.toFixed(5).padStart(11);
    matEl.textContent = M.map(r => r.map(f).join(' ')).join('\n');
    const a = M[0][0], b = M[0][1], c = M[1][0], d = M[1][1];
    const sx = Math.hypot(a, c), th = Math.atan2(c, a) * 180 / Math.PI;
    const sh = sx ? (a*b + c*d) / (sx*sx) : 0, sy = sx ? (a*d - b*c) / sx : 0;
    decEl.textContent =
      'rotation ' + th.toFixed(3) + '°\n' +
      'scale    ' + sx.toFixed(5) + ' × ' + sy.toFixed(5) + '\n' +
      'shear    ' + sh.toFixed(5) + '\n' +
      'shift    ' + M[0][2].toFixed(1) + ', ' + M[1][2].toFixed(1) + ' px (full res)' +
      (dirty ? '\n(unsaved changes)' : '');
  }

  // ── mouse ──────────────────────────────────────────────────────────
  function canvasXY(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  const dist = (p, q) => Math.hypot(p[0]-q[0], p[1]-q[1]);
  function pointInPoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function hitTest(p) {
    if (!frameEl.checked) return {mode: pointInPoly(p, LOCAL.corners.map(movToCanvas)) ? 'move' : 'pan'};
    const h = handles();
    if (dist(p, h.knob) <= 10) return {mode: 'rotate'};
    for (let i = 0; i < 4; i++) if (dist(p, h.corners[i]) <= 9) return {mode: 'scale', idx: i};
    for (let i = 0; i < 4; i++) if (dist(p, h.mids[i]) <= 9) return {mode: 'shear', idx: i};
    if (pointInPoly(p, h.corners)) return {mode: 'move'};
    return {mode: 'pan'};
  }
  const CURSORS = {rotate: 'grab', scale: 'nwse-resize', shear: 'ew-resize', move: 'move', pan: 'default'};

  let drag = null;
  cv.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const c = canvasXY(e);
    const hit = hitTest(c);
    drag = {...hit, c0: c, w0: canvasToWorld(c), A0: A.map(r => r.slice()), t0: t.slice(),
            view0: {...view}, centerW: movToWorld(LOCAL.center)};
    if (hit.mode === 'scale') {
      drag.pivot = e.altKey ? LOCAL.center : LOCAL.corners[(hit.idx + 2) % 4];
      drag.pivotW = movToWorld(drag.pivot);
      drag.uniform = e.shiftKey;
    }
    cv.style.cursor = CURSORS[hit.mode] === 'grab' ? 'grabbing' : CURSORS[hit.mode];
    e.preventDefault();
  });

  window.addEventListener('mousemove', e => {
    const c = canvasXY(e);
    if (!drag) { cv.style.cursor = CURSORS[hitTest(c).mode]; return; }
    const w = canvasToWorld(c);
    if (drag.mode === 'pan') {
      view.ox = drag.view0.ox + (c[0] - drag.c0[0]); view.oy = drag.view0.oy + (c[1] - drag.c0[1]);
      draw(); return;
    }
    A = drag.A0.map(r => r.slice()); t = drag.t0.slice();
    if (drag.mode === 'move') {
      t = [drag.t0[0] + (w[0] - drag.w0[0]), drag.t0[1] + (w[1] - drag.w0[1])];
    } else if (drag.mode === 'rotate') {
      const a0 = Math.atan2(drag.w0[1] - drag.centerW[1], drag.w0[0] - drag.centerW[0]);
      const a1 = Math.atan2(w[1] - drag.centerW[1], w[0] - drag.centerW[0]);
      setAKeepingPivot(mul(rot(a1 - a0), drag.A0), LOCAL.center);
    } else if (drag.mode === 'scale') {
      const L = worldToMov(w);                       // mouse in moving-local coords (using A0,t0)
      const q = LOCAL.corners[drag.idx], p = drag.pivot;
      let fx = (L[0] - p[0]) / (q[0] - p[0]), fy = (L[1] - p[1]) / (q[1] - p[1]);
      if (drag.uniform) {
        const f = Math.hypot(L[0]-p[0], L[1]-p[1]) / Math.hypot(q[0]-p[0], q[1]-p[1]);
        fx = Math.sign(fx || 1) * f; fy = Math.sign(fy || 1) * f;
      }
      const clamp = v => Math.sign(v || 1) * Math.max(Math.abs(v), 0.02);
      setAKeepingPivot(mul(drag.A0, [[clamp(fx), 0], [0, clamp(fy)]]), p);
    } else if (drag.mode === 'shear') {
      const L = worldToMov(w);
      const q = LOCAL.mids[drag.idx], c0 = LOCAL.center;
      let S;
      if (drag.idx % 2 === 0) {                       // top / bottom edge: shear x along y
        const k = (L[0] - q[0]) / (q[1] - c0[1]); S = [[1, k], [0, 1]];
      } else {                                        // left / right edge: shear y along x
        const k = (L[1] - q[1]) / (q[0] - c0[0]); S = [[1, 0], [k, 1]];
      }
      setAKeepingPivot(mul(drag.A0, S), LOCAL.center);
    }
    dirty = true; draw();
  });
  const endDrag = () => { if (drag) { drag = null; cv.style.cursor = 'default'; } };
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('blur', endDrag);
  cv.addEventListener('contextmenu', e => e.preventDefault());

  cv.addEventListener('wheel', e => {
    e.preventDefault(); e.stopPropagation();
    const c = canvasXY(e);
    const f = Math.exp(-e.deltaY * 0.0015);
    view.ox = c[0] - (c[0] - view.ox) * f;
    view.oy = c[1] - (c[1] - view.oy) * f;
    view.z *= f;
    draw();
  }, {passive: false});

  // ── keyboard (capture phase, hover-gated: same trick as the annotator) ──
  let hovered = false;
  cv.addEventListener('mouseenter', () => { hovered = true;
    try { if (Jupyter && Jupyter.keyboard_manager) Jupyter.keyboard_manager.disable(); } catch(_) {}
    cv.focus(); });
  cv.addEventListener('mouseleave', () => { hovered = false;
    try { if (Jupyter && Jupyter.keyboard_manager) Jupyter.keyboard_manager.enable(); } catch(_) {}
    cv.blur(); });

  function nudge(dx, dy) { t = [t[0] + dx, t[1] + dy]; dirty = true; draw(); }
  function rotateBy(deg) { setAKeepingPivot(mul(rot(deg * Math.PI / 180), A), LOCAL.center); dirty = true; draw(); }
  function scaleBy(f) { setAKeepingPivot(mul(A, [[f, 0], [0, f]]), LOCAL.center); dirty = true; draw(); }
  const BLENDS = ['source-over', 'difference', 'multiply', 'screen'];

  window.addEventListener('keydown', e => {
    if (!hovered) return;
    e.stopPropagation(); e.stopImmediatePropagation();
    const big = e.shiftKey;
    const step = big ? 10 : 1;
    if      (e.key === 'ArrowLeft')  { e.preventDefault(); nudge(-step, 0); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(step, 0); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); nudge(0, -step); }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); nudge(0, step); }
    else if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); rotateBy(big ? -2.5 : -0.25); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); rotateBy(big ?  2.5 :  0.25); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); scaleBy(big ? 1.05 : 1.005); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); scaleBy(big ? 1/1.05 : 1/1.005); }
    else if (e.key === 'f') { e.preventDefault(); fitView(); }
    else if (e.key === 'r') { e.preventDefault(); resetFrame(); }
    else if (e.key === '[') { alphaEl.value = Math.max(0, alpha - 0.05); alphaEl.dispatchEvent(new Event('input')); }
    else if (e.key === ']') { alphaEl.value = Math.min(1, alpha + 0.05); alphaEl.dispatchEvent(new Event('input')); }
    else if (e.key === 'b') { blendEl.value = BLENDS[(BLENDS.indexOf(blendEl.value) + 1) % BLENDS.length]; draw(); }
    else if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  }, true);

  // ── controls ───────────────────────────────────────────────────────
  alphaEl.addEventListener('input', () => { alpha = parseFloat(alphaEl.value); draw(); });
  blendEl.addEventListener('change', draw);
  smoothEl.addEventListener('change', draw);
  frameEl.addEventListener('change', draw);
  $('.aa-fit').addEventListener('click', fitView);
  $('.aa-reset').addEventListener('click', resetFrame);
  $('.aa-save').addEventListener('click', save);

  function resetFrame() {
    A = A_INIT.map(r => r.slice()); t = T_INIT.slice(); dirty = true; draw();
    statusEl.textContent = 'Frame reset to initial placement (not saved).';
  }

  async function save() {
    statusEl.textContent = '💾 Saving…';
    try {
      const resp = await fetch(SRV, {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({action: 'save', A: A, t: t})});
      const j = await resp.json();
      if (j.ok) { dirty = false; draw(); statusEl.textContent = '✅ Saved → ' + j.file; }
      else statusEl.textContent = '⚠ Server error: ' + j.error;
    } catch (e) { statusEl.textContent = '⚠ Save failed: ' + e; }
  }

  // ── load images (lazily from the local server) ─────────────────────
  function loadImg(idx) {
    return new Promise((res, rej) => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => res(img); img.onerror = rej;
      img.src = SRV + '/image/' + idx;
    });
  }
  statusEl.textContent = 'Loading images…';
  Promise.all([loadImg(0), loadImg(1)]).then(([f, m]) => {
    im.fixed = f; im.moving = m;
    fitView();
    statusEl.textContent = LOADED
      ? 'Loaded saved alignment from ' + CSV_PATH + '. Adjust the frame and save again to overwrite.'
      : 'Drag the frame to align the moving image with the fixed one, then press Save affine.';
  }).catch(e => { statusEl.textContent = '⚠ Could not load images from the local server: ' + e; });
})();
</script>
"""
    )

    display(HTML(css + js))
    return {'csv': csv_path, 'inverse_csv': inv_path, 'state': json_path}

if __name__ == '__main__':

    s1 = prepSlideData(slide1path)
    s2 = prepSlideData(slide2path)

    alignAffine(s2['thumb'],
                s1['thumb'],
                fixed_scale=s2['scale'],
                moving_scale=s1['scale'],
                savepath='./.affine/',
                name=sample)
