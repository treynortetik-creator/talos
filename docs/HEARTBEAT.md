# Heartbeat: the check runner and the wake

A heartbeat is a Chronos job that fires at several times a day (`times`) and carries a `talos.heartbeat` config in its
`meta`. When a slot comes due, the bridge claims it and runs the checks itself. **No agent is involved**: an empty slot
costs nothing, and the job's prompt is never sent to the agent. The shapes (config, source request and answer, item,
result) are the frozen contract in `docs/SCHEDULES.md` S1.7; this page is how the runner uses them.

When an item is `act`, the bridge wakes the agent with a run pack (see "The wake" below). The wake is a seam
(`HeartbeatWake` in `apps/bridge/src/heartbeat/runner.ts`); the runner on its own has a stub that hands nothing over, and
the bridge wires the real one (`heartbeat/wake.ts`).

## What happens at a slot

1. Chronos says the slot is due. The bridge records the offer, claims the slot, and runs the heartbeat in the background
   (one at a time per job; a slow source never holds up other jobs).
2. **Quiet hours.** If the slot falls in the quiet window (read now, in your time zone), the run closes with outcome
   `quiet` and no source runs. Run now and a test run bypass quiet hours.
3. Each enabled source is started at once, with its own `timeout_s`; the whole run has `run_timeout_s`. Anything still
   running at its limit is killed together with everything it started (by process group). A source that hangs costs only
   itself. A child it leaves running after a clean exit is killed with the group too. A process that leaves the group on
   purpose (`setsid`) is out of reach: a known limit.
4. Each answer is read with `parseHeartbeatSourceResponse`. Over 256 KiB, over 50 items, not JSON, a wrong schema or a
   non-zero exit is a **source error**, never an empty list. One item that does not parse is dropped and counted.
5. Items are merged and deduped by `(source, key)`. The same `sig` is the same item; a new `sig` raises it again. Mutes
   (`heartbeatMuteMatches`, exact key) and the work gate (below) drop items.
6. The store is written (`heartbeat-state.<job id>.json`, tmp file and rename, mode 0600).
7. The post is made, then the items are marked shown. If the bridge dies in between, the next run retries that post
   once and never posts it twice.
8. The run closes with `finish`, so Chronos writes the same `ran-` marker as for any run. The result (outcome, and per
   source `ok`, `ms`, `unreadable`, `error`) is kept in the run's entry in `schedules-meta.json`, never any item text.

## Levels and outcomes

| Level    | What it does                                                                             |
| -------- | ---------------------------------------------------------------------------------------- |
| `silent` | recorded only                                                                            |
| `fyi`    | joins ONE digest row (72 words, then "+N more"), posted with no push (a "Heartbeat" row) |
| `act`    | wakes the agent with a run pack. At the wake cap it rolls into the digest instead        |

| Outcome   | Meaning                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------- |
| `silent`  | nothing new: nothing is posted, nothing is sent to the agent                                       |
| `fyi`     | a row was posted                                                                                   |
| `woke`    | the wake took the act items                                                                        |
| `capped`  | `wake_cap_per_day` was reached; the items went into the digest                                     |
| `quiet`   | quiet hours, no source ran                                                                         |
| `partial` | some sources failed, an item could not be read, or a source kind from a newer Talos was skipped    |
| `failed`  | every source failed, no source is turned on, the post was refused, or the state could not be saved |

A failure outranks a quiet word: `failed` and `partial` win over `capped`, `woke`, `fyi` and `silent`. The run still
delivers what it found. A run that closes `failed` says why in the thread, once. A source that has failed three checks in
a row is said once more; recovery resets the count. If the heartbeat itself has not completed a run for 72 hours, every
source starts over with no cursor instead of flooding you with a backlog (see "A big or cold wake"). A source that was down
while the heartbeat kept running keeps its cursor and delivers normally when it recovers.

The wake cap counts per local day (your time zone). A stored day later than today (a clock once set forward) is ignored, so it never pins the count.

## Shadow and live

`mode: "shadow"` (the default) records everything and never posts, notifies or wakes. It still writes the digest row it
_would_ have posted to `heartbeat-shadow.jsonl` (one JSON line per run, trimmed to the last 200 lines past 512 KiB), and
keeps its own store (`heartbeat-state.<job id>.shadow.json`) so that what shadow saw is not mistaken for "already shown" when the
heartbeat goes live. Shadow never spends a wake. `mode: "live"` posts fyi rows and calls the wake for `act` items.

