# Protocol

Full definitions: the original build spec (not published), section 3. Code: `packages/protocol/src`. This page records the decisions that are
easy to get wrong.

## Envelope

Every frame is JSON text: `{ v: 1, type, id: Ulid, ts: IsoTs, ...fields }`. 64 KiB before authentication, 256 KiB after.
An unknown `type` is `error{code:'bad_frame'}`, never a crash. `parseFrame(input, { direction })` returns
`{ ok: true, frame } | { ok: false, code: 'bad_frame' | 'too_large', message }`.

The relay may add a top-level `relay: { seq, received_at }` to any frame. It is never signed.

## Owner frames and the raw-JSON rule

`message`, `voice_note`, `card.resolve`, `config.patch` and `voice.ask` carry `device_id` and `osig`. Their schemas are
`.strict()` and contain no `.default()`. The signature covers the JCS (RFC 8785) form of the frame without `osig`, `relay`
and `stepup_token`:

```
"talos-owner/v1\n" + device_id + "\n" + sha256Hex(jcs(frame))   ->  ECDSA P-256 / SHA-256, raw 64-byte P1363, base64url
```

`signOwnerFrame` and `verifyOwnerFrame` take the object exactly as it was serialized or `JSON.parse`d. Never pass a
zod-parsed value: a `.default([])` turns `{}` into `{"a":[]}` and the hash changes. The app therefore serializes every
field it signs, empty arrays included. The bridge verifies first, then calls `parseFrame`. `packages/protocol/test` proves
this with a failing case.

## Signed history reads

`history.request` (scroll-back, "Show more", the search context view with `around_id` / `before_id` / `after_id`) carries
optional `device_id` and `osig`, signed exactly like the other owner reads (`search.query`, `memory.*`): JCS over the raw
frame without `osig` and `relay`, ECDSA P-256, checked by the Mac against the pinned key.

- The Mac answers a page only when the signature verifies against a pinned, unrevoked device and `ts` is inside the
  READ window (now + 2 min / now - 5 min; durable owner frames keep 8 days). The same window applies to `search.query` and
  `memory.*`. The frame id is the nonce: it is stored in `seen_ids`, and for `history.request`, `search.query`, `memory.*`
  and the signed schedule frames the check runs AFTER the signature, so only a valid signature learns whether an id was
  used (a forged frame gets `sig_invalid` "signature check failed" whatever the Mac has seen). This holds for a frame that
  does not even parse, too: an unparseable `history.request` or `media.fetch` gets the one fixed answer, whether or not its
  id was used. A failed signed read is answered and forgotten: its id is NOT stored in `seen_ids`, so forged frames cannot
  grow that table. Same bytes again, on any
  socket: `error{ref, code:'sig_invalid', message:'That request was already used.'}`, no data, no agent notice.
- Clock skew: a frame whose signature verifies but whose `ts` is outside the window gets `error{ref, code:'stale'}` "This
  device's clock is off..." and NO forged-signature notice to the agent or the owner (it is still refused and logged). The
  app avoids it: it learns the relay's time from each `ready` frame's `ts` and signs owner frames with that corrected time
  (offsets under 30 s are ignored, and an offset is clamped to one hour). The Mac checks `ts` against its own clock, so the
  window keeps its width, but the relay picks where in it a signature falls: a relay that lies about the time can hold a
  signed read it already has and deliver it up to that hour later, once. It cannot change what the request asks for.
- A `device.revoked` frame is applied the moment it arrives, ahead of the main queue, so a read the relay delivered after
  it is never served.
- No `osig` (an old app, or a relay that invents a request): `error{ref, code:'bad_frame', message:
  HISTORY_UPDATE_APP_MESSAGE}` ("Update the Talos app to page through history."), whatever ids the Mac has seen. The code
  is deliberately not `sig_invalid`: an old build turns an unmatched `sig_invalid` into a false "failed its security
  check" row, and ignores `bad_frame`. Nothing is served. The fields are optional in the schema only so an old app's
  request parses and gets this answer.
