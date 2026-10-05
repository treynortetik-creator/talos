#!/usr/bin/env bash
# test-extras.sh -- the optional helper scripts: state-sweep, voice (tts/stt), md2html, yt-fetch.
# Everything runs in a throwaway HOME; fake binaries on PATH stand in for `say`, `whisper-cli`, `ffmpeg` and
# `yt-dlp`, so nothing is spoken, recorded or downloaded.
set -uo pipefail
export PYTHONPATH= PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
REALHOME="$HOME"; export HOME="$SB/home"; mkdir -p "$HOME/bin"
export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share"
A="$SB/agent"; mkdir -p "$A/scripts" "$A/memory"
cp "$KIT"/scripts/*.py "$KIT"/scripts/*.sh "$A/scripts/" 2>/dev/null

# ================================================================ S3 state-sweep
python3 - "$A/memory/STATE.md" <<'PY'
import sys
rows = "".join("- closed row %02d, shipped 2026-09-%02d\n" % (i, i % 28 + 1) for i in range(1, 21))
open(sys.argv[1], "w").write("""# STATE

## ACTIVE FIVE (hard cap)

| # | Bet | Disposition | Kill-by |
|---|---|---|---|
| 1 | Launch the newsletter, shipped last week | done | 2026-10-01 |
| 2 | Vendor renewal | ACT | 2026-10-20 |
| 3 | | | |

## FUSES (time-sensitive, burn if ignored)
| What | Next action | Verified |
|---|---|---|
| Contract signature due | send the draft | 2026-10-05 |

## WAITING ON (someone else's move)
| What | Who | Open since |
|---|---|---|
| Budget approval | Dana | 2026-08-01 |

## BLOCKERS
- 

## HARD DATES
- 2026-10-06 offsite starts

## RECENTLY CLOSED (keep two weeks, then prune)
""" + rows)
PY
S() { ( cd "$A" && python3 scripts/state-sweep.py --today 2026-10-02 "$@" ); }
out="$(S)"; rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | head -1 | grep -q 'needs attention' && ok "state-sweep: a messy STATE.md says 'needs attention' and exits 0" || no "state-sweep headline wrong (rc=$rc)" "$out"
printf '%s' "$out" | grep -q 'close or evict' && printf '%s' "$out" | grep -q 'Launch the newsletter' && ok "state-sweep: a finished row in a live section is listed to close or evict" || no "finished row missed" "$out"
printf '%s' "$out" | grep -q 'Budget approval.*\[62d old\]' && ok "state-sweep: a row whose newest date is 62 days old is listed as stale" || no "stale row missed" "$out"
printf '%s' "$out" | grep -q 'Contract signature due.*\[in 3d\]' && printf '%s' "$out" | grep -q 'offsite starts.*\[in 4d\]' && ok "state-sweep: dates inside the next 7 days are listed as coming up" || no "coming-up rows missed" "$out"
printf '%s' "$out" | grep -q 'RECENTLY CLOSED has 20 rows (keep 15); move the oldest 5' && ok "state-sweep: an oversized RECENTLY CLOSED is flagged with how many to prune" || no "prune count wrong" "$out"
printf '%s' "$out" | grep -q 'Vendor renewal' && no "state-sweep flagged a healthy row" || ok "state-sweep: a healthy row and empty placeholder rows are left alone"
printf '%s' "$(S --json)" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["rows"]>=8 and d["chars"]>0 and d["needs_attention"] is True' 2>/dev/null && ok "state-sweep: --json is valid" || no "--json broken"
python3 -c "open('$A/memory/STATE.md','w').write('# STATE\n\n## FUSES\n\n' + 'x' * 31000 + '\n')"
out="$(S)"; printf '%s' "$out" | grep -q 'OVER' && printf '%s' "$out" | head -1 | grep -q 'needs attention' && ok "state-sweep: more than 30,000 characters is flagged OVER the ceiling" || no "ceiling not enforced" "$out"
printf '# STATE\n\n## ACTIVE FIVE\n\n| # | Bet | Disposition | Kill-by |\n|---|---|---|---|\n| 1 | Newsletter | ACT | 2026-12-01 |\n' > "$A/memory/STATE.md"
out="$(S)"; printf '%s' "$out" | head -1 | grep -q 'nothing to do' && ok "state-sweep: a clean STATE.md says 'nothing to do'" || no "clean state flagged" "$out"
before="$(shasum -a 256 "$A/memory/STATE.md")"; S >/dev/null; [ "$before" = "$(shasum -a 256 "$A/memory/STATE.md")" ] && ok "state-sweep never modifies STATE.md" || no "state-sweep modified STATE.md"
rm "$A/memory/STATE.md"; out="$(S)"; [ "$?" = 0 ] && printf '%s' "$out" | grep -q 'no memory/STATE.md' && ok "state-sweep: a missing STATE.md is a message, not a crash" || no "missing file mishandled" "$out"
# the shipped template itself must sweep clean
sed -e 's/{{[A-Z_]*}}/X/g' "$KIT/templates/STATE.md.tmpl" > "$A/memory/STATE.md"
out="$(S)"; printf '%s' "$out" | head -1 | grep -q 'nothing to do' && ok "state-sweep: the shipped STATE.md template sweeps clean (its empty placeholder rows are not findings)" || no "template flagged" "$out"

# ================================================================ S4 voice: tts.sh, stt.sh, voice/setup.sh
mkdir -p "$A/scripts/voice"; cp "$KIT"/scripts/voice/* "$A/scripts/voice/"
FB="$HOME/fakebin"; mkdir -p "$FB"
cat > "$FB/say" <<FAKE
#!/bin/bash
# fake macOS say: records the call, writes a small file where -o points
# like the real say: an argument starting with - is an OPTION unless it comes after --
out=""; while [ \$# -gt 0 ]; do case "\$1" in -o) out="\$2"; shift 2 ;; -v) shift 2 ;; --) shift; txt="\$*"; break ;; -*) echo "say: invalid option -- \$1" >&2; exit 1 ;; *) txt="\$1"; shift ;; esac; done
echo "say: \$txt" >> "$SB/audio.calls"; [ -n "\$out" ] && printf 'AIFFDATA' > "\$out"
FAKE
cat > "$FB/afconvert" <<FAKE
#!/bin/bash
echo "afconvert: \$*" >> "$SB/audio.calls"; printf 'M4ADATA' > "\${@: -1}"
FAKE
cat > "$FB/afplay" <<FAKE
#!/bin/bash
echo "afplay: \$1" >> "$SB/audio.calls"
FAKE
cat > "$FB/ffmpeg" <<FAKE
#!/bin/bash
echo "ffmpeg: \$*" >> "$SB/audio.calls"; printf 'CONVERTED' > "\${@: -1}"
FAKE
cat > "$FB/whisper-cli" <<FAKE
#!/bin/bash
echo "whisper: \$*" >> "$SB/audio.calls"; echo "   hello from the voice note"
FAKE
chmod +x "$FB"/*
export PATH="$FB:$PATH"; : > "$SB/audio.calls"
T() { ( cd "$A" && bash scripts/tts.sh "$@" 2>&1 ); }
out="$(T file "$SB/o.m4a" "Good morning. Three things today.")"
{ [ -s "$SB/o.m4a" ] && grep -q 'say: Good morning. Three things today.' "$SB/audio.calls" && grep -q 'afconvert' "$SB/audio.calls"; } && ok "tts.sh file: with no extras installed it uses macOS say, then afconvert for .m4a" || no "tts.sh file m4a wrong" "$out"
: > "$SB/audio.calls"; out="$(T file "$SB/dash.wav" "-5 degrees today")"; { [ -s "$SB/dash.wav" ] && grep -q 'say: -5 degrees today' "$SB/audio.calls"; } && ok "tts.sh: text that starts with a dash is spoken, not parsed as an option" || no "dash text mishandled" "$out"
out="$(T file "$SB/o.wav" "x")"; [ -s "$SB/o.wav" ] && ok "tts.sh file: .wav is copied straight from the engine's output" || no ".wav not written" "$out"
: > "$SB/audio.calls"; out="$(T file "$SB/o.mp3" "x")"; { [ -s "$SB/o.mp3" ] && grep -q ffmpeg "$SB/audio.calls"; } && ok "tts.sh file: .mp3 goes through ffmpeg" || no ".mp3 wrong" "$out"
out="$(T file "$SB/o.ogg" "x")"; [ "$?" != 0 ] && printf '%s' "$out" | grep -q 'must end in' && ok "tts.sh file: an unsupported extension is refused clearly" || no "bad extension accepted" "$out"
: > "$SB/audio.calls"; T play "hello there" >/dev/null; { grep -q 'say: hello there' "$SB/audio.calls" && grep -q '^afplay:' "$SB/audio.calls"; } && ok "tts.sh play: speaks through afplay" || no "tts.sh play wrong" "$(cat "$SB/audio.calls")"
: > "$SB/audio.calls"; printf 'from stdin' | ( cd "$A" && bash scripts/tts.sh play - ) >/dev/null 2>&1; grep -q 'say: from stdin' "$SB/audio.calls" && ok "tts.sh: text can come from stdin ('-')" || no "stdin text ignored"
out="$(T file)" ; [ "$?" != 0 ] && ok "tts.sh with missing arguments fails with usage" || no "tts.sh accepted no arguments"
out="$(TALOS_TTS_ENGINE=kokoro T play "x")"; [ "$?" != 0 ] && printf '%s' "$out" | grep -q 'voice/setup.sh --kokoro' && ok "tts.sh: forcing the Kokoro engine when it is not installed fails and says how to install it" || no "forced kokoro did not fail" "$out"
# Kokoro path, with a fake venv python and stub model files: it must be PREFERRED, and say must remain the fallback
KD="$XDG_DATA_HOME/talos"; mkdir -p "$KD/venv/bin" "$KD/models/kokoro"; : > "$KD/models/kokoro/kokoro-v1.0.onnx"; : > "$KD/models/kokoro/voices-v1.0.bin"
cat > "$KD/venv/bin/python" <<FAKE
#!/bin/bash
if [ "\$1" = "-c" ]; then exit 0; fi
echo "kokoro: \$*" >> "$SB/audio.calls"; printf 'WAVDATA' > "\$3"
FAKE
chmod +x "$KD/venv/bin/python"; : > "$SB/audio.calls"
T file "$SB/k.wav" "narration" >/dev/null; { grep -q '^kokoro:' "$SB/audio.calls" && ! grep -q '^say:' "$SB/audio.calls"; } && ok "tts.sh: with Kokoro installed it is used, and say is not" || no "kokoro not preferred" "$(cat "$SB/audio.calls")"
printf '#!/bin/bash\nif [ "$1" = "-c" ]; then exit 0; fi\nexit 1\n' > "$KD/venv/bin/python"; : > "$SB/audio.calls"
T file "$SB/k2.wav" "narration" >/dev/null; { grep -q '^say:' "$SB/audio.calls" && [ -s "$SB/k2.wav" ]; } && ok "tts.sh: if Kokoro fails it falls back to say instead of failing" || no "no fallback" "$(cat "$SB/audio.calls")"
TALOS_TTS_ENGINE=say T file "$SB/k3.wav" "x" >/dev/null; ok "tts.sh: TALOS_TTS_ENGINE=say is accepted"
rm -rf "$KD"

printf 'fakeaudio' > "$SB/note.ogg"; : > "$SB/audio.calls"; mkdir -p "$SB/tmpd"
out="$( cd "$A" && bash scripts/stt.sh "$SB/note.ogg" 2>&1 )"; rc=$?
{ [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'model missing'; } && ok "stt.sh: a missing model is a clear error naming the fix" || no "stt missing model not handled (rc=$rc)" "$out"
mkdir -p "$XDG_DATA_HOME/talos/models"; printf 'm' > "$XDG_DATA_HOME/talos/models/ggml-base.en.bin"
out="$( cd "$A" && bash scripts/stt.sh "$SB/note.ogg" 2>&1 )"
{ [ "$out" = "hello from the voice note" ] && grep -q 'ffmpeg:.*-ar 16000 -ac 1' "$SB/audio.calls"; } && ok "stt.sh: converts to 16 kHz mono, runs whisper, prints a trimmed transcript" || no "stt.sh output wrong" "$out"
( cd "$A" && TMPDIR="$SB/tmpd" bash scripts/stt.sh "$SB/note.ogg" >/dev/null 2>&1 ); [ -z "$(ls -A "$SB/tmpd")" ] && ok "stt.sh leaves no temp files behind" || no "stt.sh leaked temp files" "$(ls -A "$SB/tmpd")"
out="$( cd "$A" && bash scripts/stt.sh "$SB/missing.ogg" 2>&1 )"; printf '%s' "$out" | grep -q 'not found' && ok "stt.sh: a missing audio file is reported" || no "missing audio not reported" "$out"
rm -rf "$XDG_DATA_HOME/talos"

V() { ( cd "$A" && bash scripts/voice/setup.sh "$@" 2>&1 ); }
out="$(V --kokoro --stt small.en --dry-run)"; { [ ! -e "$XDG_DATA_HOME/talos" ] && printf '%s' "$out" | grep -q 'kokoro-v1.0.onnx' && printf '%s' "$out" | grep -q 'ggml-small.en.bin'; } && ok "voice/setup.sh --dry-run prints the downloads and creates nothing" || no "voice dry-run wrong" "$out"
out="$(V)"; [ "$?" != 0 ] && ok "voice/setup.sh with no option says there is nothing to do" || no "voice setup ran with no option"
out="$(PATH="$FB:/usr/bin:/bin" V --kokoro)"; rc=$?; { [ "$rc" = 3 ] && printf '%s' "$out" | grep -q 'Python 3.10+' && [ ! -e "$XDG_DATA_HOME/talos/venv" ]; } && ok "voice/setup.sh --kokoro with no Python 3.10+ says so (exit 3) and builds nothing" || no "kokoro without python mishandled (rc=$rc)" "$out"
mkdir -p "$SB/models-src"; printf 'whisper-bytes' > "$SB/models-src/ggml-tiny.en.bin"
out="$(TALOS_WHISPER_BASE="file://$SB/models-src" V --stt tiny.en)"
{ [ "$(cat "$XDG_DATA_HOME/talos/models/ggml-tiny.en.bin" 2>/dev/null)" = "whisper-bytes" ] && [ ! -e "$XDG_DATA_HOME/talos/models/ggml-tiny.en.bin.part" ]; } && ok "voice/setup.sh --stt downloads atomically into the models folder (checked against a local file:// source)" || no "stt download wrong" "$out"
out="$(TALOS_WHISPER_BASE="file://$SB/models-src" V --stt tiny.en)"; printf '%s' "$out" | grep -q 'already have' && ok "voice/setup.sh does not download a model it already has" || no "re-downloaded" "$out"
out="$(TALOS_WHISPER_BASE="file://$SB/models-src" V --stt nonexistent.en)"; [ "$?" != 0 ] && [ ! -e "$XDG_DATA_HOME/talos/models/ggml-nonexistent.en.bin" ] && ok "voice/setup.sh: a failed download leaves no half file behind" || no "bad download left a file" "$out"
rm -rf "$XDG_DATA_HOME/talos"

# ================================================================ S5 md2html
cat > "$SB/doc.md" <<'MD'
# Weekly brief <b>x</b>

Intro with **bold**, *italic*, `code <b>`, [a link](https://example.com) and [bad](javascript:alert(1)).

<script>alert(1)</script> <img src=x onerror=alert(1)>

| Name | Status |
|---|---|
| Alpha | **done** |

- one
- two
  - nested

> quoted

```
raw <html> stays escaped
```
MD
M() { ( cd "$A" && python3 scripts/md2html.py "$@" 2>&1 ); }
printf 'before \x00 5 \x00 after `code`\n' > "$SB/nul.md"; out="$(M "$SB/nul.md" -o "$SB/nul.html")"
{ [ "$?" = 0 ] && [ -s "$SB/nul.html" ] && grep -q '<code>code</code>' "$SB/nul.html"; } && ok "md2html: NUL bytes in the input are dropped, not a crash" || no "md2html crashed on NUL bytes" "$out"
out="$(M "$SB/doc.md" -o "$SB/doc.html")"; [ "$out" = "$SB/doc.html" ] && [ -s "$SB/doc.html" ] && ok "md2html: writes one HTML file and prints its path" || no "md2html did not write the page" "$out"
H="$SB/doc.html"
{ ! grep -qi '<script' "$H" && ! grep -qi '<img src=x' "$H" && grep -q '&lt;script&gt;alert(1)&lt;/script&gt;' "$H"; } && ok "md2html: raw HTML in the source is escaped, never passed through" || no "raw html leaked into the page"
{ ! grep -q 'href="javascript' "$H" && grep -q 'href="https://example.com"' "$H"; } && ok "md2html: a javascript: link is dropped (its text kept); an https link survives" || no "link handling wrong"
grep -q '<table>' "$H" && grep -q '<th>Name</th>' "$H" && grep -q '<strong>done</strong>' "$H" && grep -q '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>' "$H" && grep -q '<pre><code>raw &lt;html&gt; stays escaped</code></pre>' "$H" \
  && ok "md2html: tables, nested lists and fenced code render" || no "block rendering wrong"
grep -q '<title>Weekly brief &lt;b&gt;x&lt;/b&gt;</title>' "$H" && ok "md2html: the title comes from the first heading, escaped" || no "title wrong"
grep -q 'prefers-color-scheme: dark' "$H" && grep -q 'Content-Security-Policy' "$H" && ok "md2html: follows the system dark mode and carries a Content-Security-Policy" || no "dark mode or CSP missing"
grep -qE '(src|href)="https?://[^"]*"' "$H" && grep -E '(src|href)="https?://' "$H" | grep -vq 'example.com' && no "the page fetches something external" || ok "md2html: nothing in the page is fetched from outside (only the author's own link)"
M "$SB/doc.md" -o "$SB/brief.html" --template brief >/dev/null; ! cmp -s "$SB/brief.html" "$H" && grep -q 'max-width:620px' "$SB/brief.html" && grep -q 'max-width:740px' "$H" && ok "md2html: the brief template is different from the report template" || no "templates identical"
printf 'AUDIOBYTES' > "$SB/n.m4a"; M "$SB/doc.md" -o "$SB/a.html" --audio "$SB/n.m4a" >/dev/null
grep -q '<audio controls' "$SB/a.html" && grep -q 'src="data:audio/mp4;base64,' "$SB/a.html" && ok "md2html --audio embeds the file as a data-URI player (no external request)" || no "audio not embedded"
python3 -c "open('$SB/big.mp3','wb').write(b'x'*(9*1024*1024))"; out="$(M "$SB/doc.md" -o "$SB/b.html" --audio "$SB/big.mp3")"
[ "$?" != 0 ] && printf '%s' "$out" | grep -q 'larger than' && [ ! -e "$SB/b.html" ] && ok "md2html: an audio file over 8 MB is refused and no half page is written" || no "oversized audio accepted" "$out"
mkdir -p "$XDG_CONFIG_HOME/talos"; printf 'PNGBYTES' > "$SB/logo.png"
printf '{"name":"Acme Ops","accent":"#ff6600","logo":"%s"}' "$SB/logo.png" > "$XDG_CONFIG_HOME/talos/brand.json"
M "$SB/doc.md" -o "$SB/br.html" >/dev/null
{ grep -q -- '--accent:#ff6600' "$SB/br.html" && grep -q 'Acme Ops' "$SB/br.html" && grep -q 'src="data:image/png;base64,' "$SB/br.html"; } && ok "md2html: brand.json supplies the accent colour, the name and an embedded logo" || no "brand not applied"
printf '{"accent":"red;}</style><script>alert(1)</script>"}' > "$XDG_CONFIG_HOME/talos/brand.json"; M "$SB/doc.md" -o "$SB/br2.html" >/dev/null
{ ! grep -qi '<script' "$SB/br2.html" && grep -q -- '--accent:#2563eb' "$SB/br2.html"; } && ok "md2html: a hostile accent value in brand.json cannot inject CSS or script" || no "brand accent injected"
M "$SB/doc.md" -o "$SB/nb.html" --no-brand >/dev/null; ! grep -q 'Acme' "$SB/nb.html" && ok "md2html --no-brand ignores brand.json" || no "--no-brand ignored"
rm -f "$XDG_CONFIG_HOME/talos/brand.json"
out="$(M "$SB/nope.md")"; [ "$?" != 0 ] && printf '%s' "$out" | grep -q 'cannot read' && ok "md2html: an unreadable input is a clear error" || no "missing input mishandled" "$out"
python3 -c "open('$SB/long.md','w').write('# T\\n\\n' + ('A paragraph with **bold** and a [link](https://example.com).\\n\\n' * 3000))"
s=$(date +%s); M "$SB/long.md" -o "$SB/long.html" >/dev/null; e=$(date +%s); [ $((e - s)) -le 5 ] && ok "md2html: a 3,000-paragraph document converts in a few seconds" || no "md2html is slow ($((e - s))s)"

# ================================================================ S7 yt-fetch (against a fake youtube_transcript_api; no network)
mkdir -p "$SB/fakeyt/youtube_transcript_api" "$SB/fakeyt2/youtube_transcript_api"
cat > "$SB/fakeyt/youtube_transcript_api/__init__.py" <<'PY'
class YouTubeTranscriptApi:               # the 0.x interface: a static method returning dicts
    @staticmethod
    def get_transcript(vid, languages=None):
        if vid == "NOCAPTIONS1":
            raise RuntimeError("Subtitles are disabled for this video")
        return [{"text": "hello   there", "start": 0.0}, {"text": "general kenobi", "start": 65.4}, {"text": "late", "start": 3725.0}]
PY
cat > "$SB/fakeyt2/youtube_transcript_api/__init__.py" <<'PY'
class _S:
    def __init__(self, t, s): self.text, self.start = t, s
class YouTubeTranscriptApi:               # the 1.x interface: an instance method returning objects
    def fetch(self, vid, languages=None):
        return [_S("hello there", 0.0), _S("general kenobi", 65.4)]
PY
Y() { ( cd "$A" && PYTHONPATH="$1" python3 scripts/yt-fetch.py "${@:2}" 2>&1 ); }
out="$(Y "$SB/fakeyt" "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s")"; [ "$out" = "hello there general kenobi late" ] && ok "yt-fetch: plain transcript, whitespace collapsed (0.x API)" || no "yt-fetch plain wrong" "$out"
out="$(Y "$SB/fakeyt2" "https://youtu.be/dQw4w9WgXcQ")"; [ "$out" = "hello there general kenobi" ] && ok "yt-fetch: works with the 1.x API too" || no "yt-fetch 1.x wrong" "$out"
out="$(Y "$SB/fakeyt" "https://www.youtube.com/shorts/dQw4w9WgXcQ" --timestamps)"; want=$'[0:00] hello there\n[1:05] general kenobi\n[1:02:05] late'
[ "$out" = "$want" ] && ok "yt-fetch --timestamps prints [m:ss] and [h:mm:ss] marks; shorts URLs parse" || no "timestamps wrong" "$out"
out="$(Y "$SB/fakeyt" "dQw4w9WgXcQ" -o "$SB/t.txt")"; [ "$out" = "$SB/t.txt" ] && [ -s "$SB/t.txt" ] && ok "yt-fetch: a bare video id works, and -o writes a file" || no "-o wrong" "$out"
out="$(Y "$SB/fakeyt" "NOCAPTIONS1")"; [ "$?" != 0 ] && printf '%s' "$out" | grep -q 'no transcript for NOCAPTIONS1: Subtitles are disabled' && ok "yt-fetch: a video with no captions fails with the library's own reason" || no "no-captions mishandled" "$out"
out="$(Y "$SB/fakeyt" "https://example.com/not-youtube")"; [ "$?" = 2 ] && ok "yt-fetch: a URL with no video id is refused (exit 2)" || no "bad URL accepted" "$out"
out="$(Y "" "dQw4w9WgXcQ")"; printf '%s' "$out" | grep -q -- '--install' && ok "yt-fetch: without the package it says to run --install (no traceback)" || no "missing package not explained" "$out"
printf '%s' "$out" | grep -qi traceback && no "yt-fetch printed a traceback" || ok "yt-fetch: no traceback when the package is missing"

export HOME="$REALHOME"
echo "  extras: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