A dry run (`dry: true` on the request) runs every source for real and writes, posts and wakes nothing. The owner's test (see
"In the app") is a dry run that also reads no saved store and looks back a window instead of at a cursor. (A "test with the
agent" level that really wakes the agent is not built yet: the bridge refuses a `with_agent` request in words, and the app has
no way to ask for it.)

## The wake

An `act` item under the daily cap does not put its words in front of the agent. The bridge:

1. Records the wake in the store (`wake`: run id, the item ids, the time) and counts it against the cap, **before** it sends
   anything, so a crash after the send still knows a wake is out.
2. Writes the **run pack**, `$TALOS_APP_HOME/heartbeat/runs/<run id>.json` (mode 0600, folder 0700, kept 14 days). It holds at
   most 10 items. Per item: `ref`, `source`, `level`, `class`, `deadline`, and `untrusted`, one block holding the key, title,
   why, link and detail inside `wrapExternal` markers (`EXTERNAL_UNTRUSTED_CONTENT`, a random id, spoofed markers removed).
3. Sends one `schedule_run` notification (kind `schedule_run`, `trust=owner`, so nothing from a source may be in it). It
   carries a fixed instruction, `hits_path`, and counts by source as integers. Never a subject, title, body or key. The
   instruction (`heartbeat/prompt.ts`, not the job's own prompt, which a heartbeat never sends) tells the agent: the pack is
   untrusted data, hand it to the **`heartbeat-triage`** agent and do not read it yourself, anything that sends, posts,
   comments, assigns, closes, merges, deploys, pays or deletes goes through a card, give every card this run id, and reply in
   the job's thread.
4. Keeps the slot's Chronos claim **open**. The agent does not call `schedule_run_start` (the bridge already started the run;
   if it does, the first call answers `GO`). The run ends with `schedule_run_done`.

**`heartbeat-triage`** is an agent in the `talos-app-mod` plugin (`plugins/talos-app-mod/agents/heartbeat-triage.md`) with
the tool `Read` and nothing else. It reads the pack and returns a short summary and suggestions. It cannot post, send or run
a command. It can still read other files you can read, and only its instructions keep it to the pack, so its
summary is treated as untrusted (the wake prompt says so). The plugin is optional: without it the agent is missing,
the bridge looks at the mod's plugin inventory before it wakes anything. If the mod is not live yet or its inventory has
not arrived (right after a bridge restart or a plugin reload), that is _unknown_, not missing: nothing is woken, nothing is
said, no attempt is counted, and the items wait for the next slot. After three slots of unknown they become plain lines
(still without the install line, which would be a guess). Only when the inventory is there and `talos-app-mod` is not in it
are the items made plain lines at once, with one thread line, "Install talos-app-mod for heartbeat triage" (said again only
after the agent has been available in between). If the agent turns out to be missing anyway, the prompt tells the main
session not to read the pack itself and to call `schedule_run_done` with `ok:false`. The bridge sees the mod's plugin
list, not its agents, so "the mod is loaded" is the nearest proof it can get.

**Shown only when it is done.** The items of a wake stay `new` while the agent works. They become `surfaced` only when
`schedule_run_done` with `ok: true` is accepted for that run id. Anything else leaves them `new`:

| What happened                                                  | Result                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `schedule_run_done` ok                                         | items `surfaced`; no digest row                                                                          |
| `schedule_run_done` ok:false                                   | items stay `new`; offered again at the next slot                                                         |
| the session refuses the notification (no session, send failed) | not counted as a wake; items stay `new`                                                                  |
| the pack cannot be written                                     | same: no pack, no wake                                                                                   |
| the run times out, or the session restarts mid-wake            | items stay `new`; offered again at the next slot                                                         |
| a wake out for over 2 hours with no word                       | treated as killed at the next run                                                                        |
| the **second** failed attempt for an item (any of the above)   | the item is posted as a plain line ("Needs you: ... Reply here and I'll take it.") and then marked shown |