- Forged, unpinned or revoked: `sig_invalid` "signature check failed", logged as `owner frame dropped` (type, id, reason, device id; never message
  text), and the agent gets the usual rate-limited `kind=system` notice.
- `media.fetch` (the app asks the Mac to re-upload an attachment older than the relay's buffer) is a signed read of the same
  kind: `device_id` and `osig` over the raw frame, `ts` inside the read window, the frame id as the nonce. An unsigned one
  (an old app, or a relay that names a media id it knows) gets `error{ref, code:'bad_frame', message:
  MEDIA_FETCH_UPDATE_APP_MESSAGE}` ("Update the Talos app to load older files.") and nothing is uploaded.
- The relay budgets signed reads per socket: `history.request` 60 a minute, `media.fetch` 120 a minute (`rate_limited`
  beyond that), on top of the 30 frames a second every socket gets.
- The signed request is the only signed half: a `history.page` is not signed. The app therefore keeps the thread it asked
  about for each request id, drops a page it did not ask for, and merges only rows of that thread.
- The relay still serves a page from its own 7-day buffer without asking the Mac (it already holds that content). It
  forwards everything else, checks that a signed request's `device_id` is the session's device, routes the `history.page`
  and any `error{ref}` for the request to the asking socket only, and never stores such an error (the request's frame id is
  remembered for 24 h, so an error from a slow Mac that lands after the route expired is dropped, not stored). That list
  is in memory and best-effort: after a relay restart a late error is stored like any other late Mac error, a fixed-text
  row with no history content, so nothing leaks.
- The app signs every history request (a new `id` each time) and rejects the wait at once on `error{ref}`.

## Read marks and messages the Mac never took

### Mark unread (`thread.unread`, D36)

The relay's read mark per thread (`thread.read`, `ready.read_upto`) only ever rises: the store keeps the larger of the old and
new `up_to_seq`. `thread.unread{thread_id}` (app to relay, not signed, like `thread.read`) is the one frame that lowers it.

- The relay puts the mark just under the thread's newest row that counts as unread, so exactly that row reads as unread, and
  answers EVERY device, the sender included, with `thread.unread{thread_id, up_to_seq?, count}`. A device applies the count and,
  when `up_to_seq` is there, the mark. The sender shows one unread at once and corrects itself when the answer lands.
- Unread counts only rows still in the 7-day buffer. When none is left, the relay keeps a manual flag instead (no
  `up_to_seq` in the answer, `count` 1); `ready.unread` reports the thread as 1 until the next `thread.read`, which clears
  the flag. A new counting row that arrives later is counted normally.
- A device that has that thread on screen re-reads it when it becomes visible (`Timeline.tsx`), so a mark made on one device
  is undone by another device that is looking at the thread. Accepted.
- Offline or not yet pinned, the app sends nothing and changes nothing. The row menu and Mark all read send the relay's own
  newest seq from the last `ready` (`serverSeq`) when the device has not caught up (`lastSeq` 0), because the read mark only
  rises and a mark at 0 would leave the unread in place.

### Not delivered (`receipt.state = 'not_delivered'`, D38)

A message, voice note, card decision or settings change waits in the relay's outbox until the Mac takes it, and is dropped
with its stored frame when it is 7 days old. Just before that sweep the relay reports what it is about to drop, once per frame
(`nd:<frame id>` in the seen ids):

- Message or voice note: `receipt{message_id, state:'not_delivered'}` to every device. The relay keeps it in message meta,
  so `ready.not_delivered` (the last 200 ids, for 7 days) tells a device that was away. `Message.receipt` accepts the new
  value; an unknown receipt word reads as no receipt, never as a bad message. The row says it did not reach the agent and offers
  Edit and Delete (a voice note: Delete only).
- Card decision or settings change: a plain `author:'system'` row (`message.stored`) in the card's thread, or the default
  thread. There is no row of the owner's to put a receipt on. A card decision whose card the Mac did decide (its
  `card.update` carried a resolution) gets no row and no day-6 warning, whatever became of the ack. The retention sweep keeps a decided
  card while a decision about it is still queued, so the report can still read it; a card row that no longer opens counts
  as undecided.
