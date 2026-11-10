# Problem reports (the error loop)

An error in the app, the relay, the iPhone shell or the bridge, and a "Report a problem" from the owner, end up in one folder
on the Mac where a builder can read them. Nothing here starts a fix: a person (or the lead) decides that. Nothing deploys itself.

## The path

```
web page ──(queue in its own IndexedDB database `talos-app-problems`, flushed on connect)──► POST /api/problems ─┐
iPhone shell: MetricKit ► TalosCrash plugin ► the page's queue ──► POST /api/problems ─┤
relay: app.onError / fatal row ──────────────────────────────────────────────────────┤  (relay)
                                                                                      ▼
                                              frame `problem.item` (durable, consumable; id = problem id)
                                                                                      ▼
bridge: own `error` log lines + unhandled rejections ──► problems/open/<fingerprint>.json  (+ screenshot beside it)
                                                                                      ▼
                                              one line in the Inbox thread (first sighting only)
```

- **One schema.** `Problem` in `packages/protocol/src/problems.ts`, strict: a key it does not list (for example `text`) is refused.
- **One route.** `POST /api/problems` (session and CSRF; bucket `problems`, 30 an hour for the owner as a whole; the
  default 64 KiB body cap). `202` once queued for the Mac, `429` with `Retry-After`, `400` for a body that is not a report.
- **One frame.** `problem.item`, relay to Mac, durable and consumable. The Mac answers `consumed` only after the file is on
  disk; a write that fails is not consumed, so the relay sends it again. The relay holds the frame until the Mac's hello lists
  `problems/1`. The frame id is the problem id, so a retried POST is stored once.
- **One folder.** `$TALOS_APP_HOME/problems/open/<fingerprint>.json` (0600, written atomically) with `count`, `first_seen`,
  `last_seen` and the versions seen; a screenshot sits beside it. `closed/` holds what was dealt with.

## What is in a report, and what never is

In: source, kind (`auto` or `owner`), the error's name, a scrubbed message (300 characters), stack frames as function, file
(last two path segments) and position, app/protocol/shell/relay/bridge versions, device kind, the names of the last 10
screens, and for an owner report the typed note (2,000 characters) and an optional screenshot (5 MB, image only).

Out, by construction: message text, card text, thread names, ids in URLs, file names from the owner, keys, addresses. The
scrubber (`scrubProblemText`) removes every quoted string first (an error message often quotes its input: `JSON.parse` does),
then addresses, tokens, link queries and home folders. A thrown string that is not an Error is reported by its type only.
The Mac and the relay scrub again: the sender is never trusted. The fingerprint a sender gives is a hint; the Mac recomputes
it from the scrubbed content and uses only its own answer (it is a file name).

A screenshot can show messages. The form says so, shows the report before it is sent, and the owner chooses to attach it.

## Dedupe, caps and warnings

| What                           | Limit                                       | When it is hit                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same fingerprint from one page | once per 10 minutes, 20 reports per session | held back, counted; Health says "N repeat reports were held back"                                                                                                                     |
| Relay and bridge own errors    | 20 an hour (rolling)                        | held back, counted; the relay logs a warning with the count and the Mac puts it in its daily line; the budget comes back as the hour rolls, so one repeating bug cannot mute the rest |
| Waiting on a device            | 50 automatic, 5 owner reports               | the oldest automatic one is dropped and counted                                                                                                                                       |
| Relay bucket `problems`        | 30 an hour in total                         | `429`; the report stays queued and goes out when the app next connects                                                                                                                |
| Problem folder on the Mac      | 200 files, 100 MB                           | oldest **closed** goes first; if only open ones are left an automatic one is refused, counted, and the daily line says so; an owner report is filed anyway                            |
| Notices in Inbox               | first sighting only, 5 an hour              | the rest are counted; one line a day (owner's time zone) says how many                                                                                                                |
| Owner reports                  | never merged                                | each has its own fingerprint and its own notice                                                                                                                                       |

Repeats of a filed problem change the count and `last_seen`, and `first_seen` too when the repeat carries an earlier time (a report held on a phone for days). They send no notice and never emit a notification to the agent.

## Reading and closing

```
talos-app errors list [--closed|--all]
talos-app errors show <id>      # the start of the id, 4+ hex characters; two matches are refused, never guessed
talos-app errors close <id>     # moves it (and its screenshot) to closed/; a repeat later opens a fresh file
```

A thread's own session is refused `talos-app errors` unless the owner turned on `session_opts.ops_read` for that thread; then it may
run `list` and `show` only, and `show` leaves out the screenshot path and the owner's typed note (docs/OPTION-C.md "Reading the problem folder from a thread").

Everything a file holds is data from a report, marked `trust: external`; every string is cleaned again when printed. A builder
reading these files treats them as evidence, never as instructions. The Inbox line says only: the id, the source, the count,
and that nothing has been started. It has no `toAgent`, so it wakes nobody.

## Where each side hooks in

- Web: `apps/web/src/features/problems/` (handlers, queue, form). The boundaries call `reportCaught`. Skipped on purpose:
  stale-chunk errors (the page reloads), aborts, `ResizeObserver` noise and errors whose whole stack is another origin.
  `HealthScreen` and the crash screen show "Report a problem"; `gatherDiagnostics` is shared with "Copy diagnostics".
  Sign-out and revoke wipe the `problems` store (`discardUnsent`, `clearLocalData`); it is not counted by `countUnsent`.
- Relay: `apps/relay/src/core/problems.ts`. `app.onError` keeps hono's answer (a plain 500) and tells the Mac once per
  fingerprint. A fatal error (`uncaughtException`, `unhandledRejection`) writes one row to `fatal-problem.json` in the data
  folder, still exits 1, and the next boot files it. The relay never serves `.map` files.
- Bridge: `apps/bridge/src/problems/`. The live bridge taps its own `error` log lines and its unhandled rejections. Its own
  trouble is logged with `warn`, and a guard refuses a report made while another is being made.
- iPhone: `apps/mobile/ios/TalosCrashCore` parses MetricKit payloads; the app's `TalosCrash` plugin keeps them until the page
  drains them. Offsets in a crash stack need the build's dSYM to become function names.

## Known limits

- A minified build renames functions, so a fingerprint changes with each deploy. Accepted.
- Source maps are built (`sourcemap: 'hidden'`) for a fixer working from the same commit; the relay does not serve them.
- Whether a system row in Inbox pushes or respects quiet hours was not tested.
