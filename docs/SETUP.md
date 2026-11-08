# Setting up Talos on your own accounts

> **The ordered path is [`SETUP.md`](../SETUP.md) in the repository root** (prerequisites, the installer, the relay, the bridge,
> starting the agent, the phone, then the extras, with a check after each step). This page is the detailed reference for the
> relay, the bridge and the phone; `SETUP.md` links here for them.

This guide takes you from nothing to your first message on your phone. You do not need to be an engineer, but you will
paste a few commands into a terminal on your Mac. Allow about an hour the first time.

## What you are setting up

Three pieces work together:

| Piece      | Where it runs                                 | What it does                                                                                                                   |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The app    | Your phone (or any browser)                   | Where you read replies, send messages and approve things.                                                                      |
| The relay  | Railway (a hosting service), about $2 a month | A small always-on server that connects your phone to your Mac. It keeps messages for 7 days.                                   |
| The bridge | Your Mac, next to your Claude Code agent      | Hands your messages to the agent and sends its answers back. It dials out; nothing on your Mac is reachable from the internet. |

Your full history lives on your Mac. The relay only holds what has not been delivered yet.

You will need:

- A Mac with [Claude Code](https://claude.com/claude-code) installed and an agent folder (any folder you run Claude Code
  in works; a [Talos](https://github.com/treynortetik-creator/talos) install works too).
- [Bun](https://bun.sh) 1.3.11 or newer, [Node](https://nodejs.org) 24, and pnpm 10 (`corepack enable` turns it on).
- A [Railway](https://railway.com) account, and a GitHub copy of this repository for Railway to build from.
- An iPhone with iOS 18.4 or newer (or an Android phone, or just a desktop browser). On iPhone the app must be added to
  the Home Screen before it can send you notifications.

## Step 1. Get the code on your Mac

```bash
git clone https://github.com/<you>/talos.git
cd talos
corepack enable
pnpm install --frozen-lockfile
```

Everything below is run from this folder. The `talos-app` command does not exist yet: Step 3 installs it as a real
command on your PATH (it is a small script, not a shell alias, so it works in every new terminal). Until then, any
`talos-app <command>` in this guide can be run as `bun run apps/bridge/src/cli.ts <command>` from this folder.

## Step 2. Create the relay on Railway

1. In Railway choose **New Project, Deploy from GitHub repo** and pick your copy of this repository. Railway reads
   `railway.json` and builds `apps/relay/Dockerfile`. The build should succeed, but the first start fails with
   "Invalid relay environment" because the variables are not set yet. That is expected.

   > **Deploying from the command line.** A command-line deploy (`railway up`) may ignore `railway.json` and fail to
   > find the Dockerfile. If so, set the service variable `RAILWAY_DOCKERFILE_PATH=apps/relay/Dockerfile` and deploy
   > again.
   >
   > **Auto-deploy.** Connecting the GitHub repository (as above) turns on auto-deploy: every merge to `main` builds
   > and deploys the relay. Turn it off under the service's **Settings, Source** if you would rather deploy by hand.
2. Open the new service, go to **Settings, Networking** and press **Generate Domain**. When it asks for a
   target port, enter `8080` (and set `PORT=8080` in the variables below) so Railway does not have to guess. You get an
   address like `https://your-relay.example.com`. This is your relay address.

   > **Important: pick your address once.** Your passkey is tied to this exact address. If you later move to a custom
   > domain, every passkey and every enrolled device stops working and you must enroll each one again (see
   > "Moving to a new address" below). The free Railway address is a fine long-term choice.
3. Add a **Volume**. It is not under the service's Settings: press **Cmd-K** on the project canvas and search for
   "Volume" (or right-click the canvas and choose it), pick this service, and set the mount path to `/data`. One
   gigabyte is plenty. The database and any uploaded files live there, so it must exist before the first real start.
4. Open the **Variables** tab and add the ones below. `.env.example` in the repository lists every variable with a
   one-line explanation; these are the ones you must set:

   | Variable            | What to put                                                                                                 |
   | ------------------- | ----------------------------------------------------------------------------------------------------------- |
   | `NODE_ENV`          | `production`                                                                                                |
   | `PORT`              | `8080`                                                                                                      |
   | `PUBLIC_ORIGIN`     | Your relay address, `https://` included, no slash at the end.                                               |
   | `RP_ID`             | The same address without `https://`.                                                                        |
   | `DATA_DIR`          | `/data`                                                                                                     |
   | `DATA_KEY`          | Run `openssl rand -base64 32` in a terminal and paste the result. **Keep a copy in your password manager.** |
   | `VAPID_PUBLIC_KEY`  | From `npx web-push generate-vapid-keys` (run it once; it prints both keys).                                 |
   | `VAPID_PRIVATE_KEY` | The other key it printed.                                                                                   |
   | `VAPID_SUBJECT`     | `mailto:` followed by an address you read, for example `mailto:you@example.com`.                            |
   | `TRUST_PROXY_HOPS`  | `1`                                                                                                         |

   Railway only **stages** variable changes. After adding or editing any variable, press the **Deploy** button that
   appears at the top of the project to apply them. Leave `BRIDGE_PUBKEY` out for now; you get it in the next step. Optional variables (live voice, limits) are covered
   at the end.
5. Keep the `DATA_KEY` safe. Without it the stored data cannot be read, and a backup of the volume is useless.
6. Turn on **daily backups** for the volume (Railway shows a **Backups** tab on the volume). The volume holds your
   passkey registration, the list of devices and your integration connections. If it were lost you would have to
   enroll your devices and reconnect your integrations again; your message history is safe on your Mac either way.

Do not turn on Railway's "sleep when idle" setting. The Mac's connection has to stay up.

## Step 3. Set up the bridge on your Mac

If you ran the root `./install.sh`, the agent folder is `~/talos-agent` and its `talos-app` server is already registered, so
this step only adds the bridge key and your relay address (or run `./install.sh --relay-url https://<your relay address>` again, which
runs the same script). Otherwise pick the agent folder you want to talk to (it can be any folder you use with Claude Code), then:

```bash
apps/bridge/scripts/install.sh --agent-dir /path/to/your/agent-folder --relay-url https://<your relay address>
```

(Add `--dry-run` first if you want to see what it will do. It writes nothing in that mode.)

This creates a private folder `~/.config/talos/app` holding the Mac's key, your settings (`config.json`) and the
bridge settings, and adds a `talos-app` entry to the agent folder's `.mcp.json`. It never touches your global Claude
settings. It also puts the `talos-app` command on your PATH: next to `bun` if that folder is writable, else in
`~/.bun/bin` or `~/.local/bin` (`--bin-dir <folder>` picks another). If that folder is not on your PATH, the installer
prints the exact line to add to your shell profile (for example
`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`); open a new terminal afterwards. It never replaces a
`talos-app` file it did not write. Check with `talos-app help`. It finishes by printing a line that starts with
`BRIDGE_PUBKEY=`.

1. Copy that whole line into the relay's variables on Railway (name `BRIDGE_PUBKEY`, value after the `=`).
2. Press **Deploy** in Railway to apply the staged change (variable edits do not apply on their own). Check that `https://<your relay address>/healthz` shows `{"ok":true,...}`.

## Step 4. Start your agent with the bridge on

If you used the root `./install.sh`, start the agent with the launch script it wrote. It adds the Talos mod and the channel flag for you:

```bash
~/talos-agent/start-talos.sh
```

For any other agent folder, the short way: from anywhere, run

```bash
talos-app start --agent-dir /path/to/your/agent-folder -- <your existing flags>
```

It runs `claude` in that folder with the two variables and the development-channel flag added after your flags (add
`--dry-run` to see the command without starting it). Everything after the `--` goes to `claude` as it is. `talos-app` never loads the agent folder's `.env` file into
that environment, so the long way and the short way start `claude` with the same variables.

The long way, which is exactly what that runs: you **add** the Talos flags to the `claude` command you already use to
start your agent, and keep every flag it already has. From the agent folder, the pattern is:

```bash
TALOS_APP_BRIDGE=1 MCP_PROTOCOL_NEGOTIATION=legacy claude <your existing flags> --dangerously-load-development-channels server:talos-app
```

For example, if you start your agent with `claude --channels plugin:<your-channel>`, you run
`TALOS_APP_BRIDGE=1 MCP_PROTOCOL_NEGOTIATION=legacy claude --channels plugin:<your-channel> --dangerously-load-development-channels server:talos-app`.
Dropping an existing flag (a `--channels` entry, a permissions flag) changes how your agent behaves, so keep
them on the same line.

The first time, Claude Code also asks you to approve the new project MCP server `talos-app` (it comes from the
`.mcp.json` the install step wrote). Approve it. Then Claude Code shows a confirmation screen about a development channel. Accept it. You will see this screen each time you
start the agent this way; that is how Claude Code treats channels that are not on its approved list.

Two things to know:

- `MCP_PROTOCOL_NEGOTIATION=legacy` is needed for messages to reach the agent, and it switches off a newer MCP feature
  ("tasks") for the other tools in that session.
- If the agent session crashes, a new one waits at the confirmation screen until someone presses a key at the Mac. The
  relay sends you a notification ("Talos's Mac session stopped") after five minutes without a connection.

To check everything, run `talos-app doctor --agent-dir /path/to/your/agent-folder`. It should print no `FAIL` lines. It
also proves the relay accepts this Mac's key (a signed, read-only call) and shows the live bridge's state; if the relay
turned the key away, it prints the exact `BRIDGE_PUBKEY=` line to paste into Railway. `talos-app status` shows the same in
short. (A bridge you started before updating needs one restart before it reports its state.)

## Step 5. Add your phone

1. On the Mac run `talos-app enroll --label phone`. It prints a link and a QR code of the same link, and waits. If no
   live bridge is running it says so first: nobody could confirm the phone, so start the agent (Step 4) before you go on.
2. Open the link on the phone (point the phone's camera at the QR code, or copy the link), **in Safari on iPhone**. The page asks you to add the app to the Home Screen first:
   tap **Copy setup link**, then Share, **Add to Home Screen**. Open the new Talos icon and tap **Paste setup link**.
   (Android and desktop browsers skip this part and go straight on.)
3. The phone asks you to create a passkey (Face ID or Touch ID). Do it.
4. The phone now shows four words, for example `swelter finicky tiger Dakota`. The Mac terminal shows a question with
   the same four words:

   ```
   Pin "phone" [swelter finicky tiger Dakota]? [y/N]
   ```

   **Only type `y` if the four words match and you started this yourself.** Anything else, press Enter (that is "no").
   The link works once and expires after ten minutes, but this check is what stops a stranger who gets hold of the link.
5. The app says "This device is ready". You will also get a note in the General thread: "New device pinned".

Repeat from step 1 for each extra device (a second phone, your laptop's browser). Each browser needs its own link.
`talos-app devices` lists the devices your Mac trusts, and `talos-app devices revoke <id>` removes one.

If the Mac terminal was closed before you answered, run `talos-app enroll --confirm` to answer later. If the Mac has not
answered after a minute and a half, the phone says "Your Mac has not answered" and lists what to check; it keeps
listening, so a late `y` still finishes setup. If `enroll` ends with "the relay turned away this Mac's key", paste the
`BRIDGE_PUBKEY=` line it prints into Railway and deploy (Step 3).

## Step 6. Send your first message

Open the General thread and type "hello". The agent's answer appears in the same thread. Hold the microphone button to
send a voice note (see "Voice" below to get them transcribed). Anything that sends, posts, deploys, pays or deletes
shows up as a card with an Approve and a Kill button; riskier cards ask for Face ID again before they go.

Turn on notifications in **Settings** (a button; the app never asks on its own). The test notification shows only the
words "New reply in a thread", never what was said.

## Next: turn on the rest

Your first message works. Everything below is optional and off until you switch it on. The app's **Settings, Health** page
shows what is on and what is not; each row there has a how-to in the table at the end of this section.

### Memory: browse your notes from the app

```bash
talos-app memory init --agent-dir /path/to/your/agent-folder   # pick folders (y/N each), then folders to leave out
talos-app memory show                                          # what is shared, before you rely on it
talos-app memory on                                            # the browser stays off until you run this
```

It is read-only and never shows dotfiles, keys, `.env` files or anything under a folder holding a `.talos-private`
file. Details: [`MEMORY.md`](MEMORY.md).

### Reindex: when search misses something

```bash
talos-app search reindex     # rebuild the search index over your message history
talos-app memory reindex     # rebuild the index over your memory folders
```

Run it when search finds nothing you know is there, or after you restored a backup of `~/.config/talos/app`.

### Ask rules: approvals on your phone

By default an agent that runs without asking never reaches your phone, because nothing prompts. Ask rules make the risky
calls (deploys, merges, deletes, pushes, shell commands) prompt even then:

```bash
talos-app install-ask-rules --agent-dir /path/to/your/agent-folder --dry-run   # shows the diff, writes nothing
talos-app install-ask-rules --agent-dir /path/to/your/agent-folder             # asks y/N, then writes
```

`talos-app init` writes `"permission_relay": true` into a new `config.json`. An existing file that says `false`, or has no such key, stays off: turn on Settings → Health → "Tool prompts as approval cards" (or set it in `~/.config/talos/app/config.json`) and restart the agent. Each approval prompt becomes
a card on your phone. Scheduled `claude -p` jobs cannot answer a prompt, so run the dry run first and read what it lists.
More in [`bridge.md`](bridge.md), "Permission prompts on the phone".

### Schedules: jobs that run on their own

Schedules needs a scheduler on the Mac; v1 uses [Chronos](https://github.com/treynortetik-creator/chronos), which is public. The
working sequence, for an agent that already exists, is in [`SETUP.md`](../SETUP.md), step 9.1: `./install.sh --with-chronos
--notify talos` from the repository root, enable the jobs you want with `python3 ~/talos-agent/scripts/talos-jobs.py enable <job>`,
restart the agent (the bridge looks for the scheduler at start and every five minutes), then run `talos-app schedules adopt`.
Open the **Schedules** tab in the app. You can also ask your agent for "every weekday at 07:30, summarise yesterday's commits"; it
proposes a card and one tap creates the job. `TALOS_APP_SCHEDULER=off` in `bridge.env` switches the whole feature off. More in
[`SCHEDULES.md`](SCHEDULES.md).

### The Talos mod: live session details in the app

The mod shows the model, context use and cost, lets the app stop or compact a run, and fills the agents panel. Without it
Talos still works. Load it by adding a flag to your launch command:

```bash
talos-app start --agent-dir /path/to/your/agent-folder -- --plugin-dir /path/to/talos-app/plugins/talos-app-mod
```

(`/path/to/talos-app` is this repository.) The Health row says **Reporting** once it connects, which can take a minute
after a restart. Details: [`plugins/talos-app-mod/README.md`](../plugins/talos-app-mod/README.md). For the agents panel to
show subagent rows, also run `talos-app install-subagent-tee --agent-dir /path/to/your/agent-folder --dry-run` and read it
first.

### Every "off" row, and what to do

| Settings, Health says                                          | It means                                                                                                                                                                  | What to do                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay: **Relay storage is nearly full**                        | The relay volume passed its soft cap                                                                                                                                      | Raise the volume size or `VOLUME_SOFT_CAP_MB` on Railway, then deploy. Messages are safe on your Mac.                                                                                                                                        |
| Mac bridge: **offline**                                        | The Mac is asleep, Claude is not running, or the key was refused                                                                                                          | `talos-app status` on the Mac. Asleep: see "A sleeping Mac". Not running: `talos-app start`. Key refused: `talos-app doctor` prints the fix.                                                                                                 |
| Talos mod: **Not installed**                                   | The mod is not loaded in this session                                                                                                                                     | Start with `--plugin-dir` as above, then give it a minute.                                                                                                                                                                                   |
| Talos mod: **Unknown while your Mac is offline**               | The relay cannot ask the Mac                                                                                                                                              | Fix "Mac bridge: offline" first.                                                                                                                                                                                                             |
| Talos mod: **quiet**                                           | It connected before but stopped reporting                                                                                                                                 | Check that Claude is running with the mod loaded; restart the agent.                                                                                                                                                                         |
| Mac disk: **nearly full**                                      | Less than 2 GB free on the Mac                                                                                                                                            | Free space on the Mac. The row shows only while the bridge is connected.                                                                                                                                                                     |
| Scheduler: **not installed**, **off**, **paused**              | No scheduler found, switched off, or paused                                                                                                                               | Install Chronos and restart the agent; remove `TALOS_APP_SCHEDULER=off` from `bridge.env`; or resume it in the Schedules tab.                                                                                                                |
| Scheduler: **degraded**, **stuck**, **unsupported**, **error** | Chronos reported a warning; a background run is stuck or the scheduler's files cannot be read; this Chronos is too old for Talos; or the scheduler did not answer in time | Open the Schedules tab: it lists each problem with its fix. At the Mac run `chronos doctor`. Too old: in the Chronos folder run `git pull && ./install.sh`. No answer: move the scheduler's files out of a cloud-synced or protected folder. |
| Phone alerts: **Nobody can be alerted**                        | No device has push on and ntfy is off                                                                                                                                     | Turn on notifications in Settings on a phone, or set up ntfy ([`HEALTH.md`](HEALTH.md)).                                                                                                                                                     |
| Note: **Voice replies need a TTS command**                     | No text-to-speech command configured                                                                                                                                      | Set `TALOS_APP_TTS_CMD` in `bridge.env` (see "Voice" below) and restart the agent.                                                                                                                                                           |
| Note: **Search is off: no FTS5**                               | This Mac's SQLite lacks the search extension                                                                                                                              | Nothing to switch on: it depends on the SQLite that macOS provides. `talos-app doctor` confirms it; the rest of Talos is unaffected.                                                                                                         |

If something stays stuck, `talos-app logs` shows the bridge log, and `talos-app report --out report.txt` makes one file for
a bug report: doctor, status and the last log lines, with keys, tokens, setup codes and your home folder removed. Read it
before you share it.

## Pick your apps

You can use Talos from any of these. They talk to the same relay and the same Mac.

| App            | What it is                                                                                         | Set up                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web app**    | The installable web app in any browser. On iPhone, add it to the Home Screen first.                | Nothing to build. Open your relay address and use the link from `talos-app enroll` (Step 5).                                                               |
| **iPhone app** | Optional. A native shell around the same web app, with a share extension and optional native push. | You build and sign it yourself, free (7-day re-sign) or with a paid account: [`ios.md`](ios.md). The web app on the Home Screen is the default phone path. |
| **Mac app**    | A menu-bar app that runs and restarts your agent, shows bridge status and opens quick compose.     | Built on your Mac with the Swift command line tools: [`desktop.md`](desktop.md). Optional.                                                                 |

The Mac app does not replace Step 3 or Step 4: it needs the bridge, and it starts the agent in place of
`talos-app start`. Add devices with `talos-app enroll` whichever app you use (the Mac app's **Sign in** runs it for you).

## Webhooks: incoming events from other services

**Settings, Webhooks** lists the incoming events you can set up: Gmail, Calendar, GitHub, Slack and more, plus a generic
webhook that anything can send to. Each one opens a short guided setup. Your agent's own tools and connectors are set up in Claude Code, not here. Three things to know:

- **What arrives is treated as untrusted.** Emails, issues and chat messages are handed to your agent wrapped in a
  warning that says it is data, not instructions. Your agent reads it; it does not act on it. If it wants to do something
  because of it, it raises a card for you to approve.
- **Work accounts are off by default.** They show a lock and a note. Switching one on asks for Face ID. Some workplaces
  do not allow outside scripts or tokens; ask first.
- **Setup keys are used once.** For services where you paste a token to set things up (Linear, Calendly), the relay uses
  the token to register the connection and then deletes it.

## Voice

**Voice notes** work without any extra service. To get them transcribed, give the bridge a speech-to-text command (any
program that prints the text of an audio file) and, for spoken replies, a text-to-speech command. Put these in
`~/.config/talos/app/bridge.env`:

```
TALOS_APP_STT_CMD=["/path/to/transcribe","{in}"]
TALOS_APP_TTS_CMD=["/path/to/speak","{out}","{text}"]
TALOS_APP_TTS_EXT=mp3
TALOS_APP_FFMPEG=/path/to/ffmpeg
```

To use the speech tools of the kit's agent folder (`~/talos-agent`), these are the real lines (`stt.sh` takes the audio file and
prints the transcript; `tts.sh file <out> "<text>"` writes the audio; the paths are absolute because no shell expands `~`):

```bash
printf 'TALOS_APP_STT_CMD=["%s/talos-agent/scripts/stt.sh","{in}"]\n' "$HOME" >> ~/.config/talos/app/bridge.env
printf 'TALOS_APP_TTS_CMD=["%s/talos-agent/scripts/tts.sh","file","{out}","{text}"]\n' "$HOME" >> ~/.config/talos/app/bridge.env
printf 'TALOS_APP_TTS_EXT=m4a\n' >> ~/.config/talos/app/bridge.env
```

`TALOS_APP_FFMPEG` is optional: when set, spoken replies are transcoded to a small AAC file before they are sent.

`{in}` is replaced by the audio file, `{out}` by the file to write, `{text}` by the words to speak. Commands run
directly, never through a shell. Without an STT command, voice notes still arrive and the agent is told where the audio
file is.

**Live voice** (talking in real time) needs an OpenAI key. To turn it on, open the relay service on Railway, add
`OPENAI_API_KEY` under **Variables**, and redeploy (variable edits only stage until you press **Deploy**). It costs about
five cents a minute; `VOICE_DAILY_MAX_MIN` (default 60) and `VOICE_SESSION_MAX_MIN` (default 30) cap it. Leave the key
empty to switch live voice off. Until the key is set, the app says "Live voice is off" on the call button and in Settings →
Voice, with a link back here; voice notes keep working. The key stays in Railway's Variables; the app never asks for it.
More in [`docs/voice.md`](voice.md).

## Optional settings on Railway

| Variable                                                       | Default          | What it does                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_API_KEY`                                               | none             | Turns on live voice and dictation.                                                                                                                                                                                                                                                                                                                           |
| `TRANSCRIBE_MODEL`                                             | `gpt-transcribe` | The OpenAI model that turns a dictation recording into text.                                                                                                                                                                                                                                                                                                 |
| `DICTATE_DAILY_MAX_MB`                                         | `100`            | Megabytes of dictation audio in any 24 hours. `0` turns dictation off.                                                                                                                                                                                                                                                                                       |
| `VOICE_DAILY_MAX_MIN` / `VOICE_SESSION_MAX_MIN`                | `60` / `30`      | Daily and per-call limits, in minutes.                                                                                                                                                                                                                                                                                                                       |
| `DICTATE_TIMEOUT_S`                                            | `90`             | Seconds to wait for OpenAI before the app is told it took too long.                                                                                                                                                                                                                                                                                          |
| `OPENAI_BASE_URL`                                              | OpenAI           | Only for tests or a proxy: where dictation requests go. Leave it unset.                                                                                                                                                                                                                                                                                      |
| `BUFFER_DAYS`                                                  | `7`              | How long the relay keeps messages for an offline Mac.                                                                                                                                                                                                                                                                                                        |
| `MEDIA_MAX_MB`                                                 | `50`             | Largest upload (1 to 50).                                                                                                                                                                                                                                                                                                                                    |
| `MEDIA_UPLOADS_PER_HOUR`                                       | `60`             | Uploads the owner may make in an hour.                                                                                                                                                                                                                                                                                                                       |
| `MEDIA_DAILY_MAX_MB`                                           | `200`            | Megabytes of owner uploads in any 24 hours. Share uploads have their own budget but also stop at this limit.                                                                                                                                                                                                                                                 |
| `SESSION_TTL_DAYS`                                             | `30`             | How long a sign-in lasts.                                                                                                                                                                                                                                                                                                                                    |
| `SESSION_IDLE_DAYS`                                            | `14`             | A sign-in unused this long ends. Must not exceed `SESSION_TTL_DAYS`, or the relay will not start.                                                                                                                                                                                                                                                            |
| `VOLUME_SOFT_CAP_MB`                                           | `800`            | The relay sends you a "storage is nearly full" notification above this size.                                                                                                                                                                                                                                                                                 |
| `WORK_INTEGRATIONS`                                            | `allow`          | `off` blocks every work integration, whatever the app says.                                                                                                                                                                                                                                                                                                  |
| `DEVICE_PROOF_REQUIRED`                                        | `0`              | `1` makes every sign-in that names a device prove it with the device key. Leave at `0` until Settings > Devices shows no "Key not verified" (each device proves its key on its next page load). The default is `0` in this release; a later release may change it. After deploying, open or revoke every device that shows "Key not verified", then set `1`. |
| `LOG_LEVEL`                                                    | `info`           | The relay never logs message text, tokens or codes at any level.                                                                                                                                                                                                                                                                                             |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_P8`, `APNS_BUNDLE_ID` | none             | Native iPhone push. All four or it stays off. `APNS_TEAM_ID` + `APNS_BUNDLE_ID` alone also serve the app-site-association file for passkeys in the app (see `docs/IOS-PUSH.md`).                                                                                                                                                                             |

## Looking after it

- **Upgrading.** See [Upgrading](#upgrading) below.
- **Replacing the Mac key** (for example if you think it leaked): `talos-app rotate`. The old key keeps working for five
  minutes while the live bridge switches over. The command then prints a new `BRIDGE_PUBKEY=` line: copy it into the
  relay's variables on Railway and press **Deploy**. Until you do, a restored or emptied relay volume would go back to
  trusting the old key.
- **Setting up a new Mac, or recovering after a rotation went wrong.** Run `talos-app init` on the Mac and copy its
  `BRIDGE_PUBKEY=` line into Railway. Also add `BRIDGE_PUBKEY_FORCE=1` and press **Deploy**: on that start the relay makes
  that key the only trusted key and forgets every rotated one. Then remove `BRIDGE_PUBKEY_FORCE` (or set it to `0`) and
  press **Deploy** again so `talos-app rotate` works. The key stays the one you set; no older key comes back.
- **If a bridge says "superseded".** Two bridges used the same key. Stop the second one or run `talos-app rotate`.
- **Moving to a new address.** Change `PUBLIC_ORIGIN` and `RP_ID` on Railway, press **Deploy**, then run `talos-app enroll` for
  each device and `talos-app devices revoke <id>` for the old ones. Passkeys cannot be moved; they must be recreated.
- **Uninstalling.** Delete the `talos-app` entry from the agent folder's `.mcp.json`, delete `~/.config/talos/app`
  (your history is in there; keep it if you want it), and delete the Railway project.

## Upgrading

One command does the Mac's part: `talos-app update`. It finds the repository the command runs from, then runs
`git pull --ff-only` and `pnpm install --frozen-lockfile` (the install runs every time, so a run that failed at the install
can be repeated), and prints the old and new versions. It stops with a plain
message, changing nothing, when the folder has changes you have not committed, when it is on a detached HEAD (checked out
on a commit rather than a branch, which is common in a worktree), when the branch follows no remote branch, or when your
branch has commits of its own and cannot fast-forward. `talos-app status` and `talos-app doctor` show the commit the running bridge started from (it records it in
`status.json`), warn when the folder has moved on since (restart needed) and when the relay is on a different commit.

Six things are still yours to do. The command lists them when it finishes:

0. **Sync your fork first.** The relay builds from your fork, and `talos-app update` pulls from the branch your clone follows
   (your fork). With the original added as `upstream`: `git fetch upstream`, `git switch main`, `git merge --ff-only upstream/main`,
   `git push origin main` (or GitHub's **Sync fork** button, then `git pull --ff-only`). The push also deploys the relay.
1. **Restart the agent.** A bridge that is already running keeps the old code in memory; `talos-app update` never restarts
   it, because that would end the live conversation. When you are ready, stop the agent and run `talos-app start` again.
   Until you do, the Mac keeps running the old version, and `talos-app doctor` will say so if the relay has moved on.
2. **The relay** deploys from Railway, not from this Mac. Push to your GitHub copy; Railway builds it.
3. **The Mac app** (if you use it): run `apps/desktop/scripts/build-app.sh`, then `apps/desktop/scripts/install.sh`, which
   copies the new app to `~/Applications` and opens it. The build alone leaves the old app in place.
4. **The agent folder (the kit).** `talos-app update` does not touch it. An agent on the plugin layout (every new install) updates with
   `talos update --dry-run`, then `talos update`, in Terminal: it checks the release's signature, swaps the release, runs the
   migrations, checks that the agent folder loads it, rolls back by itself if not, and asks the Mac app to restart the agent.
   `talos rollback` goes back one release and `talos restore <file>` puts one file back ([`kit/README.md`](../kit/README.md),
   "Updating, rolling back, restoring a file"). The first time, an install that has no release signing key needs you to add one, once, in
   Terminal: `talos-update trust-key <public-key-file>` shows the fingerprint and asks y/N; no reinstall. These commands are a speed bump for
   an agent, not a lock (it runs as you); every session start also checks that the live release still matches its recorded hash. An older agent still uses `bash kit/scripts/upgrade.sh --into ~/talos-agent
   --dry-run`, read the plan, then run it again without `--dry-run`. It backs the folder up first and never writes your memory,
   wiki or `CLAUDE.md`; [`kit/UPGRADE.md`](../kit/UPGRADE.md) has the checks and the rollback. (`talos update app` and
   `talos rollback app` are the app checkout's own pull and rollback, the same as `talos-app update` and `talos-app rollback`; from the phone use
   the `talos-app` spelling, because the agent's deny rule `talos rollback:*` also matches `talos rollback app`.)
5. **The iPhone app.** The web app on the Home Screen updates itself. A native app you built yourself is rebuilt and installed again
   after a native change ([`ios.md`](ios.md)); if you use your own TestFlight, upload a new build.

If you update by hand instead, the same two commands apply: `git pull --ff-only`, then `pnpm install --frozen-lockfile`, then
restart the agent. Skipping the install can leave a command that needs a new library unable to start. The relay's database
only ever gains columns, so going back to the previous Railway deploy is always safe.

### Going back

If a new version breaks the Mac, `talos-app rollback` puts this folder back on an earlier version that started cleanly. The
live bridge adds its version to `good-starts.json` (in the data folder) once the relay has answered after a start and the
bridge has run the synchronous part of handling that answer (work it starts in the background, such as the schedule start
and config-card recovery, is not waited for). It does this only when no tracked file is edited and the folder is still on the
commit the process started from (new untracked files are not checked). "Started cleanly" means exactly that: it connected,
not that it then ran well for a day.

- **Each run goes one step further back.** It takes the newest recorded version that is older than the one you are on, so
  running it again walks back, and it never returns to the version it just left. It moves HEAD to that commit without
  touching any branch or commit, then runs `pnpm install --frozen-lockfile`. If the install fails, fix the install; do not
  run rollback again for that, it would go back one more version. `--dry-run` shows where it would go.
- **It refuses to overwrite your own files.** If a file or folder of yours (listed in .gitignore or never added to git) sits
  where the older version has a tracked file, git stops the switch before changing anything and the command names the
  paths. Move them aside and run it again.
- **It asks first.** `y/N` at the terminal. `--yes` skips the question; use it only where the command itself is the
  approval, such as a card on your phone. The question is not tied to a terminal: piped input or `--yes` answers it; an empty answer (nothing to read) declines.
- **It stops, changing nothing,** when tracked files have changes you have not committed, when git is in the middle of a
  rebase, merge, cherry-pick, revert or bisect, or when nothing older is recorded.
- **It checks your settings first.** After switching, it asks the older code's own loader about `config.json`. If that code
  would fail to read the file, or would drop a field it does not know (it saves what it kept on its first write, so the field
  is gone for good, and going forward again does not bring it back), the checkout is put back and nothing is installed.
  `--skip-data-check` goes anyway. Only `config.json` is checked: the other data files (history, devices, keys) were not
  found to need it, but are not verified either.
- **It never writes to the data folder** (history, keys, devices, media).

Then restart the agent (stop it, `talos-app start --agent-dir <your agent folder>`; or menu bar, **Restart session**). To go
forward again: `git switch <your branch>`, `pnpm install --frozen-lockfile`, then `talos-app update`. The folder is on a
detached HEAD in between, so a commit made there belongs to no branch: `git switch -c <name>` first if you want to keep it.
The relay, the Mac app and the iPhone app are not rolled back.

From the phone:

- **The app still reaches your agent.** Ask it in the thread to run `talos-app rollback`. Run `talos-app install-ask-rules
  --agent-dir <dir>` once (again, if you ran it before this command existed) so that the shell command arrives as a card on
  your phone, with permission prompts on the phone turned on (`docs/bridge.md`). Approve the card; the agent passes `--yes`,
  and the card shows it. Without the ask rule an agent in bypass mode could run it with no card.
- **The bridge itself is down** (Settings, Health shows the Mac offline, or the "session stopped" push arrived). Nothing on
  the Mac listens to the phone except the bridge, so no Talos button can reach it. Open a remote shell into the Mac (SSH from
  a phone terminal app, with Remote Login on) and run `talos-app rollback`. `rollback` itself starts even when an update left the packages
  half installed, but its settings check needs those packages and then refuses, naming the missing one; add
  `--skip-data-check` to go through (the check is what protects settings the older code does not know).

## A sleeping Mac

The most likely reason the app says **Your Mac is offline** is that the Mac is asleep. The bridge runs inside your Claude
session on the Mac, so when the Mac sleeps (a closed lid, or the screen-saver timer on a laptop running on battery) the
connection drops and nothing you send is picked up. Your messages are not lost: the server keeps them for up to 7 days and
your agent reads them when the Mac wakes and the session reconnects. The sleep itself is something this guide has not
measured on every Mac, so treat "asleep" as the first thing to check, not a certainty.

What the app tells you, and what to do:

| The banner says                                                | What happened                                            | What to do                                                                                                                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its connection to the server just dropped                      | Under 5 minutes offline: a network blip or a quick sleep | Wait a few minutes. It usually comes back by itself.                                                                                                                                                           |
| It is probably asleep, or the Claude session on it has stopped | Offline for more than 5 minutes                          | Wake the Mac and look at the terminal: the session may be waiting at its confirmation dialog.                                                                                                                  |
| The server turned away its key                                 | The relay refused the bridge's key                       | Run `talos-app doctor` on the Mac; it ends by printing a `BRIDGE_PUBKEY=` line. Copy it into Railway and deploy. After a `talos-app rotate`, also set `BRIDGE_PUBKEY_FORCE=1` for that deploy, then remove it. |
| Your mod stopped reporting                                     | The Mac is on but the Talos mod stopped sending          | Check that Claude is running with the mod loaded.                                                                                                                                                              |

To keep a laptop reachable overnight, keep it plugged in and stop it sleeping (System Settings → Battery or Lock Screen, or
run `caffeinate -s` in a spare terminal while plugged in). A message you send while the Mac sleeps waits; the relay pushes
"Mac session stopped" after 5 minutes outside your quiet window. If the session died while a message was being handled, the
next session posts a line saying it may not have been answered; send it again if it still matters.

## Trying it without Railway

```bash
pnpm dev:all
```

starts a relay, the web app and the bridge on your machine, with a stand-in for Claude Code that answers
"ack: <your message>". It prints the command that makes the enrollment link. Nothing leaves your computer. The state
lives in a `.dev` folder you can delete.

## When something does not work

| You see                                                                        | Try                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The relay does not start on Railway                                            | Open the deploy logs. It names the variable that is missing or malformed.                                                                                                          |
| `/healthz` is fine but the Mac shows offline in the app                        | Is the agent running with `TALOS_APP_BRIDGE=1`? Is the confirmation screen accepted? `talos-app doctor`. Is the Mac asleep (see above)?                                            |
| Nothing arrives in the agent session                                           | Is `BRIDGE_PUBKEY` on Railway exactly the line `talos-app init` printed?                                                                                                           |
| "A message failed its security check"                                          | That device is not pinned or was revoked. `talos-app devices`; enroll it again if needed.                                                                                          |
| "Waiting for your Mac to confirm this device" (or "Your Mac has not answered") | Answer the `y/N` question in the terminal where `talos-app enroll` is running, or run `enroll --confirm`. No terminal prompt at all: the agent is not running (`talos-app start`). |
| `enroll` says the relay turned away this Mac's key                             | Paste the `BRIDGE_PUBKEY=` line it printed into Railway and press Deploy. `talos-app doctor` shows the same check.                                                                 |
| `talos-app: command not found`                                                 | Run `apps/bridge/scripts/install.sh` again and follow the PATH line it prints, or run `bun run apps/bridge/src/cli.ts <command>`.                                                  |
| The enroll link says it expired                                                | Links work once for ten minutes. Run `talos-app enroll` again.                                                                                                                     |
| No transcript under a voice note                                               | Set `TALOS_APP_STT_CMD`, and try the command by hand on an audio file.                                                                                                             |
| No notifications on iPhone                                                     | The app must be opened from the Home Screen icon, and notifications switched on in Settings.                                                                                       |

More detail on the bridge is in [`docs/bridge.md`](bridge.md). What each protection does is in
[`docs/SECURITY.md`](SECURITY.md).
