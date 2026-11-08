"""_update_fetch.py: fetching `latest.json`, the bundle and its signature from the update source (a folder, https, or http on this machine).
Python 3.9, standard library only."""
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

import _addr
from _update_common import DOWNLOAD_LIMIT, NET_TIMEOUT, Stop

LOOPBACK = _addr.LOOPBACK_NAMES


def check_scheme(url):
    u = urllib.parse.urlparse(url)
    if u.scheme == "https":
        return
    if u.scheme == "http" and (u.hostname or "") in LOOPBACK:
        return
    raise Stop("refusing %s: a remote update source has to be https (plain http is only allowed for a source on this machine)" % url)


class _Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_scheme(newurl)
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


def fetch_bytes(source, name, limit):
    """name inside source, at most `limit` bytes. A folder, a file:// URL, https, or http on loopback."""
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", source) and not source.startswith("file://"):
        check_scheme(source)
        url = urllib.parse.urljoin(source if source.endswith("/") else source + "/", name)
        check_scheme(url)
        deadline = time.monotonic() + DOWNLOAD_LIMIT()
        try:
            # every connection, the first and each redirect, goes through the address check; only a source the owner put on
            # this machine may reach loopback, and a redirect to any other host or port never may
            opener = _addr.build_opener(_Redirects, local_server=_addr.local_server_of(url))
            with opener.open(url, timeout=NET_TIMEOUT()) as r:
                if int(r.headers.get("Content-Length") or 0) > limit:
                    raise Stop("%s is bigger than the %d MB limit; refused" % (url, limit // (1024 * 1024)))
                buf = bytearray()
                while True:
                    if time.monotonic() > deadline:
                        raise Stop("downloading %s timed out (more than %d s in all)" % (url, DOWNLOAD_LIMIT()))
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    buf += chunk
                    if len(buf) > limit:
                        raise Stop("%s is bigger than the %d MB limit; refused" % (url, limit // (1024 * 1024)))
                want = r.headers.get("Content-Length")
                if want is not None and int(want) != len(buf):
                    raise Stop("%s was cut short (got %d of %s bytes)" % (url, len(buf), want))
                return bytes(buf)
        except Stop:
            raise
        except urllib.error.HTTPError as e:
            raise Stop("could not fetch %s: HTTP %s" % (url, e.code))
        except (socket.timeout, TimeoutError):
            raise Stop("could not fetch %s: timed out after %d s with no data (%s)" % (url, NET_TIMEOUT(), _addr.NO_PROXY))
        except urllib.error.URLError as e:
            if isinstance(e.reason, _addr.BlockedAddressError):
                raise Stop("refusing %s: %s" % (url, e.reason))
            if isinstance(e.reason, (socket.timeout, TimeoutError)):
                raise Stop("could not fetch %s: timed out after %d s with no data (%s)" % (url, NET_TIMEOUT(), _addr.NO_PROXY))
            raise Stop("could not fetch %s: %s (%s)" % (url, e.reason, _addr.NO_PROXY))
        except (OSError, ValueError) as e:
            raise Stop("could not fetch %s: %s (%s)" % (url, e, _addr.NO_PROXY))
    folder = source[len("file://"):] if source.startswith("file://") else source
    path = os.path.join(folder, name)
    try:
        if os.path.getsize(path) > limit:
            raise Stop("%s is bigger than the %d MB limit; refused" % (path, limit // (1024 * 1024)))
        with open(path, "rb") as fh:
            return fh.read(limit + 1)
    except FileNotFoundError:
        raise Stop("could not read %s: no such file (is %s the update source?)" % (path, folder))
    except OSError as e:
        raise Stop("could not read %s: %s" % (path, e))
