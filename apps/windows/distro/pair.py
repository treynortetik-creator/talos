#!/usr/bin/env python3
# Pair a phone, from the tray (docs/WINDOWS-PLAN.md section 8). Root-owned at /opt/talos-wsl/pair.py; `talos-wsl.sh pair`
# runs it as root, only while the distro is cut off from Windows.
#
# It runs `talos-app enroll --json` (Cyclops's contract, docs/bridge.md "Enroll from a program") as talos, in a pty and a
# session of its own (enroll is terminal-only on purpose), and passes on to Windows only the events that contract names,
# each checked and rebuilt field by field, one ASCII JSON line each:
#   link {link, host, expires_at}   qr {rows}   confirm {device_name, words}   answered {yes}
#   pinned {device_id}   not_pinned {code}   used   expired   error {code}
#
# enroll's `warning bridge_not_live` (no live bridge: Main not signed in, or not running) is never passed on: the pairing
# ends there with `error not-ready`, before any link or QR (Pantheon, 2026-11-12). A phone that enrolled then would be
# accepted by the relay with nothing to pin it: half-enrolled, its code expired, a later bridge answering code_unknown.
#
# What the person is shown comes from root, never from talos (Fable R5-1 on 5fc143ef):
# - the link must be EXACTLY <the install's relay URL>/enroll#<a 26-character code>. The relay URL is root's own
#   (/etc/talos/relay, written by install.ps1 from Setup's payload), never talos's bridge config. Anything else ends with
#   error "link".
# - the QR code is drawn here, by root, from that checked link (the encoder below), never by talos's bun or uqr.
# What it cannot know (Fable R5-2): the four words and "pinned" are the bridge's, and the bridge runs as talos. This window
# guards against a relay-side or network attacker with an honest bridge; it is not a wall against the agent itself
# (docs/WINDOWS-PLAN.md says so). It still never passes on `pinned` unless a `confirm` came first and the person said yes.
#
# After `confirm`, one line from the tray is the answer: exactly `y` is yes, anything else, or stdin closing, is no. The
# tray waits before it lets a person answer; enroll itself also counts a `y` within 500 ms of `confirm` as no. stdin
# closing at any time (the window closed) stops the pairing: enroll's whole session is ended (TERM, then KILL).
import json
import os
import pty
import pwd
import re
import select
import signal
import stat
import sys
import time
import unicodedata

# The TALOS_PAIR_* names are for a test as an ordinary user with a stand-in enroll; as root they are ignored (Fable R5-5),
# so nothing in any environment can point root's pairing at another program, user or relay file.
TESTING = os.getuid() != 0
USER = (os.environ.get("TALOS_PAIR_USER") if TESTING else None) or "talos"
RELAY_FILE = (os.environ.get("TALOS_PAIR_RELAY") if TESTING else None) or "/etc/talos/relay"
ANSWER_WAIT_S = 600
TOTAL_S = 15 * 60
LINE_MAX = 16384
EVENTS = {"warning", "link", "confirm", "answered", "pinned", "not_pinned", "used", "expired", "error"}
ERROR_CODES = {"usage", "key_refused", "relay", "no_relay", "bad_words", "internal"}
# fullmatch only: `$` would also match before a trailing newline (Fable R4-4 on f1699c11)
DEVICE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
# the enroll code: 16 random bytes in Crockford base32 (packages/protocol/src/enroll.ts newEnrollCode)
CODE = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}")
RELAY = re.compile(r"https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*")


