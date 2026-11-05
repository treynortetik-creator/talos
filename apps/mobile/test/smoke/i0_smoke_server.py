#!/usr/bin/env python3
"""I0 reviewer smoke server (PR #51). Plays the relay at http://localhost:8787 and an attacker origin at
http://127.0.0.1:8787 for a simulator build of the shell made with TALOS_RELAY_URL=http://localhost:8787.

Observable: every probe asks native code to set a cookie named after itself (CapacitorCookies.setCookie through the
`bridge` handler, or Capacitor's prompt() cookie channel). The guard holds for a probe iff its cookie never shows up
in a later request's Cookie header. Every request is logged as JSON lines to the file given as argv[1].
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

LOG = open(sys.argv[1] if len(sys.argv) > 1 else "smoke-log.jsonl", "a", buffering=1)
RELAY = "http://localhost:8787"
MIC_ONLY = len(sys.argv) > 3 and sys.argv[3] == "mic"

BRIDGE_JS = """
function B(key, w) {
  (w || window).webkit.messageHandlers.bridge.postMessage({type: 'message', pluginId: 'CapacitorCookies',
    methodName: 'setCookie', callbackId: key, options: {url: '%s', key: key, value: '1'}});
}
function R(o) { new Image().src = '%s/report?' + new URLSearchParams(o); }
function P(key) {  // Capacitor's prompt() side channel (WebViewDelegationHandler runJavaScriptTextInputPanel)
  try { return prompt(JSON.stringify({type: 'CapacitorCookies.set', domain: '%s', action: key + '=1; path=/'})); }
  catch (e) { return 'threw:' + e; }
}
function PG() { try { return prompt(JSON.stringify({type: 'CapacitorCookies.get'})); } catch (e) { return 'threw:' + e; } }
""" % (RELAY, RELAY, RELAY)

MAIN = """<!doctype html><meta charset=utf-8><title>i0 smoke</title><body><pre id=o></pre><script>%s
const MIC_ONLY = __MIC_ONLY__;
const phase = new URLSearchParams(location.search).get('phase') || '1';
if (MIC_ONLY && phase === '1') location.href = 'http://localhost:8788/evil';  // mic probe without the Safari sheet on top
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function frame(attrs) { const f = document.createElement('iframe'); Object.assign(f, attrs);
  for (const [k, v] of Object.entries(attrs)) if (k === 'sandbox') f.setAttribute('sandbox', v);
  document.body.appendChild(f); return f; }
(async () => {
  R({t: 'main_loaded', phase, cap: typeof window.Capacitor, handler: typeof window.webkit?.messageHandlers?.bridge,
     href: location.href, cookie: document.cookie});
  if (phase === '2') { R({t: 'phase2_cookie', cookie: document.cookie}); await sleep(500);
    location.href = 'http://localhost:8788/evil'; return; }               // another port on the relay host
  if (phase !== '1') { R({t: 'final_cookie', cookie: document.cookie}); return; }
  B('t1_main_positive_control');
  R({t: 't0p_main_prompt', r: String(P('t0p_main_prompt_set'))});   // trusted prompt(): must still work
  frame({src: '/child'});
  frame({srcdoc: '<script>' + B.toString() + ";B('t3_srcdoc_iframe')<\\/script>"});
  frame({srcdoc: '<script>' + B.toString() + ";B('t3b_srcdoc_sandboxed')<\\/script>", sandbox: 'allow-scripts'});
  const ab = frame({src: 'about:blank'}); await sleep(200);
  try { B('t4_aboutblank_handle', ab.contentWindow); } catch (e) { R({t: 't4_err', e: String(e)}); }
  frame({src: '/media/x/page?via=iframe', sandbox: 'allow-scripts'});
  const blob = URL.createObjectURL(new Blob(['<script>' + B.toString() + R.toString() + ";R({t:'t6_blob_ran',o:String(self.origin)});B('t6_blob_iframe')<\\/script>"], {type: 'text/html'}));
  frame({src: blob});
  frame({src: 'data:text/html,' + encodeURIComponent('<script>' + B.toString() + R.toString() + ";R({t:'t6b_data_ran',o:String(self.origin)});B('t6b_data_iframe')<\\/script>")});
  frame({src: 'http://127.0.0.1:8787/xo'});
  await sleep(2500);
  history.pushState({}, '', '/media/pushed'); B('t8_pushstate_media'); await sleep(300);
  history.pushState({}, '', '/'); B('t8b_after_pushback'); await sleep(300);
  R({t: 'before_nav', cookie: document.cookie});
  location.href = '/go-evil';                               // 302 to another host: must not load in the shell
  await sleep(3000);
  R({t: 'after_go_evil', href: location.href});
  await sleep(300);
  location.href = '/media/x/page?via=toplevel';          // gate should cancel + open SFSafariViewController
  await sleep(3000);
  R({t: 'after_toplevel_media', href: location.href});
  location.href = '/go-media';                              // 302 -> /media/x/page?via=redirect
  await sleep(3000);
  R({t: 'after_redirect', href: location.href, cookie: document.cookie});
  location.href = 'http://localhost:8787@127.0.0.1:8787/evil';   // passes Capacitor's starts(with: serverURL)
})();
</script>""" % BRIDGE_JS

CHILD = """<!doctype html><script>%s
B('t2_sameorigin_iframe_own_handle');
try { B('t2b_sameorigin_iframe_parent_handle', parent); } catch (e) { R({t: 't2b_err', e: String(e)}); }
try { R({t: 't2p_parent_prompt', r: String(parent.prompt(JSON.stringify({type: 'CapacitorCookies.set', domain: 'http://localhost:8787', action: 't2p_sameorigin_iframe_parent_prompt=1; path=/'})))}); } catch (e) { R({t: 't2p_err', e: String(e)}); }
</script>""" % BRIDGE_JS

MEDIA = """<!doctype html><script>%s
R({t: 'media_page_loaded', href: location.href, top: String(window === window.top), origin: String(self.origin)});
try { B('t5_media_' + new URLSearchParams(location.search).get('via')); } catch (e) { R({t: 't5_err', e: String(e)}); }
R({t: 'media_prompt', r: String(P('t5p_media_prompt'))});
R({t: 'media_env', via: new URLSearchParams(location.search).get('via'), handler: typeof window.webkit?.messageHandlers?.bridge,
   cap: typeof window.Capacitor, webkit: typeof window.webkit});
