# Security

This page explains who the app defends against, what each protection does, and, plainly, what it does not cover.
The authoritative technical text is the original build spec (not published), sections 3.5, 3.6 and 5; the setup guide is
[SETUP.md](SETUP.md).

## The idea in one paragraph

Your agent controls a computer. So anyone who can make it believe that **you** said something can make it act as you.
The relay (the server on Railway) is the door to that computer, and a door on the internet will be tried. The design
therefore assumes the relay can be attacked, even fully taken over, and arranges for the Mac to check for itself that
a message really came from your phone before the agent ever sees it. Everything that arrives from outside (emails,
webhooks, chat messages) is handed to the agent as labelled data, never as an order.

## Who could attack, and what they want

| Attacker                                                        | Wants                                                              | Main defences                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stranger on the internet who finds the relay address          | To log in, read messages, or send commands                         | Passkey-only login, closed registration, signed owner messages, pairing gate, rate limits.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Someone who gets an enrollment link or sees your screen         | To add their own device                                            | The link works once for ten minutes; the Mac asks you `y/N` with four words you compare on both screens.                                                                                                                                                                                                                                                                                                                                                                                       |
| Someone who sends you email, a webhook or a chat message        | To plant instructions the agent obeys                              | Everything external is wrapped as untrusted data; the agent acts only through a card you approve.                                                                                                                                                                                                                                                                                                                                                                                              |
| A malicious web page, or an agent-written page, in your browser | To use your session or read your data                              | Strict CSRF checks, `SameSite` cookies, sandboxed pages with no cookies and no access to the app's API.                                                                                                                                                                                                                                                                                                                                                                                        |
| Whoever breaks into the relay's database or API                 | To forge your messages, or read history                            | Owner messages are signed with a key the relay never holds; stored data is encrypted; history lives on the Mac.                                                                                                                                                                                                                                                                                                                                                                                |
| A stolen, unlocked phone                                        | To approve things as you                                           | Risky cards are approved in the app, never from the lock screen; no Face ID anywhere since 2026-11-14, by the owner's choice (see "No step-up, and Always allow"); a tap on a card approves it, and an Always allow the owner gave lets the next one through with no card). A revoke or sign-out empties the app's saved chats and unsent messages. (Limits below.)                                                                                                                            |
| Someone who gets a copy of the Mac's bridge key                 | To pose as your Mac                                                | Only one live bridge per key; a second one knocks the first off and alerts you; `talos-app rotate`. The iPhone app pins the key's fingerprint from the pairing QR and checks a fresh signature from it (the attest) at pairing and on every reconnect: a different key is a hard stop, and a rotation the old key signed still needs your confirm on the phone.                                                                                                                                |
| The agent itself, misled or hostile (it runs as you on the Mac) | To pin its own device, widen its own limits, or switch off a check | A speed bump, not a boundary (it runs as you): human-only commands (`enroll`, `devices`, `rotate`, `trust on`, `memory init`, `apps scan`, `install-ask-rules`, `install-guards`, `adopt`) refuse unless stdin and stdout are a terminal; optional guards (`talos-app install-guards`) deny the obvious moves; a tripwire alerts in the Inbox when `devices.json` or the security fields of `config.json` change outside the app. See "The agent as the attacker" for what still gets through. |

## What each protection does

Where a protection is proven by a test, the last column says which. "e2e" is the end-to-end suite in `e2e/`, which runs
the built relay, the built app and the real bridge together; "unit" tests sit next to the code.

| Protection                         | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Proven by                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Passkey-only login                 | One owner. No passwords, no email reset. A new passkey can only be created with a live, single-use enrollment code; five wrong codes from one address lock that address out for ten minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | unit (`auth/enrollment`), e2e scenarios 1 and 1b                                                                                                                                                 |
| Owner signatures                   | Every message, card decision and settings change is signed in the browser with a device key that cannot be exported. Notification buttons (Reply and a low-risk Approve) are signed by a second, separate key that lives in the iPhone Keychain, the action key; the device key signs only a time-limited grant that names it (30 days at most), and the Mac checks the whole chain against the device key it pinned. The Mac checks the signature on the exact bytes before the agent sees anything. A bad signature is dropped and you are told.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | unit (protocol, bridge `security`), browser (`test:browser`), e2e scenarios 2 to 5                                                                                                               |
| Device pinning by the Mac          | A device key counts only after you answered `y` at the Mac, comparing four words shown on both screens. The relay cannot create a pin: it never holds the secret that binds a device to its enrollment code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | unit (`bridge/enroll`), e2e scenarios 1 and 1b                                                                                                                                                   |
| Pairing gate (new in this release) | A session whose device is not pinned (you said `N`, or the browser has no device key) can finish pairing and nothing else: every data route answers `403 device_not_pinned`, and the live socket gets an empty hello and refuses requests. So a refused stranger sees none of your threads, history or media.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | unit (`wp8/pinning-gate`), e2e scenario 1b                                                                                                                                                       |
| Passkey sign-in proves the device  | Signing in with a passkey and naming a device also needs that device to sign the login challenge with its own key (the proof enrollment uses, bound to the passkey that signed in). A passkey that syncs to another keychain is not enough to sign in as a pinned device. Every successful sign-in sends a push (`sign_in`, or `sign_in_unproven`) that a visible tab, an unpinned socket's made-up presence and the chat master switch cannot silence. A device counts as proven the moment it enrolls (it just signed the enrollment proof), and an open browser proves its key in place on its next page load (`/api/auth/device/prove`), so a browser need not sign out and in again. A device that has proved once can never sign in without a proof again, and its first proof ends every session still attached to it without one. Only a device enrolled before this change that has not been opened since (Settings shows "Key not verified") still signs in without a proof, with a `sign_in_unproven` push, until it is opened once or `DEVICE_PROOF_REQUIRED=1`. The default is `0` in this release (nothing flips it by itself): after deploying, open or revoke every device that shows "Key not verified", then set `DEVICE_PROOF_REQUIRED=1`. The in-place proof calls have their own rate budget, so page loads cannot use up the sign-in budget. The native apps do not use this path (they sign in with a setup code). Revoking a device, or signing it out, also deletes the browser and Home Screen push subscriptions it made, so a lost browser stops getting notifications. A subscription made before the relay recorded which device owns it cannot be tied to a device; "sign out everywhere" still removes it. Revoking a device does not remove a passkey that another device also uses; the Devices screen and `talos-app devices revoke` both say so. To remove such a passkey, revoke every device on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | unit (relay `auth/device-proof-login`, `auth/device-proof-gaps`, `push/sign-in-alert`), e2e (`12-device-proof`, incl. 12c in-place proof after a reload: real browser, built relay, real bridge) |
| Setup-code sign-in (native apps)   | The native apps cannot make a passkey, so they trade the same one-time setup code for an unpinned session: pairing routes only, none of your data, until you answer `y` at the Mac. A leaked code alone cannot pin a device; the Mac still asks you with four words. Signing in again on an already-pinned device needs a signature from that device's private key (proof of possession), because a device id and its public key are not secret. A device made this way has no passkey behind it: its record holds no credential id. Five wrong codes from one address lock that address out for ten minutes, native apps included; no code is burned, so a stranger elsewhere cannot block your pairing; someone sharing your network's address (the same Wi-Fi, carrier NAT) could, for ten minutes at a time. A code held by a session burns on its fifth wrong device proof, from any mix of addresses, and a session made from a burned code can never pin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | unit (relay `auth/enroll-session`, `auth/n0-review`, `auth/n0-recheck`)                                                                                                                          |
| Signed history reads               | Scroll-back, "Show more" and the search context view are signed by the pinned device like search and memory reads. The Mac serves a page only for a verified, unrevoked device and a request id it has not seen, so a taken-over relay cannot page back through the Mac's history, replay an old request or answer one from an unpinned key. Re-uploading an old attachment (`media.fetch`) is signed the same way, so the relay cannot ask the Mac for a file on its own; only a signed request from your app makes the Mac upload one (see the limit below on rows the relay can write). A failed read is answered and forgotten: it is never remembered as a used id. An old app's unsigned request gets "update the app" and no data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | unit (bridge `signed-history`, `v6fu-review`; relay `v2-v0`, `v6fu-review`; web `signed-history`, `v6fu-review`), contract (`signed history reads`)                                              |
| Replay protection                  | Each signed frame has an id the Mac remembers (even across restarts). Sending the same bytes again, on the same or a new socket, changes nothing and reaches the agent once. This holds as long as the Mac's `history.sqlite` is sound. If it is damaged and replaced, the remembered ids go with it, so a frame the relay sends again within the 8-day window can reach the agent a second time. That is accepted: the replaced history also has no card ledger, so a card decision cannot run again, and a repeated message is only text the owner already sent. Owner controls (`session.control`, `thread.session.control`, `agent.recover`, `undo.request`) are not repeated: the reset time is kept in the new history, and a control signed before it (the frame's own signed time, plus the 2 minutes of phone clock the Mac accepts) is refused with a recorded `control_stale` answer and run by nothing. The owner's note says "A recent message may arrive at your agent a second time."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | e2e scenario 5, unit (bridge `cards`)                                                                                                                                                            |
| Undo to here                       | "Undo to here" on a message is a signed `undo.request` from your pinned device. The Mac answers with an undo card (high risk, step-up) or says why not; nothing is put back until you approve that card. The Mac checks the message is that thread's and has a point, and refuses a request it already answered or one signed before its history was reset. Only a relay that says `undo/1` is sent a message's undo point (on its `delivered` receipt and history rows); an older relay never sees the field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | unit (protocol `undo-frames`, relay `undo-request`, `receipt-undo`, bridge `undo-request`, `undo-card`)                                                                                          |
| Cards                              | Anything that sends, posts, deploys, pays or deletes goes through a card. Approving is one tap on the card's face; nothing has to be scrolled or opened first (the owner's ruling, 2026-11-21), and the fingerprint covers the card whether or not its details were opened. The card carries a fingerprint of everything you saw; your app recomputes it and refuses an altered card; the Mac rejects any decision whose fingerprint differs. Cards expire. A decision, from the app or from a notification, is judged at the time the relay took it: a tap in the app that the phone itself held for more than ten minutes before the relay got it is treated as expired, and a notification tap held that long is refused and its card stays pending. The Mac may be asleep, so a tap is valid for at most 12 hours from the time the phone signed it, measured on the Mac's own clock (the relay's timestamp is not signed and cannot extend it), and only while the card itself is still alive. Past that, the card stays pending: a notification tap gets a push saying it did not go through, and a tap in the app is told to tap again. A notification Approve is refused outright for a high-risk card; in the app it is allowed. Two kinds of card have shorter windows of their own: the commands on a card run only if the approval is less than ten minutes old on the Mac's clock (counted from when the phone signed it, whatever the relay's stamp says), and a dialog card is pressed at the Mac only if the signed answer is less than fifteen minutes old; past that nothing runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | unit (web `cardview`, relay `cards`, bridge `cards`), e2e scenarios 4 and 6                                                                                                                      |
| No step-up                         | Gone since 2026-11-14 (the owner's ruling: zero Face ID approvals; only sign-in keeps the passkey). A signed tap is the approval for every card and setting; a high-risk card is approved in the app, never from a notification. See "No step-up, and Always allow".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | unit (`auth/stepup`), e2e scenarios 4 and 5                                                                                                                                                      |
| Untrusted content                  | Emails, webhooks, call records and digests are wrapped by the Mac in a block with a fresh random marker and a one-line warning. Lookalike end markers, fake channel tags and model control tokens inside are neutralised. The Mac decides the trust level; the relay cannot set it. The bridge never runs a tool because of what such text says.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | unit (bridge `security`, protocol), e2e scenario 7                                                                                                                                               |
| Signed webhooks                    | Each integration verifies its sender's signature (or an unguessable URL plus a field check where the service signs nothing). A bad one is refused and stores nothing; a replayed delivery is stored once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | unit (every verifier), e2e scenario 7                                                                                                                                                            |
| Work integrations off by default   | Work sources show a lock, need the owner's signed tap to enable, and `WORK_INTEGRATIONS=off` blocks them all. While off, they are refused and nothing is stored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | unit (`hooks/work`), e2e (`security surface`)                                                                                                                                                    |
| One-time setup keys                | Tokens pasted to set up Linear or Calendly are used once to register the connection and then deleted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | unit (`wp8/provision`)                                                                                                                                                                           |
| Default-deny routes                | Every address under `/api`, `/bridge`, `/hook`, `/media` must be listed in the protocol's route table with its login rule, or the relay refuses to start. Anonymous callers get 401 on every listed route and 404 on everything else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | unit (`route-table`), e2e (`default-deny`)                                                                                                                                                       |
| No test backdoors                  | The header the tests use to pretend to be logged in exists only in test code. The relay refuses to start with it registered outside tests, and the shipped bundles are scanned for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | e2e (`production bundle`, `security surface`)                                                                                                                                                    |
| Browser hardening                  | A strict content security policy, cookies that are `Secure`, `HttpOnly`, `SameSite=Strict` and host-bound, an Origin and CSRF-header check on every change, form posts refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | unit (`auth/csrf-session`), e2e (`security surface`)                                                                                                                                             |
| Sandboxed media                    | Uploads are sniffed and given a safe type. SVG and HTML are never shown inline: agent-made pages run in an opaque origin with no cookies and no access to the app's API, send no referrer, and have camera, microphone, location, clipboard, payment, device and fullscreen access turned off (the app views' Permissions-Policy), opened inline or in a tab of their own; every media response, including errors, carries a sandbox policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | unit (relay `media`), e2e (`security surface`)                                                                                                                                                   |
| Rate limits                        | Login, enrollment, webhooks, uploads and all signed bridge requests are limited; the bridge's hello also blocks an address for an hour after five failures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | unit, e2e (`security surface`)                                                                                                                                                                   |
| Encryption at rest                 | Messages in the relay's buffer, inbox and webhook event text, secrets and uploads are encrypted with `DATA_KEY` (AES-256-GCM). The database file alone is unreadable. Inbox and webhook events written before this was added are sealed in place, 500 per 30-second housekeeping tick, so a large backlog takes minutes; each is readable the whole time. Sealing overwrites the old text in the database page it was in, but copies can survive in free pages of the database file, in the write-ahead log until its next checkpoint, and in earlier backups or volume snapshots, until the seven-day buffer has passed. Not sealed: the one-line agent summary on an inbox item and the sender, source and priority columns used to sort the list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | unit (relay `review-plaintext`)                                                                                                                                                                  |
| Short memory on the relay          | Seven days of undelivered messages at most. Full history is on your Mac.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | unit (relay `outbox`)                                                                                                                                                                            |
| Quiet notifications                | What Apple and the browser vendors can read in a push is never message text, a card title, a sender or a subject: only fixed phrases such as "New reply in a thread". A phone that turned on message text also gets the words inside a seal only that phone can open; Apple cannot read them, but your Talos relay can (it builds the seal), as it can read all your messages. Message text off (Settings) gives that phone the fixed phrase alone. The same holds for native iPhone push (`buildApnsBody`), which is stricter because Apple can read it: no thread name or id either, and a fixed title "Talos" instead of the agent's name (only General and Inbox are named, as the fixed words "General" and "Inbox" and never as renamed in config; every other thread is "a thread" with an opaque reference the app resolves after the tap), whatever "Show thread names" says; that setting governs browser notifications, and also the thread name inside the seal for a phone that turned message text on (the name travels only inside the seal, which the relay can read). The Approve button's arm is held in memory by the app shell, never in a URL, so agent text cannot start an approval prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | unit (property test in `protocol`)                                                                                                                                                               |
| Quiet logs                         | Logs name events and ids, never text, tokens, codes or cookies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | e2e (`logs hold no ...`)                                                                                                                                                                         |
| Live voice (archived)              | Live voice was removed on 2026-11-19 ([archived/voice.md](archived/voice.md)); this is what the control was. The voice model has no tools. Hand-offs to the agent are signed by the app, and the relay only passes one on if it matches a live call, a hand-off it created and that call's thread. The relay's core never forwards such a frame itself. Call transcripts are never treated as something you signed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | unit (relay `voice`), e2e (`voice.ask ... never forwarded`)                                                                                                                                      |
| Bridge safety                      | One live bridge per key (a newer one supersedes the older with a clear signal, and you are alerted); signed requests with replay-proof nonces; key rotation signed by both keys at the relay, and by the old key for phones (a rotation certificate); a public attest route (`POST /api/bridge/attest`, rate limited) on which the Mac signs only tagged bytes: a phone's nonce, the relay origin and its own key's fingerprint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | unit (relay `bridge-auth`, bridge `lifecycle`), e2e scenario 9                                                                                                                                   |
| Scheduled jobs are card-gated      | Creating, changing, turning on, deleting or adopting a scheduled job is a card the bridge applies itself, from the binding you approved, against the version you saw; a job that changed in between is refused and nothing is written. Prompt, model, runner and wider permissions are high-risk (Face ID); with trust mode on, schedule cards are low-risk and skip Face ID (see Trust mode below). Pause, resume, turn off and Run now skip the card but are signed, fresh within 2 minutes and replay-proof.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | unit (protocol `schedules-card`, bridge `schedules/card-path`), e2e (`schedules`: happy path, edit, list, wire)                                                                                  |
| Held when changed outside the app  | A job whose instructions were changed on disk without an approval is held by the scheduler itself: it is not offered to the session or run in the background, and the agent is only told it is on hold. Approving the on-disk text is an Adopt card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | unit (bridge `schedules/session-runner`), e2e (`schedules`: hold)                                                                                                                                |
| Schedule frames are not stored     | The relay forwards schedule reads and controls to the live Mac without storing them; with the Mac away it answers at once. `schedule.status` carries ids and hashes, never names or prompts. Failures reach the job's thread from the Mac, and their push waits out the quiet window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | unit (relay `schedules`), e2e (`schedules`: failure, offline, wire)                                                                                                                              |
| Run button on code blocks          | The owner chose a tap on Run as their approval for that script, in place of a card, with no Face ID on Run. A tap sends the owner's own signed `message` with `intent: 'run'`, the script in one fence, and `run_block` (message id, block index), all signed. The Mac, not the agent, refuses a thread set to have its own session, running or not. It needs an exact shape (`parseRun`), a `run_block`, a first signing time (`original_ts`, else `ts`) within a day (so a Run can arrive up to a day late), none before a history reset, a block whose message id is under 7 days old on the Mac's clock. Each tap runs once (owner, 2026-11-15, audit 14): the Mac marks the tap's own message id in its seen store before the agent hears of it, so a replay of that tap, under any frame id, is consumed and never runs twice; a fresh tap on the same block is a new signed message and runs again. Only then is `run="tap"` set on the note; the agent trusts that, not the text, and is told a Run does not override "never change devices, keys, enrollment or security settings" and happens once per tap. The Mac does not check that the script came from the agent: a relay that rewrites an agent row can show a script, and the owner's tap approves it. App: no button without `run/1`, in such a thread (except Run in Terminal in the Mac app, below), on hidden characters, an unclosed fence, a block not drawn as its source, or over 4,000 characters. One tap for a script of printable ASCII, any length up to the cap; one with any other character asks twice. After a tap the screen shows its own tap's result, and once that tap has left (or failed) Run again offers a fresh tap. An unlocked, signed-in phone in a thief's hands can ask the agent to post a script and tap Run, past cards and Face ID. That phone can already message the agent as the owner, and cards are the agent's rules unless an ask rule or the bridge enforces them; Face ID on Run alone would not close it. **In the Mac app, Run runs in the Terminal pane** (owner, 2026-11-18; `run_where: 'pane'`, `docs/TERMINAL-PANE.md`): the bridge consumes the Run as above and hands it to the app, never to the agent; the app writes it into the owner's login shell only with a native witness that a real click or Return reached its window within 2 s (not the press within 0.5 s of the window coming forward), so a phone- or browser-signed Run never gets there. It writes only when the shell is at its line editor (its own foreground group, bracketed paste on), else refuses after 5 s with nothing written; it first sends Ctrl+C to clear a half-typed line, then one bracketed paste and one Return, so a script is never appended to other input or typed into a running program. One pane Run at a time per shell, 10 s in all, never a write after that. A pane Run is accepted in a thread with its own session (no agent is involved). It runs without the agent's rules or cards, and a hostile page in the Mac app could run its own script right after a genuine click (accepted residual). | unit (protocol `run`; bridge `run-intent`, `run-instructions`; web `run-block`, `run-button`, `run-stale-queue`), browser (`run-button.spec`)                                                    |

