"""_addr.py: the kit's copy of the web-address check in packages/protocol/src/address.ts, and a way to open a URL that
uses it. Python 3.9, standard library only.

The kit cannot import the TypeScript, so this file is kept in step with it by two tests: scripts/test-address.sh runs the
shared corpus (packages/protocol/fixtures/address-corpus.json) through it, and the repo's scripts/address-parity.test.ts runs
this file and address.ts over the same generated cases and fails on any difference. Change a range in address.ts and those
fail until this file agrees.

Rule for every caller: classify the ADDRESS, never the name. Resolve a name, ask `is_blocked_address` about every address
that came back, and connect only to an address that passed (`build_opener` does all of that). Anything this file cannot parse
is blocked.
"""
import http.client
import re
import socket
import urllib.error
import urllib.parse
import urllib.request

# The one named exception: the owner's own machine. `localhost` and the loopback literals, as the URL spells them.
LOOPBACK_NAMES = ("127.0.0.1", "localhost", "::1", "[::1]")
WILL_NOT = "the host resolves to an address Talos will not contact"
SCHEME = "only http and https addresses are fetched here"
NO_PROXY = "proxy settings are not used for this fetch"

_V4 = re.compile(r"(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})")
_GROUP = re.compile(r"[0-9a-f]{1,4}")


class BlockedAddressError(OSError):
    """A connection was refused because of where it would have gone."""


def parse_ipv4(text):
    """Four dotted decimal numbers, each 0..255 with no leading zeros. Anything else (octal, hex, short, decimal) is None."""
    m = _V4.fullmatch(text)
    if not m:
        return None
    o = [int(g) for g in m.groups()]
    return o if all(n <= 255 for n in o) else None


