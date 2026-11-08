#!/usr/bin/env bash
# test-address.sh -- scripts/_addr.py, the kit's copy of the web-address check in packages/protocol/src/address.ts, and the two
# places the kit fetches a URL (the update source, scripts/_update_fetch.py; the calendar URL, scripts/watcher.py).
#
# The TypeScript side runs the shared corpus (packages/protocol/fixtures/address-corpus.json) at every one of its entry points. This
# script runs the SAME file against the Python copy: every `core`, `alsoBlocked` and `embedded` address is refused, every `public`
# one is allowed, every blocked range's first and last address is refused and its neighbours are not (`rangeEdges`), and every
# address is refused at both kit entry points (literal URL, a name that resolves to it, a redirect to it, a redirect to a name that
# resolves to it). scripts/address-parity.test.ts then compares the Python and TypeScript answers on a broad generated set.
# Other schemes (ftp, file, data) and proxy settings are refused or ignored at both entry points too. No test opens a connection to
# a real private address: `socket.getaddrinfo`, `socket.create_connection` and `ftplib.FTP.connect` are replaced, and the only real
# socket is a server on 127.0.0.1 that this script starts and that answers with redirects.
# Without the corpus (a kit copied out of the repo) the entry-point checks still run, on a short built-in list; only the corpus
# parity part is skipped, and says so.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORPUS="$KIT/../packages/protocol/fixtures/address-corpus.json"
[ -f "$CORPUS" ] || CORPUS=""
PASS=0; FAIL=0
RES="$(python3 -I - "$KIT/scripts" "$CORPUS" <<'PY'
import ftplib, http.server, json, os, socket, sys, threading, urllib.error, urllib.request

scripts, corpus_path = sys.argv[1], sys.argv[2]
sys.path.insert(0, scripts)
sys.dont_write_bytecode = True
PASS = FAIL = 0
# what the entry-point checks use when the corpus is not next to this kit
BUILT_IN = {
    "core": ["169.254.169.254", "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "100.64.0.1", "0.0.0.0", "::1",
             "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::", "fec0::1", "fd00::1", "fe80::1"],
    "embedded": [], "alsoBlocked": ["169.254.170.2"], "rangeEdges": [], "notAnAddress": ["", "127.1", "example.com"],
    "public": ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"],
}
HAVE_CORPUS = bool(corpus_path)
corpus = json.load(open(corpus_path)) if HAVE_CORPUS else BUILT_IN
if not HAVE_CORPUS:
    print("skip address parity: the shared corpus (packages/protocol/fixtures/address-corpus.json) is not next to this kit; "
          "only a short built-in list is run")


def ok(msg):
    global PASS
    PASS += 1


def no(msg, detail=""):
    global FAIL
    FAIL += 1
    print("  FAIL %s" % msg)
    if detail:
        print("       %s" % str(detail)[:240])


def check(cond, msg, detail=""):
    ok(msg) if cond else no(msg, detail)


# ---------------------------------------------------------------- 1. the corpus itself
if HAVE_CORPUS:
    check(len(corpus["core"]) == 19 and len(set(corpus["core"])) == 19, "the corpus core is the 19 addresses")
blocked = corpus["core"] + corpus["embedded"] + corpus["alsoBlocked"]
hostable = [a for a in blocked if "%" not in a]  # a zone id cannot sit in a URL host

try:
    import _addr
except Exception as e:  # red until the module exists
    no("scripts/_addr.py imports", "%s: %s" % (type(e).__name__, e))
    _addr = None