def say(obj):
    # ASCII only, one line: whatever a field holds, it reaches Windows escaped
    os.write(1, (json.dumps(obj, separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii"))


def plain(text, n):
    """Untrusted text shown to a person (talos's, through enroll): every control, format (bidi, zero-width), separator,
    private or unassigned character becomes a space; at most n characters (Fable R4-1 on f1699c11)."""
    text = "" if not isinstance(text, str) else text
    bad = ("Cc", "Cf", "Zl", "Zp", "Co", "Cs", "Cn")
    return "".join(" " if unicodedata.category(c) in bad else c for c in text)[:n]


def relay_url():
    """The install's relay URL, root's own: a JSON file root wrote, read as the supervisor reads root's files (root-owned,
    not group- or world-writable, a regular file and not a link, 4 KB or less). None when there is none."""
    try:
        fd = os.open(RELAY_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            st = os.fstat(fd)
            owner = os.getuid() if TESTING else 0
            if not stat.S_ISREG(st.st_mode) or st.st_uid != owner or st.st_mode & 0o022 or st.st_size > 4096:
                return None
            url = json.loads(os.read(fd, 4097).decode("utf-8")).get("url")
        finally:
            os.close(fd)
    except (OSError, ValueError, UnicodeDecodeError, AttributeError):
        return None
    return url if isinstance(url, str) and RELAY.fullmatch(url) else None


def checked(e, relay):
    """The event rebuilt from only the fields the contract names, each checked; None for anything else."""
    if not isinstance(e, dict) or e.get("event") not in EVENTS:
        return None
    ev = e["event"]
    if ev == "warning":
        return {"event": ev, "code": "bridge_not_live"} if e.get("code") == "bridge_not_live" else None
    if ev == "link":
        link = e.get("link")
        prefix = relay + "/enroll#"
        # exactly the install's relay, then a code: never another host, a login in the URL, or anything after the code
        if not isinstance(link, str) or not link.startswith(prefix) or not CODE.fullmatch(link[len(prefix):]):
            return {"event": "error", "code": "link"}
        exp = e.get("expires_at")
        host = RELAY.fullmatch(relay).group(1)
        return {"event": ev, "link": link, "host": host,
                "expires_at": exp if isinstance(exp, str) and re.fullmatch(r"[0-9T:.Z+-]{1,40}", exp) else None}
    if ev == "confirm":
        words = e.get("words")
        # four words of the PGP list, even/odd/even/odd as fingerprint.ts picks them: never text of the bridge's choosing
        if not isinstance(words, list) or len(words) != 4 or not all(isinstance(w, str) and w in (PGP_EVEN_SET if i % 2 == 0 else PGP_ODD_SET) for i, w in enumerate(words)):
            return None
        return {"event": ev, "device_name": plain(e.get("device_name"), 64), "words": words}
    if ev == "answered":
        return {"event": ev, "yes": e.get("yes") is True}
    if ev == "pinned":
        d = e.get("device_id")
        return {"event": ev, "device_id": d} if isinstance(d, str) and DEVICE_ID.fullmatch(d) else None
    if ev == "not_pinned":
        return {"event": ev, "code": "timeout"}
    if ev in ("used", "expired"):
        return {"event": ev}
    if ev == "error":
        return {"event": ev, "code": e.get("code") if e.get("code") in ERROR_CODES else "internal"}
    return None


# ---- the four words: the PGP word list (packages/protocol/src/pgp-words.ts, PGP_EVEN_WORDS and PGP_ODD_WORDS) -------------
# Root's own copy: a confirm passes only with words[0] and words[2] from PGP_EVEN and words[1] and words[3] from PGP_ODD,
# exactly (Pantheon and Cyclops, 2026-11-12), so a hostile bridge cannot put words of its own in the pairing window.
# scripts/windows-distro.test.ts checks it equals the protocol's list, in order.
PGP_EVEN = (
    "aardvark", "absurd", "accrue", "acme", "adrift", "adult", "afflict", "ahead", "aimless", "Algol", "allow", "alone",
    "ammo", "ancient", "apple", "artist", "assume", "Athens", "atlas", "Aztec", "baboon", "backfield", "backward",
    "banjo", "beaming", "bedlamp", "beehive", "beeswax", "befriend", "Belfast", "berserk", "billiard", "bison",
    "blackjack", "blockade", "blowtorch", "bluebird", "bombast", "bookshelf", "brackish", "breadline", "breakup",
    "brickyard", "briefcase", "Burbank", "button", "buzzard", "cement", "chairlift", "chatter", "checkup", "chisel",
    "choking", "chopper", "Christmas", "clamshell", "classic", "classroom", "cleanup", "clockwork", "cobra", "commence",
    "concert", "cowbell", "crackdown", "cranky", "crowfoot", "crucial", "crumpled", "crusade", "cubic", "dashboard",
    "deadbolt", "deckhand", "dogsled", "dragnet", "drainage", "dreadful", "drifter", "dropper", "drumbeat", "drunken",
    "Dupont", "dwelling", "eating", "edict", "egghead", "eightball", "endorse", "endow", "enlist", "erase", "escape",
    "exceed", "eyeglass", "eyetooth", "facial", "fallout", "flagpole", "flatfoot", "flytrap", "fracture", "framework",
    "freedom", "frighten", "gazelle", "Geiger", "glitter", "glucose", "goggles", "goldfish", "gremlin", "guidance",
    "hamlet", "highchair", "hockey", "indoors", "indulge", "inverse", "involve", "island", "jawbone", "keyboard",
    "kickoff", "kiwi", "klaxon", "locale", "lockup", "merit", "minnow", "miser", "Mohawk", "mural", "music", "necklace",
    "Neptune", "newborn", "nightbird", "Oakland", "obtuse", "offload", "optic", "orca", "payday", "peachy", "pheasant",
    "physique", "playhouse", "Pluto", "preclude", "prefer", "preshrunk", "printer", "prowler", "pupil", "puppy",
    "python", "quadrant", "quiver", "quota", "ragtime", "ratchet", "rebirth", "reform", "regain", "reindeer", "rematch",
    "repay", "retouch", "revenge", "reward", "rhythm", "ribcage", "ringbolt", "robust", "rocker", "ruffled", "sailboat",
    "sawdust", "scallion", "scenic", "scorecard", "Scotland", "seabird", "select", "sentence", "shadow", "shamrock",
    "showgirl", "skullcap", "skydive", "slingshot", "slowdown", "snapline", "snapshot", "snowcap", "snowslide", "solo",
    "southward", "soybean", "spaniel", "spearhead", "spellbind", "spheroid", "spigot", "spindle", "spyglass",
    "stagehand", "stagnate", "stairway", "standard", "stapler", "steamship", "sterling", "stockman", "stopwatch",
    "stormy", "sugar", "surmount", "suspense", "sweatband", "swelter", "tactics", "talon", "tapeworm", "tempest",
    "tiger", "tissue", "tonic", "topmost", "tracker", "transit", "trauma", "treadmill", "Trojan", "trouble", "tumor",
    "tunnel", "tycoon", "uncut", "unearth", "unwind", "uproot", "upset", "upshot", "vapor", "village", "virus",
    "Vulcan", "waffle", "wallet", "watchword", "wayside", "willow", "woodlark", "Zulu",
)
PGP_ODD = (
    "adroitness", "adviser", "aftermath", "aggregate", "alkali", "almighty", "amulet", "amusement", "antenna",
    "applicant", "Apollo", "armistice", "article", "asteroid", "Atlantic", "atmosphere", "autopsy", "Babylon",
    "backwater", "barbecue", "belowground", "bifocals", "bodyguard", "bookseller", "borderline", "bottomless",
    "Bradbury", "bravado", "Brazilian", "breakaway", "Burlington", "businessman", "butterfat", "Camelot", "candidate",
    "cannonball", "Capricorn", "caravan", "caretaker", "celebrate", "cellulose", "certify", "chambermaid", "Cherokee",
    "Chicago", "clergyman", "coherence", "combustion", "commando", "company", "component", "concurrent", "confidence",
    "conformist", "congregate", "consensus", "consulting", "corporate", "corrosion", "councilman", "crossover",
    "crucifix", "cumbersome", "customer", "Dakota", "decadence", "December", "decimal", "designing", "detector",
    "detergent", "determine", "dictator", "dinosaur", "direction", "disable", "disbelief", "disruptive", "distortion",
    "document", "embezzle", "enchanting", "enrollment", "enterprise", "equation", "equipment", "escapade", "Eskimo",
    "everyday", "examine", "existence", "exodus", "fascinate", "filament", "finicky", "forever", "fortitude",
    "frequency", "gadgetry", "Galveston", "getaway", "glossary", "gossamer", "graduate", "gravity", "guitarist",
    "hamburger", "Hamilton", "handiwork", "hazardous", "headwaters", "hemisphere", "hesitate", "hideaway", "holiness",
    "hurricane", "hydraulic", "impartial", "impetus", "inception", "indigo", "inertia", "infancy", "inferno",
    "informant", "insincere", "insurgent", "integrate", "intention", "inventive", "Istanbul", "Jamaica", "Jupiter",
    "leprosy", "letterhead", "liberty", "maritime", "matchmaker", "maverick", "Medusa", "megaton", "microscope",
    "microwave", "midsummer", "millionaire", "miracle", "misnomer", "molasses", "molecule", "Montana", "monument",
    "mosquito", "narrative", "nebula", "newsletter", "Norwegian", "October", "Ohio", "onlooker", "opulent", "Orlando",
    "outfielder", "Pacific", "pandemic", "Pandora", "paperweight", "paragon", "paragraph", "paramount", "passenger",
    "pedigree", "Pegasus", "penetrate", "perceptive", "performance", "pharmacy", "phonetic", "photograph", "pioneer",
    "pocketful", "politeness", "positive", "potato", "processor", "provincial", "proximate", "puberty", "publisher",
    "pyramid", "quantity", "racketeer", "rebellion", "recipe", "recover", "repellent", "replica", "reproduce",
    "resistor", "responsive", "retraction", "retrieval", "retrospect", "revenue", "revival", "revolver", "sandalwood",
    "sardonic", "Saturday", "savagery", "scavenger", "sensation", "sociable", "souvenir", "specialist", "speculate",
    "stethoscope", "stupendous", "supportive", "surrender", "suspicious", "sympathy", "tambourine", "telephone",
    "therapist", "tobacco", "tolerance", "tomorrow", "torpedo", "tradition", "travesty", "trombonist", "truncated",
    "typewriter", "ultimate", "undaunted", "underfoot", "unicorn", "unify", "universe", "unravel", "upcoming",
    "vacancy", "vagabond", "vertigo", "Virginia", "visitor", "vocalist", "voyager", "warranty", "Waterloo", "whimsical",
    "Wichita", "Wilmington", "Wyoming", "yesteryear", "Yucat\u00e1n",
)
PGP_EVEN_SET = frozenset(PGP_EVEN)
PGP_ODD_SET = frozenset(PGP_ODD)

# ---- the QR code, drawn here by root from the checked link (Fable R5-1) ---------------------------------------------------
# QR Code Model 2 (ISO/IEC 18004), byte mode, error correction level M, versions 1 to 10 (up to 213 bytes: an enroll link
# is under 120). Checked in scripts/windows-distro.test.ts against the bridge's own encoder (uqr) for every mask.
_M = {  # version: (EC codewords per block, [(blocks, data codewords per block), ...])
    1: (10, [(1, 16)]), 2: (16, [(1, 28)]), 3: (26, [(1, 44)]), 4: (18, [(2, 32)]), 5: (24, [(2, 43)]),
    6: (16, [(4, 27)]), 7: (18, [(4, 31)]), 8: (22, [(2, 38), (2, 39)]), 9: (22, [(3, 36), (2, 37)]),
    10: (26, [(4, 43), (1, 44)]),
}
_ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42],
          9: [6, 26, 46], 10: [6, 28, 50]}
_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _rs(data, n):
    """Reed-Solomon error correction codewords over GF(256), generator with roots a^0 .. a^(n-1)."""
    gen = [1]
    for i in range(n):
        nxt = [0] * (len(gen) + 1)
        for j, g in enumerate(gen):
            nxt[j] ^= g
            if g:
                nxt[j + 1] ^= _EXP[_LOG[g] + i]
        gen = nxt
    rem = [0] * n
    for b in data:
        f = b ^ rem[0]
        rem = rem[1:] + [0]
        if f:
            for j in range(n):
                if gen[j + 1]:
                    rem[j] ^= _EXP[_LOG[gen[j + 1]] + _LOG[f]]
    return rem


def _bch(value, poly):
    deg = poly.bit_length() - 1
    v = value << deg
    while v.bit_length() > deg:
        v ^= poly << (v.bit_length() - poly.bit_length())
    return (value << deg) | v


def _mask_bit(m, r, c):
    if m == 0:
        return (r + c) % 2 == 0
    if m == 1:
        return r % 2 == 0
    if m == 2:
        return c % 3 == 0
    if m == 3:
        return (r + c) % 3 == 0
    if m == 4:
        return (r // 2 + c // 3) % 2 == 0
    if m == 5:
        return (r * c) % 2 + (r * c) % 3 == 0
    if m == 6:
        return ((r * c) % 2 + (r * c) % 3) % 2 == 0
    return ((r + c) % 2 + (r * c) % 3) % 2 == 0


def _penalty(g):
    n = len(g)
    p = 0
    for lines in (g, [list(col) for col in zip(*g)]):
        for row in lines:
            run, prev = 0, None
            for v in row:
                if v == prev:
                    run += 1
                else:
                    if run >= 5:
                        p += run - 2
                    run, prev = 1, v
            if run >= 5:
                p += run - 2
            s = "".join("1" if v else "0" for v in row)
            p += 40 * (len(re.findall(r"(?=10111010000)", s)) + len(re.findall(r"(?=00001011101)", s)))
    for r in range(n - 1):
        for c in range(n - 1):
            if g[r][c] == g[r][c + 1] == g[r + 1][c] == g[r + 1][c + 1]:
                p += 3
    dark = sum(sum(1 for v in row if v) for row in g)
    p += abs(dark * 20 - n * n * 10) // (n * n) * 10
    return p


def qr_rows(text, mask=None):
    """The QR matrix of text as rows of '0' and '1', with no border; [] if it does not fit version 10-M."""
    data = text.encode("utf-8")
    for ver in range(1, 11):
        ec, groups = _M[ver]
        cap = sum(b * d for b, d in groups)
        if 4 + (8 if ver < 10 else 16) + 8 * len(data) <= cap * 8:
            break
    else:
        return []
    bits = [0, 1, 0, 0] + [(len(data) >> i) & 1 for i in reversed(range(8 if ver < 10 else 16))]
    for b in data:
        bits += [(b >> i) & 1 for i in reversed(range(8))]
    bits += [0] * min(4, cap * 8 - len(bits))
    bits += [0] * (-len(bits) % 8)
    words = [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    pad = [0xEC, 0x11]
    i = 0
    while len(words) < cap:
        words.append(pad[i % 2])
        i += 1
    blocks, k = [], 0
    for b, d in groups:
        for _ in range(b):
            blocks.append(words[k:k + d])
            k += d
    eccs = [_rs(b, ec) for b in blocks]
    final = []
    for i in range(max(len(b) for b in blocks)):
        final += [b[i] for b in blocks if i < len(b)]
    for i in range(ec):
        final += [e[i] for e in eccs]
    n = 17 + 4 * ver
    g = [[False] * n for _ in range(n)]
    fn = [[False] * n for _ in range(n)]

    def put(r, c, v):
        g[r][c] = v
        fn[r][c] = True

    for (r0, c0) in ((0, 0), (0, n - 7), (n - 7, 0)):
        for r in range(-1, 8):
            for c in range(-1, 8):
                rr, cc = r0 + r, c0 + c
                if 0 <= rr < n and 0 <= cc < n:
                    put(rr, cc, 0 <= r <= 6 and 0 <= c <= 6 and (r in (0, 6) or c in (0, 6) or (2 <= r <= 4 and 2 <= c <= 4)))
    for i in range(8, n - 8):
        put(6, i, i % 2 == 0)
        put(i, 6, i % 2 == 0)
    a = _ALIGN[ver]
    for r in a:
        for c in a:
            # only the three finder corners go without one; those on the timing lines are drawn over them
            if (r, c) in ((a[0], a[0]), (a[0], a[-1]), (a[-1], a[0])):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    put(r + dr, c + dc, max(abs(dr), abs(dc)) != 1)
    for i in range(9):  # the format areas, reserved here and filled per mask
        if not fn[8][i]:
            put(8, i, False)
        if not fn[i][8]:
            put(i, 8, False)
    for i in range(8):
        put(8, n - 1 - i, False)
        put(n - 1 - i, 8, False)
    put(n - 8, 8, True)  # the dark module
    if ver >= 7:
        vbits = _bch(ver, 0x1F25)
        for i in range(18):
            v = (vbits >> i) & 1 == 1
            put(n - 11 + i % 3, i // 3, v)
            put(i // 3, n - 11 + i % 3, v)
    allbits = [(w >> i) & 1 for w in final for i in reversed(range(8))]
    k, up, c = 0, True, n - 1
    while c > 0:
        if c == 6:
            c -= 1
        for t in range(n):
            r = n - 1 - t if up else t
            for cc in (c, c - 1):
                if not fn[r][cc]:
                    g[r][cc] = k < len(allbits) and allbits[k] == 1
                    k += 1
        up = not up
        c -= 2

    def finish(m):
        h = [row[:] for row in g]
        for r in range(n):
            for cc in range(n):
                if not fn[r][cc] and _mask_bit(m, r, cc):
                    h[r][cc] = not h[r][cc]
        f = _bch(m, 0x537) ^ 0x5412  # level M's two bits are 00
        fb = [(f >> i) & 1 == 1 for i in range(15)]
        for i in range(6):
            h[i][8] = fb[i]
        h[7][8], h[8][8], h[8][7] = fb[6], fb[7], fb[8]
        for i in range(9, 15):
            h[8][14 - i] = fb[i]
        for i in range(8):
            h[8][n - 1 - i] = fb[i]
        for i in range(8, 15):
            h[n - 15 + i][8] = fb[i]
        h[n - 8][8] = True
        return h

    best = mask if mask is not None else min(range(8), key=lambda m: _penalty(finish(m)))
    return ["".join("1" if v else "0" for v in row) for row in finish(best)]


# ---- running enroll -----------------------------------------------------------------------------------------------------
def as_user(u):
    if os.getuid() == u.pw_uid:
        return
    os.initgroups(u.pw_name, u.pw_gid)
    os.setgid(u.pw_gid)
    os.setuid(u.pw_uid)


def group_others(pgid):
    """Members of the group other than its leader, from /proc (the leader itself may be an unreaped zombie)."""
    found = []
    for d in os.listdir("/proc"):
        if not d.isdigit() or int(d) == pgid:
            continue
        try:
            with open("/proc/%s/stat" % d, "rb") as f:
                st = f.read().decode("ascii", "replace")
            # pid (comm) state ppid pgrp ...: comm may hold spaces and brackets, so read from the last ')'
            fields = st[st.rindex(")") + 2:].split()
            if int(fields[2]) == pgid:
                found.append(int(d))
        except (OSError, ValueError, IndexError):
            continue
    return found


def leader_gone(pid):
    """Whether the leader has exited, WITHOUT reaping it: an unreaped zombie keeps its pid, and so the group's number,
    from being reused while root still signals the group (Fable R7-5 on 9612c7d7)."""
    try:
        return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except ChildProcessError:
        return True


def end_session(pid):
    """enroll's whole session ended (Fable R5-3, R6-2, R7-5): TERM to its group (the contract's cancel: the code stays
    unused); then KILL to the group for as long as any member is left, the leader included; the leader is reaped only after
    the group is gone, so its number is never reused under root's signals. Every wait bounded. Returns the leader's exit
    status, or None."""
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass
    end = time.time() + 3.0
    while time.time() < end and not (leader_gone(pid) and not group_others(pid)):
        time.sleep(0.05)
    end = time.time() + 3.0
    while time.time() < end and not (leader_gone(pid) and not group_others(pid)):
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            break
        time.sleep(0.05)
    # now, and only now, the leader is reaped
    end = time.time() + 1.0
    while time.time() < end:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return None
        if done:
            return status
        time.sleep(0.05)
    return None


def to_enroll(fd, b):
    """An answer to enroll; enroll gone (EIO) is no exception: the loop then sees the pty closed and ends with an end event
    (Fable R1-4 on 0770142f)."""
    try:
        os.write(fd, b)
    except OSError:
        pass


def main():
    try:
        u = pwd.getpwnam(USER)
    except KeyError:
        say({"event": "error", "code": "internal"})
        sys.exit(1)
    relay = relay_url()
    if not relay:
        # no relay URL of root's own: nothing a link could be checked against, so no pairing
        say({"event": "error", "code": "no_relay"})
        sys.exit(1)
    app = (os.environ.get("TALOS_PAIR_APP") if TESTING else None) or os.path.join(u.pw_dir, ".bun", "bin", "talos-app")
    env = {"HOME": u.pw_dir, "USER": USER, "LOGNAME": USER, "TERM": "dumb",
           "PATH": os.path.join(u.pw_dir, ".bun", "bin") + ":" + os.path.join(u.pw_dir, ".local", "bin") + ":/usr/local/bin:/usr/bin:/bin"}
    pid, fd = pty.fork()  # the child leads a session (and a process group) of its own
    if pid == 0:
        try:
            as_user(u)
            os.chdir(u.pw_dir)
            os.execve(app, [app, "enroll", "--json"], env)
        finally:
            os._exit(127)
    signal.signal(signal.SIGTERM, lambda *a: (end_session(pid), os._exit(1)))
    buf, inbuf = b"", b""
    end = time.time() + TOTAL_S
    confirmed = answered_yes = ended = False
    confirm_at = None
    stdin_open = True
    status = None
    try:
        while time.time() < end:
            r, _, _ = select.select([fd] + ([0] if stdin_open else []), [], [], 0.5)
            if 0 in r:
                chunk = os.read(0, 4096)
                if not chunk:
                    # the window closed: an open question is answered no, and the pairing stops
                    stdin_open = False
                    if confirm_at is not None:
                        try:
                            os.write(fd, b"n\r")
                        except OSError:
                            pass
                    break
                inbuf += chunk
                while b"\n" in inbuf:
                    line, inbuf = inbuf.split(b"\n", 1)
                    # a line before `confirm`, or a second one after the answer, is no answer at all
                    if confirm_at is not None:
                        answered_yes = line.strip() == b"y"
                        # never sooner than 600 ms after enroll's question, whatever the tray does: enroll counts a `y`
                        # within 500 ms of `confirm` as typed ahead, a no (docs/bridge.md)
                        early = confirm_at + 0.6 - time.time()
                        if early > 0:
                            time.sleep(early)
                        to_enroll(fd, b"y\r" if answered_yes else b"n\r")
                        confirm_at = None
                if len(inbuf) > LINE_MAX:
                    inbuf = b""
            if confirm_at is not None and time.time() - confirm_at > ANSWER_WAIT_S:
                to_enroll(fd, b"n\r")
                confirm_at = None
            if fd not in r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                break
            buf += chunk
            stop = False
            while b"\n" in buf and not stop:
                line, buf = buf.split(b"\n", 1)
                line = line.rstrip(b"\r").strip()
                # only lines that start with `{`: the pty also echoes what is written to it
                if not line.startswith(b"{") or len(line) > LINE_MAX:
                    continue
                try:
                    e = checked(json.loads(line.decode("utf-8")), relay)
                except (ValueError, UnicodeDecodeError):
                    e = None
                if e is None:
                    continue
                if e["event"] == "warning":
                    # no live bridge: no link, no QR, nothing a phone could enrol with; enroll's code stays unused
                    e = {"event": "error", "code": "not-ready"}
                if e["event"] == "confirm":
                    if confirmed:
                        continue  # one question only: a second confirm is never asked
                    confirmed = True
                    confirm_at = time.time()
                if e["event"] == "pinned" and not (confirmed and answered_yes):
                    # "Paired" only after a confirm the person answered yes (Fable R5-2)
                    e = {"event": "error", "code": "internal"}
                say(e)
                if e["event"] == "link":
                    say({"event": "qr", "rows": qr_rows(e["link"])})
                # every end state ends it (Fable R6-5): nothing enroll prints after one is passed on
                if e["event"] in ("error", "pinned", "not_pinned", "used", "expired") or (e["event"] == "answered" and not e["yes"]):
                    stop = ended = True
            if stop:
                break
            if len(buf) > LINE_MAX:
                buf = b""
    finally:
        status = end_session(pid)
    if not ended and stdin_open:
        # enroll stopped with no end state of the contract's (found live on Titan: an older talos-app with no --json
        # printed one plain line and left): never a silent end, the window says pairing stopped. Root's own time limit
        # is an expiry, as the window says it (Fable R1-4 on 0770142f)
        say({"event": "expired"} if time.time() >= end else {"event": "error", "code": "enroll"})
    sys.exit(0 if status is not None and os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0 else 1)


if __name__ == "__main__":
    main()
