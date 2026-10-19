"""Serveur local des pages de test. /img génère une image PNG après un délai
(simule un réseau lent pour éprouver le chargement différé).
Usage : python3 tests/serve.py [port]"""

import io
import sys
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageDraw

PAGES = Path(__file__).resolve().parent / "pages"


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        # csp.html : politique stricte, sans style ni script en ligne.
        if urlparse(self.path).path == "/csp.html":
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'")
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path != "/img":
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        time.sleep(int(q.get("ms", "0")) / 1000)
        w, h = int(q.get("w", 200)), int(q.get("h", 100))
        im = Image.new("RGB", (w, h), "#" + q.get("c", "888888"))
        d = ImageDraw.Draw(im)
        d.rectangle([8, 8, w - 9, h - 9], outline="white", width=4)
        d.text((24, 24), q.get("label", ""), fill="white")
        buf = io.BytesIO()
        im.save(buf, "PNG")
        data = buf.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(PAGES)))
    print(f"http://127.0.0.1:{port}/", flush=True)
    server.serve_forever()
