import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs


class ViewerServer:
    """
    Tiny HTTP server running in a daemon thread.
    Routes:
      GET  /meta          → image metadata JSON
      GET  /tile?level=&row=&col=  → JPEG bytes
            GET  /xenium_meta   → transcript metadata JSON
            GET  /xenium_tile?grid=&level=&row=&col=&genes=  → transcript JSON
      POST /click         → {img_x, img_y, vp_x, vp_y, zoom}
            POST /strokes       → {strokes_positive:[...], strokes_negative:[...]}
    """

    def __init__(self, image, host=None, port=None, xenium=None):
        self.image   = image
        self.xenium  = xenium
        if host:
            self.host = host
        else:
            try:
                self.host = socket.gethostbyname(socket.gethostname())
            except socket.gaierror:
                self.host = '127.0.0.1'
        self.clicks  = []
        self.strokes = {
            'strokes_positive': [],
            'strokes_negative': [],
        }

        if port is None:
            with socket.socket() as s:
                s.bind(('', 0))
                port = s.getsockname()[1]
        self.port = port

        self._server = HTTPServer(('0.0.0.0', port), self._make_handler())
        self._server.handle_error = lambda *a: None  # silence broken pipe / connection reset
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._server.shutdown()

    @property
    def base_url(self):
        return f"http://{self.host}:{self.port}"

    # ── handler factory (closure over self) ───────────────────────────────────

    def _make_handler(self):
        srv = self

        class Handler(BaseHTTPRequestHandler):

            def do_OPTIONS(self):
                self._respond(204)

            def do_GET(self):
                parsed = urlparse(self.path)
                qs     = parse_qs(parsed.query)

                if parsed.path == '/meta':
                    body = json.dumps(srv.image.metadata).encode()
                    self._respond(200, body, 'application/json')

                elif parsed.path == '/xenium_meta':
                    if srv.xenium is None:
                        self._respond(404)
                    else:
                        body = json.dumps(srv.xenium.metadata).encode()
                        self._respond(200, body, 'application/json')

                elif parsed.path == '/tile':
                    try:
                        level = int(qs['level'][0])
                        row   = int(qs['row'][0])
                        col   = int(qs['col'][0])
                        data  = srv.image.get_tile(level, row, col)
                        self._respond(200, data, 'image/jpeg')
                    except Exception as e:
                        self._respond(400, str(e).encode())

                elif parsed.path == '/xenium_tile':
                    if srv.xenium is None:
                        self._respond(404)
                    else:
                        try:
                            grid = int(qs['grid'][0])
                            level = int(qs['level'][0])
                            row = int(qs['row'][0])
                            col = int(qs['col'][0])
                            genes = [gene for gene in qs.get('genes', [''])[0].split(',') if gene]
                            body = json.dumps({
                                'points': srv.xenium.get_tile_transcripts(grid, level, row, col, genes)
                            }).encode()
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
                    next_positive = []
                    next_negative = []
                    if isinstance(data, dict):
                        next_positive = list(data.get('strokes_positive', []))
                        next_negative = list(data.get('strokes_negative', []))
                    elif isinstance(data, list):
                        # Backward compatibility with legacy single-list payload.
                        next_positive = list(data)

                    srv.strokes['strokes_positive'].clear()
                    srv.strokes['strokes_positive'].extend(next_positive)
                    srv.strokes['strokes_negative'].clear()
                    srv.strokes['strokes_negative'].extend(next_negative)

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