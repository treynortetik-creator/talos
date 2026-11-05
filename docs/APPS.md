# MCP Apps

Some connectors ship a small interactive view with their tools: a chart, a form, a board. This page explains how Talos
shows one in a thread, what you approve first, what the view may do, and what it may not. The security side is in
[SECURITY.md](SECURITY.md) (section "MCP Apps (opt-in)"). The bridge settings are in [bridge.md](bridge.md).

## Status and scope

- **Opt-in and off by default.** No app tool is registered and no app request is handled until you set `TALOS_APP_APPS=1`.
  Put it in `$TALOS_APP_HOME/bridge.env`; that file is read every 2 seconds by the bridge and by the hooks, and **it wins over
  the process environment**, so setting it to `0` there turns apps off without a restart even for a bridge that was started
  with `TALOS_APP_APPS=1` in its shell. (A switch set only in the shell cannot be changed in a running process.) While it is
  off, an app request is answered "Apps are turned off on this Mac.", open views are removed, and the hooks installed by a
  scan stop writing captures and stop telling the agent about apps. The tools the agent already has stay registered until
  the session restarts, and answer that apps are off. The gate hook keeps running, so a request that was waiting for a card
  cannot be run by a late agent call.
- **Live session only.** The agent shows apps in a running Claude Code session with the Talos channel. Scheduled
  headless jobs are never touched by the hooks.
- **Scanning happens at the Mac, by you.** Never from the phone, and never because a message asked for it.
- **v1 limits:**
  - App-only buttons (tools the server hides from the agent) work for remote servers (http or sse) only. For local
    stdio servers, in-process servers and claude.ai connectors they answer `app_only_unsupported`.
  - On the agent path an app sees text and structured results only. Image, audio and resource blocks do not arrive.
  - No picture-in-picture, no "send context to the agent", no file reads from the view, no downloads, no camera,
    microphone, location or clipboard.
  - An app that loads remote code without an integrity hash, uses inline event handlers or a `javascript:` link is
    refused at scan.
  - Interactive state in the view is not saved across reloads.
  - Claude Code 2.1.296 or newer is required, and the scan must run on the same Claude Code version as the live session.

## How it fits together

1. You run `talos-app apps scan` at the Mac. It reads each connector's app and tool list, and you approve or decline
   each app.
2. The scan writes a catalog (the approvals), keeps a copy of the exact HTML you approved, and installs three Claude
   Code hooks for the approved servers.
3. In a live session the agent calls a connector's tool for you. A hook records the result. If it is worth seeing, the
   agent calls `app_show` and the app appears in the thread.
4. The app's buttons send requests to your Mac, signed by your phone. The Mac decides whether each one runs at once,
   needs a card, or is refused.

## Turning it on

```bash
echo 'TALOS_APP_APPS=1' >> "$TALOS_APP_HOME/bridge.env"   # the bridge and the hooks both read this file
talos-app apps scan --agent-dir /path/to/agent-folder
talos-app doctor --agent-dir /path/to/agent-folder
```

Restart the live Claude Code session (or the bridge) after the first scan so the hooks and the app tools load.

## Commands

All commands run at the Mac. `<server>` is the server name from `apps list`; if two servers share a name, use
`name@source`.

