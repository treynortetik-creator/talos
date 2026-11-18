# Talos on the App Store + bring your own relay (spec)

Status: draft, 2026-11-10. Source: ROADMAP.md, "App Store release + bring-your-own relay". Code refs are `~/Documents/talos-app` at the 2026-11-10 checkout. "Verified" means read in code or fetched live today; "inferred" means my reading, not checked.

## 1. Goals and non-goals

**Goals**
- One store build of the iPhone app that pairs with (a) the owner's paid hosted relay or (b) any self-hosted relay (Railway or anywhere), through the same QR flow.
- Native push for both kinds, through a push gateway the owner hosts. No message text leaves the relay in readable form.
- Pass App Review on the first or second try. External TestFlight comes first.
- Sell the hosted relay through Stripe, with one entitlement check on the relay, whatever paid for it.

**Non-goals (this spec)**
- Making the relay zero-knowledge. Today the relay can read messages (SECURITY.md:56, "your Talos relay can [read them] ... as it can read all your messages"). The hosted offer has to disclose that. See open question 4.
- Android, a multi-tenant relay process, Mac App Store.

## 2. What the code does today (verified)

| Area                   | Today                                                                                                                                                                                                                                                                                                            | Why it blocks BYOR                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Relay origin           | The shell loads ONE origin fixed at build time; never from page content or a runtime setting (`apps/mobile/capacitor.config.ts:5-8`, `:41-48`)                                                                                                                                                                   | A store build must pick the relay at runtime                 |
| Native bridge lock     | Plugin calls only from the top frame on the build-time relay origin (`App/App/TalosBridgeViewController.swift:8-15`)                                                                                                                                                                                             | The lock has to follow the active relay instead              |
| Passkeys               | `webcredentials:$(TALOS_RELAY_HOST)` compiled into `App/App/AppPush.entitlements:13-16`; relay serves AASA from `APNS_TEAM_ID`+`APNS_BUNDLE_ID` (`apps/relay/src/core/aasa.ts:14-19`); `RP_ID` must equal the origin host (`apps/relay/src/env.ts:122-123`)                                                      | Custom domains cannot be in the store build's entitlement    |
| Pairing                | `talos-app enroll` sends only a hash to the relay and prints `https://<relay>/enroll#<code>` plus a QR (`apps/bridge/src/cli-main.ts:295-326`). Native shells trade the code for an unpinned session (`apps/relay/src/auth/enroll-session.ts:1-8`); the Mac pins after the four-word check (SECURITY.md:37, :40) | Already relay-agnostic. Needs a native scanner and a key pin |
| Passkey use in the app | Step-up only; sign-in is the setup code (docs/IOS-PUSH.md:153-155)                                                                                                                                                                                                                                               | Self-hosted relays need another step-up path                 |
| Push                   | The relay signs its own APNs JWT with the `.p8` (`apps/relay/src/core/push-apns.ts:1-3`, `:19-48`, `:273-274`) and stores raw device tokens (`apps/relay/src/core/store.ts:51`, `:717`). Apple sees fixed phrases; text goes in a seal (`push.ts:1-3`, `:9-40`)                                                  | A self-hosted relay has no key for the store bundle id       |
| Ownership              | One owner per relay, closed registration (SECURITY.md:35)                                                                                                                                                                                                                                                        | Hosted = one relay instance per customer                     |
| Export compliance      | `ITSAppUsesNonExemptEncryption: false` (`App/project.yml:100`)                                                                                                                                                                                                                                                   | Re-check once the app does crypto natively (5.4)             |

## 3. Architecture

### 3.1 Multi-relay client

- The app keeps a native **relay list** in the Keychain. Each entry is a `RelayProfile` (section 4). Exactly one relay is active in the web view at a time; a switcher sits in a native sheet.
- The active origin comes **only** from a native QR scan or the hosted sign-up flow, never from page content, a deep link or JS. That keeps the security rule in `capacitor.config.ts:5-8`, moved from build time to pairing time.
- `BridgeGuard` takes the active profile's origin in place of the build-time `server.url`. Each relay gets its own `WKWebsiteDataStore` (iOS 17 `forIdentifier:`), so cookies, IndexedDB and device keys never mix between relays.
- On connect the app reads `/.well-known/talos-relay` (new: version, relay id, kind, minimum app version) and refuses relays below the minimum.
- **Risk (inferred):** a self-hosted relay serves its own web bundle, possibly modified, and that bundle reaches the native plugins. Today that's fine because the user owns the relay. It is also the 4.2 and 2.5.2 review risk (section 6). The long-term fix is bundling the web UI in the binary (open question 2).

