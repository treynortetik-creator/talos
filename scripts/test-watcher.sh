#!/usr/bin/env bash
# test-watcher.sh -- scripts/watcher.py (quiet check-ins) and scripts/watcher-adapters/macos-calendar.sh.
#
# Runs a COPY of watcher.py inside a throwaway "agent" folder with a throwaway HOME and XDG dirs, a pinned clock
# (TALOS_WATCHER_NOW) and a fake notify command that only appends to a log. No network, no real Calendar, no real
# ~/.config or ~/.local, no Claude. All people, companies and addresses below are made up.
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home"; mkdir -p "$HOME"
export XDG_CONFIG_HOME="$HOME/.config" XDG_STATE_HOME="$HOME/.local/state"
unset TALOS_NOTIFY_CMD TALOS_WATCHER_CONFIG CHRONOS_CONFIG
export CHRONOS_CONFIG="$SB/no-such-chronos.json"
AGENT="$SB/agent"; mkdir -p "$AGENT/scripts" "$AGENT/hooks" "$AGENT/memory" "$XDG_CONFIG_HOME/talos"
cp "$KIT/scripts/watcher.py" "$AGENT/scripts/"; cp "$KIT/hooks/_talos_common.py" "$AGENT/hooks/"
W="$AGENT/scripts/watcher.py"
CFG="$XDG_CONFIG_HOME/talos/watcher.json"
export TALOS_WATCHER_NOW="2026-10-28T16:00:00+00:00"            # a Wednesday
LOG="$SB/notify.log"; : > "$LOG"
cat > "$SB/notify.sh" <<FAKE
#!/bin/bash
printf '%s\n' "\$1" >> "$LOG"
FAKE
chmod +x "$SB/notify.sh"; export TALOS_NOTIFY_CMD="$SB/notify.sh"

ICS="$SB/cal.ics"
mkics(){ # events on stdin as lines "UID|SUMMARY|DTSTART-with-params|extra" ; extra lines separated by ';;'
  { printf 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'
    while IFS='|' read -r uid sum dts extra; do
      [ -z "$uid" ] && continue
      printf 'BEGIN:VEVENT\r\nUID:%s\r\nSUMMARY:%s\r\n%s\r\n' "$uid" "$sum" "$dts"
      [ -n "$extra" ] && printf '%s\r\n' "${extra//;;/$'\r\n'}"
      printf 'END:VEVENT\r\n'
    done
    printf 'END:VCALENDAR\r\n'; } > "$ICS"
}
cfg_ics(){ printf '{"timezone":"UTC","deadlines":false,"calendar":{"type":"ics","path":"%s"}}\n' "$ICS" > "$CFG"; }
run(){ python3 "$W" "$@"; }
nlines(){ wc -l < "$LOG" | tr -d ' '; }
seenfile(){ find "$XDG_STATE_HOME" -name watcher-seen.json 2>/dev/null | head -1; }
reset(){ : > "$LOG"; rm -rf "$XDG_STATE_HOME"; }

# ---------------------------------------------------------------- 1. unconfigured = silent
rm -f "$CFG"; reset
out=$(run 2>&1); rc=$?
{ [ $rc -eq 0 ] && [ -z "$out" ] && [ "$(nlines)" = 0 ] && [ -z "$(seenfile)" ]; } && ok "unconfigured: silent, exit 0, nothing sent, no state written" || no "unconfigured run" "rc=$rc out=$out"
out=$(run --explain 2>&1)
echo "$out" | grep -q "no sources configured" && ok "--explain says 'no sources configured' with no config" || no "--explain unconfigured" "$out"
mkdir -p "$AGENT/memory"; printf '## FUSES\n| 2026-10-29 | Renew example domain |\n' > "$AGENT/memory/STATE.md"
out=$(run 2>&1); rc=$?
{ [ $rc -eq 0 ] && [ -z "$out" ] && [ "$(nlines)" = 0 ]; } && ok "a STATE.md alone (no config file) does not switch the check on" || no "STATE.md without config" "$out"
rm -f "$AGENT/memory/STATE.md"