| Command                                                     | What it does                                                                                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `talos-app apps scan [--agent-dir <dir>]`                   | Reads connectors, shows each app, asks you to approve. Writes the catalog and the hook entries. `--agent-dir` defaults to the current folder.                         |
| `talos-app apps scan --check`                               | Same session, no prompts, no writes. Prints drift (an app changed, a server is gone, a version mismatch). Exits 1 if anything moved.                                  |
| `talos-app apps scan --exclude-plugin <name>`               | Turns a plugin off for the scan only (repeatable), so a plugin that polls something does not start.                                                                   |
| `talos-app apps list`                                       | Prints the catalog: label, server, source, state, first 16 characters of the approval key.                                                                            |
| `talos-app apps revoke <server or key-prefix>`              | Sets approved apps to declined. A running bridge closes their open views within a few seconds.                                                                        |
| `talos-app apps login <server>`                             | Signs in to a remote server that uses OAuth, for the bridge's own connection. See "App-only buttons" below.                                                           |
| `talos-app apps logout <server>`                            | Deletes the bridge's stored sign-in and server settings for that server from your Keychain.                                                                           |
| `talos-app apps strict on` or `off`                         | Strict mode (default off). On: calls to servers Talos cannot re-check ask each time. See "Run rules".                                                                 |
| `talos-app install-app-hooks --agent-dir <dir> [--dry-run]` | Re-writes the hook entries from the current catalog into `<dir>/.claude/settings.local.json`. Safe to repeat. `install.sh` calls it.                                  |
| `talos-app doctor --agent-dir <dir> [--deep]`               | Checks the catalog, the Claude Code version, the hook entries (including `onFailure: block`), and that the gate command runs. `--deep` also runs `apps scan --check`. |

The agent folder must not be your home folder: hooks go into `<agent-dir>/.claude/settings.local.json` (local scope),
and never into `~/.claude`.

## The scan

The scan starts an Agent SDK session in the agent folder, on the Claude Code you installed (not a bundled copy), with
hooks turned off. It uses control requests only: **no model turn runs, nothing is billed, and no tool can be called.**
It prints "Every MCP server in this folder starts once, for up to a minute." and then:

1. Checks the Claude Code version (2.1.296 or newer, same as the live session).
2. Waits for servers to connect (up to 30 seconds, then one reconnect and 15 more). A server that needs sign-in, failed,
   is disabled or is still starting is reported and skipped; its older approval stays as it was.
3. For each server with a tool that names a `ui://` app, reads the app HTML and its declared network needs.
4. Runs a static check on the HTML (below), then shows you the approval screen.
5. Writes the catalog, the approved HTML (`$TALOS_APP_HOME/apps/resources/<sha256>.html`), any server settings that go
   to the Keychain, and the hook entries.

If it finds nothing: "No app tools found. Some servers only offer apps to clients that announce MCP Apps support, which
Claude Code doesn't." That is expected for such servers.

**Refused outright** (shown as "Refused", nothing to approve):

- Remote scripts or stylesheets without an integrity hash and `crossorigin`, or from a host the app did not declare.
- Inline event handlers (`onclick=` and the like) and `javascript:` links in `href`, `src`, `action`.
- A network entry that equals or covers your relay's host.
- A declared policy that does not fit the allowed shape (for example a wildcard, an IP address, a bad port).
- Not HTML, over 8 MiB, or no content.

### The approval screen

For each app the screen shows:

- the app address, the server and where its config came from, the tools that show it, the size and the first 16
  characters of the approval key;
- **what the app may reach:** domains it may connect to, load images, fonts and media from, and embed pages from; how
  many inline scripts are pinned; pinned remote files; any permission it asks for ("requested, will be denied");
- "Results this app shows are stored on your relay for 7 days.";
- for an app that embeds other sites: a warning that their code is not pinned, and the default answer is N;
- **every tool of the server**, one line each, with its visibility (`agent + app`, `agent only`, `app only`) and its run
  rule: "runs without a tap (server says read-only)" or "asks you each time";
- lines about how Talos reaches the server, when it has app-only or no-tap tools (see "App-only buttons").

Then it asks `Approve this app? y/N`. If you approve, it asks for a **label** (the name you will see on the card in the
thread; default `{server} · {tool}`) and whether results show **automatically or ask each time**. The default is "ask"
unless the server comes from your own local config and is not remote. With "ask", each `app_show` becomes a card.

A label may not contain `talos`, `approve`, `card`, `sign in`, `code`, `password` or your agent's name, so an app cannot
pass for part of Talos.

### The approval key

