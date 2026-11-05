#!/usr/bin/env python3
"""I3b simulator smoke (loopback only). Plays the relay over https on 127.0.0.1 for a shell built with
TALOS_RELAY_URL=https://127.0.0.1:<port>; the self-signed cert must be trusted by the simulator first:
  xcrun simctl keychain booted add-root-cert cert.pem
GET /       a page that stores a fake share token through the TalosShare plugin (and shows the result)
POST /api/share  logs what the share extension sent (field names and sizes, the Authorization SHAPE, never the value)
usage: i3b_share_server.py <port> <cert.pem> <key.pem>
"""
import json
import re
import ssl
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, CERT, KEY = int(sys.argv[1]), sys.argv[2], sys.argv[3]
FAKE = "talos_share_" + "A" * 43  # not a real token: the shape the relay issues

PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>I3b smoke</title><body style="font:16px -apple-system;margin:0;padding:max(56px,env(safe-area-inset-top)) 16px;background:#14161a;color:#e8e8ea">
<h2 style="margin:0 0 8px">Talos shell: share token</h2><pre id=o style="white-space:pre-wrap;font:14px ui-monospace"></pre>
<script>
const o = document.getElementById('o'); const say = (t) => { o.textContent += t + '\\n'; new Image().src = '/report?m=' + encodeURIComponent(t); };
(async () => {
  const P = (window.Capacitor && window.Capacitor.Plugins) || {};
  say('plugins: ' + Object.keys(P).join(','));
  const t = async (name, fn) => { try { await fn(); say(name + ': ok'); } catch (e) { say(name + ': rejected (' + (e && e.message) + ')'); } };
  await t('setToken bad secret', () => P.TalosShare.setToken({ token: 'nope', scopes: ['text'] }));
  await t('setToken bad scope', () => P.TalosShare.setToken({ token: '%s', scopes: ['admin'] }));
  await t('setToken text+files', () => P.TalosShare.setToken({ token: '%s', scopes: ['text', 'files'], relay: 'https://evil.example' }));
})();
</script>""" % (FAKE, FAKE)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/report"):
            print(json.dumps({"page": self.path.split("m=", 1)[-1]}), flush=True)
            self.send_response(204); self.end_headers(); return
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n)
        auth = self.headers.get("authorization", "")
        shape = "Bearer talos_share_<43>" if re.fullmatch(r"Bearer talos_share_[A-Za-z0-9_-]{43}", auth) else "BAD"
        fields = sorted(set(re.findall(rb'name="([a-z]+)"', raw)))
        print(json.dumps({"post": self.path, "auth": shape, "ctype": self.headers.get("content-type", "")[:30],
                          "bytes": n, "fields": [f.decode() for f in fields]}), flush=True)
        body = json.dumps({"share_id": "sh_smoke"}).encode()
        self.send_response(202)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(CERT, KEY)
srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