- Only owner frames are reported: `audience both`, and a `share.item` (the owner's share, queued for the Mac for the whole
  buffer; its row gets the same `not_delivered` receipt and the day-6 warning counts it). Short-lived frames (session
  control, device notices, hook events) keep their own short `ttl_s` and are dropped silently, as before. A stored row that no
  longer decrypts is skipped by the report and still deleted by the sweep, and a failure in the report never stops the sweep.
- A frame the Mac acked `delivered` but never `consumed` (it took the frame, then died before pushing it into Claude) stays in
  the outbox, and gets this same report and the day-6 count. That applies only once the bridge has sent a `consumed` ack
  (`core_state.bridge_two_stage`, set by the relay, no migration). A bridge that only ever says `delivered` has handled its
  frames already, so its rows are dropped silently at 7 days as before. A card decision in this state reads "reached your Mac
  but never got to your agent". Consumed frames are dropped from the outbox and never reported. The relay cannot tell a Mac
  that died before passing the frame on from one whose `consumed` ack was dropped on a socket already down; a reconnect
  before day 7 settles the second (the relay resends, the Mac acks again), so a Mac away the whole week can be reported for
  a frame its agent did get.
- The app keeps a `not_delivered` row through `catchup.reset` (it is the only copy of the text). Edit on such a message brings
  its files back as chips that say "No longer stored. Attach it again.", because the relay deleted their bytes with the frame.
- Day-6 warning: one push (`messages_waiting`, "Your messages have not reached {agent} yet. Wake its Mac today.") per episode, the
  first hourly sweep that finds an owner frame six days old and still waiting. The "already warned" flag
  (`core_state.dead_mac_warned`) is kept in the store, so a relay restart does not repeat it, and is cleared when nothing is
  waiting any more. It is relay-sent and is not one of the Mac's push phrases.

## Card decisions: `resolution.taken_at` and `result.ran`

- `card.update` carries `resolution{action, at, edited, payload_hash, note?, taken_at?}`. `at` is the owner's signed tap; it can
  be hours older than the moment a sleeping Mac took it. `taken_at` is the Mac's own clock at that moment (optional). Apps place a
  card by `at`, and measure "no result yet" and "done today" from `taken_at`, falling back to `at` when an older Mac sends none.
- `result{ok, text, at, ran?}`. `ran:false` means the Mac knows nothing ran (the request was gone at the tap, Apps were off at the tap,
  the app changed before its call could run, or the write that tells the agent failed so it never heard), so the app shows the reason instead of "ask the agent to retry". `ran:"unknown"` means the
  Mac stopped while handing the decision to the agent and cannot say whether it arrived (the text says to check first); the app shows
  the text too. Absent means nothing is claimed; an older reader treats `"unknown"` as absent.
- Both are optional and an unreadable value reads as absent, so an older peer on either side is unaffected.

## Never miss a card or a reply (owner calls O2, O7, O21)

- **Card lifetime.** A background card now lives 86400 s (one day), the same as a chat card; it used to be 1800 s, so it died
  unseen. `expires_in_s` still overrides it (at most 604800). An app card keeps its own 10 minutes.