The approval covers the whole manifest, not only the HTML. The key is a hash of: the server and its source, the app
address, the HTML hash, the declared network and permission needs, the border preference, **every tool of the server**
(name, view, visibility, and its read-only, destructive and open-world labels), and how Talos reaches the server (type,
a fingerprint of the launch command, URL and headers, and the sign-in kind).

Any change to any of those gives a new key. At the next scan you are asked again and shown what changed, for example:

- "HTML changed"
- "now may also connect to: api2.example.com"
- "`set_note` is no longer marked read-only"
- "`read_note` is now marked read-only, so it would run without a tap"
- "the server's launch command, URL or headers changed"

An unchanged key keeps your decision, label and choices. A live view whose approval stops matching is closed
("Removed from your approved apps") and its buttons stop working until you re-approve.

One blind spot: for a local stdio server, Claude Code does not report the server's environment variables, so a change
to those cannot be seen.

## Showing an app

After the agent calls a connector tool for you, a hook records the result and tells the agent a capture id. The agent
then calls `app_show` with the thread and the capture id (and optionally a one-line caption). Captures last 15 minutes.

`app_show` checks that the capture succeeded, that the tool's app is approved, that the Claude Code version still
matches the scan, and that the approved HTML is on disk. With "ask each time" it posts a card first: "Show {label}
result in this thread?" Otherwise it uploads the approved HTML, sends the result with it, and the app appears in the
thread. A newer view of the same app in the thread replaces the older one.

The app card is drawn by Talos around the view: your label, `{server} · {tool}`, a "Third-party app" badge, status
("Waiting for the agent...", "Waiting for your approval"), Expand, and a menu (App log, details). The view can never draw
inside that frame area, and a real Talos card never renders inside a view. At most three app views are live on a page;
older ones become posters with a "Load app" button.

A view can send requests for **24 hours** after it was shown. After that its buttons that need the agent stop and a
banner says so.

## Run rules: what happens when a button is pressed

Every request from an app goes through the Mac, in this order. The first failure answers the app with an error code
(see "Troubleshooting") and stops.

1. The signature is checked against your pinned device, the timestamp must be within 2 minutes, and the request id must
   be new.
2. The view must exist in that thread, be active and be inside its 24 hours.
3. The view's approval key must still be the catalog's approved key.
4. Rate limits and daily budgets, and at most 3 requests from the view waiting at once.
5. The tool must belong to the view's server (another catalogued server's tool is `cross_server`).
6. The tool must be visible to apps. A tool the server marks model-only is refused.
7. Arguments must be 16 KiB or less.
8. **The decision.**

### The decision

A call runs **with no tap** only when all of these hold:

- the app is approved and its key still matches (approving the app is your consent to the run rules on its screen);
- the server labels the tool read-only and not destructive;
- Talos is not forcing that tool to ask (see below);
- Talos's call-time label check passes, or the server cannot be checked and strict mode is off.

**Everything else becomes an `app_action` card** in the thread: "{label} wants to run {tool}". It names the server and
tool, shows the exact arguments, warns "Asked for by an app, not by you or the agent.", and offers `Run {tool}` or
`Kill app request`. It expires in 10 minutes. The card is low risk only when the server marks the tool both non-destructive and not
open-world; any other card needs Face ID.

The card is built by the Mac, and the arguments you approve are the arguments that run. On the agent path, a gate hook
replaces whatever the agent types with the approved arguments, or blocks the call while a card is still waiting.

**The mislabel risk, stated plainly.** The read-only label comes from the server. A server that marks a write tool
read-only will have that tool run with no card, inside the approval you gave. Talos cannot detect a lie it has not
seen. What it does: it shows you the label before you approve, it re-reads the label right before a no-tap call where it
can (on the agent path only before the call is authorised; see the limit below), and it refuses and asks you to re-approve if the label changed. Approve apps from servers you trust to label their
tools honestly.

