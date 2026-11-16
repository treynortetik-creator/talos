#!/usr/bin/env python3
"""A stand-in relay for the black-screen repro: one bright page with a ticking counter, so a screenshot shows at a glance
whether the page is alive, and a /hang page whose script never yields (a web process that is alive and does not answer)."""
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = """<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1">
<title>stub relay</title><style>body{margin:0;background:#1f6f43;color:#fff;font:600 28px -apple-system;display:flex;
flex-direction:column;align-items:center;justify-content:center;height:100vh}small{font-size:16px;opacity:.8}</style></head>
<body><div>RELAY PAGE LIVE</div><small id=t>0</small><small id=l></small>
<script>const born=Date.now();document.getElementById('l').textContent='loaded '+new Date().toISOString().slice(11,19);
setInterval(()=>{document.getElementById('t').textContent='alive '+Math.round((Date.now()-born)/1000)+' s'},500);
if(location.hash==='#hang'){setTimeout(()=>{for(;;){}},Number(new URLSearchParams(location.search).get('after')||3000))}
</script></body></html>"""


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 48771
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