### 3.2 Pairing by QR (same flow for both kinds)

1. On the Mac: `talos-app enroll` (or the Mac app) shows the QR.
2. In the app: Add relay, Scan. The scanner reads the existing link format, `https://<relay>/enroll#<code>`, plus one new fragment field, `fp=<bridge key fingerprint>`. Browsers keep working because the code stays in the fragment.
3. The app checks the relay descriptor, makes a fresh data store, trades the code for an unpinned session (existing route), runs `device/verify`, and the Mac asks y/N with four words (existing).
4. The app pins `fp` (trust on first use) and saves the profile.
   Phase 4 changes this order: `fp` is checked against a fresh bridge signature before the code is sent. See section 10 (2026-11-17).

- Universal links are not used: `applinks` would hit the same compiled-in-domain wall as passkeys.

### 3.3 Auth per relay type

|                       | Hosted relay                        | Self-hosted relay                                                                                                                      |
| --------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in on the phone  | Setup code by QR                    | Setup code by QR                                                                                                                       |
| Device key            | Web device key, pinned by the Mac   | Same                                                                                                                                   |
| Step-up (risky cards) | Passkey (domain in the entitlement) | **New:** native step-up key: Secure Enclave, Face ID-gated, made at pairing and pinned by the Mac like the action key (SECURITY.md:36) |
| Browser login         | Passkey                             | Passkey (their own domain, works in Safari)                                                                                            |
- **Hosted domains:** one relay per customer at `<tenant>.<hosted-domain>`. A wildcard `webcredentials` entry is not reliably supported (forum reports only, no Apple doc found). So the hosted passkey path needs either `RP_ID` = the parent domain (change `env.ts:122` to allow a registrable suffix, one explicit entitlement entry) or the native step-up key everywhere. **My recommendation: the native step-up key on every relay.** It deletes Wall 2 for both kinds and leaves one code path. Passkeys stay for browsers.

### 3.4 Push gateway (owner-hosted)

Same model as Matrix's Sygnal: the app's operator runs the gateway that holds the APNs key, and servers post "notify this push key" to it. ntfy is the fallback model: a self-hosted ntfy server sends ntfy.sh a content-free poll request, and the phone fetches the message itself.

Flow:
1. _(Superseded by section 10, "Relay id": the relay mints its own `relay_id`.)_ A relay registers once with `POST /v1/relays` and its Ed25519 key, and gets a `relay_id`. Free, rate-limited, revocable.
2. The app registers its APNs token **with the gateway directly** and gets back an opaque `push_handle` bound to (relay_id, device). The relay stores the handle, never the raw token.
3. The relay sends `POST /v1/notify` with `{handle, template, collapse_id, ttl, sealed?}`, signed like the bridge's HTTP requests.
4. The gateway checks the signature, that the handle belongs to that relay, the quotas and the size (3,900 bytes, as in `push-apns.ts:84`), then sends Apple a fixed alert with `mutable-content`. The push extension opens the seal exactly as it does today.