**Ask-each-time tools.** If Talos's view of a tool's labels (from Claude Code) and the server's own answer disagree on
whether it is safe to run without a tap, the tool is stored as "asks you each time" and the approval screen says so.

**The call-time label check.** Before a no-tap call to an http or sse server that Talos can reach, the bridge asks the
server for its current tool list (always fresh, never the 60 second cache) and compares the labels with the ones you approved.

| Result                         | What happens                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same                           | The call runs with no tap.                                                                                                                                                    |
| Different, in either direction | The call is refused (`approval_changed`), open views of that server close, the app is marked "needs re-approval", and a note in the thread says to run `talos-app apps scan`. |
| The check failed               | The call becomes a card, with the warning "Talos couldn't check this tool's current labels." (connection, sign-in, Keychain or a 10 second timeout)                           |
| No way to check                | The call runs on the labels you approved (stdio, in-process and claude.ai servers). With `apps strict on` it becomes a card instead.                                          |

A card-gated call needs no label check, because you see and approve the exact call.

After the check answers, the bridge looks again at the apps switch, the view and the approved catalog entry (the same
conditions a tapped card is held to). If any of them moved while the check was waiting on the server, the call is
refused with `view_closed` and nothing runs.

**Accepted limit on the agent path.** The gate hook runs in Claude Code's process and cannot ask the server for labels. A
no-tap call is authorised once, then waits up to 120 seconds for the agent to make it. If the server relabels the tool
inside that window, the agent's call still goes through on the labels checked earlier. The next request from the app
catches the change and blocks repeats of the earlier call. The direct path re-checks the switch, the view and the approval after its second tool list and right before the server call, with nothing awaited in between, so a revoke that lands during that list stops the call. That list is bounded by the same 10 second timeout as the first.

Two smaller limits stay: the gate stops matching a request 10 minutes after it expires, or once you decline the server, so a
very late agent call passes as the agent's own.

### Two paths

| Tool visibility on the server | Agent                               | App via Talos                                                                               |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------- |
| Both agent and app (default)  | Can call it                         | Through the agent: no tap if read-only, otherwise a card                                    |
| Agent only                    | Can call it                         | Refused (`not_app_visible`)                                                                 |
| App only                      | Claude Code hides it from the agent | Through the bridge's own connection (remote servers only); otherwise `app_only_unsupported` |

**Agent path.** The Mac writes a pending request and tells the agent, in a note that is marked untrusted, to call the
named tool once with exactly the arguments shown. The result goes to the app only. The agent sees a one-line handle in
its place: `Result handed to app "{label}" ({n} bytes, capture {id}). Nothing else to do.` If the agent cannot run it, it
calls `app_result` with `ok: false` and the app gets `agent_declined`. An authorised request that is not claimed within
2 minutes, or has no result 2 minutes after it was claimed, times out. A late call after a timeout is blocked for 10
minutes so it cannot run unapproved.

**Direct path.** The bridge calls the tool itself. The agent is never involved and never sees the result. A card for a
direct call is run by the bridge when you tap, and the agent is not told.

## App-only buttons and `apps login`

Claude Code hides app-only tools from the agent, and the Agent SDK cannot call a tool, so the bridge needs its own MCP
connection. It makes one only for remote servers (http or sse). It connects when first needed, reuses the connection,
closes it after 5 idle minutes, and holds at most 3 at once. It advertises the same capabilities Claude Code does, so the
server shows it the same tools. Calls time out after 60 seconds. It starts no child process.

Where the server settings come from, and where they live:

- **http or sse with static headers:** Claude Code reports the URL and headers (placeholders already expanded). Talos
  stores them in your login Keychain (service `talos-app.direct`) and reuses them. If you rotate a key in Claude Code,
  Talos's copy is stale: the buttons fail with `direct_auth` until you scan again.
