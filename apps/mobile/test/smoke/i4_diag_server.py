#!/usr/bin/env python3
"""I4 simulator diagnostics (loopback only). Plays the relay at http://127.0.0.1:4455 for a shell built with
TALOS_RELAY_URL=http://127.0.0.1:4455. The page lists the native plugins the shell injected, fires haptics and every
TalosAudio mode, tries the same call from an iframe (must be dropped by the bridge guard), and reports each result back
as a JSON line on stdout. No secrets, no network beyond loopback.
usage: i4_diag_server.py [port]
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4455

PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>I4 diag</title>
<body style="font:16px -apple-system;margin:0;padding:max(56px,env(safe-area-inset-top)) 16px 16px;background:#14161a;color:#e8e8ea">
<h2 style="margin:0 0 8px">Talos shell: I4 diagnostics</h2><pre id=o style="white-space:pre-wrap;font:14px ui-monospace"></pre>
<script>
const out = []; const show = () => document.getElementById('o').textContent = out.join('\\n');
const R = (o) => { new Image().src = '/report?' + new URLSearchParams(o); };
const log = (k, v) => { out.push(k.padEnd(26) + ' ' + v); show(); R({k, v}); };
(async () => {
  const C = window.Capacitor;
  log('Capacitor native', String(C && C.isNativePlatform && C.isNativePlatform()) + ' / ' + (C && C.getPlatform && C.getPlatform()));
  log('plugins', Object.keys((C && C.Plugins) || {}).join(','));
  const P = (C && C.Plugins) || {};
  const run = async (name, fn) => { try { await fn(); log(name, 'ok'); } catch (e) { log(name, 'ERR ' + (e && e.message || e)); } };
  await run('haptics impact LIGHT', () => P.Haptics.impact({ style: 'LIGHT' }));
  await run('haptics notify SUCCESS', () => P.Haptics.notification({ type: 'SUCCESS' }));
  await run('audio playback', () => P.TalosAudio.setMode({ mode: 'playback' }));
  await run('audio record', () => P.TalosAudio.setMode({ mode: 'record' }));
  await run('audio idle', () => P.TalosAudio.setMode({ mode: 'idle' }));
  await run('audio bad mode', async () => { try { await P.TalosAudio.setMode({ mode: 'loud' }); throw new Error('accepted'); } catch (e) { if (e.message === 'accepted') throw e; } });
  const f = document.createElement('iframe'); f.style.display = 'none';
  f.srcdoc = '<script>window.webkit.messageHandlers.bridge.postMessage({type:"message",pluginId:"TalosAudio",methodName:"setMode",callbackId:"x1",options:{mode:"playback"}});<\\/script>';
  document.body.appendChild(f);
  log('iframe call sent', 'dropped by guard if no later native log');
})();
</script>"""

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/report":
            print(json.dumps({k: v[0] for k, v in parse_qs(u.query).items()}), flush=True)
            self.send_response(204); self.end_headers(); return
        body = PAGE.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