if _addr is not None:
    # ---------------------------------------------------------------- 2. parity with address.ts
    for a in blocked:
        check(_addr.is_blocked_address(a), "blocks %s" % a)
    for a in corpus["public"]:
        check(not _addr.is_blocked_address(a), "allows public %s" % a)
    for a in corpus["notAnAddress"]:
        check(_addr.is_blocked_address(a), "refuses text that is not exactly an address: %r" % a)
    for a in corpus["core"]:
        if ":" in a:
            check(_addr.is_blocked_address("[%s]" % a), "brackets do not change the verdict for %s" % a)
    check(_addr.find_blocked_address(["93.184.216.34", "10.0.0.5"]) == "10.0.0.5", "find_blocked_address names the first blocked one")
    check(_addr.find_blocked_address(["93.184.216.34"]) is None, "find_blocked_address: none when all are public")
    for h in ["2130" + "706433", "0x7f.1", "0177.0.0.1", "127.1", "0", "", "127.0.0.1.", "[::1]", "localhost:80"]:
        check(_addr.is_blocked_host(h), "is_blocked_host refuses %r" % h)
    for h in ["example.com", "93.184.216.34", "[2606:4700:4700::1111]", "localhost"]:
        check(not _addr.is_blocked_host(h), "is_blocked_host leaves %r to the lookup" % h)
    for h, want in [("localhost", True), ("LOCALHOST.", True), ("127.0.0.1", True), ("127.9.9.9", True), ("::1", True),
                    ("[::1]", True), ("::ffff:127.0.0.1", True), ("127.0.0.1.nip.io", False), ("10.0.0.5", False),
                    ("169.254.169.254", False), ("example.com", False), ("", False)]:
        check(_addr.is_loopback_host(h) == want, "is_loopback_host(%r) is %s" % (h, want))
    for e in corpus["rangeEdges"]:
        check(_addr.is_blocked_address(e["first"]) and _addr.is_blocked_address(e["last"]),
              "%s: first (%s) and last (%s) are blocked" % (e["range"], e["first"], e["last"]))
        for side in ("before", "after"):
            if e[side]:
                check(not _addr.is_blocked_address(e[side]), "%s: %s (%s) is allowed" % (e["range"], side, e[side]))
    for a in ["169.254.0.1", "169.254.170.2", "169.254.169.253"]:
        check(_addr.is_blocked_address(a), "link-local is blocked whole, not only the metadata address: %s" % a)
    # the named exception is loopback only, and only for the host the owner named
    ap = _addr.approved_addresses
    try:
        check(ap("127.0.0.1", ["127.0.0.1"], "127.0.0.1") == ["127.0.0.1"], "the named loopback host may reach loopback")
        check(ap("localhost", ["127.0.0.1", "::1"], "localhost") == ["127.0.0.1", "::1"], "localhost may reach its loopback addresses")
    except Exception as e:
        no("the named loopback host may reach loopback", e)
    for host, addrs, named, why in [
        ("127.0.0.1", ["127.0.0.1"], None, "loopback without the named exception"),
        ("example.com", ["127.0.0.1"], "127.0.0.1", "another host that resolves to loopback"),
        ("localhost", ["10.0.0.5"], "localhost", "the named host answering a private address"),
        ("localhost", ["127.0.0.1", "169.254.169.254"], "localhost", "one bad address among good ones"),
        ("example.com", [], None, "an empty answer"),
        ("example.com", ["93.184.216.34", "rebind"], None, "a non-address answer"),
    ]:
        try:
            ap(host, addrs, named)
            no("refuses %s" % why)
        except _addr.BlockedAddressError:
            ok("refuses %s" % why)
    for url, want in [("http://127.0.0.1:8080/x", ("127.0.0.1", 8080)), ("https://localhost/", ("localhost", 443)),
                      ("http://localhost/", ("localhost", 80)), ("http://[::1]:9/", ("::1", 9)),
                      ("https://127.0.0.1.nip.io/", None), ("https://example.com/", None), ("https://10.0.0.5/", None)]:
        check(_addr.local_server_of(url) == want, "local_server_of(%s) is %s" % (url, want))
    check(ap("example.com", ["93.184.216.34", "2606:4700:4700::1111"], None) == ["93.184.216.34", "2606:4700:4700::1111"],
          "public answers are approved")