def parse_ipv6(text):
    """Eight 16-bit groups, or None when the text is not an IPv6 literal. Accepts `::`, a dotted IPv4 tail, brackets, a zone id."""
    s = text.lower()
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    zone = s.find("%")
    if zone >= 0:
        s = s[:zone]
    if ":" not in s:
        return None
    if "." in s:
        colon = s.rfind(":")
        v4 = parse_ipv4(s[colon + 1:])
        if not v4:
            return None
        s = "%s%x:%x" % (s[:colon + 1], (v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
    halves = s.split("::")
    if len(halves) > 2:
        return None
    head = halves[0].split(":") if halves[0] else []
    tail = halves[1].split(":") if len(halves) == 2 and halves[1] else []
    if len(halves) == 1:
        if len(head) != 8:
            return None
        groups = head
    else:
        fill = 8 - len(head) - len(tail)
        if fill < 1:
            return None
        groups = head + ["0"] * fill + tail
    if len(groups) != 8 or not all(_GROUP.fullmatch(g) for g in groups):
        return None
    return [int(g, 16) for g in groups]


def _v4_from(hi, lo):
    return [hi >> 8, hi & 255, lo >> 8, lo & 255]


def _blocked_v4(o):
    a, b, c = o[0], o[1], o[2]
    return (
        a == 0  # 0.0.0.0/8 this network
        or a == 10  # private
        or a == 127  # loopback
        or (a == 100 and 64 <= b <= 127)  # 100.64.0.0/10 carrier-grade NAT
        or (a == 169 and b == 254)  # link local, includes the cloud metadata address
        or (a == 172 and 16 <= b <= 31)  # private
        or (a == 192 and b == 0 and c == 0)  # 192.0.0.0/24 protocol assignments
        or (a == 192 and b == 0 and c == 2)  # TEST-NET-1
        or (a == 192 and b == 168)  # private
        or (a == 198 and b in (18, 19))  # 198.18.0.0/15 benchmarking
        or (a == 198 and b == 51 and c == 100)  # TEST-NET-2
        or (a == 203 and b == 0 and c == 113)  # TEST-NET-3
        or a >= 224  # multicast and reserved
    )


def is_blocked_address(addr):
    """True when Talos must not contact this address: not a public unicast address. IPv4 and IPv6, including the IPv6 forms
    that carry an IPv4 address (mapped, compatible, NAT64 64:ff9b::/96, 6to4 2002::/16), judged by the IPv4 inside. Text that
    is not exactly an address (octal, hex, decimal, short forms, a name, empty) is blocked."""
    host = re.sub(r"^\[|\]\Z", "", addr)
    v4 = parse_ipv4(host)
    if v4:
        return _blocked_v4(v4)
    g = parse_ipv6(host)
    if not g:
        return True
    g0, g1, g2, g3, g4, g5, g6, g7 = g

    def zero_to(n):
        return all(x == 0 for x in g[:n])

    if zero_to(7) and g7 in (0, 1):
        return True  # :: and ::1
    if (g0 & 0xFE00) == 0xFC00:
        return True  # fc00::/7 unique local
    if (g0 & 0xFFC0) == 0xFE80:
        return True  # fe80::/10 link local
    if (g0 & 0xFFC0) == 0xFEC0:
        return True  # fec0::/10 site local
    if (g0 & 0xFF00) == 0xFF00:
        return True  # multicast
    if zero_to(5) and g5 in (0xFFFF, 0):
        return _blocked_v4(_v4_from(g6, g7))  # ::ffff:a.b.c.d mapped, ::a.b.c.d compatible
    if zero_to(4) and g4 == 0xFFFF and g5 == 0:
        return True  # ::ffff:0:a.b.c.d translated
    if g0 == 0x64 and g1 == 0xFF9B:
        if g2 == 0 and g3 == 0 and g4 == 0 and g5 == 0:
            return _blocked_v4(_v4_from(g6, g7))  # 64:ff9b::/96 NAT64
        return g2 == 1  # 64:ff9b:1::/48 local-use NAT64
    if g0 == 0x2002:
        return _blocked_v4(_v4_from(g1, g2))  # 2002::/16 6to4
    if g0 == 0x2001 and g1 == 0:
        return True  # 2001::/32 Teredo
    if g0 == 0x2001 and g1 == 2 and g2 == 0:
        return True  # 2001:2::/48 benchmarking
    if g0 == 0x2001 and g1 == 0xDB8:
        return True  # 2001:db8::/32 documentation
    if g0 == 0x3FFF and (g1 & 0xF000) == 0:
        return True  # 3fff::/20 documentation
    if g0 == 0x100 and g1 == 0 and g2 == 0 and g3 == 0:
        return True  # 100::/64 discard-only
    return False


def find_blocked_address(addrs):
    """The first blocked address in the list, or None when none is. The caller must refuse an empty list itself."""
    for a in addrs:
        if is_blocked_address(a):
            return a
    return None


def normalize_host(host):
    """A host as it appears in a URL, made comparable: lower case, no brackets, no trailing dots."""
    return re.sub(r"\.+\Z", "", re.sub(r"^\[|\]\Z", "", host.lower()))


def is_ip_literal(host):
    h = normalize_host(host)
    return parse_ipv4(h) is not None or parse_ipv6(h) is not None


def is_blocked_host(host):
    """Judges a host before any lookup. Blocked: an IP literal in a blocked range, and any number-shaped host that is not an
    exact literal (`0x7f.1`, one big decimal number, `127.1`). A real name returns False: it still has to be resolved."""
    h = normalize_host(host)
    if h == "":
        return True
    if is_ip_literal(h):
        return is_blocked_address(h)
    if re.fullmatch(r"[0-9.]+", h) or re.fullmatch(r"0x[0-9a-f.]*", h, re.I):
        return True
    return ":" in h


def is_loopback_host(host):
    """`localhost` or a loopback address literal (127.0.0.0/8, ::1, the mapped form of 127/8). Never a name that merely starts with 127."""
    h = normalize_host(host)
    if h == "localhost":
        return True
    v4 = parse_ipv4(h)
    if v4:
        return v4[0] == 127
    g = parse_ipv6(h)
    if not g:
        return False
    if all(x == 0 for x in g[:7]) and g[7] == 1:
        return True
    return all(x == 0 for x in g[:5]) and g[5] == 0xFFFF and (g[6] >> 8) == 127


def approved_addresses(host, addrs, loopback_host=None):
    """The addresses a connection to `host` may use, or BlockedAddressError. EVERY address must pass (one bad one among good
    ones refuses), an empty answer refuses, and so does anything that is not an address. `loopback_host` is the one host the
    owner named (a local server): for exactly that host a loopback address passes. Every other blocked range stays blocked."""
    named = loopback_host is not None and normalize_host(host) == normalize_host(loopback_host)
    if not named and is_blocked_host(host):
        raise BlockedAddressError(WILL_NOT)
    addrs = list(addrs)
    if not addrs:
        raise BlockedAddressError(WILL_NOT)
    for a in addrs:
        if is_blocked_address(a) and not (named and is_loopback_host(a)):
            raise BlockedAddressError(WILL_NOT)
    return addrs


def local_server_of(url):
    """(host, port) when `url` names a server on this machine (`localhost` or a loopback literal), else None. This is the one
    server a caller may let reach loopback: the owner typed it. The same host on another port is a different server."""
    u = urllib.parse.urlparse(url)
    host = u.hostname or ""
    if host not in LOOPBACK_NAMES:
        return None
    return host, u.port or (443 if u.scheme == "https" else 80)


def _checked_create_connection(local_server):
    """A replacement for socket.create_connection: resolve, approve every address, connect only to an approved one. The check
    and the connection use the same answer, so a name that changes its answer between check and connect gets nothing."""

    def create(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
        host, port = address
        named = local_server is not None and normalize_host(host) == normalize_host(local_server[0]) and port == local_server[1]
        infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        addrs = approved_addresses(host, [i[4][0] for i in infos], host if named else None)
        err = None
        for a in addrs:
            try:
                return socket.create_connection((a, port), timeout, source_address)
            except OSError as e:
                err = e
        raise err or BlockedAddressError(WILL_NOT)

    return create


def _guarded(base, local_server):
    class Guarded(base):
        def __init__(self, *a, **k):
            base.__init__(self, *a, **k)
            self._create_connection = _checked_create_connection(local_server)

    return Guarded


class _GuardedHTTP(urllib.request.HTTPHandler):
    def __init__(self, local_server):
        urllib.request.HTTPHandler.__init__(self)
        self._local_server = local_server

    def http_open(self, req):
        return self.do_open(_guarded(http.client.HTTPConnection, self._local_server), req)


class _GuardedHTTPS(urllib.request.HTTPSHandler):
    def __init__(self, local_server):
        urllib.request.HTTPSHandler.__init__(self)
        self._local_server = local_server

    def https_open(self, req):
        kw = {"context": self._context}
        if hasattr(self, "_check_hostname"):  # python 3.9 to 3.11
            kw["check_hostname"] = self._check_hostname
        return self.do_open(_guarded(http.client.HTTPSConnection, self._local_server), req, **kw)


def _refuse_scheme(self, req):
    raise urllib.error.URLError(BlockedAddressError(SCHEME))


class _NoFTP(urllib.request.FTPHandler):
    ftp_open = _refuse_scheme  # ftplib connects with no address check


class _NoFile(urllib.request.FileHandler):
    file_open = _refuse_scheme


class _NoData(urllib.request.DataHandler):
    data_open = _refuse_scheme


def build_opener(*handlers, local_server=None):
    """urllib's opener with every connection (the first request and each redirect) going through the address check.
    `local_server`: (host, port) of the one local server the owner named, or None (see `local_server_of`). Nothing else gets
    the loopback exception, so a redirect to another host or another port is refused.
    Only http and https are fetched: the default ftp, file and data handlers are replaced by ones that refuse, and the
    opener's `open` (which every redirect also goes through) refuses any other scheme before a handler is chosen.
    Proxy settings, from the environment and on a Mac from System Settings, are ignored: a proxy answers for the
    destination, so the destination could not be checked."""
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        _GuardedHTTP(local_server),
        _GuardedHTTPS(local_server),
        _NoFTP(),
        _NoFile(),
        _NoData(),
        *handlers,
    )
    plain_open = opener.open

    def open_http(fullurl, data=None, timeout=socket._GLOBAL_DEFAULT_TIMEOUT):
        req = fullurl if isinstance(fullurl, urllib.request.Request) else urllib.request.Request(fullurl)
        if req.type not in ("http", "https"):
            raise urllib.error.URLError(BlockedAddressError(SCHEME))
        return plain_open(req, data, timeout)

    opener.open = open_http
    return opener