## Decisions made while wiring it together

- **Unpinned sessions.** Earlier, a session could be signed in before the Mac pinned its device and could read
  everything meanwhile. Now it cannot (the pairing gate above). The only thing an unpinned session can do is finish
  pairing or sign out.
- **`voice.ask`** (archived 2026-11-19, [archived/voice.md](archived/voice.md)). Only the voice module could send it to the Mac, after matching it to a live call; the frame no longer exists and the relay refuses it as an unknown type.
- **Earlier calls and the next call** (archived with live voice). Spoken turns of an earlier call are not used to start the next call: the relay
  writes them itself and no device signed them.
- **A clock that steps backwards** (a time correction on the server) no longer stalls the rate limiters.

## Trust mode (off by default)

Trust mode is for an owner who has decided that their own words are enough. It is **off** in every fresh install and in the
public default; a config without the setting behaves exactly as before. It is switched on at the Mac with
`talos-app trust on` and off with `talos-app trust off` (`talos-app trust show` prints the state), or from the app (see below). It is stored as
`trust_mode` in `config.json`.

**Who can change it.** The owner, in two places. At the Mac: `talos-app trust on` and `talos-app trust off`. In the app:
Settings, Account, Trust mode. Turning it **off** from the app needs nothing. Turning it **on** from the app needs the passkey
step-up (`config:session`, the same mechanism as the permission relay), which the relay checks before the Mac sees the patch.
The relay asks even when its own copy of the config says trust mode is already on, because that copy can be stale: a patch
queued for a Mac that has since turned it off must not switch it on untapped. A patch that sets it to anything but true,
false or null is refused (`config_field_forbidden`). The agent can never change it: it is not on the `config_propose` list and is
named in `AGENT_CONFIG_REFUSED`, with trust mode on or off. An older relay or Mac does not know the setting and refuses the patch
in words; an older app never sends it.

**What it does not stop.** The Mac does not see the passkey tap, only the relay does, so the relay is trusted for this one
check, as it is for `work.enabled`. The agent runs as the same macOS user as the owner, and its own shell can edit
`config.json`: nothing stops that. What the bridge does instead is say so: every flip, including one made from the app or while
the bridge was down, posts a note in the default thread and tells the agent. The Mac app's web view cannot tap a passkey, so
turning it on there says to approve on the phone or in a browser; `talos-app trust on` at the Mac still works.

**What it changes when on.**