- **OAuth servers:** Talos cannot use Claude Code's stored sign-ins, so run `talos-app apps login <server>`.
- **stdio:** Claude Code does not report the server's environment, so a copy might be a different program. Talos never
  starts one. App-only buttons on such servers answer `app_only_unsupported`.
- **In-process servers and claude.ai connectors:** not supported for app-only buttons.

### `talos-app apps login <server>`

Run it at the Mac only. It runs the standard OAuth flow (discovery, dynamic client registration, authorization code
with PKCE) for the bridge's own sign-in. It prints, in this order:

1. `Signing in to <server host> through <authorization-server host>.`
2. If those two hosts differ: `These are different sites. Continue only if you expect <authorization-server host> to
   sign you in to <server host>. y/N`
3. The full sign-in address, for you to open yourself.

**It never opens a browser, runs `open`, or starts a URL handler.** You copy the address into a browser you trust. The
bridge listens for the answer on `127.0.0.1` only, a random port, the `/callback` path only, for 5 minutes, once, and
checks the `state` value.

Every request in the flow goes through a guard: https only, no embedded user name or password, URLs up to 4,096
characters, at most 3 redirects (each re-checked), responses up to 1 MiB and JSON only, and the authorization server's
`issuer` must match the address its metadata came from. The host is resolved before each request and refused if any
answer is a loopback, private, link-local, shared-address, unique-local or multicast address (including IPv4-mapped
forms), and the connection itself is opened only to an address that passed the same check, so a name that changes its
answer between the check and the connection is refused. The one exception is the approved server's own address when you
approved a local server (`localhost` or a loopback address such as `127.0.0.1` or `::1`; never a name, never a LAN address).
The MCP traffic itself is not sent through this guard; that gap is listed in SECURITY.md ("No address check on the MCP
connection itself"). If it stops, it prints the exact reason and host and nothing to open.

Tokens and the client registration go to the Keychain. A server without dynamic client registration cannot be used for
app-only buttons. `apps logout <server>` deletes the server's Keychain items. Afterward its app-only buttons fail with
`direct_auth` and its no-tap calls become cards until the next scan.

## The three hooks

The scan (and `install.sh`) writes three Claude Code hook entries per approved server into
`<agent-dir>/.claude/settings.local.json`. They match only that server's tools (for example
`^mcp__example-server__.*`). Entries from other tools are left alone, and only entries that contain
`apps/bridge --silent cli hook` are replaced. The hooks do nothing unless the session was started by the Talos bridge
(`TALOS_APP_BRIDGE=1`), so scheduled `claude -p` jobs are untouched.

| Hook                    | When                              | What it does                                                                                                                                                                                                                                                                                                  | If it fails                                                                         |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `pre-tool-use`          | Before a matching tool call       | The gate. If an authorised app request matches (same server, same tool, same arguments or empty arguments), claims it and swaps in the exact approved arguments. If a request is waiting for a card or has expired, blocks the call. Anything else, such as your own ordinary call, passes through untouched. | **Fails closed.** `"onFailure": "block"` and a 10 second timeout. Any error denies. |
| `post-tool-use`         | After a matching call             | For a claimed app request: writes the result for the app and replaces what the agent sees with the one-line handle. For a tool that has an app view: writes a capture and tells the agent how to call `app_show`. Otherwise nothing. Does nothing while apps are off.                                         | Fails open: loses a capture, never blocks.                                          |
| `post-tool-use-failure` | After a matching call that failed | The app is told `tool_failed`. Claude Code gives this hook the error text (no result) and lets it add context only, so the error text reaches the agent as Claude Code shows it. The app never gets the server's error text.                                                                                  | Fails open.                                                                         |

**A failed call is different.** Claude Code's failure hook cannot replace what the agent sees, so the agent sees the server's own error text, not the handle. The app only hears `tool_failed`. Treat a failing server's error text as visible to the agent.

The gate blocks only the approved servers' tools. If it is broken it also blocks them in scheduled jobs, so `doctor`
checks that it runs. A call the agent makes for you, with its own arguments, is never blocked by an app. A request that
collides with exactly the same arguments is the only overlap, and the handle text then says to make the call again.

