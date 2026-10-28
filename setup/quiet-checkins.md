# Quiet check-ins

Four small scheduled checks on weekdays (09:45, 12:15, 14:45, 18:45) that say nothing unless something is worth a
ping. No Claude, no model, no usage cost: each is a plain Python script run by Chronos as a "command" job.

## What it does

`scripts/watcher.py` checks up to three things and sends ONE short plain-text message (60 words at most) only if a
bar is crossed. Otherwise it prints nothing and exits 0.

| Check | The bar |
|---|---|
| Soon | a timed calendar event starts in the next 150 minutes (`soon_minutes`) |
| Deadline | a dated row in `memory/STATE.md` (and any `deadline_files` you list) falls in the next 48 hours (`deadline_hours`) |
| Changed | an event starting in the next 24 hours (`changes_hours`) is new, moved or cancelled since the previous run |

Each thing is announced once (the same event does not ping at 09:45 and again at 12:15). The message goes to your own
notify channel, the same wrapper your other Talos jobs use (`TALOS_NOTIFY_CMD`, else the `notify` path in your Chronos
config). No notify command configured: it prints the message and says so on stderr.

## What it does not do

- It does not read your mail, chat or any personal vault, and nothing is judged by a model.
- It does not write to your calendar. The macOS adapter is read-only.
- It sends no data anywhere except your own notify command (and, only if you choose an ICS URL, one GET request to that
  URL).
- It is not a reminder app: no snooze, no repeat, no "you have 0 events today" message.
- It does nothing at all until you create a config file. A `memory/STATE.md` alone does not switch it on.

## Privacy: event titles leave the machine

A hit puts the event title (or the STATE.md row text) into the message, and Telegram is a third-party service. If a
meeting title is sensitive, do not use Telegram for this; use the macOS banner (`notify/macos.sh`), which stays on the
machine. Titles are cut to a few words, but they are still titles.

## Enable

1. Create `${XDG_CONFIG_HOME:-~/.config}/talos/watcher.json` (below). Nothing runs without it.
2. Look at it: `python3 scripts/watcher.py --explain` shows the config path, the active sources and the notify command.
3. Try it without sending: `python3 scripts/watcher.py --dry-run --job am` prints the message it would send and leaves
   its memory of what it has seen untouched.
4. Check your Chronos is 0.2.1 or newer (command jobs), then enable the jobs you want. They ship disabled:
   `python3 scripts/talos-jobs.py enable talos-watch-am` (and `-mid`, `-pm`, `-eve`; run
   `python3 scripts/talos-jobs.py --help` if your copy words that differently).

## Config

All keys are optional. Defaults shown.

```json
{
  "calendar": {"type": "none"},
  "timezone": null,
  "soon_minutes": 150,
  "changes_hours": 24,
  "deadline_hours": 48,
  "track_days": 7,
  "state_file": "memory/STATE.md",
  "deadline_files": [],
  "deadlines": true
}
```

`timezone` is an IANA name such as `Europe/Berlin`. Leave it out to use the system timezone (used for floating times,
all-day events and for the clock times in the message). `deadlines: false` turns the STATE.md check off. Paths in
`state_file` and `deadline_files` must stay inside the agent folder.

### Calendar source: none (default)

```json
{"calendar": {"type": "none"}}
```

Only the deadline check runs.

### Calendar source: an ICS link or file

Most calendar apps can publish a private "secret address in iCal format". Treat that URL like a password: it is stored
in this file in plain text, so keep the file private (`chmod 600`).

```json
{"calendar": {"type": "ics", "url": "https://example.com/calendar/private-token/basic.ics"}}
```

`webcal://` links work too. For a file you export or sync yourself:

```json
{"calendar": {"type": "ics", "path": "~/calendars/work.ics"}}
```

### Calendar source: a command (macOS Calendar app)

```json
{"calendar": {"type": "command", "command": "bash {{TALOS_HOME}}/scripts/watcher-adapters/macos-calendar.sh"}}
```

The adapter reads the local Calendar app, read-only, and prints JSON. macOS shows a privacy prompt the first time
("... would like to access your calendar"): run `bash scripts/watcher-adapters/macos-calendar.sh` once by hand in a
Terminal and allow it. A scheduled run cannot answer that prompt. Two back ends:

- `icalBuddy` if installed (`brew install ical-buddy`): handles repeating events correctly. Written from its documented
  output and tested only against a fake binary here.
- otherwise `osascript`: Calendar's scripting interface does not expand repeating events, so a weekly meeting shows only
  on its first date. Not run against a real Calendar in the tests. If most of your meetings repeat, use an ICS source.

Any other command works if it prints either an ICS document or a JSON list such as
`[{"title": "Dentist", "start": "2026-10-28T17:30:00+00:00", "uid": "optional-stable-id", "all_day": false}]`.
`start` without an offset is read in your timezone; a bare date (`2026-10-30`) is an all-day event. The range is in the
environment as `WATCHER_FROM` and `WATCHER_TO` (YYYY-MM-DD). A 60-second limit applies.

If a command fails, the next check-in says so once ("Calendar source problem: ...") and stays quiet about that same
failure afterwards. It does not repeat until the failure text changes or the source recovers.

## Limits (verified by `scripts/test-watcher.sh` unless marked)

- ICS: `DTSTART` as UTC, `TZID=<IANA name>`, floating or all-day; `RRULE` with `FREQ` DAILY, WEEKLY, MONTHLY, YEARLY,
  `INTERVAL`, `BYDAY` (plain weekdays, daily and weekly), `BYMONTHDAY` (monthly), `UNTIL`, `COUNT`; `EXDATE`;
  `RECURRENCE-ID` overrides; `STATUS:CANCELLED`.
- Not supported: ordinal `BYDAY` (`1MO`, `-1FR`), `BYSETPOS`, `BYMONTH`, `BYWEEKNO`, `BYYEARDAY`, `RDATE`, rules finer
  than daily, Windows time-zone names (those events are read as local time, with a warning), and `VTIMEZONE` blocks (the
  IANA name in `TZID` is trusted). An unsupported rule yields only its first occurrence and a warning on stderr.
- The first run only records a baseline; change alerts begin with the second.
- A source with no stable event id (some command adapters) cannot tell "moved" from "one cancelled, one new"; it
  pairs them by identical title as a move.
- Events more than `track_days` (7) away are not tracked.
- The deadline check reads dates written `YYYY-MM-DD` in table rows and bullets, skips rows that say done, closed,
  shipped and the like, and skips any section whose heading contains "closed", "done" or "archive".
- Inferred, not tested: the `osascript` back end and real-world ICS feeds from particular vendors.

## State

One file: `${XDG_STATE_HOME:-~/.local/state}/talos/<agent-folder>-<hash>/watcher-seen.json` (the folder the hooks use).
It holds the last event snapshot, what has been announced, the last source error and a per-job last-run time. If a
notify attempt fails, nothing is recorded, so the next run retries. The script writes nowhere else.

## Turn it off

- One job: `python3 scripts/talos-jobs.py disable talos-watch-eve` (or edit the job in your Chronos jobs file).
- All of them: `touch ~/.chronos/PAUSED` pauses every Chronos job; or delete `watcher.json` and every run goes silent.
- Forget what it has seen: delete `watcher-seen.json` (the next run is a new baseline).
