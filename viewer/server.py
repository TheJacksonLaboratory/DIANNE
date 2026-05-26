import json
import queue
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import multiprocessing


class _ViewerHTTPServer(ThreadingHTTPServer):
    # A larger accept backlog avoids short request bursts getting stuck in
    # browser-pending state when many tiles/thumbnails are requested at once.
    request_queue_size = 128
    daemon_threads = True

# Prefer the 'spawn' start method to avoid forking from non-main threads.
# Forking from a non-main thread can leave Intel TBB in an invalid state and
# cause Numba/TBB errors like: "Attempted to fork from a non-main thread...".
# force=True overrides any prior setting (e.g. Jupyter's default 'fork').
try:
    if multiprocessing.get_start_method(allow_none=True) != 'spawn':
        multiprocessing.set_start_method('spawn', force=True)
except Exception:
    pass


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
                 save_fn=None, load_fn=None, list_names_fn=None,
                 secondary_images=None):
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
        self.sample_sizes = {
            str(k): int(v)
            for k, v in sample_sizes.items()
            if v is not None
        } if sample_sizes else {}
        # ── dedicated inference worker thread ─────────────────────────────────
        # Numba / Intel TBB must always be called from the same thread to avoid
        # "Attempted to fork from a non-main thread" warnings.  A single worker
        # thread is created here (before the HTTP server starts) and all
        # /run_inference requests are serialised through it via a queue.
        self._inference_queue = queue.Queue(maxsize=1)
        self._inference_worker = threading.Thread(
            target=self._inference_loop, daemon=True, name='dianne-inference-worker'
        )
        self._inference_worker.start()
        self.save_fn           = save_fn
        self.load_fn           = load_fn
        self.list_names_fn     = list_names_fn
        self.secondary_images  = {str(k): v for k, v in (secondary_images or {}).items()}

        self.clicks  = []
        self.strokes_by_sample = {
            sample: {'strokes_positive': [], 'strokes_negative': []}
            for sample in self.images.keys()
        }
        self._annotation_layers_json = '[]'
        self._tile_coords_fn  = None   # callable(sample) -> {'x': [...], 'y': [...]}
        self._tile_size       = None   # int, secondary-space pixels
        self._visium_ads      = {}     # dict[sample] -> AnnData (spots × genes)

        if port is None:
            with socket.socket() as s:
                s.bind(('', 0))
                port = s.getsockname()[1]
        self.port = port

        self._server = _ViewerHTTPServer(('0.0.0.0', port), self._make_handler())
        self._server.handle_error = lambda *a: None  # silence broken pipe / connection reset
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._stopped = False  # set True as soon as /stop is received or stop() is called

    def _inference_loop(self):
        """Long-lived worker: picks up (fn_kwargs, result_event, result_box) tuples."""
        while True:
            item = self._inference_queue.get()
            if item is None:   # sentinel → shut down
                break
            fn_kwargs, result_event, result_box = item
            try:
                result_box['result'] = self.run_inference_fn(**fn_kwargs)
            except Exception as exc:
                result_box['error'] = exc
            finally:
                result_event.set()

    def start(self):
        self._thread.start()

    def stop(self):
        self._stopped = True
        self._inference_queue.put(None)   # stop worker
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
            protocol_version = 'HTTP/1.1'

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

                elif parsed.path == '/stop':
                    srv._stopped = True  # signal immediately so _has_active_viewer sees it
                    self._respond(200, b'{}', 'application/json')
                    threading.Thread(target=srv.stop, daemon=True).start()

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
                        level   = int(qs['level'][0])
                        row     = int(qs['row'][0])
                        col     = int(qs['col'][0])
                        quality = max(1, min(95, int(qs.get('quality', ['85'])[0])))
                        # MonochannelImage does not use JPEG quality — call without kwarg
                        if hasattr(image, 'dtype_kind'):
                            data = image.get_tile(level, row, col)
                        else:
                            data = image.get_tile(level, row, col, quality=quality)
                        self._respond(200, data, 'image/jpeg' if not hasattr(image, 'dtype_kind') else 'image/png')
                    except Exception as e:
                        self._respond(400, str(e).encode())

                elif parsed.path == '/channel_tile':
                    try:
                        channel = int(qs['channel'][0])
                        level   = int(qs['level'][0])
                        row     = int(qs['row'][0])
                        col     = int(qs['col'][0])
                        data    = image.get_channel_tile(channel, level, row, col)
                        self._respond(200, data, 'image/png')
                    except Exception as e:
                        self._respond(400, str(e).encode())

                elif parsed.path == '/thumb':
                    try:
                        ready = getattr(image, '_thumb_ready', None)
                        if ready is not None:
                            ready.wait(timeout=120)
                        data = image.thumb
                        if data is None:
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
                elif parsed.path == '/tile_coords':
                    fn = srv._tile_coords_fn
                    if fn is None:
                        self._respond(404, b'no tile_coords_fn')
                    else:
                        try:
                            result = fn(sample_name)
                            xs = result.get('x', [])
                            ys = result.get('y', [])
                            if hasattr(xs, 'tolist'): xs = xs.tolist()
                            if hasattr(ys, 'tolist'): ys = ys.tolist()
                            body = json.dumps({'x': xs, 'y': ys}).encode()
                            self._respond(200, body, 'application/json')
                        except Exception as e:
                            self._respond(500, str(e).encode())

                elif parsed.path == '/visium_genes':
                    ad = srv._visium_ads.get(sample_name)
                    gene = qs.get('gene', [None])[0]
                    if ad is None or gene is None:
                        self._respond(404, b'no visium data for sample or gene missing')
                    elif gene not in ad.var_names:
                        self._respond(404, ('gene not found: ' + gene).encode())
                    else:
                        try:
                            import numpy as _np
                            xs  = ad.obs['x'].values.tolist()
                            ys  = ad.obs['y'].values.tolist()
                            col = ad[:, gene].X
                            if hasattr(col, 'toarray'):
                                col = col.toarray().ravel()
                            else:
                                col = _np.asarray(col).ravel()
                            body = json.dumps({
                                'x':         xs,
                                'y':         ys,
                                'values':    col.tolist(),
                                'spot_size': float(ad.uns.get('spot_size', 100)),
                            }).encode()
                            self._respond(200, body, 'application/json')
                        except Exception as e:
                            self._respond(500, str(e).encode())

                elif parsed.path == '/annotation_layers':
                    body = srv._annotation_layers_json.encode()
                    self._respond(200, body, 'application/json')

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

                elif parsed.path == '/secondary_tile':
                    sec_image = srv.secondary_images.get(sample_name)
                    if sec_image is None:
                        self._respond(404)
                    else:
                        try:
                            level   = int(qs['level'][0])
                            row     = int(qs['row'][0])
                            col     = int(qs['col'][0])
                            quality = max(1, min(95, int(qs.get('quality', ['85'])[0])))
                            if hasattr(sec_image, 'n_channels'):
                                data = sec_image.get_rgb_tile(level, row, col, quality=quality)
                            else:
                                data = sec_image.get_tile(level, row, col, quality=quality)
                            self._respond(200, data, 'image/jpeg')
                        except Exception as e:
                            self._respond(400, str(e).encode())

                elif parsed.path == '/secondary_channel_tile':
                    sec_image = srv.secondary_images.get(sample_name)
                    if sec_image is None or not hasattr(sec_image, 'n_channels'):
                        self._respond(404)
                    else:
                        try:
                            channel = int(qs['channel'][0])
                            level   = int(qs['level'][0])
                            row     = int(qs['row'][0])
                            col     = int(qs['col'][0])
                            data    = sec_image.get_channel_tile(channel, level, row, col)
                            self._respond(200, data, 'image/png')
                        except Exception as e:
                            self._respond(400, str(e).encode())

                elif parsed.path == '/mono_tile':
                    # Single-channel greyscale PNG tile — use the requested sample's image
                    _mono_img = srv.images.get(sample_name)
                    if _mono_img is None or not hasattr(_mono_img, 'dtype_kind'):
                        self._respond(404, b'not a monochannel image')
                    else:
                        try:
                            level = int(qs['level'][0])
                            row   = int(qs['row'][0])
                            col   = int(qs['col'][0])
                            data  = _mono_img.get_tile(level, row, col)
                            self._respond(200, data, 'image/png')
                        except Exception as e:
                            self._respond(400, str(e).encode())

                elif parsed.path == '/mono_lut':
                    # 256-entry RGBA LUT — sample-agnostic; find any MonochannelImage
                    _mono_img = next(
                        (img for img in srv.images.values() if hasattr(img, 'get_lut')),
                        None
                    )
                    if _mono_img is None:
                        self._respond(404, b'no monochannel image available')
                    else:
                        try:
                            cmap_name = qs.get('cmap', ['viridis'])[0]
                            lut = _mono_img.get_lut(cmap_name)
                            body = json.dumps({'lut': lut}).encode()
                            self._respond(200, body, 'application/json')
                        except Exception as e:
                            self._respond(400, str(e).encode())

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
                        srv.save_fn(strokes_by_sample=srv.strokes_by_sample, clfname=name)
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
                        result = srv.load_fn(clfname=name)
                        # load_fn may return (drawings, clf) or just clf
                        if isinstance(result, tuple) and len(result) == 2:
                            drawings, _clf = result
                        else:
                            drawings = None
                        if drawings and isinstance(drawings, dict):
                            for sample, sample_strokes in drawings.items():
                                if sample in srv.strokes_by_sample and isinstance(sample_strokes, dict):
                                    srv.strokes_by_sample[sample]['strokes_positive'] = list(sample_strokes.get('strokes_positive', []))
                                    srv.strokes_by_sample[sample]['strokes_negative'] = list(sample_strokes.get('strokes_negative', []))
                        body = json.dumps({'ok': True, 'strokes_by_sample': drawings or {}}).encode()
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
                    # Submit to the dedicated inference worker thread so that
                    # Numba/TBB always runs in the same persistent thread.
                    result_event = threading.Event()
                    result_box   = {}
                    try:
                        srv._inference_queue.put_nowait((
                            {'strokes_by_sample': srv.strokes_by_sample,
                             'active_sample': active_sample},
                            result_event,
                            result_box,
                        ))
                    except queue.Full:
                        body = json.dumps({'ok': False, 'error': 'inference already running'}).encode()
                        self._respond(200, body, 'application/json')
                        return
                    result_event.wait()  # block HTTP handler thread until done
                    if 'error' in result_box:
                        import traceback as _tb
                        _tb.print_exc()
                        body = json.dumps({'ok': False, 'error': str(result_box['error'])}).encode()
                        self._respond(200, body, 'application/json')
                        return
                    try:
                        result = result_box['result']
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
                    return

                self._respond(200, b'ok')

            # ── helpers ───────────────────────────────────────────────────────

            def _respond(self, status, body=b'', content_type='text/plain'):
                self.send_response(status)
                self.send_header('Content-Type',                  content_type)
                self.send_header('Content-Length',                str(len(body)))
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