Very large results: Claude Code replaces a result over its size limit with an error string and saves the full result to a
file under the session's `tool-results/` folder. The hook reads that file only if it passes strict checks (a regular file
in this session's own folder, name starting `mcp-` and containing the server and tool names, changed in the last 120
seconds, 8 MiB or less). Otherwise the capture is marked too large and `app_show` says so.

## Limits and budgets

| Where                  | Limit                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web, per view          | `tools/call` 30/min, `ui/message` 6/min, `ui/open-link` 6/min, display-mode requests 6/min, log entries 60/min, resize one per frame                                  |
| Relay                  | `app.request` 60/min per socket, inside the app-frame bucket                                                                                                          |
| Bridge, per view       | `tools/call` 30/min and 60/day; `ui/message` 6/min and 30/day; 3 waiting at once; 6/min when there was no tap                                                         |
| Bridge, global         | `tools/call` 120/min and 300/day; per server 60/min; `ui/message` 30/hour                                                                                             |
| Bridge, direct path    | per view 60/min and 2,000/day; global 300/min; at most 3 direct connections                                                                                           |
| Abuse                  | 3 limit hits by one view in 10 minutes (tool calls or messages) closes the view and posts a note in the thread                                                        |
| Sizes                  | request arguments 16 KiB; text of `ui/message` 4,000 characters; inline results 128 KiB (larger ones travel as a JSON file up to 8 MiB)                               |
| Time                   | view requests for 24 hours; card expiry 10 minutes; the view waits at most 13 minutes for an answer (card expiry, plus bridge grace, plus clock skew)                 |
| Servers that misbehave | 3 dropped connections in 5 minutes closes that server's direct connection for an hour; 3 failures in 10 minutes posts a note and the next no-card call becomes a card |

## What an app can see and do

| It can see                                                                                                                                                                                         | It never sees                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Its own HTML; the input and result of the call that showed it; the results of its own allowed calls; error codes; the theme, size, locale and platform Talos sends it; its approved network policy | Other threads or messages, other views, the agent's replies, your name, device id, cookies, local storage, tokens, push data, the catalog |

What it can do:

- Draw inside its frame, and ask to resize or go fullscreen (fullscreen waits for Allow on a fixed Talos sheet).
- Call tools of its own server under the run rules above.
- Send a text message to the agent (`ui/message`), only after your tap on Send on a fixed Talos sheet showing the text
  (also Dismiss, and Stop asking until the view is reopened). The agent receives it as untrusted
  text from the app, and a row appears in the thread: "{label} sent to {agent}:" followed by the text, shown as plain
  text. That row is drawn by Talos and is sent silently: no push, and it does not count as unread.
- Ask to open a link. You get a sheet "Open a link from {label}?" with the full address; nothing opens until you tap
  Open.
- Reach only the domains you approved, with only the scripts you approved.

What it cannot do: use cookies or storage, read your session, call the Talos API, open windows, submit forms, download
files, use the camera, microphone, location or clipboard, navigate away from its frame (a second load tears the view
down), or approve anything. An app's own "Approve" button does nothing: approvals exist only as cards outside the frame.

The frame runs in your browser, so a script in it can read what any web page can read without access to the Talos page, such as the browser's time zone and language. Talos adds the theme, size, locale and platform to the host context it sends the view.

Everything an app sends the agent is marked untrusted. The agent acts on an app request only when the notification kind
says it is an app tool call, never because text somewhere claims to be one.

## Troubleshooting

Each failed app request answers the view with one of these codes. The view usually shows its own error text; the code is
in the app log (menu on the card).