Two attempts at most per item, so nothing loops. While a wake is out the job's Chronos claim is open, so Chronos does not
offer its next slot, and Run now answers "already running". (A wake times out at the run limit, 40 minutes by default, well
before the next slot.) If the bridge is ever refused the claim because another run holds it, the slot is recorded as
**Skipped, Busy** in the run list and nothing is read or posted. As a second guard, the saved store holds the wake, so a
run that does start while one is out does not wake again for the same items, and new `act` items wait (they stay `new`, and
lead the next wake). Reaching the daily wake cap still rolls items into the digest.

**A wake that has ended cannot act.** When a wake closes (done, timeout, restart, or abandoned after two hours with no word) its pack file is deleted. The run is remembered as a wake
by a flag set when the notification is sent, not by its outcome, so a wake in which one source failed (outcome `partial`) is
treated the same. A `schedule_run_done`
or a `card` naming that run is answered "this heartbeat wake already ended; do nothing more for it", and the prompt says to
stop if the pack is missing. Packs older than 14 days are pruned at every heartbeat run, each file on its own, so one that
cannot be removed does not stop the rest.

**A big or cold wake.** One wake carries at most 10 items (nearest deadline first, then oldest). The rest stay `new` for the
next wake and the thread says "N more items are waiting for the next check-in". The store keeps `last_run`, when this
heartbeat last completed a live run. If that was over 72 hours ago, every source starts over with no cursor, what they report
on that first look is recorded as shown and not woken, and the thread gets one line, "Heartbeat was off for N days. Skipped
the backlog (M items)." A source's own silence does not trigger this: one that failed for three days while the heartbeat
kept running keeps its cursor and delivers normally. The bridge can see its own state file only; it cannot see Chronos's
history or the agent's last turn.

### Cards

A heartbeat has to have **a thread of its own**: a heartbeat with no thread, or in the default thread, is refused before any
card is made (create, update and adopt). One found without one (an old job, or its thread was archived) is never woken: its
items become plain lines and the thread says once, "Heartbeat can't wake you until it has a thread of its own. Pick one in
Schedules." Every card
made in that thread follows the heartbeat's rules, **whatever `run_id` or `origin` it names**:

- It is a `background` card and lives a day at most (a longer `expires_in_s` is cut to 86,400).
- At most **3 are pending** in the thread. The 4th is posted as a plain line and no card is made. The pending cards are
  counted from the card ledger at the moment the card is made, in the same step that makes it, so there is no list to drift
  and two cards made at once cannot both pass. An expired or answered card frees a place; the rule holds after a restart.
