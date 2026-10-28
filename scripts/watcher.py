#!/usr/bin/env python3
"""watcher.py: quiet check-ins. Silent unless a bar is crossed; no model, no network unless you configure an ICS URL.

    python3 scripts/watcher.py [--job am|mid|pm|eve] [--dry-run] [--explain]

Three checks, each optional:
  1. SOON      a calendar event starts inside the next `soon_minutes` (default 150).
  2. DEADLINE  a dated row in memory/STATE.md (and any `deadline_files` you list) falls inside the next 48 hours.
  3. CHANGED   an event in the next 24 hours is new, moved or cancelled since the previous run.

Nothing crosses a bar: print nothing, exit 0. Something does: build ONE plain-text message of at most 60 words and
hand it to your notify command (TALOS_NOTIFY_CMD, else the "notify" path in your Chronos config). The calendar title of
the event IS in that message, so it goes to your own notify channel: read setup/quiet-checkins.md first.

Calendar source (config ${XDG_CONFIG_HOME:-~/.config}/talos/watcher.json, default none):
    {"calendar": {"type": "ics", "url": "https://example.com/cal.ics"}}          webcal:// works too
    {"calendar": {"type": "ics", "path": "~/calendars/work.ics"}}
    {"calendar": {"type": "command", "command": "bash {{TALOS_HOME}}/scripts/watcher-adapters/macos-calendar.sh"}}
    optional keys: "timezone": "Area/City" (default: the system timezone), "soon_minutes": 150, "changes_hours": 24,
                   "deadline_hours": 48, "track_days": 7, "state_file": "memory/STATE.md", "deadline_files": ["wiki/x.md"],
                   "deadlines": false (turn the STATE.md source off; it is on once a config file exists)
A command source prints either an ICS document or a JSON list of {"uid"?, "title", "start": ISO-8601, "all_day"?}.

ICS support (documented limits): VEVENT with DTSTART as UTC (Z), TZID=<IANA name>, floating, or VALUE=DATE (all-day);
RRULE with FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, BYDAY (daily/weekly; plain weekdays only), BYMONTHDAY (monthly),
UNTIL, COUNT; EXDATE; RECURRENCE-ID overrides; STATUS:CANCELLED. NOT supported: BYDAY with an ordinal ("1MO", "-1FR"),
BYSETPOS, BYWEEKNO, BYYEARDAY, RDATE, SECONDLY..HOURLY, Windows time-zone names (treated as floating, with a warning),
VTIMEZONE blocks (the IANA name in TZID is used instead). An unsupported rule yields just the first occurrence.

State: ${XDG_STATE_HOME:-~/.local/state}/talos/<folder>-<hash>/watcher-seen.json, the same folder the hooks use. This
script writes nothing else, nowhere else, and never reads a personal vault. Python 3.9, standard library only.
Test hook: TALOS_WATCHER_NOW=<ISO-8601 with offset> pins "now"; TALOS_WATCHER_CONFIG=<file> pins the config path.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.realpath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "hooks"))
try:
    import _talos_common as C
    STATE_DIR = C.state_dir()
except Exception:                                   # same recipe as hooks/_talos_common.py, kept in sync by hand
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    STATE_DIR = os.path.join(base, "talos", "%s-%s" % (os.path.basename(ROOT) or "agent",
                                                       hashlib.sha1(ROOT.encode("utf-8")).hexdigest()[:8]))

try:
    from zoneinfo import ZoneInfo
except Exception:                                   # Python 3.9 has it; a minimal build may not
    ZoneInfo = None

UTC = dt.timezone.utc
WARNINGS = []
MAX_WORDS = 60
DEFAULTS = {"soon_minutes": 150, "changes_hours": 24, "deadline_hours": 48, "track_days": 7}
CLOSED_SECTIONS = re.compile(r"recently closed|closed|done|archive|completed", re.I)
DONE_ROW = re.compile(r"\b(?:done|closed|shipped|resolved|complete[d]?|finished|merged|killed)\b|~~", re.I)
DATE_RX = re.compile(r"\b(20\d\d)-(\d\d)-(\d\d)\b")


def warn(msg):
    if msg not in WARNINGS:
        WARNINGS.append(msg)


# --------------------------------------------------------------------------- config
def config_path():
    return os.environ.get("TALOS_WATCHER_CONFIG") or os.path.join(
        os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "talos", "watcher.json")


def load_config():
    """(config dict, error string or ''). A missing file is not an error: it means no sources."""
    p = config_path()
    try:
        with open(p, encoding="utf-8") as fh:
            cfg = json.load(fh)
        if not isinstance(cfg, dict):
            return {}, "%s is not a JSON object" % p
        return cfg, ""
    except FileNotFoundError:
        return {}, ""
    except Exception as e:
        return {}, "cannot read %s: %s" % (p, e)


def setting(cfg, key):
    try:
        return int(cfg.get(key, DEFAULTS[key]))
    except (TypeError, ValueError):
        return DEFAULTS[key]


def display_tz(cfg):
    """A tzinfo for the configured timezone name, or None meaning 'the system timezone'."""
    name = cfg.get("timezone")
    if not name:
        return None
    if ZoneInfo is None:
        warn("zoneinfo is unavailable; using the system timezone")
        return None
    try:
        return ZoneInfo(str(name))
    except Exception:
        warn("unknown timezone %r in watcher.json; using the system timezone" % name)
        return None


def now_utc():
    pinned = os.environ.get("TALOS_WATCHER_NOW")
    if pinned:
        d = dt.datetime.fromisoformat(pinned.replace("Z", "+00:00"))
        return d.astimezone(UTC) if d.tzinfo else d.astimezone().astimezone(UTC)
    return dt.datetime.now(UTC)


def localize(naive, tz):
    """Wall-clock naive datetime in tz (None = the system zone, DST rules included) -> aware UTC."""
    if tz is None:
        return naive.astimezone().astimezone(UTC)
    return naive.replace(tzinfo=tz).astimezone(UTC)


def to_local(d_utc, tz):
    return d_utc.astimezone(tz) if tz is not None else d_utc.astimezone()


# --------------------------------------------------------------------------- ICS parsing
def unfold(text):
    out = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line[:1] in (" ", "\t") and out:
            out[-1] += line[1:]
        else:
            out.append(line)
    return out


def unescape(s):
    return s.replace("\\n", " ").replace("\\N", " ").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def parse_prop(line):
    """'DTSTART;TZID=X:2026...' -> (NAME, {param: value}, value)."""
    if ":" not in line:
        return None
    head, value = line.split(":", 1)
    parts = head.split(";")
    params = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.strip('"')
    return parts[0].upper(), params, value


def parse_dt(value, params, cfg_tz):
    """-> (aware UTC datetime, all_day bool, wall naive datetime, tzinfo-or-None-for-local). None on failure."""
    v = value.strip()
    try:
        if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", v):
            d = dt.datetime.strptime(v[:8], "%Y%m%d")
            return localize(d, cfg_tz), True, d, cfg_tz
        if v.endswith("Z"):
            d = dt.datetime.strptime(v[:-1], "%Y%m%dT%H%M%S")
            return d.replace(tzinfo=UTC), False, d, UTC
        d = dt.datetime.strptime(v, "%Y%m%dT%H%M%S")
    except ValueError:
        return None
    tzid = params.get("TZID")
    if tzid and ZoneInfo is not None:
        try:
            z = ZoneInfo(tzid)
            return d.replace(tzinfo=z).astimezone(UTC), False, d, z
        except Exception:
            warn("time zone %r is not an IANA name; those events are treated as local time" % tzid)
    elif tzid:
        warn("zoneinfo is unavailable; TZID events are treated as local time")
    return localize(d, cfg_tz), False, d, cfg_tz


def parse_until(value, cfg_tz):
    v = value.strip()
    try:
        if v.endswith("Z"):
            return dt.datetime.strptime(v[:-1], "%Y%m%dT%H%M%S").replace(tzinfo=UTC)
        if "T" in v:
            return localize(dt.datetime.strptime(v, "%Y%m%dT%H%M%S"), cfg_tz)
        return localize(dt.datetime.strptime(v, "%Y%m%d") + dt.timedelta(days=1, seconds=-1), cfg_tz)
    except ValueError:
        return None


def read_vevents(text, cfg_tz):
    events, cur = [], None
    for line in unfold(text):
        u = line.strip().upper()
        if u == "BEGIN:VEVENT":
            cur = {"ex": []}
            continue
        if u == "END:VEVENT":
            if cur is not None and cur.get("start") is not None:
                events.append(cur)
            cur = None
            continue
        if cur is None:
            continue
        pr = parse_prop(line)
        if not pr:
            continue
        name, params, value = pr
        if name == "DTSTART":
            r = parse_dt(value, params, cfg_tz)
            if r:
                cur["start"], cur["all_day"], cur["wall"], cur["tz"] = r
        elif name == "SUMMARY":
            cur["title"] = unescape(value).strip()
        elif name == "UID":
            cur["uid"] = value.strip()
        elif name == "STATUS":
            cur["cancelled"] = value.strip().upper() == "CANCELLED"
        elif name == "RRULE":
            cur["rrule"] = value.strip()
        elif name == "EXDATE":
            for part in value.split(","):
                r = parse_dt(part, params, cfg_tz)
                if r:
                    cur["ex"].append(r[0])
        elif name == "RECURRENCE-ID":
            r = parse_dt(value, params, cfg_tz)
            if r:
                cur["rid"] = r[0]
    return events


WD = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


def parse_rrule(s):
    r = {}
    for part in s.split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            r[k.upper()] = v
    return r


def wall_occurrences(ev, horizon_wall):
    """Yield naive wall-clock occurrences >= DTSTART up to horizon_wall (a naive datetime), from a supported RRULE."""
    d0 = ev["wall"]
    rule = parse_rrule(ev["rrule"])
    freq = rule.get("FREQ", "").upper()
    try:
        interval = max(1, int(rule.get("INTERVAL", "1")))
    except ValueError:
        interval = 1
    byday_raw = [x for x in rule.get("BYDAY", "").split(",") if x]
    if any(not re.fullmatch(r"[A-Z]{2}", x.upper()) for x in byday_raw):
        warn("RRULE with an ordinal BYDAY (e.g. 1MO) is not supported: only the first occurrence is used")
        yield d0
        return
    byday = sorted(WD[x.upper()] for x in byday_raw if x.upper() in WD)
    for unsupported in ("BYSETPOS", "BYWEEKNO", "BYYEARDAY", "BYMONTH"):
        if unsupported in rule:
            warn("RRULE %s is not supported: only the first occurrence is used" % unsupported)
            yield d0
            return
    if freq not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY"):
        warn("RRULE FREQ=%s is not supported: only the first occurrence is used" % (freq or "?"))
        yield d0
        return
    count = None
    if "COUNT" in rule:
        try:
            count = int(rule["COUNT"])
        except ValueError:
            count = None
    t = d0.time()
    n = 0

    def cands():
        k = 0
        while True:
            if freq == "DAILY":
                d = d0.date() + dt.timedelta(days=k * interval)
                if not byday or d.weekday() in byday:
                    yield dt.datetime.combine(d, t)
            elif freq == "WEEKLY":
                monday = d0.date() - dt.timedelta(days=d0.weekday()) + dt.timedelta(weeks=k * interval)
                for wd in (byday or [d0.weekday()]):
                    yield dt.datetime.combine(monday + dt.timedelta(days=wd), t)
            elif freq == "MONTHLY":
                m0 = d0.year * 12 + d0.month - 1 + k * interval
                y, mo = divmod(m0, 12)
                days = []
                for x in (rule.get("BYMONTHDAY") or str(d0.day)).split(","):
                    try:
                        days.append(int(x))
                    except ValueError:
                        pass
                for day in sorted(days):
                    try:
                        yield dt.datetime(y, mo + 1, day, t.hour, t.minute, t.second)
                    except ValueError:
                        pass                                  # e.g. the 31st in a 30-day month: skipped, per RFC 5545
            else:
                try:
                    yield d0.replace(year=d0.year + k * interval)
                except ValueError:
                    pass
            k += 1
            if k > 20000:
                return

    until = parse_until(rule["UNTIL"], ev["tz"]) if "UNTIL" in rule else None
    for w in cands():
        if w < d0:
            continue
        if w > horizon_wall:
            return
        if until is not None and localize_event(w, ev) > until:
            return
        n += 1
        yield w
        if count is not None and n >= count:
            return


def localize_event(wall, ev):
    tz = ev["tz"]
    if tz is UTC:
        return wall.replace(tzinfo=UTC)
    return localize(wall, tz)


def expand_ics(text, cfg_tz, lo, hi):
    """VEVENTs -> flat list of {key, title, start(aware UTC), all_day} whose start is in [lo, hi]."""
    raw = read_vevents(text, cfg_tz)
    overrides = {}
    for e in raw:
        if e.get("rid") is not None:
            overrides[(e.get("uid", ""), e["rid"])] = e
    out = []

    def add(uid, key_when, e, start):
        if e.get("cancelled") or not (lo <= start <= hi):
            return
        out.append({"key": "%s|%s" % (uid or e.get("title", ""), key_when.strftime("%Y%m%dT%H%M%SZ")),
                    "title": e.get("title") or "(no title)", "start": start, "all_day": bool(e.get("all_day"))})

    for e in raw:
        uid = e.get("uid", "")
        if e.get("rid") is not None:
            continue                                         # handled through its master (or below, if orphaned)
        if not e.get("rrule"):
            add(uid, e["start"], e, e["start"])
            continue
        horizon_wall = (hi + dt.timedelta(days=2)).replace(tzinfo=None)
        for w in wall_occurrences(e, horizon_wall):
            occ = localize_event(w, e)
            if occ in e["ex"]:
                continue
            ov = overrides.pop((uid, occ), None)
            if ov is not None:
                add(uid, occ, ov, ov["start"])
            else:
                add(uid, occ, e, occ)
    for (uid, rid), ov in overrides.items():                 # overrides whose master was not in the file
        add(uid, rid, ov, ov["start"])
    return out


def parse_iso(v, cfg_tz):
    s = str(v).strip().replace("Z", "+00:00")
    if re.fullmatch(r"\d{4}-\d\d-\d\d", s):
        return localize(dt.datetime.strptime(s, "%Y-%m-%d"), cfg_tz), True
    d = dt.datetime.fromisoformat(s)
    return (d.astimezone(UTC) if d.tzinfo else localize(d, cfg_tz)), False


def events_from_json(text, cfg_tz, lo, hi):
    data = json.loads(text)
    if isinstance(data, dict):
        data = data.get("events", [])
    out = []
    for it in data:
        try:
            start, ad = parse_iso(it["start"], cfg_tz)
        except Exception:
            warn("an event from the command had no usable start and was skipped")
            continue
        if not (lo <= start <= hi):
            continue
        title = str(it.get("title") or "(no title)").strip()
        uid = str(it.get("uid") or hashlib.sha1((title + start.isoformat()).encode()).hexdigest()[:12])
        out.append({"key": "%s|%s" % (uid, "x" if it.get("uid") else start.strftime("%Y%m%dT%H%M%SZ")),
                    "title": title, "start": start, "all_day": bool(it.get("all_day", ad))})
    return out


# --------------------------------------------------------------------------- calendar sources
class SourceError(Exception):
    pass


def fetch_calendar(cfg, lo, hi, cfg_tz):
    """-> list of events, or raises SourceError with a short one-line reason. None config -> []."""
    cal = cfg.get("calendar") or {"type": "none"}
    typ = str(cal.get("type", "none")).lower()
    if typ == "none":
        return []
    if typ == "ics":
        if cal.get("url"):
            url = str(cal["url"]).replace("webcal://", "https://", 1)
            if not url.lower().startswith(("https://", "http://")):
                raise SourceError("calendar url must be http(s) or webcal")
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "talos-watcher"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    text = r.read(5_000_000).decode("utf-8", "replace")
            except Exception as e:
                raise SourceError("could not fetch the ICS url (%s)" % type(e).__name__)
        elif cal.get("path"):
            try:
                with open(os.path.expanduser(str(cal["path"])), encoding="utf-8", errors="replace") as fh:
                    text = fh.read(5_000_000)
            except OSError as e:
                raise SourceError("could not read the ICS file (%s)" % type(e).__name__)
        else:
            raise SourceError('calendar type "ics" needs "url" or "path"')
        return expand_ics(text, cfg_tz, lo, hi)
    if typ == "command":
        cmd = str(cal.get("command") or "").strip()
        if not cmd:
            raise SourceError('calendar type "command" needs "command"')
        cmd = cmd.replace("{{TALOS_HOME}}", shlex.quote(ROOT))
        try:
            env = dict(os.environ, WATCHER_FROM=lo.strftime("%Y-%m-%d"), WATCHER_TO=(hi + dt.timedelta(days=1)).strftime("%Y-%m-%d"))
            r = subprocess.run(shlex.split(os.path.expanduser(cmd)), capture_output=True, text=True, timeout=60, env=env)
        except subprocess.TimeoutExpired:
            raise SourceError("the calendar command timed out after 60 s")
        except (OSError, ValueError) as e:
            raise SourceError("the calendar command could not start (%s)" % type(e).__name__)
        if r.returncode != 0:
            reason = (r.stderr or r.stdout or "").strip().splitlines()
            raise SourceError("the calendar command failed (exit %d)%s" % (r.returncode, ": " + reason[0][:100] if reason else ""))
        out = r.stdout.strip()
        try:
            if out.upper().startswith("BEGIN:VCALENDAR"):
                return expand_ics(out, cfg_tz, lo, hi)
            if out[:1] in ("[", "{"):
                return events_from_json(out, cfg_tz, lo, hi)
            if not out:
                return []
        except Exception as e:
            raise SourceError("the calendar command output could not be parsed (%s)" % type(e).__name__)
        raise SourceError("the calendar command printed neither ICS nor JSON")
    raise SourceError("unknown calendar type %r (use none, ics or command)" % typ)


# --------------------------------------------------------------------------- deadlines
def row_text(row):
    s = DATE_RX.sub("", row)
    s = re.sub(r"[|*_`~#>\[\]]", " ", s)
    s = re.sub(r"^\s*[-+]\s+", "", s)
    s = re.sub(r"\s+", " ", s).strip(" -:")
    return " ".join(s.split()[:7]) or "(untitled row)"


def deadline_items(cfg, now, tz):
    """Dated rows inside the next deadline_hours. Returns (items, sources_used). Item = (date, text, key)."""
    files = [os.path.join(ROOT, str(cfg.get("state_file") or os.path.join("memory", "STATE.md")))]
    for f in cfg.get("deadline_files") or []:
        files.append(os.path.join(ROOT, str(f)))
    today = to_local(now, tz).date()
    last = to_local(now + dt.timedelta(hours=setting(cfg, "deadline_hours")), tz).date()
    items, used = [], []
    for p in files:
        p = os.path.realpath(p)
        if not (p == ROOT or p.startswith(ROOT + os.sep)) or not os.path.isfile(p):
            continue                                              # only files inside the agent folder; a missing one is fine
        try:
            text = open(p, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        used.append(os.path.relpath(p, ROOT))
        section = ""
        for line in text.splitlines():
            m = re.match(r"^#{1,4}\s+(.+)$", line)
            if m:
                section = m.group(1)
                continue
            s = line.strip()
            if not s or s.startswith(">") or CLOSED_SECTIONS.search(section):
                continue
            if not (s.startswith("|") or re.match(r"^[-*+]\s+\S", s)):
                continue
            if DONE_ROW.search(s):
                continue
            for dm in DATE_RX.finditer(s):
                try:
                    d = dt.date(int(dm.group(1)), int(dm.group(2)), int(dm.group(3)))
                except ValueError:
                    continue
                if today <= d <= last:
                    txt = row_text(s)
                    items.append((d, txt, "deadline|%s|%s" % (hashlib.sha1(txt.encode()).hexdigest()[:10], d.isoformat())))
                    break
    items.sort()
    return items, used


# --------------------------------------------------------------------------- seen-state
def seen_path():
    return os.path.join(STATE_DIR, "watcher-seen.json")


def load_seen():
    try:
        with open(seen_path(), encoding="utf-8") as fh:
            d = json.load(fh)
        if isinstance(d, dict):
            return d
    except (OSError, ValueError):
        pass
    return {}


def save_seen(d):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = seen_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, indent=1, sort_keys=True)
    os.replace(tmp, seen_path())


# --------------------------------------------------------------------------- message
def clean(t):
    return re.sub(r"[*_`\[\]~#]", "", t).strip()


def clip_title(t, n=5):
    w = clean(t).split()
    return " ".join(w[:n]) + ("..." if len(w) > n else "")


def fmt_clock(d_utc, tz):
    return to_local(d_utc, tz).strftime("%H:%M")


def fmt_day(d_utc, tz, now):
    a, b = to_local(d_utc, tz).date(), to_local(now, tz).date()
    return "today" if a == b else ("tomorrow" if (a - b).days == 1 else a.strftime("%a"))


def build_message(job, soon, deadlines, changes, errors, tz, now):
    parts = []
    for e in soon[:3]:
        mins = int((e["start"] - now).total_seconds() // 60)
        parts.append("%s %s (in %dm)." % (fmt_clock(e["start"], tz), clip_title(e["title"]), max(mins, 0)))
    for d, txt, _ in deadlines[:3]:
        parts.append("Due %s: %s." % (d.strftime("%a %m-%d"), clip_title(txt, 6)))
    for kind, e, old in changes[:3]:
        if kind == "moved":
            parts.append("Moved: %s to %s %s." % (clip_title(e["title"], 4), fmt_day(e["start"], tz, now), fmt_clock(e["start"], tz)))
        elif kind == "new":
            parts.append("New: %s %s %s." % (clip_title(e["title"], 4), fmt_day(e["start"], tz, now), fmt_clock(e["start"], tz)))
        else:
            parts.append("Cancelled: %s." % clip_title(e["title"], 4))
    for er in errors[:1]:
        parts.append("Calendar source problem: %s." % er)
    head = "Talos %s check-in." % job if job else "Talos check-in."
    words = (head + " " + " ".join(parts)).split()
    if len(words) > MAX_WORDS:
        words = words[:MAX_WORDS - 1] + ["..."]
    return " ".join(words)


# --------------------------------------------------------------------------- notify
def notify_command():
    cmd = os.environ.get("TALOS_NOTIFY_CMD", "").strip()
    if cmd:
        return cmd
    try:
        p = os.environ.get("CHRONOS_CONFIG") or os.path.expanduser("~/.config/chronos/config.json")
        with open(os.path.expanduser(p), encoding="utf-8") as fh:
            return str(json.load(fh).get("notify") or "").strip()
    except Exception:
        return ""


def deliver(msg):
    """True when the notify command accepted the message. Prints one stderr line on failure; never raises."""
    cmd = notify_command()
    if not cmd:
        sys.stderr.write("watcher: a bar was crossed but no notify command is configured (TALOS_NOTIFY_CMD or the Chronos 'notify' path).\n")
        print(msg)
        return False
    try:
        r = subprocess.run(shlex.split(os.path.expanduser(cmd)) + [msg], capture_output=True, text=True, timeout=60)
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        sys.stderr.write("watcher: notify command failed to run (%s)\n" % type(e).__name__)
        return False
    if r.returncode != 0:
        sys.stderr.write("watcher: notify command exited %d\n" % r.returncode)
        return False
    return True


# --------------------------------------------------------------------------- main
def deadlines_active(cfg):
    """The STATE.md source is opt-in by having a config file at all (an empty {} is enough); "deadlines": false turns it off."""
    if not os.path.isfile(config_path()) or cfg.get("deadlines", True) is False:
        return False
    state_rel = str(cfg.get("state_file") or os.path.join("memory", "STATE.md"))
    return os.path.isfile(os.path.join(ROOT, state_rel)) or bool(cfg.get("deadline_files"))


def explain(cfg, err):
    cal = (cfg.get("calendar") or {}) if cfg else {}
    typ = str(cal.get("type", "none")).lower() if cal else "none"
    state_rel = str(cfg.get("state_file") or os.path.join("memory", "STATE.md")) if cfg else os.path.join("memory", "STATE.md")
    state_file = os.path.join(ROOT, state_rel)
    deadlines_on = deadlines_active(cfg)
    lines = ["config file: %s (%s)" % (config_path(), "found" if os.path.isfile(config_path()) else "not found")]
    if err:
        lines.append("config problem: %s" % err)
    lines.append("seen-state: %s" % seen_path())
    lines.append("timezone: %s" % (cfg.get("timezone") or "system default"))
    lines.append("notify: %s" % (notify_command() or "none configured (TALOS_NOTIFY_CMD or Chronos 'notify')"))
    lines.append("calendar source: %s" % (typ if typ != "none" else "none"))
    lines.append("deadline source: %s (%s)" % (state_rel, "active" if deadlines_on else "inactive: needs a config file and the file present"))
    lines.append("windows: soon %d min, changes %d h, deadlines %d h, tracking %d days" % tuple(
        setting(cfg, k) for k in ("soon_minutes", "changes_hours", "deadline_hours", "track_days")))
    active = []
    if typ != "none":
        active.append("calendar (%s)" % typ)
    if deadlines_on:
        active.append("deadlines (%s)" % state_rel)
    lines.append("active sources: %s" % (", ".join(active) if active else "none"))
    if not active:
        lines.append("no sources configured")
    return "\n".join(lines)


def run(args):
    cfg, cfg_err = load_config()
    if args.explain:
        print(explain(cfg, cfg_err))
        return 0
    if cfg_err:
        sys.stderr.write("watcher: %s\n" % cfg_err)
        return 1
    now = now_utc()
    tz = display_tz(cfg)
    cal_on = str((cfg.get("calendar") or {}).get("type", "none")).lower() != "none"
    state_rel = str(cfg.get("state_file") or os.path.join("memory", "STATE.md"))
    dl_on = deadlines_active(cfg)
    if not cal_on and not dl_on:
        return 0                                                  # unconfigured: silent

    seen = load_seen()
    alerted = seen.get("alerted") if isinstance(seen.get("alerted"), dict) else {}
    horizon = now + dt.timedelta(days=max(1, setting(cfg, "track_days")))
    events, errors = None, []
    if cal_on:
        try:
            events = fetch_calendar(cfg, now - dt.timedelta(minutes=1), horizon, tz)
        except SourceError as e:
            sig = hashlib.sha1(str(e).encode()).hexdigest()[:10]
            if seen.get("last_error") != sig:                     # report a given failure once, not every run
                errors.append(str(e))
            seen["last_error"] = sig
            sys.stderr.write("watcher: %s\n" % e)
        except Exception as e:                                    # a parser bug must not become a traceback
            errors.append("calendar parsing failed (%s)" % type(e).__name__)
            sys.stderr.write("watcher: calendar parsing failed (%s)\n" % type(e).__name__)

    soon, changes, snapshot = [], [], None
    new_alerts = {}
    if events is not None:
        seen.pop("last_error", None)
        snapshot = {e["key"]: {"start": e["start"].isoformat(), "title": e["title"]} for e in events}
        soon_end = now + dt.timedelta(minutes=setting(cfg, "soon_minutes"))
        for e in sorted(events, key=lambda x: x["start"]):
            k = "soon|%s|%s" % (e["key"], e["start"].isoformat())
            if not e["all_day"] and now <= e["start"] <= soon_end and k not in alerted:
                soon.append(e)
                new_alerts[k] = now.isoformat()
        prev = seen.get("events")
        if isinstance(prev, dict):                                # no baseline on the first run: record, do not alert
            ch_end = now + dt.timedelta(hours=setting(cfg, "changes_hours"))
            adds, gone = [], []
            for k, e in ((e["key"], e) for e in events):
                if k not in prev:
                    if e["start"] <= ch_end:
                        adds.append(e)
                else:
                    old = dt.datetime.fromisoformat(prev[k]["start"])
                    if old != e["start"] and (old <= ch_end or e["start"] <= ch_end):
                        changes.append(("moved", e, old))
            for k, v in prev.items():
                if k not in snapshot:
                    old = dt.datetime.fromisoformat(v["start"])
                    if now <= old <= ch_end:
                        gone.append({"title": v["title"], "start": old, "all_day": False})
            for a in adds:                                        # same title gone and added = a move by a source with no stable uid
                m = next((g for g in gone if g["title"] == a["title"]), None)
                if m:
                    gone.remove(m)
                    changes.append(("moved", a, m["start"]))
                else:
                    changes.append(("new", a, None))
            for g in gone:
                changes.append(("cancelled", g, None))
            changes = [c for c in changes if "chg|%s" % hashlib.sha1(
                ("%s|%s|%s" % (c[0], c[1]["title"], c[1]["start"].isoformat())).encode()).hexdigest()[:12] not in alerted]
            for c in changes:
                new_alerts["chg|%s" % hashlib.sha1(("%s|%s|%s" % (c[0], c[1]["title"], c[1]["start"].isoformat())).encode()).hexdigest()[:12]] = now.isoformat()

    deadlines = []
    if dl_on:
        items, _ = deadline_items(cfg, now, tz)
        for it in items:
            if it[2] not in alerted:
                deadlines.append(it)
                new_alerts[it[2]] = now.isoformat()

    if not (soon or deadlines or changes or errors):
        if args.dry_run:
            sys.stderr.write("watcher: dry run, nothing crossed a bar\n")
        else:
            commit(seen, snapshot, alerted, new_alerts, now, args.job)
        for w in WARNINGS:
            sys.stderr.write("watcher: %s\n" % w)
        return 0

    msg = build_message(args.job, soon, deadlines, changes, errors, tz, now)
    for w in WARNINGS:
        sys.stderr.write("watcher: %s\n" % w)
    if args.dry_run:
        print(msg)
        return 0
    if deliver(msg):
        commit(seen, snapshot, alerted, new_alerts, now, args.job)
        return 0
    return 1


def commit(seen, snapshot, alerted, new_alerts, now, job):
    """Persist after a successful run (or delivery). A failed delivery leaves state alone so the next run retries."""
    cutoff = now - dt.timedelta(days=14)
    kept = {}
    for k, v in list(alerted.items()) + list(new_alerts.items()):
        try:
            if dt.datetime.fromisoformat(v) >= cutoff:
                kept[k] = v
        except ValueError:
            pass
    seen["alerted"] = kept
    if snapshot is not None:
        seen["events"] = snapshot
    seen["last_run"] = now.isoformat()
    if job:
        seen.setdefault("jobs", {})[job] = now.isoformat()        # the per-job marker
    try:
        save_seen(seen)
    except OSError as e:
        sys.stderr.write("watcher: could not write the seen-state file (%s)\n" % type(e).__name__)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Quiet check-ins: silent unless a bar is crossed.")
    ap.add_argument("--job", choices=["am", "mid", "pm", "eve"], default="", help="label for the message and the marker")
    ap.add_argument("--dry-run", action="store_true", help="print the message, send nothing, leave the seen-state untouched")
    ap.add_argument("--explain", action="store_true", help="show the config and which sources are active")
    args = ap.parse_args(argv)
    try:
        return run(args)
    except Exception as e:                                        # last resort: one line, never a traceback
        sys.stderr.write("watcher: unexpected error (%s: %s)\n" % (type(e).__name__, str(e)[:120]))
        return 1


if __name__ == "__main__":
    sys.exit(main())