| Code                   | Meaning                                                                                               | What to do                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `view_unknown`         | The Mac does not know that view in that thread.                                                       | Ask the agent to show the app again.                                                                        |
| `view_closed`          | The view is closed: its 24 hours passed, it was replaced, it hit the abuse limit, or apps are off.    | Show it again. If apps are off, set `TALOS_APP_APPS=1`.                                                     |
| `not_in_catalog`       | The tool is not part of this app's server.                                                            | Nothing to fix on your side; the app asked for a tool the server does not list.                             |
| `cross_server`         | The tool belongs to a different server than the app's.                                                | Same: the app is asking outside its server. Apps cannot call other servers.                                 |
| `not_app_visible`      | The server marks the tool for the agent only.                                                         | Nothing to fix; apps cannot call it.                                                                        |
| `app_only_unsupported` | An app-only tool on a local stdio, in-process or claude.ai server, or direct access was not approved. | Use a remote (http or sse) server, or do without that button.                                               |
| `too_large`            | The request is over 16 KiB, or a direct result is too large.                                          | The app must send less.                                                                                     |
| `rate_limited`         | Too many requests from this view, this server or overall.                                             | Wait a minute. Three hits in 10 minutes close the view.                                                     |
| `too_many_pending`     | Three requests from this view are already waiting.                                                    | Answer or kill the waiting cards.                                                                           |
| `needs_gesture`        | Older Talos builds only: a request needed a tap inside the view. Not sent any more.                   | Tap the app's own button.                                                                                   |
| `needs_confirm`        | A message was sent without the owner tapping Send on the card Talos shows with its text.              | Tap Send on the card.                                                                                       |
| `mac_offline`          | The Mac or the bridge is not connected to the relay.                                                  | Start the bridge. Run `talos-app status`.                                                                   |
| `agent_declined`       | The agent could not or would not run the call.                                                        | Read the agent's reply in the thread.                                                                       |
| `owner_killed`         | You tapped Kill app request.                                                                          | None.                                                                                                       |
| `card_expired`         | The card sat for more than 10 minutes.                                                                | Press the button again.                                                                                     |
| `tool_failed`          | The tool call failed, or the result could not be loaded.                                              | Check the server. The bridge log has the code; it never holds arguments or results.                         |
| `timeout`              | No answer in time (60 seconds on the direct path; 13 minutes overall).                                | Try again. The request is cancelled on the server.                                                          |
| `sig_invalid`          | The request was not signed fresh: the phone's clock is more than 2 minutes off, or the id was reused. | Fix the phone's clock.                                                                                      |
| `approval_changed`     | The app or a tool's labels changed since you approved it.                                             | At the Mac, run `talos-app apps scan` and review the diff.                                                  |
| `direct_unavailable`   | The bridge cannot reach the remote server.                                                            | Check the server. After 3 drops in 5 minutes the connection pauses for an hour.                             |
| `direct_auth`          | Sign-in is needed: expired token, rotated header, locked Keychain or missing item.                    | Run `talos-app apps login <server>` (OAuth) or `talos-app apps scan` (static headers). Unlock the Keychain. |

Other things you may see:

- **"The live session runs X, this scan would run Y."** Restart the live session or the scan so they match. `doctor`
  warns when the catalog was scanned with another Claude Code than the one running.
- **`app_show` says the apps were scanned with another Claude Code.** Run `talos-app apps scan`.
- **A card says "Talos couldn't check this tool's current labels."** The label check failed once; it is a card instead of
  a silent run. Check the server and the Keychain.
- **A note in the thread: "{label}: app-only buttons need sign-in."** Run `talos-app apps login <server>`.
- **A note: "{label} changed how it labels its tools."** Run `talos-app apps scan` and review.
- **`doctor` prints `FAIL apps hooks`.** Run `talos-app install-app-hooks --agent-dir <dir>`.
- **Nothing is found at scan.** The server may offer apps only to clients that announce MCP Apps support.
- **A polling app-only tool that is not marked read-only** asks for a card on every poll and stops at
  `too_many_pending`. That is the run rule working as designed.

## Differences from the original design

