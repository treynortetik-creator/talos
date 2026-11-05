# iPhone app push (APNs)

Native push for the iPhone app. Web push for browsers and the Home Screen app is untouched and keeps working.
Everything below is inert until the four `APNS_*` variables exist on the relay: the Settings row says "Needs setup".

## What it does

- The relay signs an ES256 token with your `.p8` key (refreshed every 50 minutes) and sends HTTP/2 requests to Apple.
- The app asks iOS for a token only when you tap "Turn on notifications". The page signs the token with the device key; the relay
  accepts it only from the pinned device, fresh within 2 minutes, once.
- The alert Apple sees is a fixed phrase (`buildApnsBody`): never message text, a card title, a sender, a subject or a thread name. A phone that has registered a notification grant also gets the words inside a seal that Apple cannot read but your Talos server can (it builds the seal), exactly as it can read your messages today (see "Message text and quick actions").
- Quiet window, per-thread notify settings, the master switch and "app is open" apply exactly as for web push.
- Web push is untouched and always sent: an iPhone that has both the Home Screen app and this app gets both, and a Mac Safari subscription is never muted. The two
  are separate devices to the relay; to stop the double buzz, turn notifications off in one of them. Settings > Notifications has a
  "Turn off" on the browser row (it unsubscribes the browser, deletes it at the relay, and is remembered on that device so the next open does not
  switch it back on), and the iPhone row says the same thing in a plain line.
- Only Apple's 410 deletes a token. `BadDeviceToken` or `DeviceTokenNotForTopic` are logged and the token is kept (they can mean a typo in `APNS_BUNDLE_ID` or the wrong host). The app re-registers its current token once per page load (and again when it returns to the front after five minutes), not on route changes, and only if you turned notifications on and did not turn them off.
- A bad or half-set `APNS_*` never stops the relay booting: it logs which variable is missing or malformed (never the value) and native push stays off.
- Signing out (or "sign out everywhere") removes the phone's token. Turning notifications off for Talos in iOS Settings makes the app tell the relay on the next open.
- Nothing a person or an agent named reaches Apple, at any setting. An iPhone push is TLS to Apple only (web push is encrypted to
  the browser), so on the APNs path every thread except the built-in General and Inbox reads "a thread", and no thread id appears
  anywhere in it (not in the alert, the deep link, the grouping id or the collapse id). Instead the relay puts in an opaque,
  random reference; tapping opens `/open/<reference>`, the signed-in app asks the relay what it means, and goes to that thread.
  A card keeps its own deep link (card ids are random). The Apple payload uses fixed strings only: the title is always "Talos"
  (never the agent's name), and General and Inbox are the words "General" and "Inbox", never the names in the config, so a renamed
  General or a renamed agent never reaches Apple. **Show thread names (Settings > Notifications) governs browser notifications and, for a phone that turned message text on, the thread name inside the seal** (never the Apple-visible part),
  and the iPhone row says so.
- Notification buttons: Open opens the card. Approve opens it armed. The arm is passed in memory by the app shell (`onNativePushAction`), never in a URL, so a link in agent text (`?arm=primary` or anything else) cannot start an approval prompt in a browser or the app. It is spent once, at one place, and lapses after two minutes. A high-risk card starts its normal Approve flow, so Face ID comes first and nothing is sent until it succeeds; any other card is shown with its button focused. The Approve button also needs the phone unlocked. Nothing approves by itself, and an expired, changed or already decided card ignores it. The app only redirects away from `/card/<id>` once a `ready` has landed (a cached snapshot never decides a card is gone), so a card that arrived while the app was closed still opens; this is shared with web push.

## Owner steps (needs the paid Apple Developer membership)

1. **App ID**: developer.apple.com > Certificates, Identifiers & Profiles > Identifiers > your app's ID (the same bundle id you put in
   `ios/Local.xcconfig` as `TALOS_BUNDLE_ID`) > turn on **Push Notifications** and **Time Sensitive Notifications** > Save. The share
   extension (`<id>.share`) does not need either. Time Sensitive is what lets an approval ("Needs you") through a Focus or Scheduled
   Summary instead of being held. `App/AppPush.entitlements` carries `com.apple.developer.usernotifications.time-sensitive`, so the
   provisioning profile must include the capability: tick it before building, and let Xcode regenerate the profile (automatic
   signing does this) or re-download it. A build whose profile lacks it can fail to sign (Apple rejects an entitlement the profile does not grant). If you skip the
   capability, delete that key from your copy of `AppPush.entitlements`; approvals then arrive as ordinary alerts that Focus can hold.