# ---------------------------------------------------------------- 2. ICS parsing (unit level)
cat > "$SB/unit.py" <<PY
import importlib.util, datetime as dt, sys
sp = importlib.util.spec_from_file_location("watcher", "$W"); w = importlib.util.module_from_spec(sp); sp.loader.exec_module(w)
UTC = dt.timezone.utc
def ics(*vevents): return "BEGIN:VCALENDAR\r\n" + "".join("BEGIN:VEVENT\r\n" + v.replace("\n", "\r\n") + "\r\nEND:VEVENT\r\n" for v in vevents) + "END:VCALENDAR\r\n"
lo, hi = dt.datetime(2026, 1, 1, tzinfo=UTC), dt.datetime(2027, 1, 1, tzinfo=UTC)
def starts(text, lo=lo, hi=hi): return [e["start"].strftime("%m-%d %H:%M") for e in sorted(w.expand_ics(text, w.ZoneInfo("UTC"), lo, hi), key=lambda e: e["start"])]
res = []
def check(name, got, want): res.append((name, got == want, got, want))
t = ics("UID:a\nSUMMARY:Weekly\nDTSTART;TZID=America/New_York:20261026T100000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4")
check("weekly BYDAY + TZID across the DST change", starts(t), ["10-26 14:00", "10-28 14:00", "11-02 15:00", "11-04 15:00"])
t = ics("UID:b\nSUMMARY:Every other day\nDTSTART:20261028T090000Z\nRRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261102T000000Z")
check("daily INTERVAL=2 with UNTIL", starts(t), ["10-28 09:00", "10-30 09:00", "11-01 09:00"])
t = ics("UID:c\nSUMMARY:Month end\nDTSTART:20260131T120000Z\nRRULE:FREQ=MONTHLY;COUNT=4")
check("monthly skips months without the day, COUNT counts valid ones", starts(t), ["01-31 12:00", "03-31 12:00", "05-31 12:00", "07-31 12:00"])
t = ics("UID:d\nSUMMARY:Holiday\nDTSTART;VALUE=DATE:20261029")
evs = w.expand_ics(t, w.ZoneInfo("UTC"), lo, hi)
check("all-day event", [(e["all_day"], e["start"].strftime("%m-%d %H:%M")) for e in evs], [(True, "10-29 00:00")])
t = ics("UID:e\nSUMMARY:Floating\nDTSTART:20261028T100000")
check("floating time uses the configured zone", starts(t), ["10-28 10:00"])
t = ics("UID:f\nSUMMARY:Series\nDTSTART:20261026T090000Z\nRRULE:FREQ=DAILY;COUNT=4\nEXDATE:20261027T090000Z",
        "UID:f\nSUMMARY:Series (moved)\nRECURRENCE-ID:20261028T090000Z\nDTSTART:20261028T150000Z",
        "UID:g\nSUMMARY:Dropped\nDTSTART:20261028T090000Z\nSTATUS:CANCELLED")
check("EXDATE, RECURRENCE-ID override and CANCELLED", starts(t), ["10-26 09:00", "10-28 15:00", "10-29 09:00"])
t = ics("UID:h\nSUMMARY:Ordinal\nDTSTART:20261028T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=1MO")
check("unsupported ordinal BYDAY yields only the first occurrence", starts(t), ["10-28 09:00"])
check("...and says so", any("ordinal" in x for x in w.WARNINGS), True)
t = ics("UID:i\nSUMMARY:Folded long\nDTSTART:20261028T090000Z\nDESCRIPTION:x")
t = t.replace("SUMMARY:Folded long", "SUMMARY:Folded\r\n  long")
check("line folding", [e["title"] for e in w.expand_ics(t, w.ZoneInfo("UTC"), lo, hi)], ["Folded long"])
bad = 0
for name, okk, got, want in res:
    print(("OK   " if okk else "FAIL ") + name + ("" if okk else "  got %r want %r" % (got, want)))
PY
python3 "$SB/unit.py" 2>&1 | while IFS= read -r line; do
  case "$line" in OK*) echo "ok   ${line#OK   }";; FAIL*) echo "FAIL ${line#FAIL }";; *) echo "     $line";; esac
done > "$SB/unit.out"
while IFS= read -r line; do
  case "$line" in "ok   "*) ok "ics: ${line#ok   }";; "FAIL "*) no "ics: ${line#FAIL }";; *) [ -n "${line// /}" ] && no "unit helper output" "$line";; esac
