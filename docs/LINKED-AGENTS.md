# Linked agents

Two Talos installs of the same owner (a home Mac and a work Mac, say) can message each other. The main agent on one calls
`peer_send`; the other install's relay takes the message at a signed webhook inbox and hands it to that Mac, where it reaches the
main agent as outside data (`kind=peer_message`, `trust=external`). Nothing is sent by a phone push, and nothing a peer says
approves anything.

## Set up (your agent, or you in a terminal)

Your agent can do this itself with `talos-app peer ...` unless "Lock Talos settings" is on (then it says so and you do it, or unlock).
It does not link while outside text (a message from a linked agent, a hook, a shared page, in any thread) or another session's hand-off
has reached it since you last spoke; ask again in your own words. A request made by voice, or one followed by outside text arriving (a hook, a share, a call ending), may be
refused for that reason: ask again in a typed message, or run it in a terminal. `peers` in config.json is still refused to the agent's config tools and hidden from phones.

### One paste (the way to link)

A peer is named by what THIS Mac calls the other one (`work`, `home`). Linking is one code, carried once:

1. On A: `talos-app peer link work` (`work` is what A calls the other Talos). It makes the inbox for it and prints ONE code,
   `talos-link:<A's relay host>/<id>/<token>`, and a line saying it works once, for 15 minutes. No secret is shown, written or kept on A.
2. Paste that code to B's agent. On B: `talos-app peer accept <code> --name home` (`home` is what B calls A; `--name` is required, and
   your agent takes it from your words, "link with my home Talos" means `--name home`, or asks you). B makes its own inbox, redeems
   the code once at A's relay (https only, no redirects, no private addresses, 10 seconds), keeps A's secret in the key store, and
   points `peers` at A. Nothing secret is printed, written to a file or put on the command line.
3. A's bridge picks up B's inbox address and secret from A's own relay (it asks every 10 seconds while the code is open), checks them again,
   and keeps them. Both directions are live. Each side gets one quiet row: "Linked with <name>".

The code is a bearer credential for 15 minutes: whoever pastes it first links to whoever made it. If a code is stolen and used first,
the owner's own `peer accept` fails with "this link code can't be used: it expired, was already used, or is wrong", leaves nothing behind on
B, and A's thread gets the row "Link to <name> was taken by another install; run talos-app peer remove <name>" (A notices a second
use of the code). Ask for a new code with `peer link` again once the old one has expired (15 minutes), or cancel it first with `talos-app peer remove <name>`: while a code is waiting, a second `peer link` is refused ("a link code is already waiting for <name>; use it or cancel it with talos-app peer remove <name>."). A relay that is not on public https cannot make a code:
use the manual way below. `--cap N` works as below.

### Manual, two steps (the fallback)

Both directions need two commands each:

1. On A: `talos-app peer create work`. It makes an inbox on A's relay for the other install and prints a URL and a secret, once. When
   your agent runs it, the secret is never printed: it goes to `<talos home>/peer-secrets/work.secret` (0600), and the agent carries the URL
   and that file to B.
2. On B: `talos-app peer add home --url <A's url>`, and paste A's secret when asked (it is not shown and never goes on the command
   line). B can now send to A. With a file (what an agent uses): `talos-app peer add home --url <A's url> --secret-file <file>`; the
   file must be a regular file of yours, mode 0600 or stricter, and it is deleted once the secret is stored.
3. On B: `talos-app peer create home`, then on A: `talos-app peer add work --url <B's url>` with B's secret. A can now send to B.

`--cap N` sets a daily limit (default 50 a day, at most 500): on `create` the limit for what that inbox takes, on `add` the limit
for what this Mac sends. `peer list` shows each peer (the host of its URL, never the URL), the caps, today's counts and whether
the secret is present. A's copy of the secret file is deleted when B's first message arrives (after a `peer rotate`, the first message after the old secret's 24 hours, because a message inside them may still use the old secret) (or by hand: `talos-app peer secret-forget
<name>`; `peer remove` deletes it too). The owner sees a quiet row in the default thread whenever a peer or an inbox is added or removed,
whoever did it. The secret is kept in the Keychain (the key store on Linux), the inbox connection in
`peers-inbound.json` in the Talos home (0600), the peer's name, URL and cap in config.json `peers`.

## What the agent can do

`peer_send` (main session only; never a thread's own session, never a scheduled job): `peer`, `text` (at most 8 KB), `label`
(`TASK`, `RESULT` or `BLOCK`), `in_reply_to` (the `peer_msg_id` of a peer message being answered) and `thread_id` (where the owner
sees the quiet "Sent to ..." row). It answers "queued for work" at once; delivery is in the background.

Before anything leaves, the text goes through the same redaction as `talos-app report` (secrets, tokens, home paths), and the
answer says how many items were redacted. Finances, health and family content do not go to a peer unless the owner asks.

## Limits and loop guards

All of them are enforced by the Mac from its OWN records of what it received and sent, never from what a peer claims.

- `in_reply_to` must be a message this Mac received from that same peer. A reply to a `RESULT` is refused: a RESULT ends the
  exchange. A reply to a message from one peer cannot be sent on to another peer.
- Each reply is one step further along the chain than the message it answers; more than 6 steps is refused ("ask the owner").
- At most the `peers[].daily_cap` messages a UTC day to a peer; the other relay also caps what it takes (429 `daily_cap`).
- Text is at most 8192 bytes; control and bidi characters are refused.
- A message that arrives gets the chain this Mac computes (never lower than the sender's claim), and "from a peer" is set here.

Delivery is signed with Standard Webhooks and retried with the same message id for up to 24 hours (a duplicate lands once). The relay's own 404 `not_found` means the other side removed the link: nothing more is sent, the thread says so, and `peer_send`
refuses that peer until `peer add` links it again. A 404 or 410 with any other body is a platform page and is retried, as is a 408. The outbox survives a restart. Messages
go through a fetch that follows no redirects and refuses private addresses.

## The peer taint (what the bridge can and cannot see)

A message from a linked agent can ask main to pass something on to a third install. To stop that, once a peer message has
reached main the bridge remembers which peers have spoken (kept across restarts) and `peer_send` then goes only to that one peer:
- A send to any other peer is refused, and with messages from two peers waiting, a send to either is refused. Main answers, or asks
  the owner.
- A send to the speaking peer without `in_reply_to` counts as the reply to its latest message: one step further along the chain,
  the RESULT rule and the cap of 6 apply. An explicit `in_reply_to` keeps the plain rules.
- The taint ends when the owner speaks to main: a typed message, a file. A card decision, a Run tap (an
  approval) and a share with no typed words do not end it; a share with the owner's own comment does.

The limit: the bridge cannot see where a turn of the agent ends, so it cannot tell "still working on that message" from "moved on".
ANY owner message to main clears the taint, even one about something else, and a peer message that arrives after it taints again.
In particular an owner message that lands right after a peer message clears it even if main handles both in one turn, and then main
may send anywhere in that turn.

## Revoke

`talos-app peer remove <name>` deletes the inbox on your relay (the other install gets 404 from then on; messages queued for this
Mac and not yet taken are dropped, and any that were already taken are ignored), the secret, the config entry and the local record.
`talos-app peer rotate <name>` makes a new inbox secret (shown once in a terminal; written to the secret file when your agent runs it); the old one works for 24 hours. If a secret leaked, rotate is
not enough: `peer remove`, then `peer create` and give the other install the new URL and secret.