2. **Key**: Keys > + > name it, tick **Apple Push Notifications service (APNs)** > Register > download `AuthKey_XXXXXXXXXX.p8`
   (one download only). The 10 characters in the file name are the **Key ID**.
3. **Team ID**: Membership details > Team ID (10 characters).
4. **Railway variables** on the relay (a deploy; never commit them):
   - `APNS_KEY_ID` = the Key ID
   - `APNS_TEAM_ID` = the Team ID
   - `APNS_KEY_P8` = the whole contents of the `.p8` file (literal `\n` for newlines is fine)
   - `APNS_BUNDLE_ID` = your bundle id (the APNs topic; must equal `TALOS_BUNDLE_ID`)
5. **Build with push**: add one line to the untracked `apps/mobile/ios/Local.xcconfig`:
   `TALOS_APP_ENTITLEMENTS = App/AppPush.entitlements`, then `pnpm --filter @talos-app/mobile cap:sync`, rebuild and reinstall.
   Without that line the app builds as before; tapping Turn on then makes iOS say the build has no push capability and the row reads "Needs setup" until the app is rebuilt.
6. In the app: Settings > Notifications > iPhone notifications > Turn on notifications > Allow.

## Message text and quick actions

Status (2026-11-01): built end to end and tested in pieces, **not yet run on a real phone**. The relay, the Mac and the
protocol are in `packages/protocol/src/push-rich.ts`. The phone half is Swift: `TalosPushCore` (`RichPush`: open a seal, choose
the buttons, sign an action), `TalosPushShared/NativeKeyStore.swift` (keys and grant in the shared Keychain group),
`TalosPushExtension` (the notification service extension that opens the seal) and `App/Plugins/TalosQuickAct.swift` (Reply and
Approve in the background). Message text starts **off**. Turn on notifications gives the fixed phrase only, on a new phone, after Turn off then on, and on a phone
that had notifications on before this feature. The page makes the grant only when you tap "Show message text" in Settings, and
renews it on open only while you have it on (`features/pwa/nativePush.ts`). A phone with no grant, or an older app, gets the fixed phrase exactly as before.

What is proven: the Swift opens a seal the TypeScript made and the TypeScript accepts an action the Swift signed
(`packages/protocol/fixtures/push-rich`, `swift test` in `apps/mobile/ios/TalosPushCore`); the whole app and both extensions
compile for the simulator. What is not: the extension running inside iOS, the shared Keychain with a real signing team, a Reply
or Approve pressed on a real lock screen, APNs delivering `mutable-content`. Try it from a TestFlight build with the paid
push entitlement: Settings > Notifications > Turn on notifications (the row should say "Notifications show a fixed phrase"), then
tap Show message text; the row should say "Replies and cards show their words";
send a message from the Mac and expect its text on the lock screen and a Reply button; press Reply (it asks for Face ID or the
passcode) and expect the text in the thread; send a small decision card and expect Approve; send an email card and expect only
Open. If the lock screen shows the fixed phrase instead, the extension did not run or the Keychain group did not match.

What the phone has to do, and what each side checks:

1. **Grant.** Only after you tap "Show message text". The phone makes two keys that never leave the shared Keychain: an encryption key and an action key. The page
   signs their public halves with the pinned device key (`native.grant`, 30 days at most) and posts it to
   `POST /api/push/grant` (session, CSRF, single-use nonce). `GET /api/push/grant` says whether the relay holds a current one,
   never the keys. A signed `native.grant.revoke` takes it away; the Sign out button and sign-out-everywhere delete it at the relay. Idle expiry does not, and the phone only learns of it at its next open (a 401 there empties its Keychain). Until then, and after it, the relay keeps sealing text for the phone and `POST /api/native/act` accepts taps, because that route needs no session: it checks the grant, not the cookie. A grant is renewed whenever less than 20 days are left, so at the last open it had 20 to 30 days left and the session's 14-day idle limit leaves text and buttons working for about 6 to 16 more days (reasoned from the code; the cookie-free route is tested in `apps/relay/test/push/native-act.test.ts`, an expired session end to end is not). The next open after you sign in again (a signed-in device only signs in; it does not need to be paired again) takes the grant back (see below). A grant for a device the Mac revoked is never used to seal.
2. **Seal.** For a phone with a grant the relay adds `talos.enc` to the APNs body: ECDH P-256, HKDF-SHA256, AES-256-GCM, a fresh
   key per push, bound to the device, kind, card and a random push id. The alert stays the fixed phrase (it is what shows if
   the extension cannot open the seal or the seal would push the body past 3900 bytes). The sealed words for a card come from
   `cardNotice`: title, summary, destination, body, fields, warning and the button label, with invisible and direction-changing
   characters made visible. The card id, risk and hash ride in the seal only when that text is the whole card.
