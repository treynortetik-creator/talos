# Health alarms

Talos tells you when your agent has gone quiet, so you find out from a push and not from a missing reply.
Settings → Health shows the same facts at any time. It works with your Mac offline, because it is a relay feature.

## What raises an alarm

| Alarm                               | When                                                                                                                                                                                                                                   | Sent                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{agent}'s Mac session stopped`     | The bridge has been gone 5 minutes                                                                                                                                                                                                     | Once per outage. Inside `MAC_ALERT_MIN_GAP_MIN` (default 120) of the previous one it waits: a short outage ends silently, a long one is alerted when the gap runs out |
| `{agent}'s Mac is back`             | The bridge returns after an outage that raised the alarm above                                                                                                                                                                         | Once; inside the quiet window it is held until the window ends (dropped if the Mac went down again)                                                                   |
| `{agent}'s mod stopped reporting`   | The bridge is up, the Talos mod has synced in the last 7 days, and it has been silent for `MOD_QUIET_MIN` (default 10) minutes, counted from the later of its last sync and the bridge's reconnect (a Mac that slept does not trip it) | Once per quiet spell                                                                                                                                                  |
| `Relay storage is nearly full`      | The relay volume passed `VOLUME_SOFT_CAP_MB`                                                                                                                                                                                           | At most once a day                                                                                                                                                    |
| `{agent}'s Mac disk is nearly full` | The bridge reports less than 2 GB free on the Mac's disk                                                                                                                                                                               | Once per episode; it ends when free space is back above 4 GB. Held by the quiet window like the other Mac-side alarms                                                 |

Rules that apply to all of them:

- **The watchdog is the relay.** The Mac's bridge only reports (a `health.beat` every 60 seconds, and within 2 seconds
  of a change). A Mac that sleeps cannot be the thing that notices it slept.
- **A laptop that opens and shuts five times an evening is one push.** The minimum gap above is what does that.
- **The quiet window holds Mac-side alarms.** One that falls inside it is re-checked when the window ends, and sent only
  if the problem is still there. A laptop asleep all night produces nothing.
- **A visible app does not swallow the push.** A desktop tab nobody is watching must not hide an alarm from your
  phone. A visible app also shows a banner (see Requests in the PR that shipped it). The same goes for approvals: a
  `Needs you` push (a card waiting on you) goes to the phone even while a window is open on the Mac. It still obeys the
  quiet window and the master switch.
- **A relay redeploy never pushes.** The bridge gets five minutes from the relay's start to reconnect before it counts as gone.
- **State survives a redeploy.** The flags live in the relay's store, so a restart does not repeat an alarm.
- **Alarms carry fixed text.** Never a thread name, a message, a path or a time.

## The beat carries no content

`health.beat` holds: bridge version and start time, whether the mod is `alive`, `quiet` or `absent`, whether a TTS and
an STT command are configured, whether this Mac's SQLite has FTS5, and how many bytes are free on the disk the bridge
lives on (a bare number, never a path; an older bridge leaves it out). Nothing else.

## Optional: a second path with ntfy

Web Push can fail on its own (an expired subscription, a browser that was cleared). ntfy is a separate path to the same
phone.

1. Pick a topic name nobody can guess (it is the only secret): `openssl rand -hex 16`.
2. Install the ntfy app and subscribe to that topic.
3. Set `ALERT_NTFY_URL=https://ntfy.sh/<topic>` on the relay. For a protected topic also set `ALERT_NTFY_TOKEN`.

ntfy gets the same fixed text as the push, with `Title: {agent}` and `Tags: warning`, for the health alarms only. It has
a 5 second timeout and one retry. A failure is logged without the URL. If both ntfy and Web Push are set you get two notifications per alarm, by design. If ntfy is the only way you are alerted, Talos
counts that as healthy.

## When the Mac cannot reach the relay (ntfy from the Mac)

Every alarm above travels through the relay, so none of them can tell you the relay itself is out of reach of your Mac:
the Mac's health beat goes over the same connection. For that case the bridge watches its own connection. After **10
minutes without a relay connection while the Mac is awake**, it posts once to an ntfy topic, and once more when the
connection comes back. It is off until you set the topic.

