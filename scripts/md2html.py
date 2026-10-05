#!/usr/bin/env python3
"""md2html.py: turn a markdown report into ONE self-contained HTML page (and optionally embed an audio file).

    python3 scripts/md2html.py report.md                       -> report.html next to it
    python3 scripts/md2html.py report.md -o out.html --audio narration.m4a
    python3 scripts/md2html.py report.md --template brief --title "Weekly brief"

Why: a brief or a research write-up is nicer to read as a page than as raw markdown, and a page with a small audio
player is something you can listen to. The output has no external requests at all (no fonts, scripts or images
fetched), so it works offline and cannot phone home; a Content-Security-Policy meta tag enforces that.

Standard library only; a small built-in markdown converter handles headings, paragraphs, bold/italic, inline code,
fenced code blocks, links, blockquotes, bullet/numbered lists (one nesting level) and tables. Raw HTML in the source
is ESCAPED, never passed through, and links are limited to http(s), mailto and relative targets, because the text
being converted often came from somewhere else.

Templates: `report` (default; roomy, for reading) and `brief` (compact, for a phone). Both follow the system light
or dark setting. Branding comes from ~/.config/talos/brand.json (optional):
    {"name": "Acme Ops", "accent": "#2563eb", "logo": "/path/to/logo.png"}      logo: png/jpg/svg, up to 200 KB
Never put a secret in it; nothing in the page is secret, and the logo is embedded as a data URI.
"""
import argparse
import base64
import html
import json
import mimetypes
import os
import re
import sys

MAX_AUDIO = 8 * 1024 * 1024
MAX_LOGO = 200 * 1024
AUDIO_MIME = {".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".aiff": "audio/aiff"}
SAFE_LINK = re.compile(r"^(https?://|mailto:|#|/|\./|\.\./|[A-Za-z0-9_-]+(?:[./][^:]*)?$)", re.I)


# ----------------------------------------------------------------------------------------- inline markdown
def inline(text):
    text = html.escape(text, quote=False)
    codes = []

    def keep(m):
        codes.append("<code>%s</code>" % m.group(1))
        return "\x00%d\x00" % (len(codes) - 1)

    text = re.sub(r"`([^`]+)`", keep, text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])", r"<em>\1</em>", text)
    text = re.sub(r"(?<![\w_])_([^_\s][^_]*?)_(?![\w_])", r"<em>\1</em>", text)
    text = re.sub(r"~~([^~]+)~~", r"<del>\1</del>", text)

    def link(m):
        label, url = m.group(1), html.unescape(m.group(2)).strip()
        if not SAFE_LINK.match(url) or url.lower().startswith(("javascript:", "data:", "vbscript:")):
            return label                                   # drop an unsafe target, keep the words
        return '<a href="%s" rel="noopener noreferrer">%s</a>' % (html.escape(url, quote=True), label)

    text = re.sub(r"\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)", link, text)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], text)