3. **Reply.** The extension only shows the words and picks the buttons. Pressing Reply (the phone must be unlocked) wakes the app in the background, which signs and posts `native.act` to `POST /api/native/act` with no cookie. The credential is the chain device key
   to grant to action key. The relay checks it, claims the action id (a retry of the same bytes is answered "done", the same id
   with other bytes is refused), stores the reply for the Mac and for the app, and queues it. The Mac checks the chain again
   against the key it pinned.
4. **Approve.** Offered only for a low-risk card whose notification showed the whole card, and never for a card that leaves the
   app (email, message, deploy, publish, purchase), a schedule or an app action, and never for any card that lists a destination
   (a "To:" line), whatever kind the agent gave it: those open in the app whatever risk the agent
   gave them. The phone signs `shown`, a hash of everything it displayed: the subtitle (the thread name, or none) and the body (`shownHash`, `talos-shown/v2`). The relay and the Mac each rebuild that text from
   their own copy of the card and refuse a mismatch, so a relay cannot have the phone show one thing and sign another. A card
   with an attachment or a hidden payload is never approvable here. High-risk cards need the passkey step-up in the app.
5. **Sleeping Mac.** (An Approve is also capped at 12 hours from the phone's signed time, on the Mac's own clock; the relay's stamp cannot extend that. Past it the card stays pending and you get the failed-tap push. A Reply keeps the 8-day rule.) A tap is good for 10 minutes by the phone's clock, judged at the moment the relay took it (the relay stamps
   `relay.received_at`). The Mac judges both a Reply and an Approve at that stamp, so a tap queued while the Mac slept still runs
   when it wakes (a Reply for as long as the frame is still held: the relay keeps a frame `BUFFER_DAYS` days, 7 by default, and the Mac's own outer limit is 8 days; an Approve up to 12 hours), **as long as the card itself is still alive**: a card's own expiry is
   always judged on the Mac's clock, so a card that ran out while the Mac slept is expired, not approved. (The app's own
   `card.resolve` keeps its plain 10-minute rule, measured to the Mac's clock.) If the Mac refuses a tap for any reason, the relay
   puts the card back to pending, adds a system row to the thread and sends a push ("That tap did not go through. Open Talos to
   check."), because the relay already told the phone "done" when it queued the tap. If the Mac never comes back, a Reply gets a `not_delivered` receipt and an Approve puts the
   card back to pending with a system row. A Mac that predates the feature (no `native_act/1` in its hello) gets
   `409 mac_update_needed` instead of a silent "done".

A deny-only permission card (old Claude Code, no client version, a repeated prompt, or a hidden part) is sent with the Open
category only: no Approve button on the notification, sealed or not, the same rule the app uses to show or hide Allow.

Turning message text off: Settings > Notifications > iPhone notifications has "Use a fixed phrase only" (and "Show message
text" to bring it back). Off takes the grant away on the phone first, then at the relay, and the choice is remembered on the phone
so opening the app never makes a new grant. If the relay cannot be reached when you tap, the phone is cleared at once, the row says the server has not confirmed it, and every open asks again until it does. Signing out, a blocked iOS permission or cleared page storage also put text back to off, and the next open takes any grant the relay still holds back. The row says text is on only when your choice, the keys on the phone and the relay's grant all agree. Words that are already on the lock screen or in Notification Center are taken off too: the extension marks every notification whose words it opened (`talos_text` in `userInfo`), and clearing the grant (text off, Turn on, Turn off, sign-out, a revoked pairing, a blocked permission) removes only the marked ones, never a fixed-phrase notification (`identifiersShowingText`, tested in `PushCoreTests`; that `clearGrant` calls it, in `apps/mobile/test/config.test.ts`). Limits: this works only in a build that has the marker, so a notification delivered by an older build keeps its words until you swipe it away; and that iOS hands the rewritten `userInfo` back to the app is not proven without a real iPhone. A phone that never turned text on (including one that had notifications on before
this feature) also shows the fixed phrase until you tap "Show message text".

Who can read what, plainly: **Apple cannot read the message text, but your Talos relay can**, the same as it can read all your messages
today. The seal keeps the words from Apple; the relay builds it, receives every Reply over TLS and stores events encrypted with a
key it holds itself.

What this does not protect: the relay reads every notification text and every Reply in plain text (it builds the seal, and it
receives the Reply over TLS), and stores events encrypted with a key it holds itself. The seal keeps the words from Apple. It is
not end-to-end encryption between phone and Mac.

## Passkeys in the app (WP-I6)

Risky approvals (a high-risk card, a new schedule, switching on a work integration, revoking a device) ask for the same
passkey step-up in every place. Nothing about that changes: same passkeys, same relay routes, same single-use, two-minute,
purpose-bound token. No Face ID shortcut replaces it.

What was missing: a web view inside an app can only use WebAuthn for a site the app is _associated with_. Apple's engineer on the
developer forums: "In iOS 16, passkeys can be used in a WKWebView if the client app is using Associated Domains for the relying
party." (https://developer.apple.com/forums/thread/723273). So iOS 16 or later; this app's minimum is iOS 17.0, so every supported phone qualifies.

Three pieces, all inert until set:

1. **Relay** serves `/.well-known/apple-app-site-association` with `{"webcredentials":{"apps":["<TEAM>.<BUNDLE>"]}}` when
   `APNS_TEAM_ID` and `APNS_BUNDLE_ID` are both set (the ones you already set for push; the `.p8` key is not needed for this). Unset
   or malformed = a plain 404, as before. Apple wants HTTPS, a valid certificate and **no redirects**
   (https://developer.apple.com/documentation/xcode/supporting-associated-domains). Apple's own CDN fetches it, not your phone, so
   a change can take a while to show.
2. **App build**: `App/AppPush.entitlements` (the opt-in file) carries `com.apple.developer.associated-domains` =
   `webcredentials:$(TALOS_RELAY_HOST)`. Add one line to the untracked `apps/mobile/ios/Local.xcconfig`:
   `TALOS_RELAY_HOST = <your relay host>` (the bare host, equal to the relay's `RP_ID`, no `https://`). It is not in the free-tier
   `App.entitlements`, so a free Personal Team build is unchanged. Tick **Associated Domains** on the App ID in the developer
   portal (same place as Push Notifications), then rebuild and reinstall. A debug build can add `?mode=developer` to the entry while
   you test to skip Apple's CDN.
3. **The page** (nothing to set): in the iPhone app it checks the relay's own file once at launch (so the Approve tap does not
   wait on it; WebKit can refuse a passkey prompt that comes too long after the tap), then asks for a passkey. The file is a 404
   or names no app, or there is no WebAuthn in the web view: the card says "This app can't use your passkey yet. Approve in
   Safari or the Home Screen app." and no challenge is issued. The relay not answering (offline, a redeploy) is never called "not
   linked": the step-up just runs and shows its own error. The page cannot see the app's entitlements, only the relay's file. So a
   free-tier build against a relay that serves the file asks for a passkey, the prompt is refused, and the card says: "The
   passkey prompt didn't finish. If you didn't cancel it, this app isn't linked to your relay for passkeys yet." In a browser a
   Cancel is still "cancelled", and any other failure (a rejected confirmation, a 5xx, no connection) says what it is. A push
   Approve on a high-risk card in the iPhone app opens the card with the button focused and waits for your tap, because the prompt
   needs a tap in the page. The Mac app has no passkeys and says "Approve on your phone or in a browser."

Your existing passkey: it is bound to the relay's RP ID (the host), which the app uses too, so it is the same credential. The
app signs in with a setup code, so its session is not tied to one passkey and any passkey registered on the relay is accepted
for step-up. What you need: that passkey must be available to the iPhone. If it lives in iCloud Keychain (Safari or the Home Screen
app on any of your devices) it syncs. If it lives in a third-party password manager, turn that manager on under Settings >
Passwords > Password Options > AutoFill Passwords and Passkeys. If it exists only on the Mac with iCloud Keychain off, create a
passkey from Safari on the phone first (open a setup link from `talos-app enroll`). Moving to a different relay host voids every
passkey (decision 0001).

### Sandbox vs production

The app reads how the build was signed (its provisioning profile's `aps-environment`). A build run from Xcode is **development**: its tokens are sandbox tokens and the app reports `sandbox`, so the relay sends to `api.sandbox.push.apple.com`. A Release build for TestFlight or the App Store is
`production` (`api.push.apple.com`); Xcode rewrites the entitlement when archiving. The same `.p8` key works for both. A token sent to the
wrong host is `BadDeviceToken` and is kept; open the app once after switching build type and it registers the right one.

### Keep out of git

The bundle id, Team ID, Key ID and `.p8` live only in `ios/Local.xcconfig` (gitignored) and Railway variables. Nothing in the repo
holds them; the repo's bundle id is the placeholder `app.talos.shell`.

## Tests

`pnpm exec vitest run` covers the sender against a local HTTP/2 fake Apple (`apps/relay/test/push`), the relay routes, the web row and
plugin wrapper (`apps/web/test/native`), and the iOS config (`apps/mobile/test`). `pnpm --filter @talos-app/mobile test:swift` runs the
Swift core tests. Real delivery is smoke I-S5 (needs the key and a phone).