- `supersedes` has to name a pending card **in the same thread** (any thread, not only a heartbeat's). A card that replaces a
  pending one takes no new place, and one card cannot be replaced twice at once.

`run_id` on a card gives no authority. It can only get a card refused, when it names a wake that has ended.

## The work gate

Items with `class: "work"` are refused unless the owner has allowed work content for Heartbeat. That is the same setting as
every work integration: `heartbeat` in `config.work.enabled`, turned on in Integrations ("Heartbeat (work items)") with a
passkey step-up. The agent and a command source cannot turn it on through the app or the agent's tools, and a file in the
Talos folder does nothing; the bridge reads the config each run and checks it again for items held from an earlier run.
Turning it off drops stored work items from the heartbeat's state file.

What it does not stop: someone who can edit `config.json` by hand on the Mac can switch it on, and trust mode (set only at the
Mac) relaxes the passkey step. The tripwire notices a hand edit and tells you, but it does not undo it. That is the same as
every work integration.

Rollout: reload every device (app and web) before you turn "Heartbeat (work items)" on, and do not roll the relay or the web
app back while it is on. An older peer drops the id it does not know when it reads the config (so the frame survives), but it
cannot show or switch it.

A source can be marked `class: "work"` in its config (the approval card shows `[work content]`). Every item from such a
source is work, whatever the item says about itself, so a work repo cannot skip the gate by labelling its items `own`.

A refused item is never stored and its words never leave the Mac. The thread gets one line saying how many were refused and
from which source (once per key and sig).

## Sources

A source is either a built-in (`github`, `schedule-failures`, `inbox`) or a `command`.

- `github` reads PRs and CI for the configured repos with `gh api`: CI red for over 24 h is `act`, a PR green and untouched
  for 24 h is `fyi`, and notifications for review requested, mention, assigned and security alert are `act`.
  `ci_activity` and every other reason raise nothing. It needs `gh` signed in on this Mac; if it is not, that is a source
  error that says so. At most 30 PRs are checked per run.
- `schedule-failures` reports failed, timed-out, restarted and missed runs of the bridge's own scheduled jobs (`fyi`).
- `inbox` reports things filed into the shared inbox since the last look (`fyi`).
- Every source baselines first: with no cursor it records where it is and raises nothing.

### Writing a command source

A source is any program. The runner starts `argv` directly (no shell), in `cwd` if given, with a small environment: `PATH`,
`HOME`, `LANG`, `TALOS_HEARTBEAT=1` and the `env` you configured. Nothing else is inherited, so a source reads its own
credentials from its own files. It reads ONE JSON request on stdin and prints ONE JSON answer; the shapes and limits are
in `docs/SCHEDULES.md` S1.7 and the examples in `packages/testkit/fixtures/heartbeat/`.

```sh
#!/bin/sh
# stdin: {"schema":"talos.heartbeat-source/1","now":"...","since":null,"cursor":null,"dry":false}
cat > /dev/null
printf '%s' '{"schema":"talos.heartbeat-source/1","status":"ok","cursor":null,"items":[
  {"key":"disk:full","sig":"91","title":"Disk is 91% full","level":"fyi","class":"own","why":"disk.full","deadline":null}]}'
```

Rules a source should follow: write nothing and send nothing (every source must be safe to dry-run); put a stable `key`
on each item and change `sig` when it really changes; return the `cursor` you want back next time (it is only kept when
you answer `ok`); on trouble print `status: "error"` with a short `error`, or exit non-zero. Item text is untrusted: it
is capped and escaped once, when your answer is read, so control and bidi characters show as `⟦U+XXXX⟧`.

## Files

| File in `$TALOS_APP_HOME`              | What                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `heartbeat-state.<job id>.json`        | live store: items, per-source cursor / `last_ok` / `fail_streak`, `wakes_today`, `last_run`, an open wake, a pending post |
| `heartbeat-state.<job id>.shadow.json` | the same, for shadow mode                                                                                                 |
| `heartbeat-shadow.jsonl`               | what shadow would have posted                                                                                             |
| `heartbeat/runs/<run id>.json`         | the run pack for a wake; deleted when the wake ends, pruned after 14 days                                                 |
| `heartbeat/tests.json`                 | the last passing test of each config hash (hash and time); a pass is good for 24 hours                                    |

One store per heartbeat job: two jobs never share cursors, dedupe, wakes or a pending post.

Deleting a store re-baselines: items show once more, sources start over. A store that cannot be read is set aside as
`*.corrupt-<time>` and you are told in the thread.

## How a digest is drawn

Digest rows carry text from outside (an issue title, a subject), so the app draws them under a fixed "Heartbeat" label, the
text quoted with its newlines kept. They are never drawn as a Talos notice, and a title that mentions a security check does
not get the worried mascot. (An app older than this change draws the row as an ordinary notice until it is updated.) The agent's `read_thread` returns these rows
wrapped as outside text and labelled "heartbeat (outside text)", never as `system:`.

## Which jobs can be heartbeats

A heartbeat job has to run in the live session: runner `session`, full permissions, a Claude job. Any other kind would be
started by Chronos in the background with the job's prompt, so the card path refuses it before a card exists. At a slot, if
the job cannot be read, the offer is refused with a plain notice (once) and is tried again on the next tick; it is never
handed to the agent.

## In the app

The Schedules tab draws a heartbeat job (a job whose `meta` has `talos.heartbeat`) apart from the others.

| Where                      | What it shows or does                                                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pinned "Heartbeat" section | One row above Today: the last check's outcome in words and colour, the next slot, the wake cap, and the pause switch. Offline, the cached row stays and its switch is disabled.                                                                           |
| [+ New] > Heartbeat        | Shown only when no heartbeat exists and the Mac lists `schedules/2`. Opens the setup form.                                                                                                                                                                |
| Setup                      | Cadence, first and last check, days, sources, wake cap and a thread of its own. It builds a `talos.heartbeat` config in shadow mode and a `times` job around it. Nothing is saved by the form.                                                            |
| Test sheet                 | Sends `heartbeat.test`, waits up to 200 s for `heartbeat.test_result`, and shows each source, what would wake the agent, what would post, and the estimate. 8, 24 or 72 hours of look-back.                                                               |
| Turn on                    | Disabled until a test passes for the exact config (its `configHash`), fresh within 24 hours, with every enabled source ok and nothing unreadable. Zero items is a pass. It opens the ordinary approval card. The Mac checks the same thing again (below). |
| Detail                     | Today's checks, each source as configured (kind, class, and a command's argv word by word), its last result with unreadable counts, the mute list with Remove, and Add a mute. All changes go through a card.                                             |