# ---------------------------------------------------------------- 3. the two entry points, without a real connection
class Net:
    """Replaces name lookup and connecting. A name maps to the addresses a test chooses; every connection attempt is recorded
    and refused, except to the one local server this script started."""

    def __init__(self, server_port):
        self.names, self.attempts, self.server_port = {}, [], server_port
        self._gai, self._cc, self._ftp = socket.getaddrinfo, socket.create_connection, ftplib.FTP.connect

    def __enter__(self):
        def gai(host, port, *a, **k):
            if host in self.names:
                out = []
                for addr in self.names[host]:
                    fam = socket.AF_INET6 if ":" in addr else socket.AF_INET
                    out.append((fam, socket.SOCK_STREAM, 6, "", (addr, port or 0) if fam == socket.AF_INET else (addr, port or 0, 0, 0)))
                return out
            return self._gai(host, port, *a, **k)

        def cc(address, *a, **k):
            host, port = address
            if host in ("127.0.0.1", "localhost", "::1") and port == self.server_port:
                return self._cc(address, *a, **k)
            self.attempts.append(host)
            raise ConnectionRefusedError("no real connection in this test: %s" % host)

        def ftp(this, host="", *a, **k):
            self.attempts.append("ftp:" + str(host))
            raise ConnectionRefusedError("no real ftp connection in this test: %s" % host)

        socket.getaddrinfo, socket.create_connection, ftplib.FTP.connect = gai, cc, ftp
        return self

    def __exit__(self, *x):
        socket.getaddrinfo, socket.create_connection, ftplib.FTP.connect = self._gai, self._cc, self._ftp


class Redirector(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        where = self.server.next_location
        if where is None:
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(302)
        self.send_header("Location", where)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirector)
server.next_location = None
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
PORT = server.server_address[1]
LOCAL = "http://127.0.0.1:%d/" % PORT
url_for = lambda a, path="x": ("https://[%s]/%s" if ":" in a else "https://%s/%s") % (a, path)
WILL_NOT = "will not contact"

import _update_common  # noqa: E402
import _update_fetch  # noqa: E402

os.environ["TALOS_UPDATE_NET_TIMEOUT"] = "3"


def update_fetch(source, name="latest.json"):
    try:
        return "ok", _update_fetch.fetch_bytes(source, name, 1 << 20)
    except _update_common.Stop as e:
        return "stop", str(e)
    except Exception as e:  # anything else is a bug in the fetch, not a refusal
        return "crash", "%s: %s" % (type(e).__name__, e)


def update_cases(label, run):
    """`run(kind, a, net)` -> (outcome, text) for the four ways an address reaches an entry point."""
    for a in hostable:
        # `https://127.0.0.1/` and `https://[::1]/` are a local server the owner typed: the one named exception (checked below)
        if a not in ("127.0.0.1", "::1"):
            with Net(PORT) as net:
                server.next_location = None
                out, text = run("literal", a, net)
                check(out == "stop" and WILL_NOT in text and net.attempts == [], "%s: literal %s is refused, no connection" % (label, a), (out, text, net.attempts))
        with Net(PORT) as net:
            net.names["as.example.com"] = [a]
            out, text = run("name", a, net)
            check(out == "stop" and WILL_NOT in text and net.attempts == [], "%s: a name resolving to %s is refused, no connection" % (label, a), (out, text, net.attempts))
        with Net(PORT) as net:
            server.next_location = url_for(a)
            out, text = run("redirect", a, net)
            check(out == "stop" and WILL_NOT in text and net.attempts == [], "%s: a redirect to %s is refused, no connection" % (label, a), (out, text, net.attempts))
        with Net(PORT) as net:
            net.names["second.example.org"] = [a]
            server.next_location = "https://second.example.org/y"
            out, text = run("redirect-name", a, net)
            check(out == "stop" and WILL_NOT in text and net.attempts == [], "%s: a redirect to a name resolving to %s is refused, no connection" % (label, a), (out, text, net.attempts))
    server.next_location = None
    for a in corpus["public"]:
        if "%" in a:
            continue
        with Net(PORT) as net:
            net.names["as.example.com"] = [a]
            out, text = run("name", a, net)
            check(net.attempts == [a] and WILL_NOT not in text, "%s: public %s still reaches the connection" % (label, a), (out, text, net.attempts))
            check("proxy" in text, "%s: a failed fetch says proxy settings are not used (%s)" % (label, a), text)


