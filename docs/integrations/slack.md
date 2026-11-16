# Slack (work)

Ships **disabled**. **Ask your IT team before connecting these.** A workplace admin controls which apps can be added to a
workspace; if Slack says "Request to install", an admin has to approve it.

## What it reads

Direct messages, group direct messages, and channel messages that mention you. Everything else is dropped by a
pre-filter right after the signature check, before anything is stored. Your own messages, edits, deletions and joins are
dropped too. The app asks for four user scopes and nothing else: `im:history`, `mpim:history`, `channels:history`,
`groups:history` (a channel message only matters when it mentions you, and Slack only delivers channel events with the
history scope). Names are not looked up, so events show Slack ids.

## An agent's bot

A Slack connection listens either to your own account (the default) or to an agent's bot user (`identity: bot`, chosen
when the connection is made and not changed after). A bot connection keeps what is addressed to the bot: direct
messages to it, group direct messages it is in, and channel messages that mention it (`slack.bot_dm`,
`slack.bot_mpim`, `slack.bot_mention`). The same three switches turn these on and off.

In the wizard, step 2 asks **Whose messages?**: **My messages** (the default, everything as above) or **An agent's
bot**. The choice is free until the Signing Secret is saved; after that it stays, and the other kind is a second Slack
connection (both can run side by side). The Integrations list and the connection page say which each one hears.

Step 3 for a bot has two ways to the same connection:

- **Add to a bot app you already have** (the agent already posts through it): in that app's settings turn on **Event
  Subscriptions** and paste the Request URL, subscribe to the bot events `message.im`, `message.mpim` and
  `message.channels`, check the bot scopes `im:history`, `mpim:history` and `channels:history` (reinstall if Slack asks),
  and switch on the **Messages Tab** under App Home. An app has one Request URL for all its events: if it already sends
  its events somewhere else, this replaces that, so check first.
- **Create a new bot app**: a manifest link with the bot events above, the bot scopes `im:history`, `mpim:history`,
  `channels:history` and `chat:write`, a bot user, and the App Home Messages tab on with messages allowed. `chat:write`
  is there because Slack requires it for the Messages tab (without it nobody can DM the bot); Talos never collects the
  bot token, only the Signing Secret, so it never posts as the bot. No user scopes, no private channels.

Either way, paste the app's Signing Secret. The bot only hears public channels it has been added to.

Loop guards, both ways:

- A bot connection drops every message a bot posted (the `bot_message` subtype, a `bot_id`, or the bot's own user id).
  The agent's replies come back from Slack as events; they are dropped before storage, so nothing the agent says
  reaches the agent again. This needs no id, so it holds from the first event.
- Your own connection drops messages from your bot connections' bots: their bot user ids and their app ids (a bot
  posting under a custom name carries only the app id). The relay passes these in. Once a bot is known, only that bot
  is dropped; other apps' bots reach you as before. With no bot connection nothing changes.
- For the first day after a bot connection is made, until it has learned which bot it is, your connection refuses every
  bot's message (people still come through), so the agent's bot cannot reach you and trigger a reply before it is
  known. These show in Recent deliveries as `held_bot_unknown`. A bot connection that never hears from Slack (set up but
  never installed) holds nothing back after that day.

Which bot it is: Talos reads the bot's user id and app id from the first signed event Slack sends (the `authorizations`
entry with `is_bot: true`, and `api_app_id`) and saves them. A user id given at setup (`bot_user_id`) wins and is never
replaced. After that, an event for a different bot or app is refused and shows in Recent deliveries as `other_bot`; it
is not learned. An event Slack delivered for a person rather than the bot (an app that also has user scopes) is refused
as `not_bot`, so your own messages never land on an agent's connection. So give an agent's Slack app bot scopes only:
an app with user scopes too may have events delivered for the person, which a bot connection refuses. Saving a new bot
user id or Signing Secret later makes the connection learn its bot again from the next event (and your connection
holds bots back again for a day meanwhile). If the new secret belongs to a different app, the old secret still verifies
for 24 hours; should an event from the old app arrive first, its bot is learned and the new app's events show as
`other_bot`. Save the new app's bot user id to fix that.

## Set up

1. Tap **Open Slack**. The app manifest link has the request URL and scopes filled in. Pick the workspace and **Create**.
2. In Slack open **App Manifest** and tap **Verify** next to the Request URL. The relay answers Slack's
   `url_verification` before any secret exists, so it goes green. Then **Install to Workspace**, **Allow**.
3. Paste the **Signing Secret** (Basic Information). That is the only thing asked for: no user token is collected, and your Slack id comes from the signed event itself.

## Verification

`X-Slack-Signature: v0=` + hex HMAC-SHA256(signing secret, `v0:{X-Slack-Request-Timestamp}:{raw body}`), compared in
constant time, rejected when more than 5 minutes old. A retry or replay carries the same `event_id`, which is the dedup
key, so it is stored once. The test suite includes Slack's published example (secret `8f74…85a5`, timestamp
`1531420618`).

The `url_verification` reply is `text/plain`, only for a short challenge made of letters, digits and `._~-`.