### A test before turning on (the Mac enforces it too)

**Turn on is gated twice: by the app, and by the Mac.** The bridge remembers the last passing test of each config hash in
`$TALOS_APP_HOME/heartbeat/tests.json` (hash and time, mode 0600, the newest 50 under 24 hours old). A change that leaves a
heartbeat job **enabled** is refused with `schedule_invalid` (field `test_required`) and "Run a heartbeat test for these settings
first" unless that exact hash has a pass under 24 hours old. The check is in the one place every change passes through, so it
holds for the agent's `schedule_propose`, the app's `schedule.patch` and an adopt alike, and it is asked again when the card is
approved (a pass can age out between drawing the card and tapping it; then the card fails and nothing is saved).

- A heartbeat saved **disabled** needs no test. That is how setup works.
- Turning an enabled heartbeat **off** never needs one.
- An update to a heartbeat that is **already on** needs none when the settings stay the same (a rename, a thread move) or only
  the mute list changes (a mute only hides items). Any other change (a source, the mode, a time limit, the wake cap) is new
  settings and needs a pass for them.
- An **adopt** of an enabled heartbeat always needs one, and so does `talos-app schedules adopt` at the Mac, which leaves such a
  job on hold and says why.
- **Existing heartbeats keep running.** A heartbeat that was already on before this rule is not switched off and is not asked
  for a test; only a changed setting needs one.
- **If the current job cannot be read** (Chronos did not answer), a change to an existing job is refused with "Couldn't read the
  current schedule; try again" instead of being judged without it. Turning one off is still allowed.
- If the settings on disk no longer parse strictly, the no-test shortcut does not apply: the new settings need their own pass.
- A pass is for one hash. The hash covers every setting (mode, sources, mutes, caps, limits), so a pass for shadow mode is no
  pass for live, and one pass cannot be reused for a different config. A pass dated in the future (the clock was set back) is no
  pass. A ledger that is missing, damaged or of another version means "no pass": every enable is refused until the owner tests.
- **What it does not stop.** The ledger is a plain file, not signed. It guards against mistakes (turning on settings nobody has
  looked at), not against code running as you on this Mac: a command source, or the agent's shell if you let it, can write
  a pass into it by hand. That is the same limit as the work gate above. Treat a heartbeat source like any program you run.
- Only the bridge writes a pass, only from a result it computed itself, read the way the app reads it. If the pass cannot be
  saved, the answer says so as a failed test instead of reading as a pass the next Turn on would refuse.

The app and the bridge hash the same way: `heartbeatConfigHashOf(raw)` in `packages/protocol` is `configHash` of the strict parse
of the raw `talos.heartbeat` object, and the bridge calls that one function on the config exactly as the frame carried it.

### What the Mac does with `heartbeat.test`