done < "$SB/unit.out"
[ "$(grep -c '^ok' "$SB/unit.out")" -ge 9 ] || no "fewer unit checks passed than expected"

# ---------------------------------------------------------------- 3. hits, message shape, dedup
reset; cfg_ics
mkics <<'E'
s1|Standup with Dana Ruiz|DTSTART:20261028T170000Z
a1|Acme *sync* _review_|DTSTART;TZID=America/New_York:20261028T140000
far|Planning later|DTSTART:20261105T170000Z
E
out=$(run --dry-run --job mid 2>/dev/null)
words=$(printf '%s' "$out" | wc -w | tr -d ' ')
{ [ -n "$out" ] && [ "$(nlines)" = 0 ] && [ -z "$(seenfile)" ]; } && ok "--dry-run prints the message, sends nothing, writes no state" || no "dry-run" "out=$out"
[ "$words" -le 60 ] && ok "message is $words words (<= 60)" || no "message too long: $words words"
echo "$out" | grep -q "Talos mid check-in" && ok "--job labels the message" || no "job label" "$out"
echo "$out" | grep -q "17:00 Standup" && echo "$out" | grep -q "Acme sync review" && ok "soon events listed (TZID event converted, markdown stripped)" || no "soon content" "$out"
echo "$out" | grep -Eq '[*_`]' && no "message contains Telegram-hostile characters" "$out" || ok "message is plain text (no * _ \`)"
echo "$out" | grep -q "Planning later" && no "an event 8 days out was reported" || ok "an event outside every window is not reported"
reset
out=$(run --job am 2>&1); rc=$?
{ [ $rc -eq 0 ] && [ -z "$out" ] && [ "$(nlines)" = 1 ]; } && ok "a real run sends exactly ONE message and prints nothing" || no "real run" "rc=$rc out=$out lines=$(nlines)"
[ -n "$(seenfile)" ] && ok "seen-state lives under the XDG state dir" || no "no seen-state"
out=$(run --job pm 2>&1); rc=$?
{ [ $rc -eq 0 ] && [ -z "$out" ] && [ "$(nlines)" = 1 ]; } && ok "the same events are not announced twice" || no "dedup" "lines=$(nlines)"

# ---------------------------------------------------------------- 4. silence when nothing crosses the bar
reset
mkics <<'E'
far|Planning later|DTSTART:20261105T170000Z
later|Tomorrow afternoon|DTSTART:20261029T200000Z
E
out=$(run 2>&1); rc=$?
{ [ $rc -eq 0 ] && [ -z "$out" ] && [ "$(nlines)" = 0 ]; } && ok "nothing crosses a bar: no output, nothing sent, exit 0" || no "silence" "rc=$rc out=$out"
cat > "$CFG" <<J
{"timezone":"UTC","deadlines":false,"soon_minutes":600,"calendar":{"type":"ics","path":"$ICS"}}
J
mkics <<'E'
x|Window test|DTSTART:20261028T230000Z
E
reset; run >/dev/null 2>&1; [ "$(nlines)" = 1 ] && ok "soon_minutes=600 reports an event 7 h away" || no "soon_minutes ignored" "lines=$(nlines)"

# ---------------------------------------------------------------- 5. change detection across two runs
reset; cfg_ics
mkics <<'E'
x|Budget review|DTSTART:20261029T020000Z
y|Vendor call|DTSTART:20261029T040000Z
k|Keep as is|DTSTART:20261029T060000Z
E
run >/dev/null 2>&1; n1=$(nlines)
[ "$n1" = 0 ] && ok "first run only records a baseline (no change alerts)" || no "baseline alerted" "lines=$n1"
mkics <<'E'
x|Budget review|DTSTART:20261029T030000Z
k|Keep as is|DTSTART:20261029T060000Z
z|Brand new thing|DTSTART:20261029T050000Z
E
cp "$(seenfile)" "$SB/seen.before"
out=$(run --dry-run 2>/dev/null)
cmp -s "$SB/seen.before" "$(seenfile)" && ok "--dry-run leaves the seen-state byte-identical" || no "dry-run touched the seen-state"
echo "$out" | grep -q "Moved: Budget review" && echo "$out" | grep -q "Cancelled: Vendor call" && echo "$out" | grep -q "New: Brand new thing" \
  && ok "dry-run shows the moved, cancelled and new event" || no "change detection (dry-run)" "$out"