# ----------------------------------------------------------------------------------------- block markdown
def convert(md):
    md = md.replace("\x00", "")        # a NUL would collide with the placeholder marks inline() uses for code spans
    lines = md.replace("\r\n", "\n").split("\n")
    out, i, n = [], 0, len(lines)
    title = None
    while i < n:
        line = lines[i]
        s = line.strip()
        if not s:
            i += 1
            continue
        m = re.match(r"^```(\w*)\s*$", s)
        if m:                                              # fenced code
            buf = []
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            out.append("<pre><code>%s</code></pre>" % html.escape("\n".join(buf)))
            continue
        m = re.match(r"^(#{1,6})\s+(.+?)\s*#*$", s)
        if m:
            lvl = len(m.group(1))
            if title is None and lvl == 1:
                title = re.sub(r"[*_`]", "", m.group(2))
            out.append("<h%d>%s</h%d>" % (lvl, inline(m.group(2)), lvl))
            i += 1
            continue
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", s):
            out.append("<hr>")
            i += 1
            continue
        if s.startswith(">"):                              # blockquote (consecutive > lines)
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(re.sub(r"^\s*>\s?", "", lines[i]))
                i += 1
            out.append("<blockquote>%s</blockquote>" % convert(("\n".join(buf)))[0])
            continue
        if s.startswith("|") and i + 1 < n and re.match(r"^\s*\|?\s*:?-{2,}", lines[i + 1]):
            hdr = [c.strip() for c in s.strip("|").split("|")]
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            t = ["<div class='tablewrap'><table><thead><tr>%s</tr></thead><tbody>" % "".join("<th>%s</th>" % inline(c) for c in hdr)]
            for r in rows:
                t.append("<tr>%s</tr>" % "".join("<td>%s</td>" % inline(c) for c in r))
            t.append("</tbody></table></div>")
            out.append("".join(t))
            continue
        if re.match(r"^([-*+]|\d+[.)])\s+", s):            # lists, one nesting level by indentation
            ordered = bool(re.match(r"^\d+[.)]\s+", s))
            items = []
            while i < n and (re.match(r"^\s*([-*+]|\d+[.)])\s+", lines[i]) or (lines[i].startswith("  ") and lines[i].strip() and items)):
                raw = lines[i]
                mm = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", raw)
                if mm:
                    depth = 1 if len(mm.group(1).replace("\t", "    ")) >= 2 and items else 0
                    items.append((depth, mm.group(3)))
                else:
                    d, t = items[-1]
                    items[-1] = (d, t + " " + raw.strip())
                i += 1
            tag = "ol" if ordered else "ul"
            h, open_li, in_sub = ["<%s>" % tag], False, False
            for d, t in items:
                if d == 0:
                    if in_sub:
                        h.append("</ul>")
                        in_sub = False
                    if open_li:
                        h.append("</li>")
                    h.append("<li>%s" % inline(t))
                    open_li = True
                else:
                    if not in_sub:
                        h.append("<ul>")
                        in_sub = True
                    h.append("<li>%s</li>" % inline(t))
            if in_sub:
                h.append("</ul>")
            if open_li:
                h.append("</li>")
            h.append("</%s>" % tag)
            out.append("".join(h))
            continue
        buf = []                                           # paragraph: until a blank line or a block starter
        while i < n and lines[i].strip() and not re.match(r"^(#{1,6}\s|```|>|\||([-*+]|\d+[.)])\s+|-{3,}$)", lines[i].strip()):
            buf.append(lines[i].strip())
            i += 1
        if not buf:                                        # a line that looked like a starter but was not: take it whole
            buf.append(lines[i].strip())
            i += 1
        out.append("<p>%s</p>" % inline(" ".join(buf)))
    return "\n".join(out), title


# ----------------------------------------------------------------------------------------- page
CSS = """
:root{--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--rule:#d8dee4;--accent:%(accent)s;--code:#f3f4f6;--quote:#f6f8fa}
@media (prefers-color-scheme: dark){:root{--bg:#14171a;--fg:#e6e8ea;--muted:#9aa4ad;--rule:#2d343b;--code:#1e2328;--quote:#1a1e22}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%%}
body{margin:0;background:var(--bg);color:var(--fg);font:%(size)s/%(lh)s -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:%(width)s;margin:0 auto;padding:%(pad)s 18px 64px}
header.brand{display:flex;align-items:center;gap:10px;margin-bottom:%(gap)s;color:var(--muted);font-size:.9em}
header.brand img{height:28px;width:auto}header.brand .name{font-weight:600;letter-spacing:.02em}
h1,h2,h3,h4{line-height:1.25;margin:1.6em 0 .5em}h1{font-size:1.9em;margin-top:.2em}h2{font-size:1.4em;border-bottom:1px solid var(--rule);padding-bottom:.25em}
h3{font-size:1.15em}a{color:var(--accent)}hr{border:0;border-top:1px solid var(--rule);margin:2em 0}
p,ul,ol,blockquote,pre,.tablewrap{margin:0 0 1em}li{margin:.25em 0}
blockquote{border-left:4px solid var(--accent);background:var(--quote);padding:.6em 1em;border-radius:0 6px 6px 0;color:var(--muted)}blockquote p{margin:0}
code{background:var(--code);padding:.1em .35em;border-radius:4px;font:.9em ui-monospace,SFMono-Regular,Menlo,monospace}
pre{background:var(--code);padding:12px 14px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%%}th,td{border-bottom:1px solid var(--rule);padding:.45em .7em;text-align:left;vertical-align:top}th{font-weight:600}
.meta{color:var(--muted);font-size:.85em;margin:-.3em 0 1.2em}.player{margin:0 0 1.4em}.player audio{width:100%%}
"""
TEMPLATES = {
    "report": {"size": "17px", "lh": "1.65", "width": "740px", "pad": "48px", "gap": "28px"},
    "brief": {"size": "16px", "lh": "1.5", "width": "620px", "pad": "20px", "gap": "14px"},
}