| Area                                                              | Trust mode off (and for any peer that does not know the setting)   | Trust mode on                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passkey on a card                                                 | The `risk` the agent or the bridge put on the card                 | The bridge mints `purchase` cards high and every other kind low (`mintRisk`, app cards, schedule cards). The relay and apps still obey the card's `risk`.                                                                                       |
| Passkey for work systems, the permission relay, revoking a device | Always asked (`config:work`, `config:session`, `device:revoke`)    | Skipped by a relay that has the synced `trust_mode`. An app tries without a token first and taps the passkey only if the relay still asks.                                                                                                      |
| What the agent is told                                            | A card before anything that sends, posts, deploys, pays or deletes | A card only for sending or posting as the owner, money and permanent deletes. `trust=external` is still data, and its wording is unchanged. Needs an agent restart to be read.                                                                  |
| Voice (archived)                                                  | `trust=owner_voice`: side effects need a card                      | Removed with voice input (2026-11-19, [archived/voice.md](archived/voice.md)). A spoken question on a live call is stamped `owner`, like typing. The call transcript tail stays wrapped as data.                                                |
| Schedule changes                                                  | A card for every change                                            | **Still a card for every change** (low, so a tap, no passkey). The owner taps it. See "Why schedule changes keep their card" below.                                                                                                             |
| `config_propose`                                                  | A card the owner approves                                          | A low-risk change is applied directly, behind the same "the owner asked in this thread" check; a note reports it and names the way back. A high-risk one (the table's `risk`) is still a card.                                                  |
| App tool calls                                                    | A card unless the tool is read-only and not destructive            | A card for a tool labelled destructive, one the owner listed as ask-each-time, and every other write: a view's own tap cannot be told from the view acting alone, so a write always gets its card. The approval key and label checks run first. |
| Usage governor                                                    | Starts of thread sessions stop at the "limits close" mark          | That mark only warns; the park-all mark (95 percent by default) still stops starts. The 20 agent-thread limit is lifted (the 40-thread schema limit stays).                                                                                     |

**What it does not change.** Enrolment, devices, keys, the signature on every owner message, the `trust=external` wrapping,
`permission_relay` being a signed phone change, stay as they were. A shared item or an integration
event never counts as the owner asking.

**Why schedule changes keep their card.** A job is text the agent runs later, unattended. Whether the owner "just asked" for it
cannot be known from the bridge: it sees the owner's messages and the events it delivers, but not a web page the agent
fetched or a file it read, and either can carry instructions the agent then writes into a job. A guard built on "an outside
item arrived after the owner spoke" was tried and has gaps by construction (items read through `inbox_raw` or `read_thread`,
a backlog share, a phone clock set ahead, text the agent fetched itself), so it was removed instead of patched. The card is
the check that does not depend on guessing where the text came from. `config_propose` still applies a low-risk change directly in trust mode. Those
settings are the agent name, owner name, turning quiet hours off, spoken replies, driving mode, the model list, a thread's name,
topic, icon and alert level, and a new thread; none of them runs code. Every row of the settings table has a `risk`, and a
**high** one is a card every time, trust mode or not, never applied directly (the card itself keeps the risk it always had, and a
tap on it is the approval): the app theme (the owner previews it first), the default thread,
notifications on or off, thread names in notifications, thread sessions (the master switch and a thread's own), archiving a
thread, turning a thread's alerts off, any change to the default thread's alerts, setting or moving quiet hours, and the timezone
(the relay's quiet window holds every non-system push, approval cards included, and is read in that zone). (A thread on `off` gets no push at all,
approval-card pushes included; security notices and health alarms are system pushes and still arrive.) A `mac` row (`permission_relay`, `trust_mode`, `memory_browser`, the live-voice persona) is refused whatever the mode.

**Thread agents set up by an agent** (owner ruling 2026-11-19: Main and a thread's own session may set up thread agents, the gates are opt-in and off by default). Who may set what: Main any thread, with the owner's own folder rules; a thread session (judged by the protocol's `scopeIssue`, again at apply from the scope the card carries) the low fields of its own thread, sub-threads of its own (`parent` = itself; a sub-thread makes none) and any field of those except their parent, and the instructions of those only. The fields that set a session up (its own session, folder, model, MCP list, a create carrying any) are a card while "Lock Talos settings" is on; with it off they are made at once when the one strict check every agent session meets is clean (`agent-quiet.ts`: since the owner's latest words nothing outside in any thread, no lead's hand-off, empty peer taint, the receive time of his message, not a phone's clock), the two-hour window not applying; otherwise a card. A folder must exist as a directory and is judged on the real paths at propose and again at apply (the owner's home itself, `~/.claude`, the Talos data and the agent folder refused also through a link; a thread session's sub-thread inside its parent's real path by whole segments; a parent's folder can't move away from a sub-thread that has its own folder outside the new one). An agent's AGENTS.md goes only into the target thread's own folder through the owner's no-follow, rename-over save (at most 32 KB, the old text kept as `agents-md.prev`), never with the lock on or after outside text; the owner reads what changed and how to undo it.

**Known gaps, stated plainly.**

- Money the agent files under another card kind (`generic`, `decision`) gets no passkey. The rule keys on the kind.
- A stolen phone that is unlocked and signed in can revoke devices without a passkey tap while trust mode is on.
- With the Mac offline, the relay keeps skipping the passkey for revoking a device and for config changes on the last `trust_mode` it was told, until the bridge reconnects and syncs. `talos-app trust off` does not reach the relay while the Mac cannot.
- A low card minted before trust mode was switched off stays low until it expires.
- (Archived with live voice, 2026-11-19: a spoken question counted as the owner because the relay's voice module attested it. No frame carries that any more.)
- Permission cards (Claude Code's own tool prompts) never ask for a passkey or Face ID: one tap on Allow on the card's face approves,
  in the app and from the notification (the owner's rule, 2026-11-13; since 2026-11-21 there is no scroll-to-the-end or zoom gate,
  and "Details" opens the whole call for anyone who wants it, with Allow enabled there at once). The start of the call and its
  "Ends with:" line are always on the card's face, never inside a disclosure, with or without the plain explanation (which is an
  extra sentence, and Allow does not wait for it), so a one-tap Allow is never given for a call that is not in view. Their risk is always `low`; cards that send as the owner, spend money or
  delete for good keep their own step-up. A permission card that does not show all of its call says what is missing and keeps
  Allow; only a repeated request id refuses Allow, since an answer could reach the wrong prompt.

## Settings on request (owner ruling 2026-11-14)

The owner asks his agent to change a Talos setting and it is done; he is told at once what changed and how to undo it.
"Lock Talos settings" (off by default) turns that off: the agent may turn the lock on when asked, and only the owner turns it off
(the app, or the computer). With the lock on, a change the agent proposes is a card.

- **What "he asked" means.** His own message (a row the relay accepted from one of his paired devices, `author: owner`, not a
  share) in the thread the change names, within the last two hours, with no outside text in that thread since: anything that
  reached the agent there as `trust=external` (a webhook or integration event, an app's message or tool call, a share, forwarded
  text with no note of his; `noteOutsideText`, at the one place the bridge hands the agent a notification) or a hand-off from
  that thread's lead to main. The agent's own replies do not count. Outside text elsewhere does not wipe his words
  (`apps/bridge/src/trust.ts` `ownerAskedIn`). The change is announced in that same thread. Not asked: a card, never a change.
- **What it covers.** The agent's list in the settings table (`AGENT_CONFIG_ALLOWLIST`), including the
  work section's words, the memory browser, how long attachments are kept and the theme; main's fresh conversation and park for a
  thread's session (`thread_session`); and `talos-app theme reset`, `memory init` and `lead init` run without a terminal
  (`apps/bridge/src/on-request-cli.ts`).
- **What stays the owner's.** What decides who the owner is or what is connected: devices, keys, enrollment, trust mode, the
  permission relay, the work systems themselves (`work.enabled`, `work.thread`, `work.retention`), the bug report webhook, the
  launch seal and the worker fence. None of them is on the agent's list. The one exception is the developer thread fence
  (`dev.thread_fence`, owner ruling 2026-11-15, docs/OPTION-C.md "The developer switch"): through the agent, turning it off is always a
  one-tap card (his tap is the yes; the two-hour window never turns it off), turning it on is made when he asks, and a thread
  session can never name it. Off, a thread's session gets the same access Main has, no wider (Main's deny rules and the guards'
  key and Talos-home write rules still hold); a lead keeps its own fence (the Talos home, the vault and credential folders) whatever
  it says.
- **What tells him.** Every change made this way posts "Changed X: A → B. To undo: …" in the thread he asked in. A change to
  which alerts reach him (notifications, quiet hours, a thread's alerts, the default thread) is also pushed as
  `settings_changed`, through the quiet window, the master switch and thread alerts.
- **One change an undo cannot fully take back, said plainly.** Shorter attachment keeping goes through the hour's hold that
  every change of it gets: the change line says how many files the hour will remove, when, and that undoing before then
  removes nothing. Archiving a thread keeps its saved copies of the owner's files: they are removed only when the thread leaves
  the config, otherwise they age out with the normal pruning (7 days, 1 GiB a thread), and un-archiving gets them back. Until
  pruning removes them, archived copies stay readable by thread sessions, as any inbox is.
- **The lock itself.** The agent may only propose `true` for it. Its shell could still edit config.json, so, like trust mode,
  every change of the lock is told to the owner in the default thread, whatever made it (`noteLockFlip`). The lock holds for
  `theme reset`, `memory init` and `lead init` with or without a terminal (a terminal can be faked). The app offers the switch
  only to a bridge that announces `settings-lock/1`.
- **Same-user limits.** The agent runs as the owner: its shell could edit config.json (the lock flip is told), insert an
  `author: owner` row into history.sqlite to forge "he asked", or point the CLI at another `TALOS_APP_HOME`. These rules are
  for an agent misled by what it reads, not one that sets out to get past them; the undo line and the flip notice are what the
  owner sees either way.
- **What it does not see.** Text the agent read for itself (a web page, a file) inside the window. That text reaches the agent
  wrapped as data, and the undo line is the backstop: a wrong change he sees and undoes in one tap is the accepted failure, a
  refused right one is not.
- **Open.** "Lock off" now means for settings what trust mode meant; trust mode retires once the passkey step-up leaves cards.

## An agent in Talos (owner ruling 2026-11-17)

Talos.app can be put on the screen-control allowed list like any app (same consent card, same signature-bound entry), so an agent
can look at, click and type in Talos's own window: open a thread, write, send. Two things are closed and have no switch:

1. **Input an agent sends never answers an approval card or a permission prompt.** That covers Approve, Deny, Kill, Revise, Always
   allow, a dialog card's options, the needs-you popup, a sheet, an alert and any button that answers one, by click, by Return or
   Space on a focused button, and by text that holds a Return or a space.
2. **Input an agent sends never reaches a terminal view in Talos.** Every terminal in the app is one view class (`SafeTerminalView`,
   a SwiftTerm `TerminalView`): the agent's own pane (the embedded terminal and the Terminals window), the owner's login shell
   (`OwnerShellPane`) and the sign-in pane. Each runs what it reads: Claude Code's on-pane prompts (trust a folder, dev channels,
   tool prompts left at the terminal), commands as the owner, the pin confirm `y`. Agents reach their own panes through their own
   tools, so screen-typing into a Talos terminal adds nothing legitimate. `docs/TERMINAL-PANE.md` ("No remote path to the shell")
   stays true: no screen tool is a path to the shell either.

How it holds (`SyntheticInput`, `ProtectedInputScript`, `SyntheticInputGuard`):

- **Origin of every event.** Every event Talos posts for an agent carries a token in its CGEvent user data, and the system stamps it
  with Talos's own pid. An event counts as the owner's only with none of that: a CGEvent from the hardware state, source pid 0, user
  data 0, and no event of ours still awaiting its answer. An event with no CGEvent, or any field that cannot be read, is synthetic
  (fail closed).
- **Terminals.** A local event monitor drops a synthetic mouse or key event whose target is a terminal view (the first responder for
  a key, the view under the pointer for a mouse event). `TerminalNSWindow` and `WebNSWindow` (the only windows that hold terminal
  views) drop it again in `sendEvent`, and `SafeTerminalView` refuses the mouse events itself (SwiftTerm's key handlers cannot be
  overridden from outside its module, so keys are held at the window).
- **The page.** Before the window delivers a mouse press or key to its page, it tells the page who sent it (origin, event type, the
  token, the key code). A script the app injects (its own content world; page code cannot see or forge it) cancels, ahead of every
  handler, a click, an Enter or Space, a pointer press or a submit inside any `data-talos-protected` element unless the newest stamp
  is a fresh human one that goes with this event: a pointer click needs a human mouse release; a keyboard-made click needs a human key
  press or release whose Enter or Space the page has just seen as a key event; a key event needs a human stamp of its own phase and
  key code. A human stamp is spent by the click it allowed, and a key stamp ends with its event's turn, so a click with no event
  before it (an Accessibility press) is refused whatever stamps are fresh. To protect more elements, add the one attribute
  (`data-talos-protected`); the one selector is `PROTECTED` in `ProtectedInputScript.swift`. The owner decided on 2026-11-17 to keep
  this as narrow as possible: only answers to cards and permission prompts, and the terminal panes, are protected. Trust mode, the
  Always-allowed list, Settings and the composer stay open to an agent driving Talos, so agents can test the whole interface. A
  message an agent types in the composer is sent as the owner's, like any other input on his Mac.
- **Native prompts.** The needs-you popup's own check (pid 0, hardware state) also refuses while an event of ours is awaiting its
  answer; the monitor drops a synthetic event aimed at a sheet, an alert, the popup or any window while a modal session runs.
- **The agent is told, per request.** Each posted event has its own token. The screen tool aims at Talos only when the gate found
  Talos (the front app, or the app under the pointer) and then waits, up to two seconds, for the answers of its own tokens: the
  window that took the event says "handled", or reports a drop against the token. A drop is `protected_prompt`; no answer in time is
  `delivery_unverified` ("may or may not have landed"); never "sent" on a guess. For the page, the answer is asked for after the
  event was delivered and arrives after every drop the page reported for that token. Two callers at once never read each other's
  answers (tokens are unique). An event aimed at another app waits for nothing.
- **A sign-in link is never in a screenshot.** While the sign-in tab is open, the Terminals window shows the setup link and the four
  words. It is registered as a secret window (`ScreenSecretWindows`): `ScreenCore` makes it a gap in every agent screenshot, even
  though Talos is allowed, and refuses it by id; macOS is also asked to keep it out of captures (`sharingType = .none`). The
  window's id is registered when the tab opens and again when the window is shown.

Race analysis. (1) A card that appears between the agent's look and its click: nothing is checked at look time; the check is on the
event at delivery, so a card that is there when the event lands is protected. (2) A person's click and an agent's event arriving
together: both are stamped in the order the window dispatches them and the page keeps only the newest stamp, so the agent's event
never rides the person's; the person's click while one of ours awaits its answer is refused (one more click), and that lasts until
the answer or the request's own timeout, not a fixed span. (3) A stamp that never arrives: the page holds no fresh stamp for that
event, and refuses it. (4) The stamp and the event go to the web process over one connection in the order sent; the stamp lapses
after 700 ms. (5) A late drop: the request waits for its own tokens' answers, so a drop reported a moment late is still its refusal,
and a missing answer is `delivery_unverified`.

What this does not close: a program running as the owner that is not the agent can move the pointer so the owner's own click lands
on a button, as the popup's comment says. VoiceOver, Voice Control and remote-desktop events carry another pid (or no token) and are
refused like the agent's, so on a Mac driven that way an approval is answered on the phone and a terminal is typed into by a person
at the keyboard. Settings switches and other buttons that are not approvals are not protected (open owner question, above).
Whether the system keeps the token in a posted event's user data all the way to the window is checked by a real run
(`.claude/skills/verify`, Mac app route); if it did not, requests aimed at Talos would end `delivery_unverified`, never success.

## No step-up, and Always allow (owner ruling 2026-11-14)

"There should be zero Face ID approvals. End of story." Only sign-in keeps the passkey; adding a device keeps its one confirm.
Every card and setting is approved by the owner's signed tap: high-risk cards (a label: wording, and never approved from the
lock screen), schedule cards, undo, purchases, the permission relay, work integrations, the bug report address, trust mode and
device revoke (which keeps its confirm sheet). The step-up path is deleted, not bypassed: no `/api/auth/stepup/*` routes, no
tokens, no checks in the relay or the bridge. Sessions last 90 days unused.

**Always allow.** An action card offers Always allow beside Allow and Deny (owner, 2026-11-21: while in development, the fewer
approvals the better). Exactly which cards get it, and which pass without a card afterwards:
- **Send kinds** (email, message, deploy, push, publish, purchase): yes, high risk or not; the app needs a bridge that says
  `always-allow/1`.
- **Generic**: yes (an approval card the agent makes; one with `talos-app` commands on it never).
- **Schedule: low-risk cards only.** A schedule grant covers low-risk schedule changes (a rename, a time move, switching a job off, a
  narrower tool list). A high-risk one (a job created or turned on, a new prompt, model or runner, full permissions, an extra allowed
  tool, memory on) still gets a card and the app hides Always allow on it; the bridge re-checks that when the agent proposes it. The
  grant is judged on the change's own risk (`own_risk` in the card's bound payload, written by the bridge), not the card's: trust
  mode mints every schedule card low, and must not let a high-risk schedule through. A card without `own_risk` reads as high.
- **Undo: not when it would delete files, and not when Talos can't tell whether the session is working.** Those stay cards (the
  Delete box and the stop-first note are his to read). A passed undo is applied as his tap would be and the result is a line in the
  thread; no card was shown, so the app is sent no card and no card id. The request's result ("Undoing now") goes out before the restore
  runs and is recorded then, so a replayed request after a restart starts no second restore; a restart mid-restore is told in the thread
  (the ledger row's `by: always_allow` says the card was never shown).
- **Settings (`config`): ordinary settings only**, listed below.
- **Never:** a question card (`decision`, `dialog`: they keep their content on the card), a permission card (a rule for those waits
  for Claude Code to suggest one: phase 2), an `app_action` card (an app's request), and a card the bridge
  refuses from a notification (one with `talos-app` commands, a permission-mode change, an offer to send a turn again, a screen-access
  card): those show one-tap Allow but no Always allow, and the bridge refuses `always: true` on them before anything moves.
  The newer kinds (generic, schedule, undo, settings) need a bridge that says `always-allow/2`; an older one that says only /1 gets the
  send kinds. Always allow is per card kind, stored in config.json (`always_allow`), listed in Settings with Remove.
- **Settings cards are restricted.** A settings grant lets a later settings change through with no card only when every setting it
  changes is an ordinary one. `CONFIG_TRUST_KEYS` (protocol `config-propose.ts`) lists what never passes and never shows the
  button: `always_allow` itself, `settings_lock`, `dev.thread_fence` and every thread field (`threads.<id>.*`, a thread's own
  session, folder and MCP list included). Also never (`CONFIG_NEVER_PASS`): turning the memory browser on, turning the notes lookup
  (`dev.note_lookup`) on, and keeping attachments for fewer days (`media_keep_days`; it deletes files an hour later). A row the settings
  table marks high, a row that its value or the config makes high (quiet hours set: the bridge judges each change on the current
  config with `riskOfChange`; the app has no config and refuses any change to such a row), a high-risk card, a card with a change that
  cannot be read, and a settings change while "Lock Talos settings" is on are cards too. Guards, the permission mode and the card-run
  commands are not settings keys at all (guards are files made by `install-guards`, the permission mode has its own consent card,
  the command list is code), so a settings card cannot change them. The bridge refuses `always: true` on such a card and adds nothing.
- **Who can add one.** Only the owner's signed tap: `always: true` inside the signed `card.resolve` (a relay or anyone in
  between cannot add it without breaking the signature), on the primary button of a card of that kind that offers it,
  in the app (never a notification's Approve), after the ledger checks; or, through config_propose, his tap on a one-tap card
  whose button is "Always allow <kind>": an ADD is always that card, even when he asked and the lock is off, so the two-hour
  "he asked" window can never lead to a send or a payment as him. That card is high risk, so it is approved on the card in the
  app (where its button and body name the kinds), never from a notification. A REMOVAL he asks for is made at once. A share, an
  integration event, a hand-off or the agent's own call cannot add one (`apps/bridge/test/always-allow.test.ts`).
- **What it does.** The agent's `card` call for an always-allowed kind, read from config at that moment, is approved with no
  card (a low-risk schedule card or a delete-nothing undo card the bridge makes is applied as his tap would be, and a settings change is made at once, as an
  asked-for one is); the thread gets "Allowed without a card (you always allow emails): <title>. To stop: Settings → Always allowed, or tell
  me to stop." as a silent line (no notification, since 2026-11-15; `apps/bridge/test/always-allow-notices.test.ts`). The first pass in a
  10-minute stretch per thread gets its line at once; later ones are held and come as one counted line when the stretch ends (a
  line cannot be edited). Each pass is also recorded on its own (what ran, rule, kind, thread, time) in the bridge's history store and at warn level, and the counted line lists up to 5 of the commands it covers.
- **The accepted risk.** With a kind always allowed, the agent sends that kind on its own judgement, also from text it read
  (a heartbeat, an inbox item). The receipt line and its push are how the owner sees each one; Remove stops the next.

## The agent as the attacker

**The honest frame.** The agent runs as the same macOS user as the owner. Anything the owner can do in a shell, an agent
that is set on it can do. The terminal check and the guards below are a speed bump against an agent that is careless or
has been misled by a message it read; they are not a boundary against one that is determined to get through. The tripwire is
the backstop: it cannot stop a change, it tells the owner about one.

- **The Railway token (`talos-app relay connect`).** To redeploy an online relay by itself the bridge can keep one Railway token: a project
  token (reads that project's settings and nothing else) or, if the owner insists and types `yes`, an account or workspace token (can
  change every project in the Railway account). It is asked for hidden in a terminal (`relay connect` is terminal-only, refused to an
  agent and denied by the guards; a token on the command line is refused), kept in the key store under a name of its own per Talos home,
  and written to no file, log, row or output; `relay-connect.json` holds ids and names only (tested). The one module that talks to Railway
  (`apps/bridge/src/relay/railway.ts`, the fixed endpoint, the token in one header) has a closed list of operations: one mutation, the
  service's redeploy, and a few read-only questions; a test fails on any other operation or any other file that names the endpoint.
  `relay update`, `relay auto on` and `relay disconnect` follow the `peer link` gate (the lock, outside text); `relay auto off` is
  always allowed. Railway's address (and the releases list's) is fixed in code: no environment variable or file changes it, only a seam test code sets, since whoever picks that address receives the token. The guards keep a session from reading or writing anything in `secrets/` (the secret store's files on a computer with no keyring), from writing `relay-connect.json` and `relay-auto.json` (read-only) (by a path, or by a bare or relative name resolved from the folder the command runs in) and from naming `relay-redeploy-request.json` and `-result.json` at all; a thread row never carries the Mac app's free error text, only the fixed line for its code. A relay the Mac app set up never gives the bridge a
  token: the app redeploys and answers through a result file (docs/deploy-railway.md).
- **Terminal check.** `enroll`, `rotate`, `trust on` and `relay connect` (it keeps a Railway token) refuse when stdin or stdout is not a
  terminal: what decides who the owner is (owner ruling 2026-11-14 keeps these until he decides on adding devices). `devices`, `peer` and `sandbox`
  are the agent's own unless "Lock Talos settings" is on (owner ruling 2026-11-19, `agent-cli.ts`; `sandbox on|off|status` is the OS sandbox switch below, and `sandbox off` is also held to the outside-text check): `peer link|accept|create|add|list|remove|rotate|secret-forget`
  and `devices list|revoke` run from a session with no terminal, and refuse with the one lock sentence while the lock is on; a terminal runs
  as it always did, lock on or off (the desktop app's Revoke-this-device runs the CLI under a pty, and enroll and the bridge-key rotate are
  terminal-reachable already). From a session (main or a thread's own: one rule, and the session name is only for the audit line) `peer link`, `peer accept`,
  `peer create`, `peer add`, `peer rotate` and `devices revoke` are also refused while, since the owner's latest words in any thread (counted from when the bridge received them, never the phone's clock), outside text
  reached any thread (one that has left config.json too), any lead handed main anything (a hand-off is the agent's own words, so it sets no outside text), or the peer taint
  stands; with history.sqlite missing or unreadable they are refused too. `devices revoke` never takes
  the last approved device or the one his latest message came from (the bridge keeps that device id, kv `last_owner_device`, from his
  signed messages). **A card can carry commands Talos runs on the owner's tap** (`apps/bridge/src/card-cli.ts`). There is no permission for the agent here: the agent never runs these commands and no stored grant exists. The agent's `card` tool takes an optional `cli`, a list of commands, each a list of words (for example `peer remove work`, then `peer list`). Only `peer accept`, `peer list`, `peer remove`, `peer secret-forget`, `devices list` and `devices revoke` can be named (the allowlist, `CARD_CLI_ALLOWED`). **No command that makes a one-time code or a secret runs from a card:** `peer link` (a one-time code), `peer create` and `peer rotate` (a secret) and `peer add` (it needs a secret file, which a card may not name) are refused when the card is made, with "talos-app peer link makes a one-time code, so it can't run from a card yet. Run it in Terminal." The reason: a card's result is copied by the web app into IndexedDB and localStorage, by the Mac app's web view into its data store, and by the relay into its log, and a card cannot yet keep a code out of those, so a code never goes on one. Anything else is refused too (`relay update`, `enroll`, `rotate`, `trust on`, an unknown word), and so is any word that names a file or folder (`--secret-file`, a path, a `file:` link). The plain words are written from what each command was parsed to mean (the name, the host a link code points at, a daily cap), using the same options the CLI reads; an option the sentence writer does not know, a bad cap, a missing part or a stray word is refused when the card is made. The bridge writes three read-only fields onto the card from those words: "What will happen" in plain words (for example "1. Removes the link to work."), "Details" with the exact commands, and "Commands check", the hash of the commands. All three are inside the payload hash the owner approves, and an agent-written field with one of those keys, or (on a card with commands) one of those labels, is refused. The web card shows "Details" as an ordinary field for now; a collapsible Details is a web change still to do. For `devices revoke <id>` the bridge looks the id up when the card is made and writes "Removes access for <device name> (added <date>)" into the plain words; an unknown or already revoked id is refused. A card with `peer accept` or `devices revoke` is always high risk, and a card with commands is made with editing off (`allow_edit` true or an editable field is refused). A notification tap on such a card is refused (open it in the app), and a replay is refused by the ledger. When the owner's signed `card.resolve` with the primary button arrives in the app, the BRIDGE runs each command itself, in its own process through the same CLI code with the owner's authority, in order, once each, stopping at the first one that fails, as the bridge itself (the thread-session fence by folder marker does not apply to it), with the agent profile of the CLI (nothing is printed or read as a secret), in a fresh 0700 folder (`talos-cardcli-*` in the temp folder) that is removed afterwards. Before running it checks that the stored card still hashes to what he approved (a card changed in the ledger afterwards runs nothing), that the commands, the plain words and the check code still agree, and that his tap is no more than ten minutes old (the ledger refuses an older tap too). The lock is read before every command and refuses it; `devices revoke` still never takes the last approved device or the one his latest message came from; a command that needs something typed fails instead of waiting. The thread gets only a short summary from Talos ("Ran 2 commands."); what the commands printed is in the card's own result in the app. Both are redacted for anything that looks like a link code or secret, as a second line of defence. Kill and Ask for changes run nothing and reach the agent as for any card; a bridge that stops mid-run ends the card as "may have run". The agent is not told to run anything and has no command, tool or file that starts a run: a session's own `talos-app peer link` is judged exactly as before (the lock, outside text, the peer taint). A `peer` or `devices` word that is not a command (`peer unlink`) is answered as that, with the nearest real command, not as "only runs in Terminal". A peer secret never appears in command output (stdout, stderr, the audit line, a row): `peer create` and `peer rotate` write it to `peer-secrets/<name>.secret`, and an agent run gets it only in that 0600 file
  (0600, folder 0700, never through a symlink), `peer add --secret-file` reads such a file (a regular file of the current user, 0600
  or stricter) and deletes it after storing the secret, and the bridge deletes the creator's copy when the first message of that connection
  arrives (after a rotate: the first message after the old secret's 24 hours, recorded in `peers-inbound.json`). Every session run writes an `agent cli` line in bridge.log (session, command, target, allowed or refused); the bridge posts a
  silent row in the default thread for each change it sees (peer added, removed or changed, inbox made, removed or replaced, an agent rotate, device revoked). With the guards
  installed their deny rules still keep a session from running `talos-app peer` and `talos-app devices` at all: the opt-in lock. A faked terminal (`script`) skips the lock and every agent check above (a terminal returns before them), so against a faked terminal only the guards (`install-guards`) hold. A keychain-wide key store (the macOS Keychain, the Secret Service) keys an item by name for the whole account, so the bridge keeps every peer secret under `com.talos.app.peer.<h>`, h being the first 16 hex of SHA-256 of the real path of the Talos home (`apps/bridge/src/secrets/home-scope.ts`): two homes on one account never share or overwrite a secret, and an agent may link from any home. A secret kept before this under the plain name is moved (written only if the home's own item is still missing, read back, then deleted) only by the account's default home (`~/.config/talos/app` of the password-database home, compared by real path); every other home never moves or deletes it, even when no default home exists yet. A home that is not the default may only COPY it (`apps/bridge/src/peer/secret-store.ts`): for a peer name that its own `config.json` lists, written to its own item only if still missing and read back, leaving the plain item untouched. The two homes' secrets cannot be told apart, so the copy is marked (`peer-copied.json`: name and time, never the secret) and a send the other side rejects with 401 or 403 says the link needs re-linking; the relink line is said once per peer, and the mark goes when the peer is linked again, removed, or a send to it lands. A home made up by any program of this user (for example with `TALOS_APP_HOME` and a config that names a peer) can copy a legacy peer secret; that gives it nothing new, because that user's programs can read the legacy item anyway, and the copy exists so a real second home keeps working. Moving or renaming a Talos home folder changes its name, so its key-store items are orphaned and the peers must be re-linked. The per-home file store is already per home. Everything
  else a person could ask the agent to do, it may (the kit's update, rollback and restore, adopt, apps scan, install-ask-rules,
  install-guards, supervise start and stop among them); `internal` rows (hook, start, supervise, guards refresh) are run by
  Talos itself, which nothing enforces. One thing stays the owner's inside `supervise start`: while his own Stop stands, a start
  from a session (no terminal, or one inside Claude Code: a faked one) needs his recent words in a thread; the owner at a real
  terminal starts it as before. Off a real terminal (or inside Claude
  Code) the kit's update, rollback and restore work only on the installed kit: `--vendor`, TALOS_KIT_HOME, TALOS_VENDOR_DIR, a
  moved XDG_DATA_HOME, or a HOME that is not the account's own (the passwd entry), which would let a caller bring its own signer,
  are refused (in `talos` and in the updater). `install-guards --remove` stays at a terminal: the agent may turn the guards on,
  never off. Adding a release signer
  (`talos-update trust-key`) keeps its own terminal check. The table in `apps/bridge/src/talos.ts` (`needs_terminal`, `who`) is
  the one list. There is no setting or
  environment variable that turns the check off. `trust off` and `trust show` stay open. This stops an agent that pipes `y` into
  a command. It does not stop one that makes a terminal (`script`, a pty from Python, `expect`).
- **One-paste link code** (`talos-app peer link` / `peer accept`, docs/LINKED-AGENTS.md). The code is a bearer credential: single use, 15 minutes, only its
  SHA-256 kept on the relay (compared in constant time), and the other install's address and secret are stored encrypted until the Mac collects them once.
  Redeeming needs no signature, so it is rate limited per client address before anything is read, every failure (unknown, expired, used, wrong
  token) is charged to the failed-verify bucket and answered with the same 404 `link_unusable`, and the relay log says which without the token. The
  code never reaches bridge.log or the audit line, is redacted from a peer message, a report, a log tail and the text sealed into a phone push, and `peer accept` reaches only
  the host in the code (https, a plain DNS name, port 443, no redirects, no private address). A link code pasted from anywhere but the owner links to whoever made it, so
  only the since-owner gate stops it: `peer accept` and `peer link` are refused while outside text reached any thread since his latest words.
- **Main's development-channel warning.** The Mac popup answers only a real click from the mouse or trackpad: a press by
  Accessibility or AppleScript sends no mouse event, and a click another program posts (cliclick, a computer-use tool) carries
  that program's process id, so neither counts. Only that click seals the start command. A phone answer to the card starts this
  launch once and seals nothing: the Mac checks it against `devices.json`, which a program running as you can also write, so it
  is no stronger than an Enter in the pane. It does not stop a program that moves the pointer onto the button so your own
  next click lands there. The confirmed start command is sealed with a key in the Keychain, which stops a
  program that only edits `desktop.json`. It does not stop one set on forging it: Apple's `security` tool can overwrite the key
  with one it knows, with no prompt, and then seal a changed start itself. Closing that needs the key in the protected Keychain,
  which needs a build signed by an Apple developer team, or a helper that runs as root (installed once with an admin
  password). An agent with tmux can also press Enter on the warning itself.
- **The permission-mode request file.** `permission_mode` lets Main change its own permission mode when the owner asked, through
  `permission-mode-request.json` in the Talos home, which only the bridge writes (the guards deny the agent a write) and the Mac
  app reads. A looser mode (Auto, Bypass all) is made straight away only on the owner's own words in the named thread with
  nothing from outside since in any thread and no lead's hand-off (the quiet test `config_propose` uses to open the thread
  fence); otherwise the owner gets a card naming the mode and only his signed Allow in the app writes the file (a notification
  tap is refused). "Lock Talos settings" refuses every change, at the tool, at his Allow and again on the Mac. The file does not
  say who wrote it, and any program running as the owner can write one. The Mac acts on a well-formed fresh request only while
  Lock is off, tells the phone "The agent asked to switch ..." (never "as you asked"), and Main does not run in the new mode until
  the owner confirms the development-channel dialog at the Mac or on the phone card (the launch seal), because the changed
  launch is a cold start.
- **The restart request file.** The Mac app acts on `agent-request.json` in the Talos home folder, which the bridge writes
  when the owner taps "Restart agent" on the phone, or when a session calls `restart_main`. It is restart only: restore is not
  a phone action, it stays in the Mac menu and Terminal. The agent runs as the same user and can write that file too. So the
  app checks the owner's signature itself: the phone's request carries the owner's own signed `agent.recover` (the device, the
  signature and the exact bytes it signed), and the app restarts as the owner asked only when that proof checks out against
  `devices.json` (a device paired and not revoked, its signature over those bytes, exactly one `agent.recover` with action
  `restart` for this very request, signed within the last five minutes and after the app started, and not spent; the dialog
  answers' own key lookup and used-proof store). It stops a forged owner request from anything without a paired phone's key; it is not a wall, devices.json is
  writable by anything running as you (the bridge's tripwire reports a change to it afterwards).
  On Linux the supervisor checks it the same way (`apps/bridge/src/supervisor/restart-proof.ts`), with two Linux limits: the
  owner's signed tap may be dated up to 2 minutes ahead of the computer's clock (as on the Mac: phone clocks drift), and the
  proofs already used and the newest signed time are kept twice (`restart-proofs-used.json`, `restart-proof-mark.json` and the
  actor's own `restart-actor.json`, all denied to sessions by the guards). What that leaves: code running past the guards that
  deletes all three files and restarts the supervisor can have one used tap taken once more, within the 5 minutes after it was
  signed and only if it was signed up to 2 minutes ahead of the restarted supervisor's start; and a `restart-actor.json` that does
  not read holds a session's requests as if a restart had just happened with the hourly cap reached (the owner's tap is not held). On an unmanaged install the owner's proof separates the owner from an AGENT ACTING
  THROUGH THE GUARDS, not from arbitrary code running as the same user: such code can pin its own key in `devices.json` and sign
  as the owner, the same as on the Mac. The signed frame names no machine either, so one tap could be replayed to another
  machine of the owner's within its five minutes (a protocol change for the phone, on the roadmap). The real
  boundary comes with root-owned files on a managed install (the P3c2 design note). Every other request (no
  proof, a session's `restart_main`, or the phone's own button through a bridge that has not restarted since this change) is
  an agent's: the app re-checks whether Main would come back by itself and refuses on a no, so a session can make the app
  restart the agent only when it would come back without you, at most once every two minutes. A request whose proof is
  there and fails is refused and logged (`restart_proof_bad`, with the check that failed), and the phone is told once:
  "a restart request that claimed to be yours did not verify". A proof that is real but signed outside that time, or earlier
  than one already accepted (a phone clock that is off), or in a form this version does not know, goes the agent's way, and
  the phone is told which. A proof is spent the moment its request
  is decided, restarted or refused: the app remembers the newest 64 spent proofs and the newest signed time it accepted for
  as long as it runs (written to files in the Talos home too, which only seed the next run), and never takes a proof signed
  before it started, so deleting those files and relaunching the app frees no old proof. What the app also checks: the exact format (`v` is 1, the
  action is `restart`, `control_id` is 1 to 64 of letters, digits, `_` and `-`, `ts` is a number; a link, a non-regular file
  or one over 4 KB is ignored), a `ts` older than five minutes, more than a minute ahead, or earlier than the app's own
  launch is ignored (the owner's Stop is not remembered across a launch, so a request written while the app was closed must
  not start the agent over it), each `control_id` is acted on once and at most one request per two minutes (a rogue file
  that writes a new id every tick cannot loop restarts), nothing from the file reaches a shell, an argument or a path, and
  only the copy of the app that holds the session lock acts. A file that fails the check is deleted; so is a request once
  acted on (only if it still holds the `control_id` that was read, so a newer one is kept). Every restart it makes shows a
  line in the menu: "Restarted the agent: asked from your phone" (the press-Enter line of the new start can replace it at
  once; the log always has it), and a request refused for being too soon shows "Ignored a restart request: one was acted on
  less than 2 minutes ago", except while the menu says Talos needs you at the Mac (then it is only in the log). A restart a
  session asked for is also posted to the phone. If you see one you did not ask for, the agent (or something running as you)
  wrote the file.
- **The automatic restore.** When the agent crash-loops, or the bridge has been down five minutes (counted only while the Mac
  is awake, and only after the bridge was seen up in this start), the Mac app runs `talos-app restore-last-good --yes
  --newest-start` once, then restarts the agent; the latch resets after ten healthy minutes. It takes `talos-app` from
  `talos_app_command` in `desktop.json` or the login PATH, never from the agent folder's `.mcp.json` (the agent can write that
  file). `desktop.json` is writable by anything running as you. Only the confirmed launch is sealed; the other settings,
  `talos_app_command` and `relay_url` among them, take effect at the app's next launch.
  What it writes comes from `$TALOS_APP_HOME/last-good`, which the agent can write too, into `.mcp.json` and the `.claude`
  settings files of the agent folder the version was saved from. It writes through a symlink that is already there, so a
  setup file that is a link is written at its target (outside the agent folder, if the owner linked it there); with `--yes`
  nobody is asked, and the warning line it prints goes to output the app does not show. It moves aside a setup file the
  version does not have. It saves what it replaces as a backup version first, but that is a copy in the same folder, and nothing in the app undoes the restore. An agent that can
  crash its own session, or stop the bridge, can therefore cause one such restore per ten healthy minutes. The menu line says
  which files it wrote and the date of the version, taken from one fixed output line of the command and shown only if it
  matches exactly. The same line is posted to the default thread on the phone (also when the restore failed, but not when the owner's `talos-app` was not found; not when it
  changed nothing), built from that parsed result only, so text the agent planted in the output never reaches the phone.
  The phone gets no answer to its Restart tap: a result file would be one more file the agent can write, so it could
  forge the answer. The phone says "sent to your Mac" and that the app decides. The menu shows a line for a restart (which the press-Enter line of the new start can replace), and for a request refused because you stopped the agent. It shows none for a malformed or repeated `control_id` request, one older than five minutes or dated ahead, one dated before the app launched (written while it was not running), or a too-soon one while the menu says Talos needs you at the Mac. The log has every one of them.
- **Guards (opt-in).** `talos-app install-guards` writes a PreToolUse hook and permission deny rules under the Talos home
  folder, outside the agent folder. The hook and its rules file are tied by a hash written at install; if `guards.json` is
  edited, emptied or removed, every tool call is blocked until the owner runs `install-guards` again (it fails closed, it never
  loosens). The Mac app refreshes installed guards at each start of Main (`talos-app guards refresh`, below), so a new release's rules
  and a bun upgrade reach Main without another `install-guards`; a refresh that fails is said in the audit log and once on the
  phone, and Main starts under the guards as they were. The rules live in a file named by their hash (`guards-<sha>.json`), written
  in full before the settings that name it and never written over; an old one is removed only once no session's settings have named
  it for ten minutes (each settings file parsed for its hook's `--config`; one that cannot be parsed stops all removal), so a session
  still running on the old hook, or one starting just as a refresh switches the rules, keeps checking its own rules. Every way the Mac app or `talos-app start` launches the agent adds the guards when they are installed: the main
  session, thread sessions and workers, the terminal's "open claude here", and `talos-app start`. They deny writes to the files
  in `docs/protected-paths.txt`, the running checkout, the guard files themselves (`guards/`, `tripwire.json`,
  `tripwire.writing`), `last-good/` (the saved setup versions that `restore-last-good` puts back; writes only, reading and
  `restore-last-good --list` stay open), `enroll-pending/` (any spelling, wildcards included, matched on the name's stem), `devices.json` and
  `config.json` (write redirections; reading is allowed), `claude plugin`, `~/.claude/plugins`, `~/.claude/dev-mods`,
  and a shell line that runs a human-only command (also through `sudo`, `bash -c`, `$(...)`) or
  fakes a terminal for one. (`action-rules.py approve` is no longer on it: with the Talos app it approves nothing itself, see "The kit's ask rules" below.) Paths are compared after `~`, `$HOME` and `${HOME}` are written out and `..`, symlinks and
  `/private/tmp` style aliases are resolved, without regard to case.
- **The kit's ask rules: the owner's tap is the approval (audit item 28, 2026-11-15).** An "ask first" rule of
  `kit/hooks/action-rules.py` (push to main, deploy, publish, a send through a connector, your own) is approved, with the Talos
  app, only by the owner's signed tap on an "Allow once" card that shows the exact call (`apps/bridge/src/action-rule-asks.ts`).
  `approve` asks the bridge over the hub socket for that card and waits; the approval is held in the bridge's memory, never in a
  file, and the PreToolUse check asks the bridge for it (`rule_take`) and uses it up. It is bound to who asked (main, or a
  thread session that proved itself as for a permission card), the rule, the tool and the exact call (a Bash command and its
  folder; any other tool's whole input, its description aside): a different command asks again. The hook talks only to the
  process named in bridge.pid (peer pid), so a stand-in listener never sees the call. A starter rule of a send kind
  (`kind:` in the shipped table; `send` means email for a mail tool, else message; making a repository public, deleting one and
  switching GitHub accounts have none, so they are a card every time) gives a high-risk card, approved in the app only, with "Always allow
  <kind>" as on the agent's own send cards; a kind the owner always allows is approved at once with a line in the thread. The KIND is the bridge's call, never the
  asker's (review, 2026-11-15): the hub line carries no kind; the bridge keeps its own copy of the shipped rules that have one
  (`SHIPPED_ASK_RULES`: every shipped ask rule, in order, with its kind or none; a test keeps it equal to the yaml) and gives a
  kind only when the named rule is one of those with a kind, it matches the call, and EVERY shipped ask rule that matches the
  call has that same kind. The hook stops at the first rule that matches, so `git push origin main && gh repo delete x` is
  named push-to-main; with pushes always allowed it is still a card, because the delete rule (no kind) matches too. A git push to main is its own kind, `push` (it was `deploy`); a grant for `deploy` still covers it, a grant for `push` never covers a deploy, and a push chained with a deploy counts as the deploy (`apps/bridge/test/action-rule-asks.test.ts`). Kinds are
  read from the command alone, never the folder (a folder named `a;git push origin main` makes nothing a push); the folder stays
  in the key. The no-kind rules are also listed first in the yaml. A session naming `push-to-main` for another command, or its
  own rule, gets a card. The
  kind is in the approval's key. The owner's rules file (`~/.config/talos/action-rules.yaml`) is read first by the hook and a
  session can edit it (re-kind a rule, drop one, add an `allow`): that is the same-user class below, and the bridge never reads
  kinds from it. A Bash call is bound by every field but its description and time limit, so `dangerouslyDisableSandbox` is
  part of what was approved. A
  restart, an expired card, a Deny, no bridge: no approval, and the call keeps asking. With the app, an approval file in the
  kit's state folder counts for nothing; "the app is here" is judged at the account's home from the password database (or
  `TALOS_APP_HOME` in the hook's own environment), and a HOME moved off it gets no file approvals either. Without the app the
  file approval works as before (honour-system, the native prompt is the live path). Same-user limits as above: the agent's
  shell could stop the bridge and listen in its place with a forged bridge.pid, or delete the app's config.json to look like a
  kit on its own; both break the app the owner is using, and neither is a way an agent misled by what it reads would go.
- **Saved setup versions (`last-good`).** The deny rule above blocks the common ways the agent's tools write to `last-good/`
  (the Write and Edit tools, redirections, `tee`, `cp`, `mv`, `rm`, `sed -i`, `rsync` and the like, when the command names the folder), but not every spelling: `unlink`,
  `mkdir`, `touch`, `find -delete`, `tar` or `unzip` extraction, relative paths and interpreters can still get through. The agent runs as the
  same macOS user that owns the files, so the saved versions are not protected from a determined agent, and nothing on disk
  is a boundary against it. What protects you is that a restore shows the owner what it will change before it writes, keeps a
  backup of the files it replaces (so a restore can be undone with `--version`), and picks only versions the bridge saved
  after a healthy start unless you name a pre-restore backup by number. Any restore the agent asks for goes through the owner:
  `restore-last-good` has an ask rule, so it waits for you. A restore that writes through a symlink
  to a file outside the agent folder (dotfiles are still allowed) prints a warning line even with `--yes`. Guards installed
  before this change do not list `last-good/`; run `talos-app install-guards` again.
- **Tripwire.** The bridge hashes `devices.json` and the security fields of `config.json` (trust mode,
  permission relay, Option C, enabled work sources), field by field, and keeps what it saw in memory as well as in
  `tripwire.json`. A change the CLI or bridge did not record puts one line in the Inbox that names the fields that changed
  (never their values). Any change to the set of pinned devices (added, removed, revoked, or a new key) puts a notice in the
  Inbox even when the app recorded the write, because a script that imports the device store records its writes too; the
  notice gives the device label and id, never the key. Changes to the security fields of `config.json` that the app
  recorded stay quiet. It also alerts when the record itself has been deleted, emptied or rewritten ("tripwire state was reset
  outside the app"). A `tripwire.writing` marker only counts when it is dated in the last 30 seconds, and only for one check.
  It reports after the fact and undoes nothing.

**Bypasses that remain.** Each of these gets past the guards today; the owner should know them.

- **The Linux supervisor's own files** (`supervisor-control`, `supervisor-stopped`, `supervisor.json`, `launch/`,
  `restart-proofs-used.json`, `restart-proof-mark.json`), and `talos-app supervise start|stop` (open to the agent since 2026-11-14): on an unmanaged
  install these guards raise the cost for a session acting through Claude Code's tools; they are not a boundary against code
  running as the same user (a name built at run time, base64, a script file, an interpreter all pass a pattern guard). The
  boundary is a root-owned control path and marker on a managed install (the P3c2 design note). `talos-app supervise start|stop`
  refuse without a terminal, and the guard denies the usual ways to hand one a terminal (script, expect, tmux, screen,
  systemd-run, ssh -t, a pty module), but not every route: a link to `talos-app` under another name run inside a pseudo-terminal,
  wrappers the guard does not unwrap (setsid, ionice, env -S, a `{ …; }` group, `$(which …)`, a name in a variable) are known
  ways past it on an unmanaged install. The supervisor reads the control
  file strictly (no link, a small regular file, exactly the words `talos-app supervise` writes), and an update adds these files'
  deny rules to the settings Main is launched with, so guards installed earlier cover them without `install-guards` run again.

- **The message pointer's Enter in a thread session** (Linux and the Mac alike). Talos tells a thread's session about a message
  by typing one line into Claude Code's input box and pressing Enter, also mid-turn (Claude Code queues it). The Enter goes only
  when a fresh capture shows the box holding exactly that line and no select or dialog live on the pane, with nothing awaited
  between that capture and the key. What remains: a select Claude Code draws between the capture and the key takes the Enter as its
  default answer (often "Yes"). Measured on a Linux test machine (2 idle cores, 200 Enters into a real tmux pane), from the start of
  the capture to the key reaching the pane: median 4.5 ms, p95 12.2 ms, worst 15.3 ms; longer under load. On the Mac (a MacBook Pro
  M5, macOS 26.7, the app's own capture, guard and send on a private tmux server, 200 Enters, debug build): from the start of the
  capture to the Enter delivered, median 7.5 ms, p95 8.0 ms, worst 24.2 ms; from the capture done, median 3.9 ms, worst 15.3 ms. It applies only to
  sessions whose permission mode allows on-screen prompts (a thread's mode is never wider than Main's; its approval prompts go to
  the phone through its hook, but an "ask" answer, AskUserQuestion and a subagent's prompt can still show a select). Talos
  captures the pane again right after the Enter and about 300 ms later; if its line is still in the box, or a select or dialog
  that was not there before has appeared, it records `enter_may_have_answered` (the captures' classes, never their text), tells
  that thread once ("Talos pressed Enter as a prompt appeared in this thread's session; check what it approved"), and never
  presses Enter for that message again.

- A shell line the patterns do not recognise: a script file written first and run later, a command built from variables or
  decoded text, an interpreter one-liner that writes a path built at run time.
- `cd <folder>` followed by a relative path elsewhere (`cd src && rm -rf apps`): the check sees the words, not where the shell is
  standing. A relative name inside the Talos home is caught by name; other relative paths are not.
- Running `claude` without the guards' `--settings` (a terminal the owner did not start through Talos), or with its own
  `--settings`: Claude Code reads one, so `talos-app start` leaves the owner's flag alone and warns; the Mac app merges the
  guard rules into the settings it writes for workers and "open claude here", but the main session's own configured
  `--settings` wins and is only noted in the supervisor's audit log.
- An agent running without the guards installed can write `agent-request.json` in the Talos home (it runs as the same user, so
  this cannot be closed completely). The guards deny that file, `last-good/` and `config-history/` to the agent; without them,
  the safety is that the Mac app posts a visible notice for every recovery it performs, so the owner always sees one.
- **Needs-you prompts (answering a start-up question with a tap).** Every agent session runs as the same user and can write the
  Talos home, and the guards are optional and only match text (a script that opens the file by another route gets past them).
  So nothing about WHO answered is taken from a file name or a field in a file. The defence is the proof check: the answer file
  (`dialog-answer.json`) carries the owner's own signed `card.resolve` frame and the card's binding, and the Mac presses a key only
  after it checks, against a device paired and not revoked in `devices.json`, the owner's signature, the signed action and choice, a tap time within
  15 minutes, that the card is exactly the dialog on this worker's pane (thread, id, kind, folder or server and every option
  equal to what the Mac itself read), and that the option's label is on the screen now; and it presses at most once per dialog.
  (The card's own life is a day and is NOT one of these bounds: the card closes when its dialog leaves the pane, a tap is only taken
  for the dialog id on the pane now, and the tap's signed time above stays 15 minutes.)
  Each signed tap is used once, whatever came of it, across a relaunch too: the Mac keeps the ones it has acted on in
  `workers/<thread>/dialog-proofs-used.json` (Main's development-channels card: `main-dialog-proofs-used.json`), known by the text that
  was signed, and tools are kept off those files like the others. While the app runs, its own list is what counts: entries
  something else writes into the file cannot push a tap the app acted on out of it (the newest 64 are kept).
  A process that forges an answer for another thread, or for a card with a harmless folder name on the real dialog's id, or
  replays an old tap, fails that check and nothing is pressed (the card then says "Answer on the Mac"). Fixtures for each of
  those cases are in `packages/protocol/fixtures/needs-you/`, and the reference check is `verifyDialogAnswer`.
  The other files (`dialog-card.json`, `dialog-result.json`, `workers.json`) are **display only**. A forged result, or a forged
  `workers.json`, can change what a card SAYS ("Answered on this Mac", "Nothing pressed", a different folder name on a card that
  can never be pressed from), and a forged `dialog-card.json` can hide the Mac's fallback thread line. None of them can press a
  key. This is the real boundary even where the guards are installed; the guards (`talos-app install-guards` denies Write, Edit
  and any command naming the three files) are an extra, not the defence. The readers also refuse a link (the bridge looks at
  `workers/` and `workers/<thread>/` with lstat as well as the files), cap sizes and require strict fields.
  For context: a program running as the same user can already pre-accept folder trust or an MCP server by editing Claude Code's
  own settings, so this does not add a new power; it keeps a tap on the phone from being forged into a different press.
  **Where the signer's key comes from, honestly:** the Mac verifies against the paired, not-revoked devices in `devices.json`,
  behind one lookup function. That file is writable by any program running as the same user, so the signer source is guarded only by
  the tripwire (which watches `devices.json` and tells the owner when it changes), not by the operating system. An agent that adds
  its own device to `devices.json` could then sign a forged answer with that device's key and have the Mac press it; the tripwire
  notice is what is meant to catch that, and the proof check does not. The proof closes forging by anything that does NOT hold a
  paired device's key; it does not close a process that can both write `devices.json` and get past the tripwire. See
  `docs/OPTION-C.md`, "Needs-you prompts".
- Anything that edits `guards.json` and `settings.json` together, if it can get past the checks on those two files. The hash
  only catches a file edited alone.
- A faked terminal, as above: the terminal check is not a boundary, and the guards' pattern for it is a pattern.
- **Under the 30-second poll an undo goes unseen.** The tripwire looks every 30 seconds. A change made and put back
  between two looks leaves no alert.
- **An in-process import of the stores bypasses the gate.** The terminal check lives in the CLI entry point. Code that
  imports the device store or the config file directly (a script run with `bun`, a mod) writes them without it. A device
  change made that way still raises the Inbox notice (the owner sees every one and can revoke); a `config.json` security
  change made that way goes through the recorded path and is not reported.
- **A baseline forged with the old hash in `hist` hides a config change.** The tripwire takes a change that matches a recorded
  hash in `tripwire.json` for the app's own.
- **Deleting `tripwire.json` and then restarting the bridge takes a fresh baseline**, which hides a config change made in
  between.
- **The hook pins the bun binary's path** (its real Cellar path, e.g. `/opt/homebrew/Cellar/bun/1.3.11/bin/bun`). A `brew upgrade
  bun` removes that folder. Measured 2026-11-14 (`apps/bridge/test/guards-refresh.test.ts`, the hook command run exactly as
  `settings.json` writes it, through `/bin/sh -c` as Claude Code runs a command hook): the bare command of the installs before this
  change cannot start, exits 127 and prints nothing, and Claude Code's hook reference (code.claude.com/docs/en/hooks, "Exit codes")
  treats that as a non-blocking error: the tool call goes ahead with only the `permissions.deny` rules. The command install writes
  now fails closed instead: when the pinned bun is not an executable regular file or the checkout's `cli.ts` is gone, the shell prints a deny
  ("This session's guard hook can't start (its Bun moved). Talos is restarting the session; nothing is lost.") and every guarded call
  is blocked; when both are there the shell becomes the hook (`exec`), so its answers are exactly what they were. The Mac app makes
  the restart real: at each start of Main the refresh re-pins the hook to the bun it finds now; a thread session whose own hook names
  a gone bun is told about in its owner line once and restarted as soon as it is quiet, with restart on update on or off, once the
  guards name a bun that is there; Main itself, found pinned to a gone bun, is told about once and restarted by the app as soon as
  nobody is typing and the restart check (the one `restart_main` uses) says it would come back, once per pin. What remains: a session
  started under the old bare command, and any agent started without the Mac app (`talos-app start`, Linux), runs with the deny rules
  only until it restarts or the owner runs `talos-app install-guards` again.
- **Paths in the hook command.** The hook command quotes each path in double quotes for a shell; install and the refresh refuse a
  bun, checkout or Talos home whose path holds `$`, a backtick, a quote, a backslash or a control character, which would not reach
  the shell as the same path.
- **`talos-app guards refresh` itself.** It takes no argument, reads no environment variable for the rules (the kit's folder too comes
  from the installed rules, or it refuses), and refuses unless both guard files are plain files of this user in a plain folder of this
  user inside the Talos home and are the pair an install wrote; it never installs or removes the guards. It refuses any checkout but
  the one the guards were installed from (moving the checkout is the owner's `install-guards` in Terminal) and a bun inside the Talos
  home. The Mac app runs it with a bun from a fixed list (`/opt/homebrew/bin/bun`, `/usr/local/bin/bun`, `~/.bun/bin/bun`, by their
  real paths) and the `cli.ts` of the checkout the installed hook names, in an environment of its own (PATH, HOME, TALOS_APP_HOME):
  never `talos_app_command`, the PATH or the env of `desktop.json`, nor anything in the agent folder, which a session can edit; a bun
  or a `cli.ts` inside the Talos home, the agent folder, a thread's folder or a temp folder is refused before anything runs, said in
  the audit log and once to the owner. Whenever the bun the app finds is not the one the hook is pinned to, the owner is told once, in
  plain words, whatever the refresh did. The hook and a deny rule keep a session
  from running the command itself (`Bash(talos-app guards:*)`), and a thread session is refused it before it runs. Like the rest of
  the guards this is a spelling check: a session that runs the code under its own bun can still rewrite the guard files, which it
  could already do by writing them directly (see "Anything that edits guards.json and settings.json together" above), and the
  Homebrew folders the bun list names are the user's own, so a process running as the user could replace a bun there.
- **What a mod can still do.** A mod (a plugin or `dev-mods` file) runs inside Claude Code with the agent's own rights, outside
  these checks if it was installed before the guards. It can read the folder the agent can read, run any shell command the
  patterns do not name, and edit files the deny rules do not list. The guards make installing a mod or plugin through the agent
  harder; they do not make a mod already running safe. Install mods and plugins only yourself, and run
  `talos-app install-guards` before you give the agent a task you do not watch.

## The OS sandbox: an extra lock on protected files (opt-in, off by default)

The shell guard reads a command's text, so a command written in a way it cannot read (`python -c`, `awk -i inplace`, `vim`, `eval`,
`xargs sh -c`, `sort -o`, a link, `git restore`) can still change a protected file. With the switch on, Main and every thread session
start inside Claude Code's own OS sandbox (bubblewrap on Linux, Seatbelt on macOS), set so that a command cannot leave it
(`allowUnsandboxedCommands: false`) and a session does not start without it (`failIfUnavailable: true`). The kernel then refuses a
write to the protected files from a shell command, however the command is spelled. Real runs of every spelling above were refused; reading the files still works.

**This is experimental and it does not stop everything.** It is off by default. Four gaps are known and open (none fixed yet):

- **A thread folder that contains the Talos code folder** (or sits inside it). The check cannot tell which copy of the code is the trusted one,
  so the code the guard hook runs outside the sandbox may be editable from that session.
- **MCP servers added with `claude mcp add`**, which Claude Code keeps in `~/.claude.json`. Their commands are not checked, and Main and a
  thread with no server list load them outside the sandbox.
- **Some newer Claude Code command settings and plugins** (a command a setting names, such as a file-suggestion or auth-refresh helper; enabled
  plugins and folder marketplaces; a settings `env` that changes how a hook's `#!/usr/bin/env` line is resolved). Talos reads the settings it knows about, so a setting Claude Code adds later is not covered until it is added here.
- **A hook written in a project's own settings** can get around it.

Until these are closed, treat the lock as one more layer, not a wall: keep thread folders apart from the code folder, add MCP servers with
`talos-app`, and leave plugins alone.

- **The switch.** `os_sandbox` in `config.json`; Settings calls it "Extra lock on protected files". Off unless the owner turns it on.
  The agent may turn it on or off when the owner asks (a settings proposal, like the other guard switches: a card while "Lock Talos
  settings" is on), or `talos-app sandbox on|off|status` does (the same lock applies to an agent; the guards, when installed, keep it
  at a terminal). It takes effect at the next start of Main and of each thread session. `talos-app facts` and `talos-app doctor` show it.
  With it on, agents also cannot edit their own instruction files (`CLAUDE.md`, `AGENTS.md`); the owner changes them. Off, no launch changes at all.
  One file is the stated exception to the rule that a session gets no Edit allow rule with a path: the thread's own live state file, `<agent folder>/threads/<id>.state.md`, which the supervisor seeds and the session keeps current. Its generated settings carry an Edit allow for that exact path and a deny of what is under it (`<id>.state.md/*`).
- **What is unwritable, and the home is not writable at all.** The sandbox adds nothing to what Claude Code lets a session write by
  default: its own folder and tmp (plus, in a thread session's own generated settings, an Edit allow for its one state file, see above). The Talos home is **not** writable from a session (an earlier design made it writable except for a
  list; that left `workers/` with the permission-hook copy every thread runs outside the sandbox, `bridge.env` (the bridge runs the
  commands named in it) and the apps catalog open). Besides that, the protected names are denied by name, in case a session's folder
  sits under the home: every file the guards protect from writes (`config.json`, `devices.json`, `owner-folders.json`, the keys,
  `guards/`, `secrets/`, `bridge.env`, `mod.key`, `apps/catalog.json`, the relay and restart files, `last-good`, `config-history`, the
  supervisor's files, `workers/` and `workers.json`), the launch files (`supervisor.json`, `launch/`) and the sandbox's own
  `sandbox/gitignore`. The signing keys, `mod.key`, the secret store and the supervisor's control files cannot be read either. The agent's Talos work
  goes through the `talos-app` MCP server (the bridge), which runs outside the sandbox. A `talos-app` command run from sandboxed Bash that
  must write the home fails with one plain line: "This lock is on, so I'll ask Talos to change that setting."; its audit line to `bridge.log` is best effort (a failed write never stops a command that only
  reads). **With the switch on these agent-runnable commands do not work from a session's shell:** `sandbox on|off`, `relay auto
  on|off`, `relay update`, `relay disconnect`, `devices revoke`, `peer link|accept|create|add|remove|rotate|secret-forget`, and
  `install-guards`, `lead init`, `theme reset`, `memory init|on|off|set-root|reindex` (they write the home). `peer list`, `devices list`,
  `relay status`, `sandbox status`, `facts`, `doctor`, `status` and `logs` still read fine. The settings the agent may change are
  changed through `config_propose`, which is the bridge's own write.
- **The session's own folder.** Claude Code runs the hook scripts, the status line and the MCP servers named in a folder's settings
  outside the sandbox, so a session that could replace one would run its own code unsandboxed at the next tool call. These are
  unwritable in the session's folder (Main's, a thread's or a lead's): `.claude`, `.mcp.json`, `hooks`, `scripts`, `kit`, `CLAUDE.md`,
  `AGENTS.md`, a lead's `.talos-lead`, and every existing file the project and local settings' hooks and status line, and the `.mcp.json` servers, name.
  A kit link (`hooks`, `scripts`) is denied by its own name; a real run showed that the sandbox then keeps the name occupied for the
  rest of the session (a new folder or file cannot be put there), but that `rm` of the link itself still removes it on disk. So a
  session can switch the guard hooks off for the rest of its own session (they skip when their script is missing; unattended runs block),
  though it cannot replace them with code of its own; the next start is refused ("hooks is missing ... run the kit's install again").
- **Settings that could weaken the sandbox: an allow-list.** With the switch on, a start is refused, with one line naming the file and
  the key (and a doctor row), when a settings file the session loads has a `sandbox` key that is not on a short list: the folder's (and
  its git root's) project and local files for Main and for a thread in the agent folder, and the owner's user settings for every session
  (a thread in another folder loads user settings alone). On the list: `autoAllowBashIfSandboxed` (only `false`),
  `ignoreViolations` (silences the log), `enabled` (only `true`), `failIfUnavailable` (only `true`) and `allowUnsandboxedCommands` (only `false`, which real lead folders
  set), which say what the lock itself
  says. Everything else is refused, a key from a newer Claude Code included (`allowAppleEvents`, `network.*` sockets and Mach lookups,
  the weaker-isolation switches, `credentials`, proxy and TLS keys, ripgrep overrides, `excludedCommands`, every `filesystem` key): Claude
  Code 2.1.330 honours them and some reach outside the sandbox. Talos's own block also sets `allowAppleEvents: false` and
  `enableWeakerNetworkIsolation: false`. A `permissions.allow` rule (what "Yes, don't ask again" writes into `settings.local.json`) is no
  way out of the sandbox and does not refuse a start. A real run also showed `<folder>/.git/config` and `.git/hooks` read-only in the
  sandbox (Claude Code mounts them so), so `core.fsmonitor` cannot be planted there.
- **What a hook, the status line or an MCP server runs.** Those run outside the sandbox (MCP servers are not sandboxed either), with
  everything they load, so with the switch on they must not be something the session can change. From the folder's (or its git root's)
  project or local settings or `.mcp.json`, a command hook, the status line, a helper command or a stdio MCP server is allowed only when
  it is the kit release's own (its files are inside the kit's real folder), or a lead's hook script (a regular file directly in
  `<folder>/.claude/hooks` that is byte for byte the kit's template of the same name in the recorded clone, `kit/templates/lead`; with no
  recorded bridge none passes; a file planted before the switch went on does not pass by its place); anything else refuses the start, naming the file and the command ("<file> runs "<command>",
  which is not the kit's own; move it to your user settings (~/.claude/settings.json), then start again"). From the owner's user
  settings a command is allowed only as an absolute path to a file, alone or run by an interpreter, outside the session folder and every
  temp folder (so outside everything the sandbox can write), in a form that does not depend on where it starts: no `npx`, `uvx`,
  `bunx`, `bun x`, `python -m` or relative script, and bun only with both `--no-env-file` and `--config=<a file nobody can write>`;
  anything else refuses, naming it. `http` and `sse` MCP servers run nowhere and are fine. Nothing is locked by folder (an earlier
  design denied each script's folder and `node_modules` with it; the refusals replaced it). Not covered: MCP servers in the owner's
  user-level Claude config (`~/.claude.json`), which these checks do not read.
- **The one stdio exception: `talos-app`.** Every agent folder's `.mcp.json` has it, and it must still start. `bun <script>` run from
  the session folder loads that folder's `bunfig.toml` (its `preload` is code) and `.env`, outside the sandbox (tested on Linux, bun
  1.4.4; the Mac side agrees: both flags are needed on both systems). So Talos writes the entry as `<bun> --no-env-file
  --config=<bridge clone>/apps/bridge/bunfig.toml <bridge clone>/apps/bridge/src/server.ts` (the working folder stays the agent folder:
  the bridge and its CLI read it as that) and the lock allows an entry only when, by real path, its command is the bun Talos recorded,
  its two paths are the recorded bridge's, its args are exactly those three, it has no `cwd`, its env holds only `TALOS_APP_HOME` (this
  home) and `TALOS_AGENT_DIR`, and the recorded bridge is outside the session folder. "Recorded" is what the supervisor's own process
  knows (the bun it finds or runs on, the clone it runs from, and nothing the entry says of itself); no record is built for a clone in a
  shared temp folder. The older form (`run --cwd ...`) still works with the switch off; with it on the start is refused ("has a
  talos-app server in the old form; run talos-app doctor to rewrite it") and `talos-app doctor --fix-mcp` rewrites it in one step
  (adopt and `install-mcp` write the new form for everyone). The lock also denies writing `<folder>/bunfig.toml`, `<folder>/.env`,
  `<folder>/.env.*` and the recorded bridge clone.
- **Folders made writable inside the lock refuse.** Claude Code makes `permissions.additionalDirectories`, an `Edit` or `Write` allow rule
  with a path, and `--add-dir` into sandbox write roots. With the switch on, a start is refused when a loaded settings level (project,
  local, user) has one, or when Main's launch args carry `--add-dir`, naming the file and the setting. (A thread session's own generated settings carry one such allow, for its state file `threads/<id>.state.md` only; it is the supervisor's, not a loaded level.) The sandbox also denies writing
  `~/Library/LaunchAgents` (a login item) and the kit release's real folder, each by real path and even when missing.
- **Bash approval cards stay on.** Our block sets `autoAllowBashIfSandboxed: false`. A `true` in a settings file the session loads
  refuses the start (Claude Code's own `--settings` outranks project, local and user settings, so ours should win, but the start is
  refused rather than rely on it). A `false` starts.
- **A `config.json` that cannot be read keeps the lock as it last was, and the lock is off unless the owner chose it.** No file, or no
  `os_sandbox` key, is off. A file that exists but cannot be read, is not JSON or is not an object does not say which way the switch is
  set, so the launch uses the state of the last good reading: on, if the owner had it on (the launch carries the sandbox, it is not
  refused, one audit line `os_sandbox_config_unreadable` says `lock=kept on`, and the owner gets one notice: "Talos couldn't read its
  settings, so the extra lock stays on"), and off if it was off or there was never a reading (the audit line says `kept off`; the owner is told
  nothing about a lock he never turned on). The last good reading is one small file, `config-history/os-sandbox-last` in the Talos home, "on" or "off".
  It is written by the supervisor at each start and by the bridge each time it loads, reloads or writes `config.json` (so switching the
  lock on and then damaging the file before the next start keeps it on), and only when the answer changed. It sits inside a name the sandbox
  and the guards already keep sessions from writing, as they do `config.json` itself, so the lock's own lists are unchanged (and `allowWrite`
  stays empty: nothing in the Talos home is writable from a locked session). A session under the lock can neither write that file nor
  `config.json` (the `talos-app` tools change `config.json` only through their own checks), so it cannot damage the file and then use the record
  to turn its own lock off. The record counts only as a plain file with one name and a few bytes, inside a real folder, checked before it is
  opened (a pipe, a link or a folder in its place is no record and never holds a start); a file that says anything but `on` is no record either.
  Writing refuses a linked folder, and removes a record entry that is not a plain file (that entry only). An `on` that could not be written
  down is one audit line (`os_sandbox_record_failed`), because a later damaged file would then read as off. One case is left: an owner who
  already had the lock on before this record existed, and whose `config.json` is damaged before the first start after the update, reads as off.
- **The hard-link check.** The sandbox protects a file by its path, so a second name for the same file (a hard link made outside the
  sandbox before the launch) would still reach it. With the switch on, every start of Main and of a thread session (and `lead init
  --sandbox`) first checks that each protected file that exists is a regular file with link count 1, not a link (in the session's own folder too: its protected files, such as `.claude/settings.local.json`, and the files inside the protected folders; the kit's `hooks`, `scripts` and `kit` links are links on purpose, but only into the kit release: a link at those names to tmp or back into the folder is refused, and a real folder there is checked like any other); a start that fails
  the check is refused with one line naming the file and how to fix it (`config.json has another name on this disk (a hard link);
  remove the other link, then start again`), and `talos-app doctor` says the same. Every path in the sandbox rules is a real path (the
  home may be a symlink); on macOS a rule path that is not the real path is silently not enforced, so one that cannot be resolved
  refuses the launch instead. The check runs once more as the last step before the session process starts (after the settings are
  written; the same line refuses it), and Talos writes each protected file as a new file moved into place, so an older hard link goes
  stale at the next write. A link made by an unsandboxed process of the same user between starts, then kept and used from the session
  folder or `/tmp/claude-<uid>`, is still open until a planned watch on link counts is built (a link made while a session runs).
- **The Mac app (Seatbelt).** The Swift supervisor builds the same settings for Main's one `--settings` and for each thread session's
  settings (`OsSandbox.swift`, `OsSandboxFolder.swift`; compared with the TypeScript builder through a checked-in golden,
  `apps/desktop/Tests/Fixtures/os-sandbox/golden.json`, held to by both sides' parity tests). The refusal lines are the same; a refused start is a failed start of Main (with the line) or a thread's error, and nothing
  is spawned. Every path is the real path (`/private/tmp/...`, not `/tmp/...`). The block also says `allowAppleEvents: false` and
  `enableWeakerNetworkIsolation: false`. A `config.json` that cannot be read keeps the lock as it last was (off when it never was on), as above: the same record file, the audit line, and one notice only when the lock stays on.
  - **bun's working folder, measured on this Mac (bun 1.4.4).** A planted `bunfig.toml` with a `preload` that names a script in the folder and a `.env` in the folder, run as
    `bun <abs script>` from it: the preload RAN and the `.env` loaded. `bun --no-env-file --config=<abs neutral file> <abs script>`: neither. Each flag does
    one job: `--config` alone stops the preload but the `.env` still loads, `--no-env-file` alone stops the `.env` but the preload still runs. A
    `tsconfig.json` with `paths` in that folder did not redirect the script's imports; node and python3 run as `<interpreter> <abs script>` loaded nothing
    from the folder (`node_modules`, `package.json`, `.npmrc`, a shadow `json.py`, `sitecustomize.py`, `pyvenv.cfg` were planted). The older entry form
    (`bun run --cwd <bridge> --silent` with the server script) moved bun's folder first and loaded neither. Claude Code's sandbox takes patterns in `denyWrite`: a
    `<folder>/.env.*` rule refused `.env.local` and `.env.production` and left `.envrc` writable. The Mac reads the record the `talos-app` entry is
    compared with from the pins in the installed guards' hook and the fixed bun list the guards refresh uses (`OsSandboxLaunch.recordedBridge`); none when
    the guards are not installed ("Talos can't confirm which bridge this folder runs (the guards aren't installed); install them from Settings, then start
    again"), and none when the bun or the bridge sits in the Talos home, a session's folder or a temp folder.
  - **The kit release** is found from the session's login environment (where Claude Code's folder comes from), not from the app's.
  - **`uchg` is not used: an agent can clear it through a hard link made after the start; the link-count check is the protection.** An
    earlier build flagged three files; the app clears that flag at every Main start if it finds one, so nothing is left unwritable.
  - The check runs again right before the spawn for Main and for each thread session (the Mac twin of the re-check above), and a link made mid-session
    is not seen until the next start (the planned link-count watch is not on the Mac yet).
- **Friction handled.** Package caches go into the session's folder (`.cache`), and git is pointed at an excludes file the bridge
  writes in the sandbox folder (the placeholders the sandbox mounts in a folder, `.claude/` and `.cache/`; the owner's own global
  git excludes are copied in, read only, and his git config is never touched), so `git add -A` works.
- **What it does not cover.** Hooks, MCP servers and `!` commands run outside the sandbox (which is why the files they run are
  protected above). The time between the hard-link check and the launch is not closed. The sandbox is Claude Code's, so
  a Windows PC has none. Claude Code's network allow-list is left at its default, and in `bypassPermissions` mode it does not apply
  (an unlisted domain is reached without a prompt). A session that starts with the owner's own `--settings` has no guards and no
  sandbox for that launch (said in a warning). The bridge's own writes are not sandboxed (it is not started through Claude Code).

## What this does not protect against

- **A relay that serves malicious JavaScript.** The relay serves the app. If someone takes over the server's code (not
  just its database), they can serve a script that signs whatever they like with your device key. Signatures stop a
  database or API break-in from forging your messages; they do not stop a rewritten app. Keep the Railway account and
  GitHub copy protected with their own strong login and two-step sign-in.
- **A hostile page in the Mac app can use the microphone (archived 2026-11-19).** While voice input existed the Mac app gave the microphone to the relay's own page without a second prompt once macOS had allowed it for Talos, and the relay's `Permissions-Policy` said `microphone=(self)`. Both are gone from this branch: the relay now sends `microphone=()` and the page's microphone grant in the Mac app is to be removed in the Swift change ([archived/voice.md](archived/voice.md)). Until that lands the Mac app still hands the microphone to the page, and the web page no longer asks for it. Agent pages, iframes and other sites never got it.
- **A hostile page in the Mac app can show the agent's terminal, but not read or type into it.** The Terminal item in
  the Mac app is a native view laid over a space the page names (`terminal_view`). The Mac app takes "signed in" from
  the page's own word, and the relay controls the page, so a taken-over relay or a script in the page can place and show
  the view, in the size and place it picks inside the window, as long as the window is open. It cannot read the screen
  or send keys: the page never receives what the terminal shows, nothing the page sends is typed into it, and the view
  never takes the keyboard because of a page message, only because of a click in it. It can leave the view over other
  page controls, and can slide it under a click about to land (on a mouseenter, say), so the owner's next keys go to the
  agent, Enter included, which could answer a prompt. That needs a real click and real typing from the owner; the page
  picks no bytes and reads nothing, and the view is opaque and at least 80 columns by 24 rows. There is no time guard: a
  fixed delay would only change the odds. The size floor also stops a page from squeezing the agent's own screen. The
  separate Terminals window has no sign-in check either.
- **A hostile page in the Mac app can show the owner's shell pane, but not read or type into it.** The Terminal pane
  beside a thread is the owner's own login shell in a native view laid over a slot the page names (`shell_pane`,
  [`docs/TERMINAL-PANE.md`](TERMINAL-PANE.md)). The page's message says where the slot is and which thread it belongs to;
  it has no field for a folder, a command, an environment or any input, and nothing a shell prints goes back to the page,
  the relay or the bridge. So a taken-over relay or a script in the page can place, show, hide and close the pane, bring
  another thread's shells to the front, and start up to 16 idle shells, 12 a minute. As with the agent's terminal, it can
  slide the opaque view under a click about to land, so the owner's next keys go to their own shell; it picks no bytes.
  It can also hide the pane while the owner types, which hands the keyboard back to the page, and draw a look-alike there.
  The shell starts in the folder this Mac's config has for a thread with its own session, and that folder is a thread
  setting the page can change through the same checked patch that moves the thread's agent session; the agent folder is
  used for every other thread. The shell is on a pty the Mac app holds, not in tmux, so there is no socket to send keys
  through, and what a shell prints cannot set or read the clipboard. The agent runs as the same macOS user, so this is not
  a wall between the agent and the owner's processes; it is only that Talos adds no path to the shell.
- **Unsigned rows can steer which old files the app asks for.** A `reply` or `message.stored` row carries no Mac
  signature, so a taken-over relay or database can insert one that names old media ids. When you open that thread the
  app fails to load the file and signs a `media.fetch` for that id, and the Mac uploads it (up to 10 files per row). You
  must open the thread; nothing happens in the background. The Mac does not check where the id came from. Closing this
  needs Mac-signed attachment references.
- **A relay that holds back a notification tap.** A taken-over relay can keep a signed Reply or Approve and deliver it
  later. For an Approve the Mac refuses anything signed more than 12 hours ago (on the Mac's clock) or for a card that has
  expired; it cannot change what was approved, because the tap is bound to the card's fingerprint and to the exact words
  the phone showed. For a Reply, the Mac accepts a tap that the relay held, up to 8 days old (the Mac's own limit; the relay itself keeps a frame 7 days by default, `BUFFER_DAYS`). In both
  cases the relay can read the message text, as it can read all your messages.
- **A relay that holds back a tap in the app.** A taken-over relay could keep a signed tap on a card (a high-risk card
  included) and deliver it late: up to 12 hours after the phone signed it, on the Mac's clock, and never past the card's own
  deadline. It cannot make, change or double-run one: the tap is signed by the phone, bound to the card's fingerprint,
  and a card is decided only once.
- **Unsent messages kept on the phone after a session simply expires.** When a session runs out of time (idle for 14
  days, or past its 30-day limit), the app keeps the messages you had sent but that nothing had
  delivered yet, and sends them after you sign in again. They are stored as they are in the app's browser storage on
  that device: the signed message text and any attached files, **not encrypted by Talos**, readable by anything that can read
  that storage (someone with the unlocked phone or its backup). They are removed by a revoke, any sign-out, sign-out
  everywhere, a session the relay cannot say was merely expired (the app then treats it as revoked), signing in with a
  different device key, or **Discard** on the sign-in page. A lost phone should be revoked from another device: that
  removes the queue the next time the phone reaches the relay. A phone that never connects again keeps it.
- **Forged webhook events.** A compromised relay can invent events that look like an integration. They still arrive as
  labelled data, and can only lead to a summary or a card you decide on.
- **The agent's own later actions.** A card proves what you saw and what the Mac told the agent. It cannot force the
  agent to do exactly that and nothing else; the agent's instructions say to do what the approved card says and no more.
- **Prompt injection.** The wrapping makes it much harder for outside text to steer the agent, but no wrapping is a
  guarantee. That is why actions go through cards. The manual run below is how this is checked on a real agent.
- **A stolen, unlocked phone** can approve what the owner could: since 2026-11-14 nothing asks for Face ID again (the owner's choice). Sessions last 90 days unused; "Sign out everywhere" and revoking the phone from another device end it.
- **What push providers can see.** Notifications contain only fixed phrases, but that one arrived, and when, is visible
  to Apple or Google.
- **A folder renamed into place right after the check (accepted limit, NOT closed).** The memory browser and the
  upload readers open files so that no link in the path is followed, and ask the kernel where the open handle really is.
  That stops a swapped-in link, and a folder that was moved away again by the time of the handle check. It does not stop a
  real folder renamed into place and left there, or one flipped in just AFTER the check, so the `.talos-private` marker can still be beaten by someone who can
  rename folders next to the root. Closing it needs a kernel feature this code cannot use on macOS. The attacker already
  needs write access beside the folder, which also lets them copy the files, so we accept it and say so.
- **Hard links and copies.** A hard link to a protected file is refused by name rules only; `isSensitive` guards
  against accidents, not against someone who can already read the file. Media attachments with more than one hard link
  (for example after `cp -al` of the bridge home) are skipped by search for good.
- **Setup codes can be replaced by a leaker.** The five-failures rule counts misses per address (one valid `X-Real-IP`
  behind the proxy, or the socket peer), so five wrong guesses lock out only the guesser for ten minutes and burn no code.
  When the relay cannot tell the address (no single valid `X-Real-IP`), it counts nothing and locks nothing. A guesser who
  rotates addresses is not stopped by it, only slowed. A shell that kept the session of an
  earlier code (burned, expired, or a Mac that answered `N`) trades the new code for a fresh session before it pairs, so a new
  code is enough; "Sign out" in Settings is not needed. A leaked code can also replace the
  session a shell just made (one session per code); it still cannot pin without your `y`. Sessions made from a code that later
  burned or expired are not deleted. They stay unpinned and reach only the pairing routes (`/api/me`, `device/verify`, sign-out) and the pairing-only socket, which carries no data.
- **The relay chooses when a signed read lands.** The app signs reads with the relay's clock (from `ready`), limited to one
  hour of difference from its own. The Mac accepts a read from 2 minutes ahead to 5 minutes behind, so a relay that lies
  about the time can hold a request it already has and deliver it up to that hour later, once. It cannot change what the
  request asks for. If the phone's own clock is more than an hour off, its reads are refused as "clock is off".
- **History pages are not signed.** The request is signed; the page that answers it is not. A taken-over relay could
  rewrite a past message, or add a row that looks like yours, in what a device shows. The app drops a page it did not ask
  for (unknown request id, or another thread), but cannot tell a page the relay edited. Your Mac's own history and the agent
  are unaffected: they never read from a page.
- **Ask rules are a speed bump, not a boundary.** `talos-app install-ask-rules` adds rules to Claude Code that ask you
  first when an agent runs the common spellings of `rollback`, `restore-last-good`, a push, a delete and similar. A rule
  matches the command's text, so an agent that tries can get past it with another spelling, a different capitalisation
  (a Mac disk ignores case in file names), odd spacing, or by starting the same action another way. Treat the rules as a
  prompt for the usual case, not a guarantee. `rollback` and `restore-last-good` stay safe without them: each shows what
  it will do before it does it, keeps a backup, and can be undone.
- **Your Mac.** Anyone with access to your Mac's files has the bridge key and your history.
- **The first device.** The relay accepts the very first passkey only with a code made at your Mac, but if that link is
  intercepted _and_ you answer `y` to a device you did not start, you have approved a stranger. Read the four words.

## Relay authentication, as built (`apps/relay/src/auth`)

- **Sessions.** Cookie `__Host-talos_s` (`Secure; HttpOnly; SameSite=Strict; Path=/`), 32 random bytes, only the SHA-256
  is stored. 30-day sliding expiry with a 14-day idle cap; signing in or registering a passkey replaces the session that
  came with the request. Revoking a device deletes its sessions.
  Idle expiry does not reach an iPhone grant by itself: the phone learns of it at its next open, and until then the relay
  keeps sealing notification text for it and `POST /api/native/act` (no session needed, it checks the grant) keeps taking
  Reply and Approve taps, about 6 to 16 more days at most. The relay can read notification text whenever text is on.
- **Passkeys.** Discoverable credentials, user verification required, attestation `none`. Registration works only with a
  live enrollment `code_auth`. Every `enroll/*` or `device/verify` call with an unknown, used, burned or expired code
  counts as a failure for the calling address; the fifth in ten minutes locks that address out of these routes for the
  window, and burns no code.
- **Setup-code sign-in (native apps).** `POST /api/auth/enroll/session` trades a live, unused setup code for an unpinned
  session (no passkey, so `credential_id` is null; only the frame that tells the Mac carries the word `setup-code`, and the Mac never reads it). The code is not spent there; the
  following `device/verify` spends it and the Mac asks for `y`. There is **one session per code**: a second call with the
  same live code replaces the first, so whoever holds a leaked code can knock the shell's session out until the code is spent.
  A session is tied to the code that made it and can pin only with that code. Re-enrolling a device that already exists needs
  a signature from its private key over a fresh nonce (120 s, single use, bound to the session, the code and the device).
  Wrong, used, burned and expired codes count toward the same per-address five-failures lockout as passkey enrollment; a
  wrong device proof counts too, and a held code burns on its own fifth wrong proof, from any mix of addresses.
- **Challenges** (registration, sign-in) are single use with a five-minute lifetime.
- **No step-up tokens** since 2026-11-14: the routes, the tokens and their table are gone (migration 0006). An older app that
  still sends a `stepup_token` or a `stepup` assertion has it accepted and never read; the relay strips the token.
- **CSRF.** Non-GET `/api/*` needs `Origin === PUBLIC_ORIGIN`, `X-Talos-CSRF: 1` and a JSON content type (the media upload
  has its own type but never a form type). `/ws` checks the cookie and the Origin before upgrading.
- **Pairing gate.** `requireSession` answers `403 device_not_pinned` unless the session's device is pinned and not
  revoked. Only `/api/me`, `/api/auth/device/verify` and `/api/auth/logout[-all]` accept an unpinned session.
- **Bridge.** Hello is an Ed25519 signature over a per-connection challenge; a challenge signs in once, `hello` must
  arrive within 10 s (4408), the first frame must be a valid hello (4401), a pre-auth frame over 64 KiB is closed (the
  library closes it with 1009, "message too big", rather than 4413), and five failed hellos from one address in ten
  minutes block it for an hour. HTTP requests carry `TalosBridge` signatures over method, path, timestamp, nonce and
  body hash (skew 120 s, nonces remembered ten minutes in the database, so a restart does not reopen a replay window)
  and are rate limited before anything is read. Key rotation is signed by both keys; the old key stays valid for five
  minutes. `BRIDGE_PUBKEY_FORCE=1` makes the environment key the only trusted key and refuses rotation.
- **Bridge attest (BYOR phase 4).** `POST /api/bridge/attest {nonce}` is public: no session, no csrf (a native call sends no
  Origin, and the route changes nothing). The relay passes the nonce to the live bridge only, waits 5 s and drops late or
  unmatched answers; it never stores or buffers the request. The Mac signs `talos-bridge-attest/v1`, nonce, relay origin and
  the fingerprint of its current key (never a fallback key), at most 5 at once and 1 a second; the relay limits callers per
  address, relay-wide (0.5 a second) and, for a request carrying a live paired session cookie, in a separate bucket so
  strangers cannot use up the owner's phones' checks. That cookie is read without side effects (no refresh, no
  `Set-Cookie`, no last-used update). `rotate` signs a certificate with the old key for the new one (`talos-rotate-cert/v1`,
  with the relay's `relay_id`), kept 0600 in `bridge.rotations.json` and served as a chain of at most 8, so a phone can
  follow a rotation; it refuses when the relay's descriptor cannot be read or the file is damaged. What it proves: that the
  owner's Mac answers behind the origin the phone paired with. **Accepted gap (owner decision 2026-11-17):** a server swapped
  in at that origin can pass the request on to the real relay and return its answer; the signed origin still matches, so
  the attest does not identify the server, only that the Mac is reachable through it. Anyone can also learn the Mac's
  public key and whether it is online (a 503 `mac_offline`), and cost it a signature within those limits.
  **On the phone** (native code, never the page): a fresh 32-byte nonce per call, 10 s in all, one retry of a 429, an 8 KB cap,
  and the paired session cookie read from that pairing's own web view store (never at pairing). The answer must be the
  pinned key's, or reach it by a chain of old-key rotation certificates, and carry a valid signature over the phone's own
  nonce, origin and fingerprint; anything else is a hard stop with a red screen. At pairing nothing is saved and no setup
  code is sent unless the check passes against the QR's key. Every key change, signed or not, needs a blocking confirm that
  names the host. When the Mac does not answer (the relay's unsigned words, a timeout, a 5xx) the app is "unverified": a
  banner says so with the last confirmed time, the page's camera and microphone access (not a file input that opens the system
  camera, which WebKit does not ask the app about), sharing, the prompt channel and every native plugin are off, and the page
  stays read-only. 24 hours after the LAST verified check the app blocks outright (a screen with Retry and
  Remove, no page). The time, and whether the last check failed, are kept per pairing, by the phone's own key id, in the shared
  Keychain: a notification button (Reply, Approve) refuses, before it reads any key or sends anything, when its pairing failed
  its last check or was last verified 24 hours ago or more. Accepting a key change saves the new key and then runs a fresh check;
  the old answer is never stamped as a pass.
- **Rate limits** are token buckets keyed by the client address: `X-Real-IP` (the header Railway documents) when
  `TRUST_PROXY_HOPS` is above 0, else the entry `TRUST_PROXY_HOPS` from the right of `X-Forwarded-For`, else the socket
  address. They are in memory and reset on restart. An address that sends five bad bridge hellos is blocked for an hour, but
  the block is for strangers: a hello that proves it holds a trusted key still gets in, so one stranger on a shared address
  cannot lock the Mac out.
- **Request size.** Every JSON route is capped at 64 KiB while the body streams (413); the sign-in routes and device revoke
  also have a 15 s deadline. Only media, share, frame posts and hooks carry bigger bodies, and each caps itself. A signed
  bridge upload is checked for a trusted key id and a fresh time before its body is read. The Mac's uploads carry the body
  hash (`x-talos-sha256`), so the signature is checked against it first and the body must then match; only requests with
  no hash are read unproven, and those share small pools (4 per address, 6 in all for media; 12 and 48 for frames). The
  hook receiver has its own pool (8 per address, 32 in all) and a read deadline. IPv6 addresses count per /64. Device revoke checks the session before it reads the body, and is
  limited to 20 calls a minute per address.

## MCP Apps (opt-in)

Connectors can ship small interactive views ("apps"). They are off unless `TALOS_APP_APPS=1`. The owner-facing guide is
[APPS.md](APPS.md); this section is the security summary. The agent runs without Claude Code permission prompts, so every
gate below is a Talos mechanism, not a Claude Code one.

### Threat model

A malicious or compromised view; a server that changes its manifest after you approved it; a server whose hints lie; a
taken-over relay (it cannot forge `app.request`, which is signed by your device and checked on the Mac, but it can serve
hostile JavaScript to the app as it always could); prompt injection through what an app says, asks for or returns;
resource abuse; and phishing inside the frame (a view painting a fake Talos card).

### The sandbox and the network bounds

- A view runs in an iframe with `sandbox="allow-scripts"` and no other flag, and its page is served with the same
  restriction as a CSP `sandbox` directive. The origin is opaque: no cookies, no storage, no access to the app's API,
  no same-origin requests. There is no `allow-same-origin`, popups, forms, modals, downloads or top navigation, and no
  permission is granted (camera, microphone, location, clipboard and similar are denied in the response headers).
- Code: only the inline scripts whose hashes you approved, and remote files pinned by an integrity hash and an exact URL.
  No `'unsafe-inline'` for scripts, no `eval`, no workers, no form targets, `base-uri` is none unless approved.
- Network: fetch, XHR and WebSocket reach only the domains you approved. The relay's own host can never be on the list.
- The approval is bound to the exact HTML, the policy, every tool's labels and how Talos reaches the server. Any change
  asks again, and a view whose approval stops matching is closed.
- Every app-to-agent message is marked untrusted, and what runs for an app call is the approved arguments, substituted by
  the gate hook, not what the agent typed. Results of app-requested calls never reach the agent (a one-line handle
  replaces them). A failed call is the exception: see residual 7. Approvals exist only as cards drawn outside the frame.

### Side channels

- **WebRTC and DNS prefetch.** A content security policy does not govern WebRTC connection setup (STUN or TURN) or DNS
  prefetch in shipping browsers. This is an **INFERENCE** from how the engines behave, not something this project proved for
  every browser. So a view that holds data could leak it by those routes even to a host you did not
  approve. The bound that actually holds is **what the view holds**: it sees only its own HTML, its own call results and
  the host context (see APPS.md), nothing else.
- **A page taking the keyboard (Chromium).** A sandboxed page may call `focus()` on its own input with no tap on Chromium
  engines (Chrome, Edge, Brave, Android Chrome), so a page doing it on a timer received what the owner typed into the
  message box. Seen with Playwright Chromium 156 on loopback; Playwright WebKit did not lose focus. (1) **No tap before a
  page card runs, by the owner's choice (2026-11-18 05:39):** "There's no need for the user to go click Run... They want to
  see the HTML file, or they wouldn't have asked for it." An HTML page card runs its page at once on every engine, in the
  same sandbox as before (`allow-scripts`, opaque origin, unchanged); the Chromium-only "Run page" tap is gone. **Accepted
  residual risk:** on Chromium a page that steals focus as soon as it loads, from any sender, can take keys the owner types
  into the box until guard (2) holds it: up to three keys before the frame is hidden (the spec allows three); about one
  key per steal for a page that steals slower than three times in ten seconds, which is never held; and, open-ended, every
  key until the owner taps the box again when a page's first steal lands just after the pointer arrives over it, or on a
  touch screen in a pause of 1.5 s or more in the owner's typing, while the browser's activation is live (all three under
  **Not covered** below). Before, each of these needed the owner's Run tap; now any sender's page card can try them. The hold numbers (three hand-backs in ten seconds) are pinned by a unit test, and a spec drives a
  stealing page card with no tap. iPhone, the Mac app and other WebKit shells are unaffected. (2) On every engine
  except WebKit, every sandboxed frame, page card or app view, passes through `apps/web/src/ui/frameFocusGuard.ts`: when a frame takes
  focus from a text field the owner had, focus goes back to the field, and a frame handed back three times in ten seconds is
  hidden behind a notice with a "Show page" button (the button exists only after the third hand-back). A frame handed
  back in the last ten seconds gets none of the exemptions below, Tab included. A frame that takes focus while the window
  is in the background is handed back on return, so clicking into a frame to come back to the window is handed back, and
  the frame is then on notice for ten seconds: further clicks in that time are handed back too, and three in ten seconds
  hide it. A click is not fought when the owner tabbed in, or when the mouse moved into the frame after the owner's last
  key or tap in the host. That "moved into" is a pointerover whose position differs from the last one the host saw, taken
  only when the pointer lands on a frame from the page or from outside the window (leaving a frame does not count, and
  neither does moving from one frame straight into another, because the host sees nothing of moves inside a frame and its
  position is stale then); a pointerover with no movement, which is what a
  view's cover lifting under a parked pointer produces, does not count, and a position the host has not seen yet counts as
  not moved. A pointer that merely rested over the frame while the owner typed is believed again only after five seconds
  without host input. Every exemption (arrival, resting pointer, touch pause) also needs `navigator.userActivation.isActive`
  to be true, which a click or tap inside the frame gives for about five seconds and a script on a timer does not (a
  browser without that API keeps the older behaviour; tested through the real install function). Typing also sets it, so
  within about five seconds of a key the flag cannot tell a script from a click. On a touch screen a click is not fought
  when the host saw no input for 1.5 s and the browser saw a gesture. A different box that gets focus (by the owner or by a script
  of the host) counts as the owner's last input at that moment; the same box announced again (window or tab return) does not. Input means keys, taps, and the input and composition events that dictation
  and IME text produce. The guard is told about the box that has focus when it is installed (and that moment counts as the
  owner's last input, so a touch screen does not read the first steal as a tap after a pause), and SandboxedFrame installs
  it in a layout effect, so a view that arrives while the owner is typing is covered. Focus on a button in the open-link
  sheet makes the guard forget the box until the owner is in it again; a spec shows that after the sheet is cancelled and
  the owner types in the box, a view that then takes focus is handed it back and held. Focus in the sheet while it is open
  was not tested. **A well-behaved page can be bounced:** a click into a frame is handed back when the pointer was already
  resting over it and the owner typed in the box afterwards (this includes a frame that appears or grows under a still
  pointer after typing), when a phone tap follows typing within 1.5 s (a swipe within 1.5 s before the tap counts as
  input too, not only typing), when a finger tap on a touchscreen laptop takes the mouse path, when the pointer moves
  from one frame straight into another, when the click
  returns to the window from another app, and during the ten seconds after a hand-back of that frame (notice is per frame, not for all frames). Before the first hand-back,
  moving the pointer out and back in, or waiting five seconds, gets a mouse click through. After a hand-back the frame is on
  notice: wait ten seconds, or, once it has been hidden (three hand-backs), use "Show page". Waiting ten seconds is not always enough: typing in the box during the wait with the pointer parked still bounces the click until the pointer moves or five quiet seconds pass. A view that calls focus() in its own touchstart or pointerdown after a pause is bounced on a touch screen, because the browser reports touch activation on release, after the guard has looked. **A bounced click also loses
  the view's gesture.** The hand-back happens before the mouse button comes up, so the view's own click handler sees no
  frame focus (`gesture.ts`), the host sends `user_gesture: false` and the bridge refuses the call with "That needs a tap."
  The fullscreen request no longer rests on the gesture (it waits for a tap on a Talos sheet), so a bounce costs only the
  rate-budget hint. The frame is then on notice for ten seconds, and three such
  clicks hide it. A click with real activation cannot be told apart from a script's focus() inside the first five
  seconds, so this is a limit, not a bug to fix: after a bounce, wait ten seconds and click again. This chain was read
  from the code, not driven in a real browser. WebKit is left alone: Playwright WebKit did not lose focus,
  and a hand-back there could cost the owner a tap.
  **Not covered:** a key can slip through in the instant before each hand-back (up to three in the test, then the page is
  hidden); a page that steals slower than three times in ten seconds is never held and costs about one key per steal;
  a frame that takes focus the first time just after the pointer arrives, or on a touch screen after a 1.5 s pause in the
  owner's input, cannot be told from a click or tap while the browser's activation is live (about five seconds after any
  click, tap or key), because the host sees neither inside a frame, so the first such steal inside that time wins and then
  holds the keyboard, with no further focus change for the guard to see, until the owner taps the box again; a page that
  tries once every ten seconds or so is never on notice, so on a phone one try sooner or later lands in such a pause; after
  it, a steal with no gesture is handed back; Firefox is untested; real Chrome with a window, Android (including a keyboard dismissed with
  the back button) and the apps were not tried; the background-window path is covered by a unit test with simulated events,
  not by a real window switch; and a page card, which runs with no tap, can still use the WebRTC route above.
- **Frame navigation.** The Talos web app's own policy (`frame-src 'self'`) confines a frame that navigates itself to the relay's
  own addresses. This is an **INFERENCE** from the browser's behaviour. As a second layer, a second load of the
  frame tears the view down.
- **Messages to the agent.** A view can forward content it holds with `ui/message`, only after your tap on a Send button in a sheet that Talos
  draws outside the frame with the text in it. The agent gets it wrapped and marked untrusted.

### Data on disk and on the relay

| Where    | What                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay    | The app's HTML as encrypted media, with the 7-day buffer. The input and result of the call that showed the view, inside the stored reply (encrypted at rest, 7 days). Results over 128 KiB are stored as a JSON file for 7 days.       |
| Relay    | Counts only in logs; never arguments, text or results. The approval screen says "Results this app shows are stored on your relay for 7 days", and "ask each time" turns each `app_show` into a card.                                   |
| Mac      | The history store (as for messages). Under `$TALOS_APP_HOME/apps/`: `captures`, `pending`, `claimed`, `resources` (directories 0700, files 0600), `catalog.json` (0600) and `scan.log`.                                                |
| Mac      | Captures exist only for tools that have an app, or for claimed app requests. They live at most 15 minutes, 64 MiB in total, and are pruned at bridge start, every 5 minutes, and when an app is shown or a request resolves.           |
| Mac      | Bridge logs name view ids, server, tool, decision, code, byte count and a hash of the arguments. Never arguments, text, results or header values.                                                                                      |
| Keychain | OAuth tokens and client registration, remote server settings (URL and headers) and the HMAC key used to fingerprint them, as generic-password items with service `talos-app.direct`. Never in a file, a log, the catalog or the relay. |

Claude Code itself saves an oversize tool result under the session's `tool-results/` folder. That file is Claude Code's,
is outside Talos's retention rules, and is readable by the agent like any session file.

### Dictation audio (archived 2026-11-19)

Dictation was removed ([archived/voice.md](archived/voice.md)); this is how it handled audio while it existed.

Dictation (the composer's dictate button) sends the owner's recording to the relay, which forwards it to OpenAI to be
turned into text. The audio passes through the relay and OpenAI sees it; the relay keeps none of it: it is held in memory for
that request only, never written to disk, the media store or the database, and the relay's logs hold only byte counts and
status codes (no audio, no words, no key). The route needs the owner's session on a pinned device and the CSRF header, has an
hourly rate limit and a daily size cap, and the words it returns are shown in the message box as untrusted display text: they
become a message only when the owner taps Send. What OpenAI does with the audio is governed by the owner's own OpenAI account
terms. The app keeps a recording in memory (not storage) while a transcription is retried, and drops it on leaving the thread
or when the session ends.

### Known residuals

These are stated as they are. None is hidden behind a control that does not exist.

1. **No address check on the MCP connection itself; DNS rebinding is closed only for the `apps login` requests (Low to
   Medium severity).** What is checked: every request of the sign-in flow (`apps login`, and the OAuth discovery and token
   refresh the connector makes for a server that uses OAuth). The guard resolves the host (all A and AAAA answers) and
   refuses any address in the shared web-address list (`packages/protocol/src/address.ts`: loopback, private, link-local,
   shared-address, unique-local, multicast, documentation, IPv4 benchmarking (198.18.0.0/15), IPv6 benchmarking
   (2001:2::/48), Teredo and discard ranges, and the IPv6 forms that carry an IPv4 address: mapped, compatible, NAT64,
   6to4) before each request and before following each redirect. Each request is then sent over a connection whose own
   name lookup runs the same check and hands the socket only an address that passed
   (`packages/protocol/src/guarded-fetch.ts`), so a name whose DNS answers change between the check and the connection is
   refused. Each request uses a fresh connection, has an overall time limit, and follows no redirect on its own.
   **What is not checked, and so has no address protection at all (not only a rebinding gap):**
   - the MCP endpoint itself, for every server. The SDK sends it through the plain fetch;
   - all traffic to servers with no sign-in or with fixed headers: the verification connect during `apps scan`
     (`scan.ts`, which connects before any sign-in) and every call the connection pool makes afterwards. A server like
     that can be, or can later be pointed at, an internal or metadata address and is still contacted;
   - the MCP path has no https rule, so a plain `http://` server gets no certificate check and no encryption.
   - MCP traffic has no body size cap. The SDK reads each response with `response.json()` through the plain fetch
     (`streamableHttp.js`), so a server that sends an endless response is read without limit. The 60 s call timeout
     does not stop it: the read outlives that timeout and ends only at the connection's idle close, about 5 minutes
     later.

   A hostile or changed server entry is therefore contacted without an address check. We have not routed MCP traffic through the guarded fetch: it does not follow redirects (some servers redirect `/mcp`) and
   its time limit does not suit a long-lived stream, so that needs its own change. We have not measured what could be
   learned from such a request. The sign-in page address printed for you to open is syntax-checked and shown, not
   contacted.

   Local servers: the approved server's own origin skips the address check and may use http. This applies to
   `localhost` and loopback addresses only (127.0.0.0/8, `::1`), and the rule is the same in `apps login` and in the
   connector's sign-in requests (one function each side, one corpus test that they agree). A LAN address (10/8,
   172.16/12, 192.168/16, fc00::/7) is not exempt: login refuses it, so no token can exist for a real LAN OAuth server,
   and exempting it in the connector would only let a token carried over from an earlier URL go over plain http to a new
   one. A name is never local by its looks, and no blocked literal is: the cloud metadata address (169.254.169.254, also
   in its mapped, NAT64 and 6to4 forms, and the IPv6 one inside fc00::/7), other link-local addresses, shared-address
   (100.64/10), 0.0.0.0 and multicast are refused like any other address (tested through the real connector:
   `apps/bridge/test/apps/connector-address.test.ts`). Side effect: a fake-IP proxy that answers with addresses in
   198.18.0.0/15 makes `apps login` fail, and `::ffff:8.8.8.8`-style addresses are judged by the public IPv4 inside and
   allowed.

2. **Keychain items are readable by the agent's own shell.** The wording we stand behind: Talos keeps app sign-in tokens
   and server headers in your login Keychain so they stay out of files, backups, sync folders and commits. The Keychain
   does not hide them from the agent: it runs as you, and any program running as you can read these items without a
   prompt. Talos adds a deny rule for the plain `security find-generic-password` command, which stops the obvious form
   only; the same command wrapped in `sh -c` or run from a script still reads them (tested). **The deny rule is a speed
   bump, not a control.** This was tested in gate G9 on a throwaway keychain, and the real login Keychain was not used
   for that test. Treat these secrets as readable by the agent. (The same headers already sit in Claude Code's own MCP
   config or environment, which the agent can read too.) Opt-in hardening, off by default: skip `apps login`, or run
   `apps logout <server>`, for servers whose tokens matter (their app-only buttons then stop and their read-only buttons
   ask each time); give such servers tokens scoped to what the app needs; or run the agent folder with Claude Code's Bash
   sandbox, which may block `security` from reaching the Keychain (**INFERENCE**, not tested). Locking the item's access
   list to the bridge is not offered: it is untested, likely weak (the list binds to a program file the agent can also
   run), and it raises Keychain prompts on your screen.
3. **A mislabelled write tool gets no per-call card.** If a server marks a write tool read-only, that tool runs with no
   card inside the approval you gave. The call-time label check catches a label that changes after you approved it. It
   cannot catch a label that was wrong from the start, and it does not exist for stdio, in-process and claude.ai servers
   (they run on the labels you approved unless strict mode is on).
4. **Results of agent-path calls are stored on the relay for 7 days**, encrypted, as part of the view's stored reply. The
   approval screen says so, and "ask each time" makes every show a card.
5. **A tap inside a view cannot be told from the view acting alone.** `user_gesture` rests on the browser's transient
   activation, which is page-wide and lasts 5 seconds, and a view can call `focus()` on itself within that window to make
   a real focus change into its frame. On iOS Safari a tap inside a cross-origin frame never reaches the host at all, so
   reading gestures cannot fix this. So the flag is only a hint for the rate budget (6 a minute when there was no tap), and
   nothing that sends or changes anything rests on it: every `ui/message` waits for the owner's tap on a Send button in a
   sheet that Talos draws outside the frame, with the message text in it, and the bridge refuses the message without a
   signed `owner_confirmed` (`needs_confirm`); a view's request for full screen waits for a tap on an Allow button in the
   same kind of sheet; an app's write always gets its card, trust mode or not. Reads are unchanged. The sheet is fixed to
   the bottom of the viewport above everything (the fullscreen overlay too), with a backdrop that takes every tap, so
   nothing a view does (resize its frame, scroll itself) or the page does (a new reply, a layout shift) can move a
   button under the finger. Its main button also ignores press, click and Enter or Space for 600 ms after the sheet opens
   and again after the visual viewport resizes or scrolls (the iOS keyboard, a pinch). "Stop asking" mutes a view's
   questions until it is closed and reopened.
6. **Claude Code's own oversize tool-result files are outside Talos retention.** See above.
7. **A failed app-requested call shows the agent the server's error text.** Claude Code's `PostToolUseFailure` hook receives `error` (not a
   result) and can only add context, so Talos cannot swap in the handle. The app is told `tool_failed` and never sees the error
   text, but the agent does. This follows from the hook schema in the pinned SDK and the installed Claude Code; a live
   session check is smoke item S11.
8. **The apps switch and hooks.** Switching apps off (`bridge.env` wins over the shell) stops the post hooks and removes open views,
   but the gate hook keeps running on approved servers' tools until the scan's hook entries are removed.
9. **The Mac app's updater runs git in a folder an agent can write to.** The app's own git calls in the checkout (AutoUpdater, and CloneProvisioner for a folder that was already there) come after `auto-update-apply.sh --preflight`, which refuses a checkout that is not a plain clone (its own config keys, grafts, shallow, alternates, replace refs, a `.git` that is a link) or has changes of its own; a refusal (exit 20) stops the update with the script's reason in plain words. Each call then runs hardened (`HardenedGit`: no fsmonitor program, no hooks, no commit graph, no alternate-refs command, no background maintenance or gc, `--git-dir` and `--work-tree` named outright, an environment built from nothing: a fixed system PATH, HOME, the locale, TMPDIR and proxies, an empty alternates list, no system or user git config, no prompt). What is resolved by full path: git (`/usr/bin/git` when the Command Line Tools are installed, else `/opt/homebrew/bin/git`, never found through PATH; the apply script is handed it with `--git`), the script's own `env` (`/usr/bin/env`), and the apply script itself and the release's `install.sh --check-only` and the swap, which all run with a fixed PATH (the system folders, then git's folder, and only for the modes that install packages the login PATH's folders after those) so a program in `~/.local/bin` or `/opt/homebrew/bin` never stands in for env, mktemp, grep or dirname. The script takes grep, mktemp, rm, mv, awk, ps, sleep, seq, bash, open and osascript from /usr/bin, /bin, /usr/sbin or /sbin only (`tool()`). The app's own copy of the script is the only one used; the checkout's is never run, and neither is the checkout's `install.sh`: the zip is checked by the release commit's `install.sh`, read out of the object store, after HEAD is shown to be in the release's history. The release's commit is fetched from the public repository's explicit https address (`-c protocol.allow=never -c protocol.https.allow=always`, no credential helper, askpass or ssh command), never from the checkout's `origin`; the same address goes to `--prepare` as `--repo-url`, both `--restore` calls carry `--commit`, and HEAD must equal the release's commit right before the swap. This is a tripwire, not a wall: the write guard on the checkout's folder is the main protection, and the sha256-pinned archive checkout (no `.git`) is the real fix.

## Checking it on a real agent (manual, on your Mac)

Automated tests cannot tell what a real model does with hostile text. After deploying, send the injection samples
(`e2e/tests/05-hooks.spec.ts` contains the corpus: fake end markers, "ignore previous instructions", a forged
`</channel>` tag, special tokens, full-width markers) through a generic webhook to your real agent and confirm it
summarises them without acting. Record the result here:

| Date        | Agent and model | Result |
| ----------- | --------------- | ------ |
| not yet run |                 |        |

The MCP Apps injection corpus (hostile app text, forged "app request" notifications, forged oversize-result text) is run
through the same kind of real agent as smoke item S7 in the manual smoke list for apps. It has its own
result table there, also "not yet run".

## Folder listing (the folder picker)

The Folder box of a thread's own session has a Choose… button (docs/desktop.md, "Choose… for a thread's folder"). In the browser and on the iPhone it asks the Mac
for folder names with a signed `fs.list` read (`packages/protocol/src/folders.ts`, `apps/bridge/src/folders/service.ts`).

- **Who may ask.** Only a pinned, unrevoked owner device, with a signature over the raw frame, inside the same freshness window as the other
  signed reads, once per frame id (`inbound-reads.ts`, `onReadFrame`). An unsigned or forged frame, an unpinned or revoked device and a replay
  get no names. The relay routes the answer to the asking socket only and stores nothing. It is not an agent tool, is in no agent
  instruction, and a thread session's process never installs the lister (`bridge.ts`: live main bridge only).
- **What it returns.** Folder names, sorted, at most 500 (the count of the rest is sent), and the owner's home and the agent folder as paths.
  Never a file, a size, a time or a content. A name with a control character, or that is not valid text, is left out; a name with a hidden or
  direction-changing character is sent as it is and the app spells the character out (`dialogVisibleText`).
- **What it refuses**, always with the same sentence, so a refused folder, a missing one and a file read alike: a path that is not absolute,
  has `.` / `..` / empty segments, a control character or broken text; anything outside the owner's home; any root in `folderRefusedRoots`
  and anything under it. That list is the lead fence's own (`defaultLeadRoots` in `apps/bridge/src/lead/fence.ts`: the agent folder, the
  Claude config folder and its global files, the Talos home, the vault, `~/.ssh`, `~/.config/gh`, `~/.aws`, `~/.npmrc`, `~/.netrc`) plus
  `~/.gnupg`, `~/.config/talos`, `~/.talos-inbox`, `~/Library`, `~/.docker`, `~/.kube`, `~/.config/gcloud`, `~/.azure`, `~/.codex`,
  `~/.gemini`, `~/.password-store` and `~/.local/share/keyrings` (`FOLDER_EXTRA_REFUSED` in `apps/bridge/src/folders/service.ts`).
  Matching ignores letter case and treats `/private/tmp` and `/tmp` alike.
  A refused root is also left out of its parent's listing.
- **Symlinks.** Every step from home to the folder is checked with `lstat`; a path through a symlink is refused, and a symlink is left out of
  every listing, so a link to a folder inside home, to somewhere outside it, or to a refused root can never be entered from the picker.
- **Time and the event loop.** The listing is read in turns (`fs.promises`), never in one blocking call, with a real two-second timer: a
  folder that is slow to open or never opens is answered "This folder is slow to open." and given up on. A folder the system will not let
  Talos open (macOS privacy folders such as Documents, Desktop and Downloads when Talos has no grant, or a file mode) answers "macOS
  hasn't given Talos access to this folder." That is a different sentence from the refusal, and is only ever said for a folder that is
  not on the refused list. I could not try a real privacy prompt on this Mac; the tests use a folder with mode 000, which fails the same way
  (EACCES, and EPERM from macOS is treated alike).
- **Spellings.** Paths are compared in composed Unicode (NFC) and with case folded the long way (`.ſsh`, `.SSH` and `.ssh` are one name),
  and the folder is also judged by the spelling the disk gives back (`realpath`), and again after it was read, so a folder swapped for
  another place in between returns no names.
- **The save path agrees.** A thread's folder is refused when it is a refused root or inside one, however it was chosen (typed, the app's
  browser, or the Mac's open panel), with the same sentence and the same list (`apps/bridge/src/worker/patch-check.ts` reads `folderRefusedRoots`). The
  Mac app's supervisor still re-checks the folder before every start, by its own rules (a refused root is not among them yet).
- **What the app trusts.** The answer is carried by the relay, so the app saves the path it asked for, never the one the answer names,
  drops an answer for another path, pins the Mac's home from the first answer, and leaves out any name that is not one folder name.
- **What the picker does not do.** It writes nothing. The folder it hands back goes through the existing owner-signed thread patch, where the
  Mac checks it again (`apps/bridge/src/worker/patch-check.ts`). In the Mac app the open panel is the Mac's own and only returns a path to the page.

## Agent folders (a thread's folder, read-only)

Memory's agent folders (once the Files pane beside a thread, `apps/web/src/features/memory/AgentFolders.tsx`) show the folder a thread's
session works in, read-only, with signed
`files.list` and `files.read` reads (`packages/protocol/src/files.ts`, `apps/bridge/src/files/service.ts`). It was reviewed on 2026-11-11
before it shipped; each finding of that review has a test in `apps/bridge/test/files-service.test.ts` ("the review of 2026-11-11").

- **Who may ask.** Exactly as for the folder picker: a pinned, unrevoked owner device, a signature over the raw frame, fresh and once
  (`inbound-reads.ts`). The relay routes the answer to the asking socket only, by request id and answer type, and stores nothing; it limits
  the reads to 240 a minute per socket (`files`). It is no agent tool and in no agent instruction; only a live main bridge answers.
- **Which folder.** The Mac decides from the thread, never the app: a thread with its own session shows its own folder
  (`session_opts.cwd`, else the agent folder), by the supervisor's own rules (`dedicatedThreads`); every other thread, Main included, the
  agent folder (`apps/bridge/src/files/wiring.ts`). A thread folder with a hidden name anywhere in its real path (`~/.config`) or inside a
  refused root shows nothing.
- **What it refuses**, always with the one sentence, for a missing path and a refused one alike and whatever the disk said: a path that is
  absolute or has `.` / `..` / empty parts, a control character or broken text; a hidden name in any part (a dot-name, so `.env*` and `.git`,
  or `node_modules`, in any letter case), as asked and in the real path below the folder; a real path outside the thread's folder (a link
  that leaves is refused, one that stays inside is followed); the Talos home, the Claude config, the lead fence's secret stores and
  `FOLDER_EXTRA_REFUSED` (which holds `~/Library`), inside the folder too, checked on the path as written before the disk is asked (no
  "no access" answer for what sits there); and what a `.talos-lead` marker at or above the folder protects (a marker that cannot be read
  refuses everything, as for `attach`).
- **Reading a file.** Through one handle opened with no link followed in any part of the path (`safe-open.ts`) and checked by where the
  kernel says it is; it must be a regular file with one name: a hard link to a file outside, or to `.env` inside, passes every path check, so
  a file with more than one name is neither listed nor read. A named pipe never blocks. Reads run on the thread pool (a file iCloud still has
  to download, or a stalled network disk, never freezes the bridge), at most four at once, with a three-second limit; work past the limit
  stops at its next step, and an image is never uploaded for an answer that timed out.
- **What it returns.** A listing: names, folder or file, file sizes, cut to the 1000-entry cap and to one frame. A file: text in chunks
  (up to 2 MB in all, each chunk fitted to one frame as JSON), an image uploaded as an attachment (up to 10 MB), or nothing but a sentence
  for a file that is not text.
- **What the app trusts.** The answer must be for the thread and path asked; a hidden or malformed name in it is dropped, an unknown kind is
  shown as a file that cannot be displayed (`apps/web/src/lib/socketFiles.ts`).
- **Accepted limit.** A listing reads the folder by name: a writer inside the folder who swaps a sub-folder for a link to another place and
  back between the checks before and after can have a few names and sizes of that place listed (never its contents: a read goes through the
  fenced handle). That needs write access inside the thread's folder, which that thread's own session has anyway.

## Upload into a thread's folder (the agent folders)

Memory's agent folders can add a file to a thread's folder (`packages/protocol/src/frames-files-put.ts`,
`apps/bridge/src/files/put.ts`). It adds; it never changes or deletes. A file put there is content the agent will read: the same exposure
as an attachment in a message.

- **Who may put.** A pinned, unrevoked owner device, a signature over the raw frame, fresh and once (`files.put` runs on the read queue
  like the Files reads). The file goes up the media path first (POST /api/media, the 50 MB cap); the Mac fetches it and checks its size and
  sha256 against the signed ref, in memory. The relay routes the request to the Mac and the answer to the asking socket only, and keeps
  neither frame (`apps/relay/test/core/files-put-relay.test.ts`); the uploaded bytes stay in its media store like any attachment's, for
  the attachment retention period. It is no agent tool; only a live main bridge answers. An upload runs beside the Mac's queue of signed
  reads (verified and marked seen first), so a 50 MB download never holds a search or a listing; the app and the relay wait two minutes
  for its answer, and the app lists the folder again either way.
- **Which folder.** The Files pane's fence (`FilesService.fencedDir`), taken after the download (a marker added meanwhile counts): a plain
  folder inside the thread's folder by its real path, not hidden, refused or protected by a `.talos-lead` marker, and each name in it
  checked against the same rules.
- **Which name.** One plain name: no separator, control character or broken text, at most 255 bytes, no space at either end; never a hidden
  name (a dot-name, `node_modules`), and never an instruction file Claude Code reads (AGENTS.md, CLAUDE.md, CLAUDE.local.md) or `.claude`,
  in any letter case and as a disk that ignores case folds it (NFKC, then upper- and lower-cased, so `AGENTſ.md` with a long s, which APFS
  opens as AGENTS.md, is refused too). After the create, the new file is compared by inode with each of those names in the folder, so a
  fold this list does not know cannot make an instruction file either. Instructions are edited in thread settings, not dropped in.
- **Never over a file.** The file is created with `O_EXCL` and no link followed anywhere in its path (`safe-open.ts`, checked by where the
  kernel says the handle is): a file or a link already at that name is never opened, and a folder swapped for a link fails the create. A
  taken name becomes "name (2).ext", up to 99 tries. A write that fails, or a create the handle check then refuses, removes the file it
  created. On Linux there is no O_NOFOLLOW_ANY (only the last name is checked at an open by path), so the create goes through a handle
  on its folder instead: the folder is opened and checked first (its handle must be at its path), and the file is created inside that
  very folder through `/proc/self/fd/<folder>/<name>` with O_NOFOLLOW, which is openat in effect. A folder swapped for a link before
  the create is refused at the folder's open, and nothing is made outside. The one ordering left, the checked folder itself moved
  elsewhere after its check, makes the file inside that moved folder; the file's handle check refuses it, and it is removed through the
  same folder handle (never by a path, which a second swap could redirect to someone else's file of the same name), and only if it is
  still that file, regular and empty. On macOS O_NOFOLLOW_ANY refuses a link anywhere at the open; a real folder renamed into place
  passes it, and there the file is left where it landed, empty, and the bridge log says where (macOS has no handle path to remove it
  through safely). Review of 1502cd06 (Cyclops, Fable).
- **Limits.** 50 MB a file, two at once, and 1 GB a device a UTC day: reserved before the download and given back on a failure. The day's
  count is kept in memory: a restart of the bridge starts it again.
- **What the app trusts.** The answer must be for the thread and folder asked, under one plain name, with the size sent, or it is
  refused (`apps/web/src/lib/socketFiles.ts`). Reviewed on 2026-11-11 before it shipped; each finding has a test
  (`apps/bridge/test/files-put.test.ts`, "the review of 2026-11-11").

## Files: the files sent in Talos (a list from history)

The Files sheet (and the Files pane on a wide screen) lists the files sent in Talos, by the owner or an agent, across every thread
(`packages/protocol/src/frames-files-sent.ts`, `apps/bridge/src/files/sent.ts`). It lists what the timeline already shows; it reads no
folder and no file.

- **Who may ask.** A pinned, unrevoked owner device, a signature over the raw frame, fresh and once (`files.sent` runs on the read queue
  like search). The relay forwards it, under search's rate bucket, and the answer to the asking socket only, and keeps neither.
- **Which files.** Every attachment of every message in a thread the Mac lists now (archived and sub-threads included): a message whose
  thread is no longer listed (deleted, or an id a peer made up) adds nothing, even when asked for by id. Voice notes and spoken replies are
  messages, not files. It reaches back as far as the Mac's message history (90 days by default) and says so at the end of the list.
- **The query.** The owner's name filter never reaches SQL: it is matched on each file in code (Unicode-folded), so `%` and `_` are
  characters; thread ids, the sender and dates are bound parameters (dates compared as times). One statement per page reads the
  messages newest first in the order of an index (`messages_time`), and a damaged row is skipped. Pages go by position (time, message
  id, attachment index) in an opaque cursor, never an offset; a cursor the Mac did not make is refused. A page is at most 50 files and
  reads at most 5,000 messages with files before it answers with a cursor (well under a second on 400,000 messages).
- **What the app trusts.** Each row must parse as the protocol's `SentFile` and name a thread this device lists, or it is dropped
  (`toFilesSentPage` in `apps/web/src/lib/socketFiles.ts`); the list is asked for each time it opens and never kept.
- **Opening a file.** A row is a link to the same `/media/:id` (a page: `/media/:id/page`) the timeline uses, under the same session
  cookie and CSP. An old file the relay no longer holds is asked back from the Mac (`media.fetch`), as the timeline does; a file the Mac
  removed (Settings, Storage) is listed greyed and never asked for.

## A thread's instructions (AGENTS.md, an owner edit)

Thread settings can edit AGENTS.md in the folder of a thread with its own session (`packages/protocol/src/frames-agents-md.ts`,
`apps/bridge/src/files/agents-md.ts`). Claude Code loads it beside CLAUDE.md in thread sessions (`withInstructionFiles`), so a save shapes
that thread's next sessions: it is a prompt-injection surface, and it is treated as one.

- **Who may save.** A pinned, unrevoked owner device, a signature over the raw frame, fresh and once (`agents_md.read` and `agents_md.write`
  run on the same read queue as the Files pane, `inbound-reads.ts`). The owner's call: no passkey step per save, and no card even in trust
  mode. The same signed save sent again is refused. It is no agent tool and in no agent instruction; only a live main bridge answers.
- **Nothing kept on the way.** The relay routes the request to the Mac and the answer to the asking socket only, by request id and answer
  type; it stores none of it and replays none of it to another device or to the Mac reconnecting (`apps/relay/test/core/agents-md-relay.test.ts`).
- **Which folder.** A dedicated thread's own folder only, by the supervisor's rules (`agentsMdFolderFor`). Never the shared agent folder,
  even for a dedicated thread that runs in it, nor a folder that holds it: a save there would be Main's and every shared thread's
  instructions too. (A sub-thread's folder inside its parent's is meant to read the parent's file.) Inside the Files
  pane's fence (`FilesService.fencedName`): not in a hidden or refused place, and not what a `.talos-lead` marker protects.
- **The file.** Read through one handle with no link followed anywhere in its path, a regular file with one name: a link, or a hard link to
  a file elsewhere, is neither read nor replaced. At most 64 KB; a larger file is shown as too large and cannot be saved over from here. A
  save is written to a new file in the same folder (created, never an existing one) and renamed over AGENTS.md, and only when the file is
  still the one the editor loaded (`base_sha`), checked again just before the rename: a change made meanwhile is refused, never lost. A
  file that is not UTF-8, or that would not fit one answer as JSON, is not opened here (decoding would change it, and a save write that
  back). The same save sent again after its answer was lost is answered as saved.
- **The agent may edit it too.** Its agents are expected to keep their own instruction files, so nothing refuses an edit made outside
  Settings. The Mac keeps, under `<talos home>/threads/<id>/`, the text before each save (`agents-md.prev`), the text of the last save
  (`agents-md.saved`) and the folder those are for (another folder's records do not count). Settings shows a change made elsewhere as a diff against that save, and the next start of that thread's session posts
  one quiet system line in the thread (it never holds the start, and says so once per change).
- **What the app trusts.** The answer must be for the thread asked, with text within the cap whose sha256 is the sha it came with (a relay
  that slipped lines in under the file's real sha would have the owner sign them in the next save), and a save's answer must be the text
  sent, saved. Anything else is refused, never shown or saved over (`apps/web/src/lib/socketAgentsMd.ts`). Reviewed on 2026-11-11 before
  it shipped; each finding has a test (`apps/bridge/test/agents-md.test.ts`, "the review of 2026-11-11").

## The bug report webhook address (an owner setting)

Where the relay announces a new bug report (`bug_webhook_url`, a Standard Webhooks call signed with the relay's
`BUG_WEBHOOK_SECRET`) can be set in the app (Settings > Bug reports) as well as in config.json at the Mac. Reviewed on 2026-11-11
before it shipped; each finding has a test (`packages/protocol/test/bug-webhook.test.ts`, `apps/relay/test/review/bug-webhook-setting.test.ts`).

- **Who may set it.** The owner's signed device with the passkey step every time: trust mode does not skip it (it is where reports
  leave for), and clearing it asks too. The agent cannot: `config_propose` refuses it by name.
- **Which addresses.** One rule for the app and the relay (`bugWebhookUrlOk`): https on port 443 or 8443, no `user:pass@`, no IP
  literal outside the public internet, no name that is never public (`localhost`, `.local`, `.internal`, `home.arpa`, `.lan`,
  `.corp`, `.intranet`, a single label). The relay refuses an address that fails it before the patch reaches the Mac, and checks
  again where a name resolves when it connects (DNS rebinding). No redirect is followed; the whole exchange has a time limit and
  the answer body is never read.
- **Never back to a device.** The address may carry the receiver's token, so devices are told only its host, with any label that
  could be a secret (16+ characters, or 6+ digits) shown as `…`. The patch that set it is stored for the Mac only, so catch-up
  never replays it to a device.
- **What it carries.** The report without its picture (the Talos team's inbox, below, gets the picture too), with every text run through `talos-app report`'s redaction again
  (`redactReport`), each cut back to its limit. The redaction also takes out Slack and Discord webhook paths and signed-URL values, secret-named query-string values (`?api_key=`, `&token=`, `&sig=`), `curl -u user:pass` / `--password` / `--token` values, and secret-named headers. The same cleanup runs on the command of every always-allowed pass before it is stored, logged or shown in the thread.

## The bug inbox (reports from other installs)

The Talos team's relay can take bug reports from other people's relays (`POST /api/bug-inbox`, `apps/relay/src/core/bug-inbox.ts`)
and file each as a problem on its Mac. It is outside input from end to end.

- **Off by default.** Without `BUG_INBOX_SECRETS` the route answers 404 and reads nothing. A sending relay sends only when it has
  `BUG_WEBHOOK_SECRET` and an address (`BUG_TEAM_INBOX_URL` at deploy, or the owner's own `bug_webhook_url`).
- **Who sent it.** One secret per install (`name=whsec_...`), so the name in the errors list is proven by the signature that
  checked out, never read from the body, and one install can be cut off alone. A device id in the body is dropped.
- **What is refused.** Before the body: a per-address bucket (`bug_inbox_ip`, 30 a minute), missing or malformed Standard
  Webhooks headers, a timestamp more than 5 minutes off, a body over 8 MiB. After it: a signature no install's secret makes
  (compared in constant time), a body that is not `bug.reported` in the bounded shape, an install over its bucket (`bug_inbox`,
  30 an hour), a picture over 5 MiB, not plain base64, or whose first bytes are not the PNG or JPEG it claims, and a report id
  this install sent before (kept 90 days).
- **What goes on.** What the person typed, versions, recent errors, the cleaned log, the thread and screen, the last messages
  only when the person ticked them, and the marked-up picture. Unknown fields are dropped. Every text is scrubbed again here
  (`talos-app report`'s redaction, then the problem scrubbers) and again on the Mac; the sender's scrubbing is never trusted.
  Four switches (`BUG_INBOX_NO_SCREENSHOT`, `_LOGS`, `_MESSAGES`, `_THREAD`) leave a part out.
- **On the Mac.** A file marked `trust: external`, `source: install`, never an instruction; past the problem folder's cap it is
  refused like an automatic report (another install cannot fill the disk). A thread session's `errors show` sees the error
  lines only, and `errors list` withholds its message there too. `POST /api/problems` refuses `source: install`, so only the
  inbox makes one. An older Mac that cannot file these is not sent them (the relay waits for `problems-install/1`, for up to
  `BUFFER_DAYS`).
- **The sender's side.** The call to the team inbox carries the picture inside the one signed body; an address the owner set
  still gets text only. The reporter, and Settings > Bug reports, say which, from the relay's own answer: "your relay only",
  "then the Talos team, with the screenshot", or the webhook's host. A refused call (any status but 2xx, or 409 from the
  inbox) is logged as refused; there is no retry.

## Reporting a problem

Please report security problems privately through GitHub's "Report a vulnerability" button on the repository's Security tab, not in a public issue.
