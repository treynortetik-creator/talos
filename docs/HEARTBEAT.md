# Heartbeat: the check runner (HB2)

A heartbeat is a Chronos job that fires at several times a day (`times`) and carries a `talos.heartbeat` config in its
`meta`. When a slot comes due, the bridge claims it and runs the checks itself. **No agent is involved**: an empty slot
costs nothing, and the job's prompt is never sent to the agent. The shapes (config, source request and answer, item,
result) are the frozen contract in `docs/SCHEDULES.md` S1.7; this page is how the runner uses them.

HB2 has no agent wake. The wake is a seam (`HeartbeatWake` in `apps/bridge/src/heartbeat/runner.ts`) and the default one
hands nothing over, so an `act` item becomes a plain line that asks you to reply. HB4 puts the real wake behind it.

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

| Level    | What it does                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------- |
| `silent` | recorded only                                                                                  |
| `fyi`    | joins ONE digest row (72 words, then "+N more"), posted with no push (a "Heartbeat" row)       |
| `act`    | wakes the agent (HB2: the stub) and notifies. At the wake cap it rolls into the digest instead |

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
a row is said once more; recovery resets the count. A source that has not answered for 72 hours starts over with no cursor
instead of flooding you with a backlog.

The wake cap counts per local day (your time zone). A stored day later than today (a clock once set forward) is ignored, so it never pins the count.

## Shadow and live

`mode: "shadow"` (the default) records everything and never posts, notifies or wakes. It still writes the digest row it
_would_ have posted to `heartbeat-shadow.jsonl` (one JSON line per run, trimmed to the last 200 lines past 512 KiB), and
keeps its own store (`heartbeat-state.<job id>.shadow.json`) so that what shadow saw is not mistaken for "already shown" when the
heartbeat goes live. Shadow never spends a wake. `mode: "live"` posts fyi rows and calls the wake for `act` items.

A dry run (`dry: true` on the request) runs every source for real and writes, posts and wakes nothing.

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

| File in `$TALOS_APP_HOME`              | What                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `heartbeat-state.<job id>.json`        | live store: items, per-source cursor / `last_ok` / `fail_streak`, `wakes_today`, a pending post |
| `heartbeat-state.<job id>.shadow.json` | the same, for shadow mode                                                                       |
| `heartbeat-shadow.jsonl`               | what shadow would have posted                                                                   |

One store per heartbeat job: two jobs never share cursors, dedupe, wakes or a pending post.

Deleting a store re-baselines: items show once more, sources start over. A store that cannot be read is set aside as
`*.corrupt-<time>` and you are told in the thread.

## How a digest is drawn

Digest rows carry text from outside (an issue title, a subject), so the app draws them under a fixed "Heartbeat" label, the
text quoted with its newlines kept. They are never drawn as a Talos notice, and a title that mentions a security check does
not get the worried mascot. (An app older than this change draws the row as an ordinary notice until it is updated.)

## Which jobs can be heartbeats

A heartbeat job has to run in the live session: runner `session`, full permissions, a Claude job. Any other kind would be
started by Chronos in the background with the job's prompt, so the card path refuses it before a card exists. At a slot, if
the job cannot be read, the offer is refused with a plain notice (once) and is tried again on the next tick; it is never
handed to the agent.