def read_brand():
    p = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "talos", "brand.json")
    try:
        with open(p, encoding="utf-8") as fh:
            b = json.load(fh)
        return b if isinstance(b, dict) else {}
    except Exception:
        return {}


def data_uri(path, mime, limit):
    path = os.path.expanduser(path)
    if os.path.getsize(path) > limit:
        raise ValueError("%s is larger than %d KB" % (os.path.basename(path), limit // 1024))
    with open(path, "rb") as fh:
        return "data:%s;base64,%s" % (mime, base64.b64encode(fh.read()).decode("ascii"))


def build_page(md, template="report", title=None, audio=None, brand=None):
    body, h1 = convert(md)
    brand = brand if isinstance(brand, dict) else {}
    accent = str(brand.get("accent") or "#2563eb")
    if not re.fullmatch(r"#[0-9a-fA-F]{3,8}", accent):
        accent = "#2563eb"                                 # a brand file is not allowed to inject CSS
    t = TEMPLATES.get(template, TEMPLATES["report"])
    page_title = title or h1 or "Report"
    parts = []
    name, logo = str(brand.get("name") or ""), brand.get("logo")
    head = ""
    if logo:
        try:
            ext = os.path.splitext(str(logo))[1].lower()
            mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml"}[ext]
            head += '<img alt="" src="%s">' % data_uri(str(logo), mime, MAX_LOGO)
        except Exception:
            pass                                           # a missing or oversized logo never breaks the page
    if name:
        head += '<span class="name">%s</span>' % html.escape(name)
    if head:
        parts.append('<header class="brand">%s</header>' % head)
    if audio:
        ext = os.path.splitext(audio)[1].lower()
        mime = AUDIO_MIME.get(ext) or mimetypes.guess_type(audio)[0] or "audio/mpeg"
        parts.append('<div class="player"><audio controls preload="metadata" src="%s"></audio></div>' % data_uri(audio, mime, MAX_AUDIO))
    parts.append(body)
    css = CSS % dict(accent=accent, **t)
    return ("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'\">"
            "<meta name=\"color-scheme\" content=\"light dark\">"
            "<title>%s</title><style>%s</style></head><body><main>\n%s\n</main></body></html>\n"
            % (html.escape(page_title), css, "\n".join(p for p in parts if p)))


def main(argv):
    ap = argparse.ArgumentParser(description="Markdown to one self-contained HTML page.")
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--template", choices=sorted(TEMPLATES), default="report")
    ap.add_argument("--title")
    ap.add_argument("--audio", help="embed this audio file (m4a, mp3, wav, ogg; up to 8 MB) as a player at the top")
    ap.add_argument("--no-brand", action="store_true", help="ignore ~/.config/talos/brand.json")
    a = ap.parse_args(argv)
    try:
        with open(a.input, encoding="utf-8", errors="replace") as fh:
            md = fh.read()
    except OSError as e:
        print("md2html: cannot read %s: %s" % (a.input, e), file=sys.stderr)
        return 1
    out = a.output or os.path.splitext(a.input)[0] + ".html"
    try:
        page = build_page(md, a.template, a.title, a.audio, None if a.no_brand else read_brand())
    except (OSError, ValueError) as e:
        print("md2html: %s" % e, file=sys.stderr)
        return 1
    tmp = out + ".tmp.%d" % os.getpid()
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(page)
    os.replace(tmp, out)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