def update_run(kind, a, net):
    if kind == "literal":
        return update_fetch(url_for(a, ""))
    if kind == "name":
        return update_fetch("https://as.example.com/")
    return update_fetch(LOCAL)  # the loopback source answers with a redirect


update_cases("update source", update_run)

# the loopback source itself still works, over http, by address and by name
server.next_location = None
with Net(PORT) as net:
    out, text = update_fetch(LOCAL)
    check(out == "ok" and text == b'{"ok": true}', "update source: http on 127.0.0.1 still works", (out, text))
    out, text = update_fetch("http://localhost:%d/" % PORT)
    check(out == "ok" and text == b'{"ok": true}', "update source: http on localhost still works", (out, text))
    out, text = update_fetch("http://example.com/")
    check(out == "stop" and "https" in text, "update source: plain http to another host is still refused for its scheme", (out, text))

import watcher  # noqa: E402


def ics_fetch(url):
    cfg = {"calendar": {"type": "ics", "url": url}}
    import datetime as dt
    lo, hi = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc), dt.datetime(2027, 1, 1, tzinfo=dt.timezone.utc)
    try:
        watcher.fetch_calendar(cfg, lo, hi, dt.timezone.utc)
        return "ok", ""
    except watcher.SourceError as e:
        return "stop", str(e)
    except Exception as e:
        return "crash", "%s: %s" % (type(e).__name__, e)


def ics_run(kind, a, net):
    if kind == "literal":
        return ics_fetch(url_for(a, "cal.ics"))
    if kind == "name":
        return ics_fetch("https://as.example.com/cal.ics")
    return ics_fetch(LOCAL + "cal.ics")


update_cases("calendar url", ics_run)

server.next_location = None
with Net(PORT) as net:
    out, text = ics_fetch(LOCAL + "cal.ics")
    check(out != "crash" and WILL_NOT not in text, "calendar url: http on 127.0.0.1 still reaches the local server", (out, text))



# ---------------------------------------------------------------- 4. other schemes and proxies, at both entry points
def other_scheme_cases(label, run):
    """A redirect to ftp://<address>/, file:///etc/passwd or a data: URL must be refused with no connection attempt at all."""
    targets = ["ftp://%s/" % ("[%s]" % a if ":" in a else a) for a in hostable]
    targets += ["ftp://as.example.com/cal.ics", "ftp://anonymous" + chr(64) + "as.example.com/", "FTP://as.example.com:80/",
                "file:///etc/passwd", "file://localhost/etc/passwd", "data:text/calendar,BEGIN%3AVCALENDAR%0D%0AEND%3AVCALENDAR",
                "gopher://as.example.com/"]
    for target in targets:
        with Net(PORT) as net:
            net.names["as.example.com"] = ["10.0.0.5"]
            server.next_location = target
            out, text = run("redirect", None, net)
            check(out == "stop" and net.attempts == [], "%s: a redirect to %s is refused, no connection of any kind" % (label, target), (out, text, net.attempts))
    server.next_location = None


other_scheme_cases("update source", update_run)
other_scheme_cases("calendar url", ics_run)

# the stock ftp, file and data handlers are not in the opener at all (the scheme check alone would leave them one slip away)
_op = _addr.build_opener()
for name, stock in (("ftp", urllib.request.FTPHandler), ("file", urllib.request.FileHandler), ("data", urllib.request.DataHandler)):
    check(not any(type(h) is stock for h in _op.handlers), "the opener has no stock %s handler" % name)
    check(any(isinstance(h, stock) for h in _op.handlers), "the opener has a refusing %s handler instead" % name)