1. Pick a topic nobody can guess (`openssl rand -hex 16`) and subscribe to it in the ntfy app. This can be the same topic
   the relay uses.
2. Put `TALOS_APP_ALERT_NTFY_URL=https://ntfy.sh/<topic>` in `bridge.env` (in the bridge's folder, `~/.config/talos/app`
   by default) and restart the agent. The value must be `https://`; anything else is ignored with a log line (the log never
   shows the topic).

Rules: one alert per outage, however long it lasts, and one "connected again" only if an alert went out. **Sleep does not
count.** The watch counts only time it saw pass on schedule; if the Mac sleeps (or its clock jumps) the count starts over
when it wakes, so closing the lid never raises it, and a 9-minute gap, a sleep and another 9 minutes still send nothing.
The post has a 5 second timeout and one retry; a failure is logged without the URL and is not repeated. A bridge that
another bridge has replaced stops watching. `TALOS_APP_ALERT_NTFY_URL` has no token setting: use an unguessable topic.

## Settings → Health

| Row          | Reads                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Relay        | Up since, version. Red if storage is nearly full                                                 |
| Mac bridge   | Connected, or `offline since 22:41` (amber, red after 12 hours)                                  |
| Talos mod    | Reporting, quiet, `Not installed`, or unknown while the Mac is offline                           |
| Scheduler    | The cached scheduler state (when Schedules is on)                                                |
| Mac disk     | Free space (only while the bridge is connected and reports it); amber under 4 GB, red under 2 GB |
| Phone alerts | Push on this device, ntfy on, or red `Nobody can be alerted`                                     |

The thread screens show one banner per Mac problem, each with what happened and what to do: the connection just dropped
(under 5 minutes), the Mac is probably asleep or its session has stopped (over 5 minutes), the server turned away the Mac's
key, or the mod stopped reporting. The Home screen shows the same words for the states that come from the health status (the
Mac offline over 5 minutes outside the quiet window, a refused key, a quiet mod); "just dropped" is a thread-screen banner
only, because Home reads the status, not the live presence. On a thread screen the live-presence banner steps aside when the health banner says the same thing, so there is one banner.
A refused key is `bridge.auth_refused_at` in `GET /api/status`: set when the relay refuses the bridge's hello, shown only
while the bridge is offline and only if the refusal came after the Mac went away, and cleared by the next good hello. It is deliberately not a `mac_problems` value (that list is a strict enum, so
a new value would make an older app reject the whole status). Anyone who can reach the relay can send a bad hello, so the
banner proves a refusal happened, not who sent it.

Under the rows, two notes appear when they apply: a missing TTS command and a SQLite without FTS5.
**Send test alert** sends one fixed test message down every configured path, whatever the quiet window says, and reports what actually happened (or `Nobody to alert: no subscribed device and ntfy off.`).
The screen asks the relay for `GET /api/status` every 30 seconds while it is visible.

## Settings that matter

| Variable                   | Default | Meaning                                                                              |
| -------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `ALERT_NTFY_URL`           | unset   | The optional ntfy topic (`https://` only)                                            |
| `ALERT_NTFY_TOKEN`         | unset   | Bearer token for a protected topic                                                   |
| `MOD_QUIET_MIN`            | 10      | Minutes of mod silence before `mod_quiet`                                            |
| `MAC_ALERT_MIN_GAP_MIN`    | 120     | Minimum minutes between two bridge-down pushes                                       |
| `TALOS_APP_ALERT_NTFY_URL` | unset   | In the Mac's `bridge.env`, not Railway: the ntfy topic for "no relay for 10 minutes" |

## Not built: the hourly external check

An earlier design had a GitHub Actions workflow call the relay every hour, to catch the one failure the relay cannot
report about itself: the relay being down. That is **dropped** for now (no `/api/health`, no `HEALTH_TOKEN`, no
"your hourly health check stopped" push). If you want that coverage today, point any uptime monitor at the relay's
public `GET /healthz` (it answers `{ "ok": true }` and exposes nothing else).