- Modes: `sealed` (default, today's behaviour) or `poll` (no seal; the extension or the app fetches from the relay, as ntfy does).
- The hosted relays use the same gateway: one code path. Owner builds can still set `APNS_*` and push direct.

## 4. Data model and protocol changes

| Where                             | Change                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App (Keychain)                    | `RelayProfile {id, origin, kind: hosted\|self, label, bridge_fp, device_id, data_store_id, push_handle, step_up_key_ref, added_at}`                                                     |
| Relay                             | `GET /.well-known/talos-relay` → `{protocol, relay_version, relay_id, kind, min_app}`                                                                                                   |
| Relay                             | `push_devices.token` → `handle` (with a migration path; keep raw tokens for direct-APNs builds)                                                                                         |
| Relay env                         | `PUSH_GATEWAY_URL`, gateway key; `PLAN_SOURCE=none\|control-plane`                                                                                                                      |
| Relay                             | `entitlement {account_id, plan, status: active\|grace\|lapsed, source: stripe\|apple\|comp, expires_at}`. Only hosted relays read it; lapsed = read-only for 7 days, then suspended     |
| Enroll link                       | Fragment gains `fp=`; parser lives in `packages/protocol`                                                                                                                               |
| Bridge/Mac                        | Pins the native step-up key; signs `fp` rotation (exists: rotation signed by both keys, SECURITY.md bridge row)                                                                         |
| Gateway (new `apps/push-gateway`) | `relays(id, pubkey, quota, status)`, `handles(handle, relay_id, apns_token_enc, env, device_id, created_at)`; routes `/v1/relays`, `/v1/handles`, `/v1/notify`, `DELETE /v1/handles/:h` |
| Control plane (hosted only)       | Accounts, Stripe and Apple webhooks → entitlement; provisions and suspends tenant relays through the Railway API                                                                        |

## 5. Security review points

| Risk                                | Control                                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway used as free spam to phones | A handle exists only after the app registers it; one relay can't hit another relay's handles; per-handle and per-relay token buckets; fixed templates only (no free-text alert); size cap; relay revoke; alarm on 410 spikes                         |
| Gateway compromise                  | It holds APNs tokens and the key, never text (sealed). Tokens encrypted at rest. Metadata (timing, relay ids) is visible and goes in the privacy policy                                                                                              |
| Relay impersonation                 | The QR binds origin + `fp`; the Mac's four-word check binds the device to the Mac; owner messages stay signed by keys the relay never holds (SECURITY.md:36). A fake relay gets an unpinned session that sees nothing (pairing gate, SECURITY.md:38) |
| QR replay or shoulder-surf          | Code single-use, 10 minutes, five failures burn every code (SECURITY.md:369-371). Known gap: one session per code, so a leaked code can knock the app's session out until it is spent (SECURITY.md:372-378). Keep it, and show it in the UI          |
| TOFU pin                            | The first scan pins `fp`. A changed key is accepted only through the signed two-key rotation; anything else is a red screen that offers re-pair only                                                                                                 |
| Cross-relay leakage                 | Separate data stores; native plugins answer only the active origin; the share extension token is scoped per relay                                                                                                                                    |
| Malicious self-hosted web bundle    | Inferred risk, owned by that user. Plugins stay narrow (no file system, no contacts); the bundled-UI option removes it                                                                                                                               |
| Hosted operator access              | The hosted relay can read messages. Disclose it plainly; it decides the nutrition labels                                                                                                                                                             |

## 6. App Store submission checklist

| Item                                                        | Guideline (verified live 2026-11-10)                                                          | Plan                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privacy policy link in App Store Connect and inside the app | 5.1.1(i)                                                                                      | Hosted: what the relay stores (7-day buffer), what the gateway sees (tokens, timing)                                                                                                                                  |
| Privacy nutrition labels                                    | App Store Connect                                                                             | Hosted: user content ("not linked to tracking"), identifiers (push token). Self-hosted: data goes to the user's own server                                                                                            |
| Demo relay + demo account                                   | 2.1(a): demo account info, back end on                                                        | A sealed demo relay with a canned headless bridge (no tools), and a "Reviewer demo" entry that takes a long-lived demo code typed in by hand (reviewers can't scan a Mac QR). Ask Apple about the demo mode if needed |
| Account deletion in the app                                 | 5.1.1(v)                                                                                      | Hosted: Delete account deletes the tenant relay, its data and its gateway handles, and cancels Stripe. For Apple IAP, link to Manage Subscriptions. Self-hosted: Remove relay wipes local data and handles            |
| Encryption export                                           | Info.plist key exists (`project.yml:100`)                                                     | Inferred: still `false` (standard OS algorithms). Re-check Apple's export doc once native Secure Enclave and seal code ship                                                                                           |
| 4.2 minimum functionality                                   | "beyond a repackaged website"                                                                 | Real risk for a web-view shell. Lead with the native parts: QR pairing, native push with Reply and Approve, Face ID step-up, share extension, media viewer, audio                                                     |
| 2.5.2 / 4.7 remote code                                     | 2.5.2 bars downloaded code that changes features; 4.7 allows HTML5 mini apps under conditions | Inferred risk: the UI comes from the relay. The bundled UI removes it                                                                                                                                                 |
| Describing a self-hosted client                             | n/a                                                                                           | Review notes: "A client for the user's own Talos server running on their Mac, like a home-server or SSH client. Demo server provided." 4.2.7 (remote desktop) does not apply: no screen mirroring                     |
| Privacy manifest                                            | `PrivacyInfo.xcprivacy`                                                                       | None found in `apps/mobile/ios` (verified by `find`). Add before submission                                                                                                                                           |

## 7. Selling the hosted relay

**Rules as of 2026-11-10**
- **Verified (guidelines page):** 3.1.1 requires IAP to unlock features or subscriptions. 3.1.1(a): link-out entitlements "are not required ... in their United States storefront apps"; in every other storefront, no buttons, links or calls to action to other purchase methods. 3.1.3(b) multiplatform: content bought elsewhere may be used in the app "provided those items are also available as in-app purchases". 3.1.3(f): free stand-alone companions to a paid web tool for "VoIP, Cloud Storage, Email Services, or Web Hosting" need no IAP if there is no purchasing in the app and no outside calls to action.
- **Verified (search, sources below):** Ninth Circuit, December 2025: the contempt finding stands, but the outright ban on commission was vacated. Apple may charge a cost-based commission on linked-out purchases, to be set on remand. Rehearing denied March 2026, stay lifted April 2026, Supreme Court petition No. 25-1311 (Apple's merits brief filed September 2026). A law firm wrote on 2026-08-03 that Apple currently collects no commission on US link-outs but that IAP must be offered alongside.
- **Inferred:** a hosted relay fits 3.1.3(f) "Web Hosting" loosely, and a reviewer may disagree. A US link may return to a commission after the remand.

**Stripe (all options).** Sign-up happens on the web or in the Mac app, which fits the product since setup starts on the Mac anyway. Stripe Checkout (subscription mode) → webhooks (`checkout.session.completed`, `customer.subscription.updated/deleted`, `invoice.payment_failed`) → the control plane sets `entitlement` → provisions or suspends the tenant relay. Customer Portal handles card, plan and cancel. Apple App Store Server Notifications v2 write to the same table if IAP is added. The relay checks only `plan` + `status`, never where the money came from.

| Option                            | In the iOS app                                                                       | Apple's cut                       | Review risk                                     |
| --------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------- |
| A. Web-only Stripe, companion app | No prices. US storefront: one "Get hosted relay" link to the web. Elsewhere: nothing | 0 today (US could change)         | Medium: rests on 3.1.3(f) plus the US exception |
| B. Stripe + IAP mirror            | IAP subscription at the same price, plus the US link                                 | IAP share (rate not checked live) | Low                                             |
| C. IAP only                       | IAP                                                                                  | IAP share                         | Lowest, and it loses web/Mac buyers             |

**Recommendation: A at launch, with B built behind a flag.** If review cites 3.1.1 or 3.1.3(b), switch on IAP and resubmit. The entitlement model already takes `source: apple`.

## 8. Phased build plan (small pushes)

Owners: **Lemnos** = Swift, iOS, relay. **Cyclops** = TypeScript. ⚠ = risky (relay, security or push): Opus review before main.

| #   | Push                                                                                                                                                          | Owner            | Flag              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------- |
| 0   | Owner steps: **set up a Stripe account (owner: business details, bank, tax)**; App Store Connect app record and bundle id; hosted domain; privacy policy text | Owner            |                   |
| 1   | `/.well-known/talos-relay` descriptor + `min_app`                                                                                                             | Cyclops          | relay             |
| 2   | Enroll link adds `fp=`; shared parser in `packages/protocol`                                                                                                  | Cyclops          | ⚠ security        |
| 3   | Native QR scanner + Keychain `RelayProfile` (still one relay)                                                                                                 | Lemnos           |                   |
| 4   | Runtime origin: BridgeGuard follows the active profile, per-relay data stores, switcher                                                                       | Lemnos           | ⚠ security        |
| 5   | Native Face ID step-up key, pinned by the Mac (bridge side)                                                                                                   | Lemnos + Cyclops | ⚠ security        |
| 6   | `apps/push-gateway`: relays, handles, notify, quotas, a fake APNs in tests                                                                                    | Cyclops          | ⚠ push            |
| 7   | Relay gateway client; handles instead of tokens; direct APNs kept                                                                                             | Lemnos           | ⚠ push, relay     |
| 8   | App registers with the gateway; extension unchanged                                                                                                           | Lemnos           | ⚠ push            |
| 9   | Privacy manifest, account deletion, Remove relay, Reviewer demo entry                                                                                         | Lemnos           |                   |
| 10  | Demo relay + canned bridge                                                                                                                                    | Cyclops          | relay             |
| 11  | Deploy on Railway template (`railway.json` exists; template variables, button, SETUP.md section)                                                              | Cyclops          |                   |
| 12  | Control plane: Stripe Checkout, Portal, webhooks → entitlement; Railway provisioning                                                                          | Cyclops          | ⚠ relay, security |
| 13  | IAP mirror behind a flag + Apple server notifications                                                                                                         | Lemnos           |                   |
| 14  | External TestFlight (beta review) → full submission                                                                                                           | Lemnos           |                   |

## 9. Open questions for the owner

1. **Step-up in the store app:** a native Face ID key on every relay (recommended, one path), or passkeys on the hosted relay only?
2. **Where the UI lives:** keep loading the web app from each relay (faster to ship, carries 4.2 and 2.5.2 risk, and a modified relay's code reaches native plugins), or bundle it in the app (safer, a bigger rebuild)?
3. **Pricing path:** web-only Stripe at launch (A), or the IAP mirror from day one (B)? And the monthly price?
4. **Hosted privacy:** OK to sell the hosted relay while the operator can technically read messages (disclosed), or does end-to-end encryption come first?
5. **Seller of record:** personal name or a company? It shows on the App Store and in Stripe.

## 10. Decisions, 2026-11-17

- **Bridge key fingerprint (`fp`):** base64url, no padding, of the full SHA-256 of the raw 32-byte bridge public key (43
  characters). It is the same key the relay pins as `BRIDGE_PUBKEY`.
- **Enroll link:** `https://<relay>/enroll#<code>&fp=<fp>`, parsed by `parseEnrollFragment` in `packages/protocol`. The
  bridge adds `fp` only when `/.well-known/talos-relay` answers 200.
- **Relay descriptor:** `{protocol, relay_version, relay_id, kind, min_app}`.
  - `relay_id` is `r_` plus 20 base32 characters, minted once into `relay_meta`.
  - `kind` comes from `RELAY_KIND` (`hosted` or `self`, default `self`).
  - `min_app` comes from `MIN_APP_VERSION` (default `0.0.0`).
- **App requirements for phases 3-4:**
  - (a) The app verifies a bridge-signed frame against the pinned `fp` at pairing and on every reconnect. It never trusts
    the relay's descriptor for identity.
  - (b) After a key rotation, the app re-pins only on a rotation signed by the old key. Anything else is treated as a new
    relay, and the app asks.
  - (c) `min_app` is advisory only.
  - (d) The active origin comes only from a native scan, with one `WKWebsiteDataStore` per relay.
  - (e) The iPhone app refuses a setup link without `fp=`. A BYOR relay always serves the descriptor, so a missing `fp`
    means an old relay or a relay downgrading the link. The bridge drops `fp` silently only on a real 404 from
    `/.well-known/talos-relay`; on any other failure it prints a visible warning.
  - (f) The native parser follows `packages/protocol/src/enroll-link.ts` exactly: exactly one `#`, the code is the first
    segment, no percent-decoding of keys or `fp`, and `fp` is exactly 43 base64url characters. A duplicate `fp` or any
    near-miss key (`FP`, `" fp"`, `fp%3D`, `%66p`) fails the whole link. Unknown keys are ignored.
  - (g) The Mac app's sign-in and the Windows tray's `pair.py` keep the plain link. The bridge gives `fp` as a separate
    `--json` field, and `pair.py` joins it into the QR.
  - (h) The iPhone app parses the whole scanned link with `parseEnrollLink` (`packages/protocol/src/enroll-link.ts`),
    which also checks the origin as written: exactly `https://` (http is refused even for loopback; dev builds keep their
    own path outside this parser), no userinfo, a plain ASCII host lowercased (no `%`, no `xn--` label, no trailing dot,
    no empty label, labels `[a-z0-9-]` of 1-63 characters with no leading or trailing `-`, at most 253 characters, no
    IPv6 literal; a host whose last label is a number, decimal or `0x`, only as a plain dotted quad 0-255 without leading
    zeros, since a browser reads `0x7f.1` or `2130706433` as `127.0.0.1`), an optional port 1-65535 with no leading zero
    (an empty port is refused), the path exactly `/enroll`, no query, exactly one `#`, and only characters 0x21-0x7E
    in the whole link, so no space (only space, tab, CR and LF are trimmed from its ends). Anything else is `bad_link`. The origin is
    `https://<host>[:<port>]`, with 443 dropped, and equals what a WHATWG URL parser gives (the tests check it).
    Lookalike hosts are stopped by refusing `xn--` and raw non-ASCII and by showing the host at pairing, not by the `fp`
    pin: a spoofed link carries its own `fp`. The cases are shared in `packages/protocol/fixtures/enroll-link/vectors.json`
    (`cases` for the fragment, `links` for whole links), which the TS tests and the Swift twin both run. (2026-11-17)
- **Relay id (supersedes the first step of section 3.4):** `relay_id` is minted by the relay at first start (the
  descriptor), not issued by the push gateway. The gateway's `POST /v1/relays` registers that same id with the relay's
  Ed25519 key, binds the two at the first registration, and refuses the same id with a different key. `RelayProfile`,
  push handles and the gateway all key on this one id.
- **Owner, 2026-11-17:** no per-user TestFlight builds. BYOR is queued, not urgent.
- **Owner, 2026-11-17, bridge-signed frame (phase 4, `docs/specs/BYOR-phase4-frame.md`):**
  - The app checks a fresh bridge signature (`bridge.attest`) natively. At pairing nothing is sent or saved unless it
    passes; later, an unanswered check is "unverified": a native banner says that camera, mic, sharing and native
    features are off and when the Mac was last confirmed.
  - 24 hours without a verified check is a hard block, counted from the LAST verified check, not from pairing.
  - Every re-pin after a key rotation, signed ones included, needs a blocking native confirm. This tightens (b).
  - The same-host proxy gap is accepted and documented: the check proves the Mac is reachable through the origin, not
    who runs the server. The relay's own key in the QR is a later phase.

## Sources (fetched 2026-11-10)

- App Review Guidelines (3.1.1, 3.1.1(a), 3.1.3(b), 3.1.3(f), 2.1(a), 2.5.2, 4.2, 4.2.7, 4.7, 5.1.1(i), 5.1.1(v)): https://developer.apple.com/app-store/review/guidelines/ (no last-updated date on the page)
- Ninth Circuit Dec 2025 + remand: https://www.fenwick.com/insights/publications/ninth-circuit-largely-upholds-ruling-in-epic-v-apple ; https://scl-llp.com/ninth-circuit-upholds-apple-contempt-finding-but-narrows-scope-of-remedial-relief/
- Supreme Court No. 25-1311, Apple merits brief 2026-09-14: https://www.supremecourt.gov/DocketPDF/25/25-1311/424150/20260914154510009_2026-09-14%20No.%2025-1311%20Apple-Epic%20Merits%20Opening%20Brief.pdf
- Current US practice (2026-08-03): https://technologylaw.fkks.com/post/102mp7y/update-your-app-external-purchase-developments-for-apple-google
- ntfy iOS upstream: https://docs.ntfy.sh/known-issues/ and the ntfy config docs
- webcredentials wildcard (forum evidence, no Apple doc): https://developer.apple.com/forums/thread/741170 ; https://developer.apple.com/documentation/xcode/supporting-associated-domains
- Not verified live: the export-compliance page (the body didn't load), Apple's IAP commission rates, Sygnal's API (from training).