1. The frame is checked like every owner schedule frame (signature, pinned device, not seen before). Then the config in it is read
   with the strict schema. One that fails is answered with an `error` (`schedule_invalid`, field paths under `config`, "These
   heartbeat settings can't be tested") and nothing runs. So is `with_agent: true` ("isn't available yet"), and a third test while
   one is already running (`rate_limited`, "A heartbeat test is already running"); a request more than two minutes old is
   refused as `stale`, like Run now. The same `request_id` asked again while it runs is acked and not run again.
2. **The Mac acks as soon as the request is accepted**, before any source starts, outside the schedule queue (a Chronos call
   in progress does not delay it). So an ack means "this Mac took the test"; a socket that drops before the ack never reached the
   Mac, and the app can ask again with the same `request_id`. The result follows when the sources are done, which can be up to
   `run_timeout_s` (150 s at most) later.
3. The sources run for real with `dry: true`, on a runner of their own: a test never waits for a real slot and a real slot never
   waits for a test. Nothing is written to a heartbeat store, nothing is posted, nobody is woken, Chronos is not asked to claim
   anything. The source request carries `since` = now minus the window, and no cursor; the built-in sources are given a cursor
   that means "from the start of the window". Each source has its own `timeout_s` and the run has `run_timeout_s`; what is still
   running at its limit is killed with everything it started. The inbox source has no time cut: it lists what the last three days
   of the shared inbox hold.
4. `heartbeat.test_result` carries `config_hash`, `at`, `window_h`, `with_agent` (always false), `mode`, `error`, a row per enabled source (`ok`,
   `ms`, `read`, `act`, `fyi`, `dropped`, `held`, `unreadable`, `error`), `would_wake` and `would_post` (at most 20 lines each, the
   item's title and rule; nothing from a muted, silent or work-gated item), `held`, `est_wakes`, `est_tokens` and `if_live`. **In shadow mode the heartbeat only records**, so `would_wake` and
   `would_post` are empty and the estimates are 0; `if_live` then holds what live mode would wake and post, and the sheet says
   "Shadow: records only, never wakes or posts". `error` is set (and the test is never a pass) when the run broke or a pass could
   not be saved. `read` counts
   items that parsed, `dropped` the muted and silent ones, `held` the ones the work gate refused. The token figure is a rough
   estimate (180,000 per wake, from the design), not a measurement.
5. If the run itself breaks after the ack, the answer is still a result: sources that had answered keep their real result (ok,
   time, how many items, unreadable), the others are marked "It did not finish", and `error` says the run broke, so the sheet
   shows what happened instead of waiting out its 200 seconds. Stopping the bridge kills the sources of a test in flight and
   sends nothing; the sheet then runs out its wait.

A test that cannot run (rate limited, Mac offline, no answer, an unreadable result) never replaces a pass for the same config
that is under 24 hours old; only a real result for it does. If the app's socket drops while a test runs, it asks again with the
same `request_id` on the new socket: the relay keeps the pending test for its owner (in memory, for its 210 s) and hands the
answer to the new socket without asking the Mac a second time. A heartbeat posts to a thread of its own: General, the default
thread, inbox and a thread another job already uses are not offered.

Outcome words: `Nothing new`, `N updates posted`, `Checked in, N items`, `Wake limit reached`, `Couldn't check X`, `Check failed`,
`Quiet hours`, and `Busy`. The app reads these from the run's one-line summary. The busy one is a slot that could not start because
the earlier wake still holds the claim: the run is recorded as `skipped` with the summary "Busy: the earlier check-in is still
running, so this one did not run", and the app draws it as "Busy: the last wake is still open" (it reads `/^busy\b/i` on a skipped
run). A run that did
not finish OK is never shown as quiet, and a word it does not know is shown as a neutral "Unknown".

### The two frames

| type                    | direction           | fields                                                                       |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `heartbeat.test` 🔏     | app to relay to Mac | `request_id`, `config` (an open object), `window_h` (1 to 168), `with_agent` |
| `heartbeat.test_result` | Mac to relay to app | `request_id`, `result` (an open object the app reads one source at a time)   |

The relay treats them like the schedule frames (`docs/SCHEDULES.md` S4): the same owner check, never stored, the answer
routed to the asking socket only, `mac_offline` at once, 6 tests an hour, and a request kept for 210 s. A second socket
cannot reuse a live `request_id`. Both are gated by the feature `heartbeat/1`, which the relay lists and the bridge lists in its hello; an app sends the frame only when both do, and a relay answers `scheduler_unavailable` if the Mac does not.
Neither frame has a closed list in it, so a newer app's config or a newer Mac's result costs at most one source row.

`result` carries `config_hash`, `at`, `window_h`, `sources` (each `id`, `ok`, `ms`, `read`, `act`, `fyi`, `dropped`, `held`,
`unreadable`, `error`), `would_wake`, `would_post`, `held`, `est_wakes` and `est_tokens`. Examples are in
`packages/testkit/fixtures/heartbeat-frames/`.