run >/dev/null 2>&1
{ [ "$(nlines)" = 1 ] && grep -q "Moved" "$LOG" && grep -q "Cancelled" "$LOG" && grep -q "New" "$LOG"; } && ok "the real run sends ONE message with moved + cancelled + new" || no "change detection (real)" "$(cat "$LOG")"
run >/dev/null 2>&1; [ "$(nlines)" = 1 ] && ok "a third run with no further change stays silent" || no "changes repeated" "lines=$(nlines)"

# ---------------------------------------------------------------- 6. deadlines from STATE.md
reset
printf '{"timezone":"UTC","calendar":{"type":"none"}}\n' > "$CFG"
cat > "$AGENT/memory/STATE.md" <<'S'
# STATE
## FUSES
| Renew example domain | 2026-10-29 | open |
| Old thing, shipped | 2026-10-29 | done |
| Far away item | 2026-11-20 | open |
## HARD DATES
- Dentist for the dog 2026-10-30
## RECENTLY CLOSED
| Closed thing | 2026-10-29 |
S
out=$(run --dry-run --job eve 2>/dev/null)
echo "$out" | grep -q "Renew example domain" && echo "$out" | grep -q "Dentist" && ok "STATE.md rows dated inside 48 h are reported" || no "deadline hits" "$out"
echo "$out" | grep -Eq "shipped|Far away|Closed thing" && no "a done row, a far row or a RECENTLY CLOSED row was reported" "$out" || ok "done rows, far dates and RECENTLY CLOSED are ignored"
run >/dev/null 2>&1; run >/dev/null 2>&1
[ "$(nlines)" = 1 ] && ok "a deadline is announced once" || no "deadline repeated" "lines=$(nlines)"
rm -f "$AGENT/memory/STATE.md"

# ---------------------------------------------------------------- 7. command adapters
reset
cat > "$SB/good.sh" <<'A'
#!/bin/bash
echo '[{"title":"Adapter event","start":"2026-10-28T17:30:00+00:00"},{"title":"Day off","start":"2026-10-30","all_day":true}]'
A
printf '{"timezone":"UTC","deadlines":false,"calendar":{"type":"command","command":"bash %s"}}\n' "$SB/good.sh" > "$CFG"
out=$(run --dry-run 2>/dev/null)
echo "$out" | grep -q "17:30 Adapter event" && ok "command adapter: JSON events are read" || no "json adapter" "$out"
cat > "$SB/bad.sh" <<'A'
#!/bin/bash
echo "calendar access was denied" >&2
exit 3
A
printf '{"timezone":"UTC","deadlines":false,"calendar":{"type":"command","command":"bash %s"}}\n' "$SB/bad.sh" > "$CFG"
reset
out=$(run --job am 2>"$SB/err.txt"); rc=$?
{ [ "$(nlines)" = 1 ] && grep -q "Calendar source problem" "$LOG" && grep -q "denied" "$LOG"; } && ok "command failure: reported once in the message" || no "failure not reported" "$(cat "$LOG") rc=$rc"
grep -q "calendar command failed" "$SB/err.txt" && ok "...and as one stderr line" || no "no stderr line" "$(cat "$SB/err.txt")"
run --job mid >/dev/null 2>&1; [ "$(nlines)" = 1 ] && ok "the same failure is not repeated on the next run" || no "failure repeated" "lines=$(nlines)"
printf '{"timezone":"UTC","deadlines":false,"calendar":{"type":"command","command":"/nonexistent/adapter --x"}}\n' > "$CFG"
reset; out=$(run 2>&1); rc=$?
echo "$out" | grep -q Traceback && no "traceback on a missing command" "$out" || ok "a missing command never produces a traceback"
printf '{"timezone":"UTC","deadlines":false,"calendar":{"type":"ics","path":"%s/missing.ics"}}\n' "$SB" > "$CFG"
reset; out=$(run 2>&1)
echo "$out" | grep -q Traceback && no "traceback on a missing ics" "$out" || ok "a missing ICS file never produces a traceback"
printf '{not json' > "$CFG"; out=$(run 2>&1); rc=$?
{ [ $rc -ne 0 ] && ! echo "$out" | grep -q Traceback; } && ok "a broken config is one stderr line, not a traceback" || no "broken config" "rc=$rc $out"