- **`card_expiring`.** One push, "A card in {thread} expires soon", about an hour before a card expires. Only a card that was
  given at least 2 hours to live gets one. Fixed text, no card title. For per-thread rules it is a needs-you push (a thread
  set to "needs you only" still gets it; "off" does not). The master switch and the quiet window still apply: a reminder held
  back by quiet is retried until the card expires. A card whose expiry falls inside the quiet window is reminded shortly BEFORE
  the window starts instead (the hour before its expiry would be quiet). The web push carries `renotify` (the reminder shares
  its card's tag; without it the browser would replace the unseen first banner silently). The "already reminded" flag is `core_state.card_reminded:<card id>`, so a
  relay restart repeats nothing. Sent by `core/card-reminder.ts`, not by the hub.
- **`quiet_summary`.** The quiet window drops chat and card pushes. The relay counts what it dropped (`core_state.quiet_held`:
  a reply count per thread and the ids of the cards) and, once the window is over, sends one push such as "3 replies, 1 card
  waiting". A reply the owner read before the window ended is not counted (the count is capped by each thread's unread now),
  and the summary keeps for 12 hours at the push service (a digest), not one.
  Counts only, never a name or text (`PushIntent.replies` and `.cards` are numbers). A thread set to off is not counted, the
  master switch off sends nothing, a card decided in the meantime is not "waiting", and nothing to report sends nothing.
  Webhook events are not counted here: the hooks digest (`overnight`) owns those, and schedule failures are held by the health
  watch. Sent by `core/quiet-summary.ts`.
- **App badge.** `badgeCount()` (`push.ts`) is the one number: open cards plus unread. Unread leaves out archived threads
  and threads set to off; an open card is always counted. The relay puts it in every push; the phone and the web app compute it from the same function between
  pushes. The Mac app's own badge is separate and unchanged.

## Acks

| Hop    | Rule                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App    | The app never acks relay-to-app frames; durability is `seq` + `catchup`. The relay acks every durable app frame with `ack{ref, seq}` after the durable write. |
| Bridge | Durable frames in both directions are acked with `ack{ref, seq?}`. Unacked frames are re-sent after reconnect; receivers dedupe on `id`.                      |

### Two-stage ack on the bridge hop

Added after the crash-restart research: a message the bridge received but Claude never consumed before a crash must not
be lost or reordered.

- `ack{ref}` or `ack{ref, stage: 'delivered'}`: the bridge has the frame.
- `ack{ref, stage: 'consumed'}`: the bridge pushed it into the Claude session as a channel notification.
- For `CONSUMABLE_FRAME_TYPES` (`message`, `voice_note`, `card.resolve`, `hook.event`, `hook.digest`, `voice.ask`,
  `voice.ended`) the relay keeps the frame in its replay buffer until `consumed`.
- On **every** bridge `hello` the relay re-sends all consumable frames not yet `consumed` (delivered or not), in `relay.seq`
  order, original bytes. A (delivered, unconsumed) then B (sent while the bridge was down) arrive A, B.
- The bridge handles inbound frames one at a time in arrival order and dedupes on `id` when it notifies: a frame it already
  notified is answered `consumed` again, never notified twice.
- A frame the bridge rejects gets `error{ref, code}` and is then acked `consumed`, so it does not stay buffered.
- `replay.request{ids}` (bridge to relay only, 1-200 ids) is an optional hint with the same result as the re-send on hello.

Tests: `defineTwoStageAckContract` (relay) and the ack-order checks in `defineBridgeContract` (bridge).

## Ephemeral session frames

`session.state`, `session.inventory` and `session.agents` (bridge to relay to app) are not durable: no `seq`, no
catch-up, no push. The relay keeps only the last of each in memory and hands it to a connecting app in
`ready.session_state` / `ready.session_inventory` / `ready.session_agents`. A relay restart forgets them until the
bridge sends again. Details: [CLAUDE-CODE.md](CLAUDE-CODE.md) C2.5.

`session.agents` (the subagent panel, [SUBAGENTS.md](SUBAGENTS.md)) carries one `AgentsSnapshot`, replaced wholesale on
every frame. It has its own cap below the frame limit: the snapshot's JSON may be at most `AGENT_LIMITS.frameBytes`
(64,000) UTF-8 bytes, and a larger one is `bad_frame`. The schema caps alone allow more, so the bridge runs
`trimAgentsSnapshot` before every send (recent lines on ended rows, then on live rows, then ended rows, oldest first).
Every text field is one line (`oneLine`); control characters, line separators and bidi overrides are refused. The
matching control is `session.control {action: 'agent_stop', agent_id}`; `agent_id` is required for it and refused on
every other action, and a row that is gone, ended or not stoppable is `agent_not_found`.

The relay keeps a `session.agents` snapshot only while the last `session.state` names the same session, forwards only
its envelope and snapshot, and advertises `agents/1` in `ready.features`; the bridge sends none to a relay without it.

`session.state.capabilities` is read leniently from this build on (unknown strings dropped). Older apps and relays
read it as a strict enum, so the bridge publishes only `SESSION_CAPABILITIES_V1` (`wireSessionState`); newer
capabilities ride elsewhere (the agents panel's in `AgentsSnapshot.can_stop`).

## Errors and close codes

`bad_frame`, `unauthorized`, `stepup_required`, `stepup_invalid`, `card_not_pending`, `card_expired`,
`card_hash_mismatch`, `card_edit_forbidden`, `config_conflict`, `config_field_forbidden`, `integration_disabled`,
`device_not_pinned`, `sig_invalid`, `mac_offline`, `rate_limited`, `too_large`, `internal`. Option C adds
`worker_unavailable`, `worker_cap`, `usage_governor`, `worker_folder_claimed`, `needs_mac` ([OPTION-C.md](OPTION-C.md)).
WebSocket close codes: 4400 bad frame, 4401 unauthorized, 4403 bad origin, 4408 handshake timeout, 4409 superseded,
4413 frame too large, 4429 rate limited.

When a session has ended, the 401 body (`{ "error": "unauthorized", "reason": ... }`) and the 4401 close reason carry
why, when the relay knows: `expired` (idle or past its limit), `revoked`, `logged_out`, `logged_out_everywhere` or
`replaced`, `signed_in_again` (the owner signed in again over it) or, on the close for a `hello` naming a different device
than the session's, `device_changed`. The field is optional. An app that gets no reason, or one it does not know, treats the
session as revoked: only `expired`, `signed_in_again` and `device_changed` let it keep messages that were queued but not yet
delivered.

## Identifiers

`Ulid` (26 Crockford chars), `m_ c_ e_ md_ v_` + ULID, `d_` + 20 base32 chars (device, from the SPKI hash), `cn_` + 22
base62 chars (connection, a capability). Frame ids are bare ULIDs.

## Other helpers in the package

| Module               | Contents                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonical.ts`       | `jcs`, `sha256Hex`, `payloadHash(binding)` = `sha256:<hex>`                                                                                                |
| `hash.ts`            | Synchronous SHA-256, HMAC-SHA256, HKDF-SHA256 (verified against `node:crypto` in tests)                                                                    |
| `enroll.ts`          | Enrollment code, `code_auth`, `code_bind`, `bindingMac`, `verifyBinding`                                                                                   |
| `bridge-auth.ts`     | Ed25519 challenge and HTTP signature helpers, key id, rotation signature                                                                                   |
| `untrusted.ts`       | `wrapExternal`, `sanitizeExternal`, `stripSpecialTokens`, `sanitizeMetaValue`                                                                              |
| `quiet-window.ts`    | `isQuiet`, `nextQuietEnd` (Intl, any IANA zone, DST-safe)                                                                                                  |
| `push.ts`            | `PushPayload`, `buildPushPayload` (fixed templates, no free text field), `badgeCount` (the one app-icon number)                                            |
| `fingerprint.ts`     | `fingerprintWords(device_id)`: four PGP words for pin confirmation                                                                                         |
| `http.ts`            | Request and response schemas and a route table for spec 3.8                                                                                                |
| `native.ts`          | Native-shell JS bridge messages (page <-> Mac/iPhone web view), strict zod; fixtures in `fixtures/native/`                                                 |
| `thread-sessions.ts` | Option C: the per-thread switch, `dedicated` settings, `workers.json`, wake file, hub lines; fixtures in `fixtures/option-c/` ([OPTION-C.md](OPTION-C.md)) |

## Config patches: when a save counts

The relay acks a `config.patch` when it stores it. The bridge's answer is what counts: `config.sync` with
`applied: <patch id>` means applied, `error{ref: <patch id>}` means refused (`config_conflict` also re-sends the current
`config.sync`). A `threads` array is patched per thread: inside an existing thread an omitted key keeps its value and
`null` clears it (`resolveThreadsPatch`). Details: docs/THREADS.md.
