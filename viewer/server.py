import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs


class ViewerServer:
    """
    Tiny HTTP server running in a daemon thread.
    Routes:
      GET  /meta          → image metadata JSON
      GET  /tile?level=&row=&col=  → JPEG bytes
            GET  /xenium_meta   → transcript metadata JSON
            GET  /xenium_tile?grid=&level=&row=&col=&genes=  → transcript JSON
            GET  /xenium_cells?level=&row=&col=  → cells JSON
      POST /click         → {img_x, img_y, vp_x, vp_y, zoom}
            POST /strokes       → {strokes_positive:[...], strokes_negative:[...]}
    """

    def __init__(self, image=None, images=None, chosen_sample=None, host=None, port=None,
                 xenium=None, xenium_cells=None, xenium_by_sample=None, xenium_cells_by_sample=None,
                 run_inference_fn=None, sample_sizes=None,
                 save_fn=None, load_fn=None, list_names_fn=None):
        if images is None:
            if image is None:
                raise ValueError('ViewerServer requires image or images')
            default_name = str(chosen_sample) if chosen_sample is not None else 'default'
            images = {default_name: image}

        self.images = dict(images)
        if not self.images:
            raise ValueError('ViewerServer requires at least one sample image')

        if chosen_sample is None:
            self.chosen_sample = next(iter(self.images.keys()))
        else:
            self.chosen_sample = str(chosen_sample)
            if self.chosen_sample not in self.images:
                raise ValueError(f"unknown chosen_sample '{self.chosen_sample}'")

        self.image   = self.images[self.chosen_sample]

        # Backward compatibility: allow either a single xenium object or per-sample maps.
        self.xenium_by_sample = {str(k): v for k, v in (xenium_by_sample or {}).items()}
        self.xenium_cells_by_sample = {str(k): v for k, v in (xenium_cells_by_sample or {}).items()}
        if xenium is not None and not self.xenium_by_sample:
            for sample in self.images.keys():
                self.xenium_by_sample[sample] = xenium
        if xenium_cells is not None and not self.xenium_cells_by_sample:
            for sample in self.images.keys():
                self.xenium_cells_by_sample[sample] = xenium_cells

        self.xenium = self.xenium_by_sample.get(self.chosen_sample)
        self.xenium_cells = self.xenium_cells_by_sample.get(self.chosen_sample)
        if host:
            self.host = host
        else:
            try:
                self.host = socket.gethostbyname(socket.gethostname())
            except socket.gaierror:
                self.host = '127.0.0.1'
        self.run_inference_fn = run_inference_fn
        self.sample_sizes = dict(sample_sizes) if sample_sizes else {}
        self._inference_lock = threading.Lock()
        self._inference_running = False
        self.save_fn       = save_fn
        self.load_fn       = load_fn
        self.list_names_fn = list_names_fn

        self.clicks  = []
        self.strokes_by_sample = {
            sample: {'strokes_positive': [], 'strokes_negative': []}
            for sample in self.images.keys()
        }

        if port is None:
            with socket.socket() as s:
                s.bind(('', 0))
                port = s.getsockname()[1]
        self.port = port

        self._server = ThreadingHTTPServer(('0.0.0.0', port), self._make_handler())
        self._server.handle_error = lambda *a: None  # silence broken pipe / connection reset
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._server.shutdown()

    @property
    def base_url(self):
        return f"http://{self.host}:{self.port}"

    @property
    def strokes(self):
        """Backward-compat property: return strokes for current sample."""
        return self.strokes_by_sample.get(self.chosen_sample, {'strokes_positive': [], 'strokes_negative': []})

    def set_sample(self, sample):
        sample_name = str(sample)
        if sample_name not in self.images:
            raise KeyError(sample_name)
        self.chosen_sample = sample_name
        self.image = self.images[sample_name]
        self.xenium = self.xenium_by_sample.get(sample_name)
        self.xenium_cells = self.xenium_cells_by_sample.get(sample_name)

    def _sample_from_qs(self, qs):
        requested = qs.get('sample', [self.chosen_sample])[0]
        return str(requested)

    # ── handler factory (closure over self) ───────────────────────────────────

    def _make_handler(self):
        srv = self

        class Handler(BaseHTTPRequestHandler):

            def do_OPTIONS(self):
                self._respond(204)

            def do_GET(self):
                parsed = urlparse(self.path)
                qs     = parse_qs(parsed.query)
                sample_name = srv._sample_from_qs(qs)
                image = srv.images.get(sample_name)

                if image is None and parsed.path in ('/meta', '/tile'):
                    self._respond(404, b'unknown sample')
                    return

                if parsed.path == '/meta':
                    body = json.dumps(image.metadata).encode()
                    self._respond(200, body, 'application/json')

                elif parsed.path == '/samples':
                    body = json.dumps({
                        'chosen_sample': srv.chosen_sample,
                        'samples': list(srv.images.keys()),
                    }).encode()
                    self._respond(200, body, 'application/json')

                elif parsed.path == '/xenium_meta':
                    xenium = srv.xenium_by_sample.get(sample_name)
                    if xenium is None:
                        self._respond(404)
                    else:
                        body = json.dumps(xenium.metadata).encode()
                        self._respond(200, body, 'application/json')

                elif parsed.path == '/xenium_cells_meta':
                    xenium_cells = srv.xenium_cells_by_sample.get(sample_name)
                    if xenium_cells is None:
                        self._respond(404)
                    else:
                        body = json.dumps(xenium_cells.metadata).encode()
                        self._respond(200, body, 'application/json')

                elif parsed.path == '/tile':
                    try:
                        level = int(qs['level'][0])
                        row   = int(qs['row'][0])
                        col   = int(qs['col'][0])
                        data  = image.get_tile(level, row, col)
                        self._respond(200, data, 'image/jpeg')
                    except Exception as e:
                        self._respond(400, str(e).encode())

                elif parsed.path == '/thumb':
                    try:
                        level = int(qs.get('level', [str(image.n_levels - 1)])[0])
                        size = int(qs.get('size', ['256'])[0])
                        data = image.get_level_thumbnail(level, size=size)
                        self._respond(200, data, 'image/jpeg')
                    except Exception as e:
                        self._respond(400, str(e).encode())

                elif parsed.path == '/xenium_tile':
                    xenium = srv.xenium_by_sample.get(sample_name)
                    if xenium is None:
                        self._respond(404)
                    else:
                        try:
                            grid = int(qs['grid'][0])
                            level = int(qs['level'][0])
                            row = int(qs['row'][0])
                            col = int(qs['col'][0])
                            genes = [gene for gene in qs.get('genes', [''])[0].split(',') if gene]
                            body = json.dumps({
                                'points': xenium.get_tile_transcripts(grid, level, row, col, genes)
                            }).encode()
                            self._respond(200, body, 'application/json')
                        except Exception as e:
                            self._respond(400, str(e).encode())

                elif parsed.path == '/xenium_cells':
                    xenium_cells = srv.xenium_cells_by_sample.get(sample_name)
                    if xenium_cells is None:
                        self._respond(404)
                    else:
                        try:
                            level = int(qs['level'][0])
                            row = int(qs['row'][0])
                            col = int(qs['col'][0])
                            body = json.dumps({
                                'cells': xenium_cells.get_tile_cells(level, row, col)
                            }).encode()
                            self._respond(200, body, 'application/json')
                        except Exception as e:
                            self._respond(400, str(e).encode())
                elif parsed.path == '/classifier_names':
                    if srv.list_names_fn is None:
                        body = json.dumps([]).encode()
                    else:
                        try:
                            names = list(srv.list_names_fn())
                            body  = json.dumps(names).encode()
                        except Exception as exc:
                            body = json.dumps({'error': str(exc)}).encode()
                    self._respond(200, body, 'application/json')

                else:
                    self._respond(404)

            def do_POST(self):
                n    = int(self.headers.get('Content-Length', 0))
                body = self.rfile.read(n)
                parsed = urlparse(self.path)

                try:
                    data = json.loads(body)
                except Exception:
                    self._respond(400, b'bad json')
                    return

                if parsed.path == '/click':
                    next_clicks = []
                    if isinstance(data, dict) and isinstance(data.get('clicks'), list):
                        next_clicks = data.get('clicks', [])
                    elif isinstance(data, list):
                        next_clicks = data
                    elif isinstance(data, dict):
                        next_clicks = [data]

                    srv.clicks.clear()
                    srv.clicks.extend(next_clicks)

                elif parsed.path == '/strokes':
                    if isinstance(data, dict) and 'by_sample' in data:
                        # New format: strokes organized by sample
                        by_sample = data.get('by_sample', {})
                        for sample, sample_strokes_data in by_sample.items():
                            if sample in srv.strokes_by_sample:
                                pos = list(sample_strokes_data.get('strokes_positive', []))
                                neg = list(sample_strokes_data.get('strokes_negative', []))
                                srv.strokes_by_sample[sample]['strokes_positive'] = pos
                                srv.strokes_by_sample[sample]['strokes_negative'] = neg
                    else:
                        # Legacy format: single sample strokes
                        next_positive = []
                        next_negative = []
                        if isinstance(data, dict):
                            next_positive = list(data.get('strokes_positive', []))
                            next_negative = list(data.get('strokes_negative', []))
                        elif isinstance(data, list):
                            # Backward compatibility with legacy single-list payload.
                            next_positive = list(data)

                        sample_strokes = srv.strokes_by_sample.get(srv.chosen_sample)
                        if sample_strokes:
                            sample_strokes['strokes_positive'].clear()
                            sample_strokes['strokes_positive'].extend(next_positive)
                            sample_strokes['strokes_negative'].clear()
                            sample_strokes['strokes_negative'].extend(next_negative)

                elif parsed.path == '/choose_sample':
                    sample = data.get('sample') if isinstance(data, dict) else None
                    if sample is None:
                        self._respond(400, b'missing sample')
                        return
                    try:
                        srv.set_sample(sample)
                    except KeyError:
                        self._respond(404, b'unknown sample')
                        return

                elif parsed.path == '/save_classifier':
                    name = data.get('name', '').strip() if isinstance(data, dict) else ''
                    if not name:
                        body = json.dumps({'ok': False, 'error': 'missing name'}).encode()
                        self._respond(200, body, 'application/json')
                        return
                    if srv.save_fn is None:
                        body = json.dumps({'ok': False, 'error': 'save not configured'}).encode()
                        self._respond(200, body, 'application/json')
                        return
                    try:
                        srv.save_fn(name)
                        body = json.dumps({'ok': True}).encode()
                    except Exception as exc:
                        import traceback; traceback.print_exc()
                        body = json.dumps({'ok': False, 'error': str(exc)}).encode()
                    self._respond(200, body, 'application/json')
                    return

                elif parsed.path == '/load_classifier':
                    name = data.get('name', '').strip() if isinstance(data, dict) else ''
                    if not name:
                        body = json.dumps({'ok': False, 'error': 'missing name'}).encode()
                        self._respond(200, body, 'application/json')
                        return
                    if srv.load_fn is None:
                        body = json.dumps({'ok': False, 'error': 'load not configured'}).encode()
                        self._respond(200, body, 'application/json')
                        return
                    try:
                        srv.load_fn(name)
                        body = json.dumps({'ok': True}).encode()
                    except Exception as exc:
                        import traceback; traceback.print_exc()
                        body = json.dumps({'ok': False, 'error': str(exc)}).encode()
                    self._respond(200, body, 'application/json')
                    return

                elif parsed.path == '/run_inference':
                    if srv.run_inference_fn is None:
                        body = json.dumps({'ok': False, 'error': 'run_inference not configured'}).encode()
                        self._respond(200, body, 'application/json')
                        return
                    active_sample = (
                        data.get('active_sample', srv.chosen_sample)
                        if isinstance(data, dict) else srv.chosen_sample
                    )
                    with srv._inference_lock:
                        if srv._inference_running:
                            body = json.dumps({'ok': False, 'error': 'inference already running'}).encode()
                            self._respond(200, body, 'application/json')
                            return
                        srv._inference_running = True
                    try:
                        result = srv.run_inference_fn(
                            strokes_by_sample=srv.strokes_by_sample,
                            active_sample=active_sample,
                        )
                        if not isinstance(result, dict):
                            raise ValueError('run_inference_fn must return a dict')
                        sample_out = result.get('sample', active_sample)
                        xi = [float(v) for v in result['xi']]
                        yi = [float(v) for v in result['yi']]
                        pi = [float(v) for v in result['pi']]
                        style = {
                            'delta':     float(result.get('delta', 448)),
                            'alpha':     float(result.get('alpha', 0.5)),
                            'colorLow':  str(result.get('color_low',  '#FFA500')),
                            'colorHigh': str(result.get('color_high', '#0000FF')),
                        }
                        payload = {'ok': True, 'sample': sample_out,
                                   'overlay': {'xi': xi, 'yi': yi, 'pi': pi, 'style': style}}
                        body = json.dumps(payload).encode()
                        self._respond(200, body, 'application/json')
                    except Exception as exc:
                        import traceback
                        traceback.print_exc()
                        body = json.dumps({'ok': False, 'error': str(exc)}).encode()
                        self._respond(200, body, 'application/json')
                    finally:
                        with srv._inference_lock:
                            srv._inference_running = False
                    return

                self._respond(200, b'ok')

            # ── helpers ───────────────────────────────────────────────────────

            def _respond(self, status, body=b'', content_type='text/plain'):
                self.send_response(status)
                self.send_header('Content-Type',                  content_type)
                self.send_header('Access-Control-Allow-Origin',   '*')
                self.send_header('Access-Control-Allow-Methods',  'GET, POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers',  'Content-Type')
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def log_message(self, *a):
                pass

            def handle_error(self, request, client_address):
                pass  # silence ConnectionResetError / BrokenPipeError from aborted tile fetches

        return Handler