These are places where what shipped differs from the first written design, stated as engineering notes.

1. The media route `GET /media/:id/app` was added with the relay work, not with the protocol work.
2. `AppView` lives in `models.ts`. "A message has an app view if and only if its kind is app" is checked by
   `appMessageProblem()` when the bridge mints the message, not by a schema refinement. A broken view reads as absent, so
   one bad row cannot drop a whole frame.
3. `McpCallToolResult` and `AppView` are not strict: older and newer peers ignore fields they do not know. `AppCsp`,
   `AppPendingRequest` and the signed frames are strict.
4. The script hash pattern requires exact base64 lengths. The policy entry check also rejects IPv4 literals, ports
   outside 1 to 65535, and pinned URLs with `.` or `..` segments. The policy header is capped at 8,000 encoded
   characters. A request timestamp more than 60 seconds in the future is refused as well as one older than 2 minutes.
5. The bridge needed changes beyond `apps/bridge/src/apps`: the inbound pipeline, `bridge.ts`, the context object, card
   expiry, config, the media cache, the relay HTTP client (upload with the policy header, and rehydrate) and the frame
   sender.
6. The catalog server entry has an `ask_each_time` list, outside the approval key, for tools where Claude Code's view
   and the server's own answer disagree on whether they are safe to run without a tap.
7. The bridge's view table stores the app address (`resource_uri`).
8. With no redirect address, the MCP SDK takes its non-interactive path and never refreshes tokens, so the runtime OAuth
   provider carries a placeholder redirect address. The SDK sends MCP traffic through the transport's own fetch, so the
   login guard wraps only the non-MCP URLs of the flow.
9. A hook finds its server by the `mcp_server` field when present (only the post-tool hook documents it), otherwise by
   the unique tool-name prefix.
10. "Receipts" (marking a request seen when the agent calls the requested tool) are not implemented: app notifications
    carry request ids, not a message id.
11. Three dropped connections in five minutes close a server for an hour, and three failures in ten minutes post a note.
    A third failed call therefore also pauses the connection, and the next no-card call becomes a card ("couldn't
    check").
12. An upload over 8 MiB is HTTP 413 (`too_large`), not 400.
13. The relay does not verify the `app.request` signature. It forwards the raw bytes, and the bridge verifies. A request
    the relay invented is rejected by the bridge as `sig_invalid`.
14. The relay's `app.request` rate limit is checked before the offline check.
15. An older bridge's generic error for an `app.request` reaches the asker as a failed `app.response` and is never
    stored.
16. A re-upload without the policy header clears the stored policy. The `/app` route then answers 404 (fails closed).
    `GET /media/:id/page` answers 404 for an app page.
17. The host accepts view messages from the frame's window at any time (a view starts talking while its page is still
    parsing, before `load`), and tears the view down on a second `load`. A rule of "loaded exactly once" cannot work.
18. Request ids are `ar_` followed by a ULID (the id helpers have no `ar` prefix yet).
19. `user_gesture` is not just "activation is live". The browser's transient activation is page-wide (a tap on Talos
    chrome sets it for 5 seconds), so the host also requires that focus moved into the view's frame after the last tap
    outside it, and spends one gesture per request. It is only a rate-budget hint now: nothing that sends or changes
    anything rests on it. A message and a fullscreen request wait for a tap on a Talos sheet, and an app's write always
    draws a card.
20. The row header "{label} sent to {agent}:" is drawn by Talos, so the bridge mints only the bare message text.
21. `tool-cancelled` is sent to a view only when its stored result cannot be loaded, because the view row carries no
    failure flag.
22. The test relay in the testkit answers `bad_frame` to `app.request` (it predates the relay work), and the web shows
    that as `tool_failed`.
23. When apps are off, requests are answered `view_closed` with the text "Apps are turned off on this Mac.", and the
    Keychain deny rules are written only when an approved server is remote (http or sse), the only case where the
    Keychain holds anything.
