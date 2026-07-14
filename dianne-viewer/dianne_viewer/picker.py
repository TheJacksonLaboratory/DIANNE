import json, os, socket, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from IPython.display import display, HTML

def datasetPicker(data: dict, target_var: str = 'ds'):
    """
    Dark, color-coded, value-sized button grid for `data` (keys like
    'results.GROUP.Dataset_name' -> sample count). Clicking a button sets
    `target_var` in the notebook namespace. Routes POSTs through
    JupyterHub's jupyter-server-proxy (/proxy/<port>) instead of a raw
    host:port URL, so it works behind cloud/hub proxies.
    """
    ip = get_ipython()
    uid = uuid.uuid4().hex[:8]

    groups = sorted({k.split('.')[1] if len(k.split('.')) > 1 else 'Other' for k in data})
    palette = ['#e94560', '#4E9EE9', '#2ecc71', '#f1c40f', '#ab47bc', '#00acc1', '#ff7043', '#8892a4']
    colors = {g: palette[i % len(palette)] for i, g in enumerate(groups)}

    vmin, vmax = min(data.values()), max(data.values())
    W_MIN, W_MAX = 130, 300
    H_MIN, H_MAX = 56, 200

    def scale(v):
        t = 1.0 if vmax == vmin else (v ** 0.5 - vmin ** 0.5) / (vmax ** 0.5 - vmin ** 0.5)
        return round(W_MIN + t * (W_MAX - W_MIN)), round(H_MIN + t * (H_MAX - H_MIN))

    # ── tiny HTTP server: bridge from JS click -> kernel variable ───────────
    with socket.socket() as s:
        s.bind(('', 0)); port = s.getsockname()[1]

    class Handler(BaseHTTPRequestHandler):
        def do_OPTIONS(self): self._ok(b'')
        def do_POST(self):
            n = int(self.headers.get('Content-Length', 0))
            key = json.loads(self.rfile.read(n))['key']
            ip.user_ns[target_var] = key
            self._ok(json.dumps({'ok': True}).encode())
        def _ok(self, body):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.end_headers()
            if body: self.wfile.write(body)
        def log_message(self, *a): pass

    # Bind to all interfaces (matches ViewerServer's approach); JupyterHub's
    # proxy talks to it over localhost regardless of the machine's real IP.
    threading.Thread(
        target=ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever, daemon=True
    ).start()

    # ── URL construction: same trick as ViewerServer.base_url ───────────────
    service_prefix = os.environ.get('JUPYTERHUB_SERVICE_PREFIX', '')
    if service_prefix:
        api_url = f"{service_prefix.rstrip('/')}/proxy/{port}"
    else:
        try:
            host = socket.gethostbyname(socket.gethostname())
        except socket.gaierror:
            host = '127.0.0.1'
        api_url = f"http://{host}:{port}"

    def parts(key):
        p = key.split('.')
        group = p[1] if len(p) > 1 else ''
        name = p[2].replace('Dataset_', '').replace('_', ' ') if len(p) > 2 else key
        return group, name

    buttons = ''.join(
        f'''<button class="ds-btn" data-key="{k}"
              style="--c:{colors.get(parts(k)[0], '#8892a4')}; width:{scale(v)[0]}px; height:{scale(v)[1]}px;">
              <span class="ds-group">{parts(k)[0]}</span>
              <span class="ds-name">{parts(k)[1]}</span>
              <span class="ds-count">{v} samples</span>
            </button>'''
        for k, v in data.items()
    )

    display(HTML(f"""
<style>
  #dsp-{uid} {{
    --bg:#1a1a2e; --accent2:#0f3460; --text:#eaeaea; --muted:#8892a4; --radius:8px;
    font-family:'JetBrains Mono','Fira Code','Consolas',monospace;
    background:var(--bg); color:var(--text); padding:16px; border-radius:10px;
    display:inline-block; max-width:1000px;
  }}
  #dsp-{uid} .dsp-header {{
    font-size:11px; letter-spacing:.12em; text-transform:uppercase;
    color:var(--muted); margin-bottom:10px;
  }}
  #dsp-{uid} .dsp-grid {{
    display:flex; flex-wrap:wrap; align-items:flex-start; gap:8px;
  }}
  #dsp-{uid} .ds-btn {{
    font-family:inherit; background:var(--accent2); color:var(--text);
    border:none; border-left:4px solid var(--c); border-radius:var(--radius);
    padding:8px 10px; cursor:pointer; text-align:left;
    display:flex; flex-direction:column; justify-content:center; gap:2px;
    transition:filter .15s, transform .1s;
    flex-shrink:0;
  }}
  #dsp-{uid} .ds-btn:hover  {{ filter:brightness(1.2); transform:translateY(-1px); }}
  #dsp-{uid} .ds-btn:active {{ filter:brightness(.9); transform:translateY(0); }}
  #dsp-{uid} .ds-btn.selected {{ outline:2px solid var(--c); box-shadow:0 0 8px var(--c); }}
  #dsp-{uid} .ds-group {{ font-size:10px; font-weight:700; color:var(--c); letter-spacing:.06em; text-transform:uppercase; }}
  #dsp-{uid} .ds-name  {{ font-size:12px; line-height:1.25em; }}
  #dsp-{uid} .ds-count {{ font-size:10px; color:var(--muted); }}
  #dsp-{uid} .dsp-status {{ margin-top:10px; font-size:11px; color:var(--muted); min-height:14px; }}
</style>
<div id="dsp-{uid}">
  <div class="dsp-header">Select dataset</div>
  <div class="dsp-grid">{buttons}</div>
  <div class="dsp-status">Click a button to assign {target_var}.</div>
</div>
<script>
(function() {{
  const root   = document.getElementById('dsp-{uid}');
  const status = root.querySelector('.dsp-status');
  root.querySelectorAll('.ds-btn').forEach(btn => {{
    btn.addEventListener('click', async () => {{
      const key = btn.dataset.key;
      root.querySelectorAll('.ds-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      status.textContent = 'Assigning…';
      try {{
        await fetch('{api_url}', {{
          method: 'POST',
          headers: {{'Content-Type': 'application/json'}},
          body: JSON.stringify({{key}})
        }});
        status.textContent = key;
      }} catch (e) {{
        status.textContent = '⚠ ' + e;
      }}
    }});
  }});
}})();
</script>
"""))
