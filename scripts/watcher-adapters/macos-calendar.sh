#!/usr/bin/env bash
# macos-calendar.sh -- READ-ONLY adapter: prints the next days of events from the local macOS Calendar app as JSON,
# for scripts/watcher.py (calendar type "command"). It creates, edits and deletes nothing.
#
#   {"calendar": {"type": "command", "command": "bash {{TALOS_HOME}}/scripts/watcher-adapters/macos-calendar.sh"}}
#
# Range: WATCHER_FROM .. WATCHER_TO (YYYY-MM-DD; watcher.py sets them), default today .. today+8 days.
# Output: [{"title": "...", "start": "2026-10-28T09:00:00", "all_day": false}, ...]  (local wall-clock times)
#
# Two back ends, tried in this order:
#   1. icalBuddy (brew install ical-buddy; optional). It reads through EventKit, so repeating events are expanded
#      correctly. This path was written from icalBuddy's documented output and is covered by a fake-binary test only.
#   2. osascript (always on macOS) driving the Calendar app. LIMIT: Calendar's scripting interface does not expand
#      repeating events, so a weekly meeting shows only on its original date. If you rely on recurring events, install
#      icalBuddy or use an ICS source instead. This path has NOT been run against a real Calendar by the tests.
#
# PRIVACY PROMPT: the first time either back end reads Calendar, macOS asks whether the app that launched it (Terminal,
# your scheduler, ...) may access your calendars. Say yes once, interactively, then run the check by hand to confirm.
# A scheduled run cannot answer that prompt and will fail with a message until you have.
set -u
FROM="${WATCHER_FROM:-$(date +%Y-%m-%d)}"
TO="${WATCHER_TO:-$(date -v+8d +%Y-%m-%d 2>/dev/null || date -d '+8 days' +%Y-%m-%d)}"

if command -v icalBuddy >/dev/null 2>&1; then
  out=$(icalBuddy -nc -nrd -ea -b '@@' -iep 'title,datetime' -df '%Y-%m-%d' -tf '%H:%M' "eventsFrom:$FROM" "to:$TO" 2>&1) || {
    echo "macos-calendar: icalBuddy failed: $(printf '%s' "$out" | head -n 1 | cut -c1-120)" >&2; exit 1; }
  printf '%s\n' "$out" | python3 -c '
import json, re, sys
ev, cur = [], None
for line in sys.stdin.read().splitlines():
    if line.startswith("@@"):
        cur = {"title": line[2:].strip()}; ev.append(cur); continue
    m = re.search(r"(\d{4}-\d\d-\d\d)(?: at (\d\d:\d\d))?(?: - (?:\d{4}-\d\d-\d\d at )?(\d\d:\d\d))?", line)
    if cur is not None and m and "start" not in cur:
        cur["start"] = "%sT%s:00" % (m.group(1), m.group(2)) if m.group(2) else m.group(1)
        cur["all_day"] = m.group(2) is None
print(json.dumps([e for e in ev if "start" in e]))'
  exit 0
fi

if [ "$(uname -s)" = "Darwin" ] && command -v osascript >/dev/null 2>&1; then
  osascript -l JavaScript - "$FROM" "$TO" <<'JXA'
function run(argv) {
  var from = new Date(argv[0] + "T00:00:00"), to = new Date(argv[1] + "T00:00:00");
  var app = Application("Calendar"), out = [];
  app.calendars().forEach(function (c) {
    var evs = c.events.whose({_and: [{startDate: {_greaterThan: from}}, {startDate: {_lessThan: to}}]})();
    evs.forEach(function (e) {
      var d = e.startDate(), p = function (n) { return (n < 10 ? "0" : "") + n; };
      var ad = e.alldayEvent();
      var day = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
      out.push({title: String(e.summary()), uid: String(e.uid()), all_day: ad,
                start: ad ? day : day + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":00"});
    });
  });
  return JSON.stringify(out);
}
JXA
  rc=$?
  [ $rc -ne 0 ] && echo "macos-calendar: osascript could not read Calendar (exit $rc). If macOS asked for calendar access, allow it and retry by hand." >&2
  exit $rc
fi

echo "macos-calendar: needs macOS (osascript) or icalBuddy, and found neither. Use an ICS source instead." >&2
exit 1