# the opener itself refuses everything but http(s), on the first request and on a redirect, whoever calls it
for url in ["ftp://169.254.169.254:80/", "ftp://as.example.com/", "file:///etc/passwd", "data:text/plain,hello", "gopher://as.example.com/"]:
    with Net(PORT) as net:
        net.names["as.example.com"] = ["10.0.0.5"]
        try:
            _addr.build_opener(local_server=("127.0.0.1", PORT)).open(url, timeout=3)
            no("the opener refuses %s on the first request" % url)
        except urllib.error.URLError as e:
            check(isinstance(e.reason, _addr.BlockedAddressError) and "only http" in str(e.reason) and net.attempts == [],
                  "the opener refuses %s on the first request, no connection" % url, (e.reason, net.attempts))
        except Exception as e:
            no("the opener refuses %s on the first request" % url, "%s: %s" % (type(e).__name__, e))
for target in ["ftp://169.254.169.254:80/", "ftp://as.example.com/", "file:///etc/passwd", "data:text/plain,hello"]:
    with Net(PORT) as net:
        net.names["as.example.com"] = ["10.0.0.5"]
        server.next_location = target
        try:
            _addr.build_opener(local_server=("127.0.0.1", PORT)).open(LOCAL, timeout=3)
            no("the opener refuses a redirect to %s" % target)
        except urllib.error.URLError as e:
            # a redirect to file: or data: is already refused by urllib itself (an HTTPError); ftp: is the one urllib follows
            check(net.attempts == [] and (target.startswith(("file:", "data:")) or isinstance(e.reason, _addr.BlockedAddressError)),
                  "the opener refuses a redirect to %s, no connection" % target, (e, net.attempts))
        except Exception as e:
            no("the opener refuses a redirect to %s" % target, "%s: %s" % (type(e).__name__, e))
server.next_location = None

# proxy settings (from the environment, and on a Mac from System Settings) are not used: a proxy hides where a request really goes
PROXY = "http://proxy.example.net:3128"
saved = {k: os.environ.get(k) for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY")}
for k in saved:
    os.environ.pop(k, None)
os.environ.update({"http_proxy": PROXY, "https_proxy": PROXY, "HTTP_PROXY": PROXY, "HTTPS_PROXY": PROXY})
try:
    check(urllib.request.getproxies().get("https") == PROXY, "the test really has a proxy configured", urllib.request.getproxies())
    for label, run in (("update source", lambda n: update_fetch("https://as.example.com/")), ("calendar url", lambda n: ics_fetch("https://as.example.com/cal.ics"))):
        with Net(PORT) as net:
            net.names["as.example.com"] = ["93.184.216.34"]
            net.names["proxy.example.net"] = ["10.0.0.9"]
            out, text = run(net)
            check("proxy.example.net" not in net.attempts and "10.0.0.9" not in net.attempts, "%s: https goes to the checked address, never to a configured proxy" % label, (out, text, net.attempts))
            check(net.attempts == ["93.184.216.34"], "%s: the one connection attempted is to the checked address" % label, net.attempts)
    with Net(PORT) as net:
        net.names["proxy.example.net"] = ["10.0.0.9"]
        server.next_location = None
        out, text = update_fetch(LOCAL)
        check(out == "ok" and "proxy.example.net" not in net.attempts, "update source: a loopback source is not sent through a configured proxy", (out, text, net.attempts))
finally:
    for k, v in saved.items():
        os.environ.pop(k, None)
        if v is not None:
            os.environ[k] = v

server.shutdown()
print("RESULT %d %d" % (PASS, FAIL))
PY
)"
printf '%s\n' "$RES" | grep -v '^RESULT'
read -r _ PASS FAIL <<<"$(printf '%s\n' "$RES" | grep '^RESULT' | tail -1)"
PASS="${PASS:-0}"; FAIL="${FAIL:-1}"
echo "  address: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