const via = new URLSearchParams(location.search).get('via');
// Viewer escapes: drop the sandbox CSP via a data: document, or load the relay app itself in the bridge-less viewer.
if (via === 'toplevel') setTimeout(() => { location.href = 'data:text/html,' + encodeURIComponent('<script>' + R.toString() +
  ";R({t:'viewer_data_doc',handler:typeof window.webkit?.messageHandlers?.bridge,o:String(self.origin),p:String(prompt('x'))})<\\/script>"); }, 500);
if (via === 'redirect') setTimeout(() => { location.href = '/?from=viewer'; }, 500);
</script>""" % BRIDGE_JS

XO = """<!doctype html><script>%s
try { B('t7_crossorigin_iframe_bridge'); } catch (e) { R({t: 't7_err', e: String(e)}); }
R({t: 't7_prompt_set', r: String(P('t7p_crossorigin_iframe_prompt_set'))});
R({t: 't7_prompt_get', r: String(PG())});
</script>""" % BRIDGE_JS

EVIL = """<!doctype html><script>%s
R({t: 'evil_loaded', href: location.href, top: String(window === window.top), cap: typeof window.Capacitor,
   handler: typeof window.webkit?.messageHandlers?.bridge});
try { B('t11_lookalike_bridge_' + location.port); } catch (e) { R({t: 't11_err', e: String(e)}); }
R({t: 't11_prompt_set', r: String(P('t11p_lookalike_prompt_set_' + location.port))});
R({t: 't11_prompt_get', r: String(PG())});
// Race: keep posting while navigating back to the relay; frameInfo.securityOrigin must still drop these.
const iv = setInterval(() => { try { B('t12_race_' + location.port); } catch (e) {} }, 1);
if (location.port === '8788') {
  // Capacitor answers requestMediaCapturePermission with .grant for every origin: no WebKit prompt for this page.
  // The page then stays put so the harness can background the app and see whether capture is interrupted.
  clearInterval(iv);
  const ev = [];
  navigator.mediaDevices.getUserMedia({audio: true}).then((s) => {
    const t = s.getAudioTracks()[0];
    for (const e of ['mute', 'unmute', 'ended']) t.addEventListener(e, () => ev.push(e + '@' + Date.now()));
    R({t: 'mic_granted', label: t.label, state: t.readyState, muted: String(t.muted)});
    setInterval(() => R({t: 'mic_tick', state: t.readyState, muted: String(t.muted), ev: ev.join(','), now: Date.now()}), 1000);
  }).catch((e) => R({t: 'mic_denied', e: String(e)}));
} else setTimeout(() => { location.href = '%s/?phase=2'; }, 800);
</script>""" % (BRIDGE_JS, RELAY)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="text/html; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        host = self.headers.get("Host", "")
        rec = {"ts": time.time(), "host": host, "path": self.path, "cookie": self.headers.get("Cookie", ""),
               "ua": self.headers.get("User-Agent", "")[-60:]}
        if u.path == "/report":
            rec["report"] = {k: v[0] for k, v in parse_qs(u.query).items()}
        LOG.write(json.dumps(rec) + "\n")
        print(json.dumps(rec), flush=True)
        sess = {"Set-Cookie": "sess=httponly-secret; Path=/; HttpOnly; SameSite=Strict"}  # relay: __Host-, Secure, HttpOnly, Strict
        if u.path == "/report":
            return self._send(204)
        if u.path == "/" and u.query == "from=viewer":
            return self._send(200, b"<!doctype html><p>relay app in viewer?")
        if u.path == "/" and host.startswith("localhost"):
            page = MAIN.replace("__MIC_ONLY__", "true" if MIC_ONLY else "false")
            return self._send(200, page.encode(), extra=sess)
        if u.path == "/child":
            return self._send(200, CHILD.encode())
        if u.path == "/go-evil":
            return self._send(302, extra={"Location": "http://127.0.0.1:8787/evil?via=redirect"})
        if u.path == "/go-media":
            return self._send(302, extra={"Location": "/media/x/page?via=redirect"})
        if u.path.startswith("/media/"):
            # Mimic the relay: session required, sandbox CSP on every /media response.
            csp = {"Content-Security-Policy": "sandbox allow-scripts"}
            if "sess=httponly-secret" not in self.headers.get("Cookie", ""):
                return self._send(401, b'{"error":"unauthorized"}', "application/json", csp)
            return self._send(200, MEDIA.encode(), extra=csp)
        if u.path == "/xo":
            return self._send(200, XO.encode())
        if u.path == "/evil":
            return self._send(200, EVIL.encode())
        return self._send(404, b"nf")


if __name__ == "__main__":
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8787
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
