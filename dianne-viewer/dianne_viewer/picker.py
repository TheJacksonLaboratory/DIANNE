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

import json, os, socket, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from IPython.display import display, HTML


def samplePicker(data: dict, target_var: str = 'samples'):
    """
    Dark, color-coded multi-select button grid for sample metadata `data`
    (keys like '110686' or 'HCI_023_PDXEv_Control_M4' -> dict with
    'Treatment', 'Drug', 'Timing', 'Origin', 'LabID', 'Institution').

    Every button represents one sample and can be toggled on/off. Buttons
    are grouped by Origin (tissue) and color-coded by Institution. Chip
    filters for Treatment / Origin / Institution let the user narrow down
    which buttons are visible (filtering never changes the underlying
    selection, only what's shown).

    On every click, the FULL current selection (list of sample keys) is
    pushed to the kernel and assigned to `target_var` in the notebook
    namespace -- so `samples` (or whatever target_var is) always reflects
    the live selection.

    Routes POSTs through JupyterHub's jupyter-server-proxy (/proxy/<port>)
    instead of a raw host:port URL, so it works behind cloud/hub proxies.
    """
    ip = get_ipython()
    uid = uuid.uuid4().hex[:8]

    keys = list(data.keys())

    def field_values(field):
        return sorted({str(v.get(field, 'N/A')) for v in data.values()})

    institutions = field_values('Institution')
    origins = field_values('Origin')
    treatments = field_values('Treatment')
    timings = field_values('Timing')

    palette = ['#e94560', '#4E9EE9', '#2ecc71', '#f1c40f', '#ab47bc',
               '#00acc1', '#ff7043', '#8892a4', '#7986cb', '#d4e157']
    inst_colors = {inst: palette[i % len(palette)] for i, inst in enumerate(institutions)}

    # ── tiny HTTP server: bridge from JS click -> kernel variable ───────────
    with socket.socket() as s:
        s.bind(('', 0)); port = s.getsockname()[1]

    class Handler(BaseHTTPRequestHandler):
        def do_OPTIONS(self): self._ok(b'')
        def do_POST(self):
            n = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(n))
            selected = payload.get('selected', [])
            ip.user_ns[target_var] = selected
            self._ok(json.dumps({'ok': True, 'count': len(selected)}).encode())
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

    threading.Thread(
        target=ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever, daemon=True
    ).start()

    # ── URL construction ─────────────────────────────────────────────────
    # Behind JupyterHub, route through jupyter-server-proxy (this path is
    # relative, so the browser resolves it against the page's own origin --
    # always reachable). Outside a hub, DON'T resolve a hostname/IP on the
    # Python side (that address is only meaningful inside the kernel's own
    # network namespace and is frequently unreachable from the browser over
    # SSH tunnels, port-forwards, VPNs, Docker, etc.). Instead, hand the
    # port to JS and let the browser build the URL from window.location --
    # i.e. whatever address the browser already used to load this page,
    # which is by definition reachable.
    service_prefix = os.environ.get('JUPYTERHUB_SERVICE_PREFIX', '')
    if service_prefix:
        api_url_literal = json.dumps(f"{service_prefix.rstrip('/')}/proxy/{port}")
    else:
        # built client-side; see bridgeUrl() in the script below
        api_url_literal = 'null'

    # initialize target_var so it exists even before any click
    ip.user_ns[target_var] = []

    # ── group samples by Origin for section headers ─────────────────────────
    by_origin = {}
    for k in keys:
        by_origin.setdefault(str(data[k].get('Origin', 'N/A')), []).append(k)

    def chip_row(label, field, values):
        chips = ''.join(
            f'<button class="filt-chip" data-field="{field}" data-value="{v}">{v}</button>'
            for v in values
        )
        return f'''<div class="filt-row">
            <span class="filt-label">{label}</span>
            <div class="filt-chips">{chips}</div>
        </div>'''

    def sample_button(k):
        m = data[k]
        inst = str(m.get('Institution', 'N/A'))
        color = inst_colors.get(inst, '#8892a4')
        drug = m.get('Drug', 'N/A')
        timing = m.get('Timing', 'N/A')
        treatment = m.get('Treatment', 'N/A')
        origin = m.get('Origin', 'N/A')
        return f'''<button class="s-btn" data-key="{k}"
              data-institution="{inst}" data-origin="{origin}"
              data-treatment="{treatment}" data-timing="{timing}"
              style="--c:{color};">
              <span class="s-key">{k}</span>
              <span class="s-drug">{drug}</span>
              <span class="s-meta">{treatment} · {timing}</span>
            </button>'''

    sections = ''.join(
        f'''<div class="origin-section" data-section-origin="{origin}">
              <div class="origin-header">{origin} <span class="origin-count">({len(sk)})</span></div>
              <div class="s-grid">{''.join(sample_button(k) for k in sk)}</div>
            </div>'''
        for origin, sk in sorted(by_origin.items())
    )

    legend = ''.join(
        f'<span class="legend-item"><span class="legend-swatch" style="background:{inst_colors[i]};"></span>{i}</span>'
        for i in institutions
    )

    display(HTML(f"""
<style>
  #sp-{uid} {{
    --bg:#1a1a2e; --accent2:#0f3460; --text:#eaeaea; --muted:#8892a4; --radius:8px;
    font-family:'JetBrains Mono','Fira Code','Consolas',monospace;
    background:var(--bg); color:var(--text); padding:16px; border-radius:10px;
    display:inline-block; max-width:1100px;
  }}
  #sp-{uid} .sp-header {{
    font-size:11px; letter-spacing:.12em; text-transform:uppercase;
    color:var(--muted); margin-bottom:10px; display:flex; justify-content:space-between; align-items:center;
  }}
  #sp-{uid} .sp-actions button {{
    font-family:inherit; font-size:10px; background:var(--accent2); color:var(--text);
    border:none; border-radius:6px; padding:5px 9px; cursor:pointer; margin-left:6px;
  }}
  #sp-{uid} .sp-actions button:hover {{ filter:brightness(1.25); }}

  #sp-{uid} .filt-row {{ display:flex; align-items:flex-start; gap:8px; margin-bottom:6px; }}
  #sp-{uid} .filt-label {{ font-size:10px; color:var(--muted); width:70px; flex-shrink:0; padding-top:5px; text-transform:uppercase; letter-spacing:.06em; }}
  #sp-{uid} .filt-chips {{ display:flex; flex-wrap:wrap; gap:5px; }}
  #sp-{uid} .filt-chip {{
    font-family:inherit; font-size:10.5px; background:var(--accent2); color:var(--muted);
    border:1px solid transparent; border-radius:12px; padding:4px 10px; cursor:pointer;
    transition:filter .15s;
  }}
  #sp-{uid} .filt-chip:hover {{ filter:brightness(1.3); }}
  #sp-{uid} .filt-chip.active {{ background:#e94560; color:#fff; }}

  #sp-{uid} .legend {{ display:flex; flex-wrap:wrap; gap:10px; margin:8px 0 14px 0; font-size:10px; color:var(--muted); }}
  #sp-{uid} .legend-item {{ display:flex; align-items:center; gap:4px; }}
  #sp-{uid} .legend-swatch {{ width:9px; height:9px; border-radius:2px; display:inline-block; }}

  #sp-{uid} .origin-section {{ margin-bottom:14px; }}
  #sp-{uid} .origin-header {{ font-size:12px; font-weight:700; color:var(--text); margin-bottom:6px; border-bottom:1px solid #2a2a45; padding-bottom:3px; }}
  #sp-{uid} .origin-count {{ color:var(--muted); font-weight:400; }}

  #sp-{uid} .s-grid {{ display:flex; flex-wrap:wrap; gap:7px; }}
  #sp-{uid} .s-btn {{
    font-family:inherit; background:var(--accent2); color:var(--text);
    border:none; border-left:4px solid var(--c); border-radius:var(--radius);
    padding:6px 9px; cursor:pointer; text-align:left; width:158px;
    display:flex; flex-direction:column; justify-content:center; gap:2px;
    transition:filter .15s, transform .1s; flex-shrink:0;
  }}
  #sp-{uid} .s-btn:hover  {{ filter:brightness(1.2); transform:translateY(-1px); }}
  #sp-{uid} .s-btn:active {{ filter:brightness(.9); transform:translateY(0); }}
  #sp-{uid} .s-btn.selected {{ outline:2px solid var(--c); box-shadow:0 0 8px var(--c); background:#20203a; }}
  #sp-{uid} .s-btn.filtered-out {{ display:none; }}
  #sp-{uid} .s-key  {{ font-size:11px; font-weight:700; word-break:break-all; }}
  #sp-{uid} .s-drug {{ font-size:10px; color:var(--text); opacity:.85; word-break:break-word; }}
  #sp-{uid} .s-meta {{ font-size:9.5px; color:var(--muted); }}

  #sp-{uid} .sp-status {{ margin-top:12px; font-size:11px; color:var(--muted); min-height:14px; border-top:1px solid #2a2a45; padding-top:8px; }}
  #sp-{uid} .sp-status b {{ color:var(--text); }}
</style>
<div id="sp-{uid}">
  <div class="sp-header">
    Select samples
    <span class="sp-actions">
      <button data-action="select-visible">Select all visible</button>
      <button data-action="clear">Clear selection</button>
      <button data-action="reset-filters">Reset filters</button>
    </span>
  </div>

  {chip_row('Treatment', 'treatment', treatments)}
  {chip_row('Origin', 'origin', origins)}
  {chip_row('Institution', 'institution', institutions)}
  {chip_row('Timing', 'timing', timings)}

  <div class="legend">{legend}</div>

  {sections}

  <div class="sp-status">Selected: <b class="sp-count">0</b> / {len(keys)}</div>
</div>
<script>
(function() {{
  const root = document.getElementById('sp-{uid}');
  const statusCount = root.querySelector('.sp-count');
  const selected = new Set();

  // active filter values per field, e.g. {{treatment: Set(...), origin: Set(...)}}
  const activeFilters = {{ treatment: new Set(), origin: new Set(), institution: new Set(), timing: new Set() }};

  // If behind JupyterHub, the server gave us a relative /proxy/<port> path
  // (resolves against this page's own origin -- always reachable). Otherwise
  // build the URL from window.location: the browser's own address/protocol
  // paired with the bridge server's port. This is the address the browser
  // used to load the notebook itself, so it's guaranteed reachable, unlike
  // any hostname/IP the Python kernel might guess at on its own side.
  const HUB_URL = {api_url_literal};
  const PORT = {port};
  function bridgeUrl() {{
    if (HUB_URL) return HUB_URL;
    return window.location.protocol + '//' + window.location.hostname + ':' + PORT;
  }}

  function applyFilters() {{
    root.querySelectorAll('.s-btn').forEach(btn => {{
      let visible = true;
      for (const field of Object.keys(activeFilters)) {{
        const active = activeFilters[field];
        if (active.size > 0 && !active.has(btn.dataset[field])) {{
          visible = false;
          break;
        }}
      }}
      btn.classList.toggle('filtered-out', !visible);
    }});
    root.querySelectorAll('.origin-section').forEach(sec => {{
      const anyVisible = sec.querySelector('.s-btn:not(.filtered-out)');
      sec.style.display = anyVisible ? '' : 'none';
    }});
  }}

  root.querySelectorAll('.filt-chip').forEach(chip => {{
    chip.addEventListener('click', () => {{
      const field = chip.dataset.field;
      const value = chip.dataset.value;
      if (activeFilters[field].has(value)) {{
        activeFilters[field].delete(value);
        chip.classList.remove('active');
      }} else {{
        activeFilters[field].add(value);
        chip.classList.add('active');
      }}
      applyFilters();
    }});
  }});

  async function pushSelection() {{
    statusCount.textContent = selected.size;
    const url = bridgeUrl();
    try {{
      const resp = await fetch(url, {{
        method: 'POST',
        headers: {{'Content-Type': 'application/json'}},
        body: JSON.stringify({{selected: Array.from(selected)}})
      }});
      if (!resp.ok) throw new Error('server responded ' + resp.status);
      root.querySelector('.sp-status').innerHTML =
        'Selected: <b class="sp-count">' + selected.size + '</b> / {len(keys)}';
    }} catch (e) {{
      root.querySelector('.sp-status').innerHTML =
        'Selected: <b class="sp-count">' + selected.size + '</b> / {len(keys)} ' +
        '&nbsp;⚠ could not reach ' + url + ' (' + e + '). ' +
        'The selection is tracked in this tab but not yet pushed to the kernel -- ' +
        'try again, or check that port {port} is reachable from your browser.';
    }}
  }}

  root.querySelectorAll('.s-btn').forEach(btn => {{
    btn.addEventListener('click', () => {{
      const key = btn.dataset.key;
      if (selected.has(key)) {{
        selected.delete(key);
        btn.classList.remove('selected');
      }} else {{
        selected.add(key);
        btn.classList.add('selected');
      }}
      pushSelection();
    }});
  }});

  root.querySelector('[data-action="select-visible"]').addEventListener('click', () => {{
    root.querySelectorAll('.s-btn:not(.filtered-out)').forEach(btn => {{
      selected.add(btn.dataset.key);
      btn.classList.add('selected');
    }});
    pushSelection();
  }});

  root.querySelector('[data-action="clear"]').addEventListener('click', () => {{
    selected.clear();
    root.querySelectorAll('.s-btn.selected').forEach(btn => btn.classList.remove('selected'));
    pushSelection();
  }});

  root.querySelector('[data-action="reset-filters"]').addEventListener('click', () => {{
    Object.values(activeFilters).forEach(s => s.clear());
    root.querySelectorAll('.filt-chip.active').forEach(c => c.classList.remove('active'));
    applyFilters();
  }});
}})();
</script>
"""))