# ---------------------------------------------------------------- 8. notify failure keeps state so the next run retries
reset; cfg_ics
mkics <<'E'
s1|Standup|DTSTART:20261028T170000Z
E
printf '#!/bin/bash\nexit 7\n' > "$SB/failnotify.sh"; chmod +x "$SB/failnotify.sh"
out=$(TALOS_NOTIFY_CMD="$SB/failnotify.sh" run 2>&1); rc=$?
{ [ $rc -eq 1 ] && echo "$out" | grep -q "notify command exited 7" && [ -z "$(seenfile)" ]; } && ok "notify failure: exit 1, one stderr line, nothing marked as sent" || no "notify failure" "rc=$rc $out"
run >/dev/null 2>&1; [ "$(nlines)" = 1 ] && ok "...and the next run delivers it" || no "no retry" "lines=$(nlines)"

# ---------------------------------------------------------------- 9. --explain with a source
out=$(run --explain)
echo "$out" | grep -q "calendar source: ics" && echo "$out" | grep -q "active sources: calendar (ics)" && ok "--explain lists the active calendar source" || no "--explain with ics" "$out"
echo "$out" | grep -q "no sources configured" && no "--explain claims no sources although one is set" || ok "--explain does not say 'no sources configured' when one is"

# ---------------------------------------------------------------- 10. the macOS adapter, with fake back ends
AD="$KIT/scripts/watcher-adapters/macos-calendar.sh"
FB="$SB/fb"; mkdir -p "$FB"
for t in bash date uname cut head printf; do p=$(command -v "$t") && [ -x "$p" ] && ln -sf "$p" "$FB/$t"; done
ln -sf "$(python3 -c 'import sys,os;print(os.path.realpath(sys.executable))')" "$FB/python3"   # not a pyenv shim: a shim needs tr/sed on PATH
out=$(PATH="$FB" "$FB/bash" "$AD" 2>&1); rc=$?
{ [ $rc -ne 0 ] && echo "$out" | grep -q "found neither"; } && ok "adapter: clear message when neither osascript nor icalBuddy exists" || no "adapter without back ends" "rc=$rc $out"
cat > "$FB/icalBuddy" <<'FAKE'
#!/bin/bash
printf '@@Dentist visit\n    2026-10-28 at 17:30 - 18:15\n@@Company holiday\n    2026-10-30\n'
FAKE
chmod +x "$FB/icalBuddy"
out=$(PATH="$FB" "$FB/bash" "$AD" 2>&1); rc=$?
python3 - "$out" <<'PY' && ok "adapter: icalBuddy output becomes JSON (timed and all-day)" || no "icalBuddy parse" "rc=$rc $out"
import json, sys
d = json.loads(sys.argv[1])
assert d[0] == {"title": "Dentist visit", "start": "2026-10-28T17:30:00", "all_day": False}, d
assert d[1] == {"title": "Company holiday", "start": "2026-10-30", "all_day": True}, d
PY
printf '{"timezone":"UTC","deadlines":false,"calendar":{"type":"command","command":"%s/bash %s"}}\n' "$FB" "$AD" > "$CFG"
out=$(PATH="$FB:$PATH" run --dry-run 2>/dev/null)
echo "$out" | grep -q "Dentist" && ok "watcher + adapter end to end (fake icalBuddy)" || no "end to end adapter" "$out"
grep -Eq 'osascript|icalBuddy' "$KIT/scripts/watcher-adapters/macos-calendar.sh" && ! grep -Eq 'make new|delete |set summary|tell application "Calendar" to (make|delete)' "$AD" \
  && ok "adapter source has no write verbs" || no "adapter may write"

# ---------------------------------------------------------------- 11. writes only inside the state dir
reset; cfg_ics
mkics <<'E'
s1|Standup|DTSTART:20261028T170000Z
E
before=$( (cd "$SB" && find agent home/.config -type f | sort; find agent home/.config -type f -exec cksum {} + | sort) | cksum)
run --job eve >/dev/null 2>&1
after=$( (cd "$SB" && find agent home/.config -type f | sort; find agent home/.config -type f -exec cksum {} + | sort) | cksum)
[ "$before" = "$after" ] && ok "nothing under the agent folder or the config folder was written" || no "watcher wrote outside the state dir"

echo "watcher: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
