# BYOR phase 4: the bridge-signed frame the iPhone app verifies (design note)

Status: design only, no code; revised after review rounds 1 and 2; owner decisions of 2026-11-17 are recorded in BYOR.md section 10. Read at `1dbf25a1f`. Every claim cites `file:line`; "not found" means I
searched and saw none; "assumption" marks a choice of mine. Serves `docs/specs/BYOR.md` 3.2, section 5 (TOFU pin row), section 10
(a), (b), (d). "Owner decision" marks a call the owner has made.

## 1. What the bridge signs today, and who sees it

One Ed25519 bridge key (`apps/bridge/src/keys.ts:8-14`); the relay pins its public half as `BRIDGE_PUBKEY` (`apps/relay/src/env.ts:29`,
`apps/relay/src/auth/core.ts:627-630`). All in `packages/protocol/src/bridge-auth.ts` unless a path is given.

- **WebSocket `hello`:** signs `talos-relay/v1`, nonce, relay_host, server_time (`:8,86-88`), all four from the relay's `challenge`
  (`apps/relay/src/core/hub-bridge-conn.ts:101-107`). `sig` rides the `hello` (`frames.ts:114-118`, `apps/bridge/src/handshake.ts:140-144`).
  The relay checks it once per nonce (`apps/relay/src/auth/impl.ts:107-131`). No app ever receives it.
- **HTTP request:** `talos-bridge-http/v1`, METHOD, path+query, ts, nonce, sha256-hex(body) (`:9,104-121`), sent as an `Authorization`
  header (`:123-140`). Relay only; I found no code that stores or forwards the header (the bridge header is read only in `impl.ts:138,154,168`; `core/share.ts:335` reads a different, share-token `Authorization`).
- **Rotation:** `sig_new` signs `talos-rotate/v1`, new_pubkey, ts with the NEW key (`:10,197-206`; `http.ts:648-658`). The OLD key signs the
  HTTP request that carries it. The relay wants `sig_new` and, on a first try, the active key in the header (`apps/relay/src/auth/index.ts:518-540`;
  a retry of a finished rotation answers 200 to any key that authenticates, line 536). Nothing reaches a device.
- **Features:** unsigned. The bridge lists them in `hello.client.features` (`frames.ts:119-122`); the relay stores and echoes them as
  `presence.features` (`apps/relay/src/core/features.ts:1-9`, `models.ts:625-630`).
- **`device.pinned`** (the Mac's y/N): unsigned. `frame()` has only `v,id,ts,relay` (`frame-base.ts:8-13`); the only `sig` in the frame files is
  the bridge hello (`frames.ts:117`); `osig` is the owner's device key. The relay stores and fans it out (`hub-bridge-frames.ts:142-157`).

Pairing today: scan, `enroll/session` (unpinned session), `device/verify` (route `http.ts:184-206`, the 202 at `auth/index.ts:327`); the
relay forwards `device.enrolled` (`auth/index.ts:238,315`); the Mac asks y/N and answers `device.pinned` (`apps/bridge/src/enrollment.ts:42-56,90-120`).
`binding` is a code-keyed proof device to Mac, not Mac to device (`enrollment.ts:65`). Reconnect: the app speaks first; the relay answers `ready`
at once, no challenge for the app (`hub-app-conn.ts:146-148,165-180`). **No bridge-signed frame reaches a device, at pairing or on reconnect.**

## 2. What the device verifies today

Nothing about the bridge key: no Ed25519 or bridge-key check in `apps/web/src`, `apps/mobile/ios/App`, `BridgeGuard` or `TalosRelayCore`
(only the stored string `bridgeFp`, `RelayProfile.swift:14`). The web ignores any answer in `device/verify` (`passkeys.ts:171,183`). The only
relay plugin opens the scan sheet, no arguments (`TalosRelay.swift:6-14`). Phase 3b "never pins and never runs device/verify"
(`AddRelayFlow.swift:4-5,56-70`). The device holds only the SHA-256 `fp` (`bridge-auth.ts:32-34`), never the public key, so the frame must carry
the key. `ENROLL_LINK_FP = true` (`enroll-cli.ts:49`, on since a8bd0ac2): a real setup link carries `&fp=` whenever the relay answers `/.well-known/talos-relay` (`enroll-cli.ts:144`); a link made while the descriptor is unavailable has no `fp`, and the app refuses it (`requirePin`).

## 3. The frame: `bridge.attest`

**Route.** `POST /api/bridge/attest`, body `{"nonce":"<43 base64url chars>"}`; new row in the route table (`http.ts`, `owner: 'BYOR'`,
`auth: 'none'`), registered beside the descriptor (`apps/relay/src/core/index.ts:148`). **No csrf middleware:** it needs an `Origin` header equal
to the relay (`impl.ts:86-89`), and a native call sends none; the route changes no state, so csrf has nothing to guard.
**Cookie, said once:** the fetcher reads only that origin's session cookie (`__Host-talos_s`, `apps/relay/src/auth/util.ts:8`) from the profile's own
`WKHTTPCookieStore` and sends it only for a paired profile, never at pairing. The relay checks it with no side effects: no refresh, no `Set-Cookie`, no
last-used update, no failure count. A missing or bad cookie falls back to the public bucket. **Rate limits** (all assumptions): a per-address bucket; a
relay-wide public bucket of 0.5 per second, below the bridge's 1 per second; a paired-session bucket of 0.5 per second with a small burst (so two of the
owner's phones do not flicker), so outside traffic cannot push the owner's phones to `unverified`. The phone retries one 429 inside its 10 s. A flood on the
public bucket can still stall pairing, which has no cookie yet. Codes: 200 `{pubkey, sig, chain}`; 400 `bad_request` (nonce shape); 429; 503 `mac_offline` (no live bridge) or
`attest_unsupported` (hello lacks `attest/1`, listed last, `handshake.ts:77-79`); 504 `attest_timeout` (the Mac did not answer in 5 s, assumption).

**Frames** (`frames.ts`, add to `frameSchemas` :1093, `relay_to_bridge` :1360 and `bridge_to_relay` :1332; neither is durable, so never in the outbox):

```ts
const RotationCert = z.strictObject({ relay_id: RelayId, old_pubkey: B64_43, new_pubkey: B64_43, sig: B64_86 })
frame('attest.request', { nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
frame('attest.response', {
  ref: Ulid /* the request's id, as ack.ref (:211) */,
  pubkey: B64_43,
  sig: B64_86,
  chain: z.array(RotationCert).max(8),
})
```

The relay keeps a small map `request id -> waiting HTTP call` (5 s), sends the request only to the live socket, drops late or unmatched responses.

**Bridge** (new file `apps/bridge/src/attest.ts`): accept only `nonce` matching `^[A-Za-z0-9_-]{43}$`; answer on the socket it arrived on; never
queue, retry or replay an `attest.request` (a request that arrives from a resend is not answered); sign only with the current key (`keyRef`,
`bridge.ts:147,870-873`), never the `.prev` or `.next` fallbacks the socket may dial with (`bridge.ts:636-655`); rate limit signatures (assumption: 1 per second).

**Signed bytes.** UTF-8, LF only, no spaces, no trailing LF:
`"talos-bridge-attest/v1\n" + nonce + "\n" + origin + "\n" + fp`. `nonce` and `fp` are the 43-character base64url TEXT, never decoded bytes.
`origin` is `new URL(relayUrl).origin` of the bridge's OWN configured URL (`config.ts:148`), text like `https://relay.example.com:8443`. Today the
link carries the raw `relayUrl` (`enroll-cli.ts:166-167`, `enroll-link.ts:98`), which `config.ts:148` only trims of slashes; the phone normalizes
the link's origin (`EnrollLink.swift:74-90`, BYOR 10(h)), so the two agree after normalizing (a URL with an uppercase host or `:443` is the case to test;
the bridge should build the link from the same `origin`, a follow-up). The phone makes one plain string compare with `RelayProfile.origin`
(`https://<host>[:<port>]`, no slash). A changed Mac URL therefore means re-pair. `fp` is the signing
key's own fingerprint. The tag differs from `talos-relay/v1`, `talos-bridge-http/v1` and `talos-rotate/v1` (`bridge-auth.ts:8-10`).

**Nonce:** 32 bytes from `SecRandomCopyBytes`, one per attempt, in memory only, not echoed (the phone rebuilds the bytes).

## 4. What the phone does

**Swift API.** Pure, in `TalosRelayCore` (CryptoKit `Curve25519.Signing`, `SHA256`):
`BridgeAttest.bytes(nonce:origin:fp:)`, `BridgeAttest.certBytes(relayId:oldFp:newFp:)`, and
`BridgeAttest.check(body: Data, nonce:, origin:, relayId:, pinnedFp:) -> AttestVerdict` where `AttestVerdict` is `.pass`, `.repin(newFp)` or
`.fail(reason)`. In `App/App/Relay`: `protocol AttestFetching` with `URLSessionAttestFetcher` (ephemeral, https, no cookies, no redirects, capped
streaming read, as `AddRelayFlow.swift:80-123`, plus the one cookie above set by hand), result `.body(Data)` or `.unreachable` (any non-200, timeout, bad body). A per-profile state
store `RelayTrust`, one shared class: `pass(at)`, `unverified(since)`, `failed(reason)`, in memory, one attest in flight, plus `lastVerifiedAt` saved on the
profile. `RelayStore` today has `add` (replaces the whole list, :97), `remove`, `reset` (:101, deletes everything, for a damaged blob) and `setActive` (:112); it
gets `update(id:, _ change:)` (false when missing, like `setActive`) for `bridgeFp` and `lastVerifiedAt`. Plugin: `TalosRelay.recheck()`, no
arguments, resolves with nothing; it works only while the state is `pass`.

**Check order (the one order; section 6 uses it).** (1) Body at most 8 KB and well-formed; (2) `fp(K)` = canonical base64url text of `SHA256(pubkey)`;
(3) `fp(K) == pinned`, or else the chain walk of section 6; (4) the Ed25519 signature over `bytes(nonce, origin, fp(K))`. Only when 3 and 4 both pass does
the verdict come out (`.pass`, or `.repin` after a walk) and anything get saved. Total time 10 s (request and body, `AddRelayFlow.swift:93-94`);
running out is `unverified`. More than 8 chain entries, a key not exactly 32 bytes, a repeated fp, or non-canonical text is `fail`.
At pairing only `.pass` against the QR's `fp` is accepted; a `.repin` there is a `fail`.

**When ("reconnect", defined natively).** At pairing, before the code leaves the phone; at launch before the first load; on foreground
(`didBecomeActive`, `TalosBridgeViewController.swift:286-296`); on a network change (`NWPathMonitor`, :306-312); and on a timer while in front
(assumption: 10 minutes). The page's `recheck()` only adds a check: one attest in flight at a time, a minimum gap of 30 s between attests
(assumption), and a call inside the gap or while one runs does no network call. A page cannot make the Mac sign in a loop, skip a check or set a result.

## 5. Policy: pass, unverified, fail

`mac_offline`, a timeout, a 5xx and `attest_unsupported` are unsigned relay words, so a relay can hold a phone `unverified` for ever. Policy (the
24 h limit and the banner are owner decisions of 2026-11-17):

- **At pairing, unverified blocks.** `prepare` runs the attest; the code is never sent and nothing is saved on anything but a pass. `save`
  (`AddRelayFlow.swift:75`) takes the pass, because `RelayStore.add` replaces the whole stored list (`RelayStore.swift:97`): a failed re-pair must never reach it.
- **On reconnect, unverified shows a native banner** (drawn by the shell, with Retry and Remove) saying what is off and why: "Can't confirm this is
  your Mac. Camera, mic, sharing and native features are off until it answers. Last confirmed <time>." While it shows, NO plugin call, camera or mic
  grant, share request or prompt() message is allowed, and no allowlist (the banner's own buttons are native). `BridgeGuard` stays pure: a `Sendable` struct with only `let relay`
  (`BridgeGuard.swift:38-43`), and each handler holds its own copy made at build time (`TalosBridgeViewController.swift:170`). So the one shared `RelayTrust` object is
  injected into every site, which reads its state at call time and passes it into the guard methods as an argument. The sites: `allowsPluginCall` (:52: the share-media handler `TalosBridgeViewController.swift:502-512`,
  Capacitor's bridge incl. haptics and keyboard through `GuardedMessageHandler` :569-597, and `NavigationGate.trusted` :637-642), `allowsPromptChannel`
  (:175, used at :653) and `devicePermission` (:169, camera, mic and motion grants at :766-783). `TalosPluginGate.check` (`TalosPluginGate.swift:15-21`)
  reads the same state for the per-plugin guards (e.g. `TalosPush.swift:187`).
- **Remove** goes straight to the native Add-relay sheet. In production that sheet opens only through the `TalosRelay.openAddRelay` plugin call
  (`TalosRelay.swift:15-21`); the other entry is DEBUG-only (`TalosBridgeViewController.swift:142-150`). A banner or red screen would be a dead end, so the
  runtime-origin work must also show a native first-run scan screen whenever no profile exists, and call the sheet directly from Remove.
- **After 24 hours without a verified attest, a hard block**: the `fail` screen, wording "can't confirm your Mac", with Retry and Remove. Count from
  `lastVerifiedAt`, which every pass renews (not from pairing); a time in the future counts as expired.
- **Fail** (wrong key, bad signature, bad shape, bad chain): the web view is cleared and a native full-screen red screen offers only "Remove
  this relay and pair again" (BYOR 5, TOFU row). All plugin calls are refused.

## 6. Rotation (requirement b)

Today it is two signatures at the relay (section 1); no device can check it. **Certificate bytes:** UTF-8, LF only, no trailing LF:
`"talos-rotate-cert/v1\n" + relay_id + "\n" + old_fp + "\n" + new_fp`, all text (`relay_id` is the descriptor's `r_...`, `relay-descriptor.ts:10-17`;
fps are 43-char base64url text), signed by the OLD key. Entry: `{relay_id, old_pubkey, new_pubkey, sig}`.

- **Made by** `prepareRotation` (`keys.ts:42-47`): it loads the old key (`cmdRotate` already does, `cli-main.ts:364`), reads `relay_id` from the
  descriptor (`relay-http.ts:101` `descriptor()`). If it is `unavailable`, `rotate` refuses and nothing changes; it skips the cert only on a real 404
  (`absent`, :101-103), the same rule as `enroll-cli.ts:144-147` (an older relay has no BYOR phone). Then it signs, and appends to a new
  0600 file (assumption: `bridge.rotations.json`) before the relay call. A leftover `bridge.key.next` (`cli-main.ts:358-379`) already has its cert.
- **Served:** `chain` = certs walked backwards from the current key, so certs of failed tries drop out; at most 8.
- **Phone walk** (step 3 of the check order; nothing is saved until step 4 also passes): if `fp(K) == pinned`, done. Else skip entries until `old_fp == pinned`
  (so a phone pinned to a middle key works), then each entry must have `SHA256(old_pubkey) == current`, a valid old-key signature, and
  `relay_id == RelayProfile.id`; `current = SHA256(new_pubkey)`; the walk must end at `fp(K)`. Pass gives `.repin(fp(K))`.
- **Every re-pin, signed rotations included, needs a blocking native confirm** ("your Mac's key changed; did you run `talos-app rotate`?"
  Continue / Remove). Stricter than BYOR 10(b) as first written; owner decision of 2026-11-17 (the next point is why).
- **Key theft:** after a leak, any phone that has not yet moved to the new key can be moved by the thief, who signs a cert from the old key to
  their own key, if they also answer for the pinned origin. A "no-cert" rotate mode does not help; only the confirm and the owner's attention do.
- **Rollback is a re-pair.** A key older than the pinned one (`BRIDGE_PUBKEY_FORCE=1`, `SECURITY.md:683-684`, or a restored `bridge.key.prev`,
  `keys.ts:53-58`) has no chain from the pinned key, so it is `fail`. The CLI's FORCE hints (`cli-main.ts:156,539`) and the `rotate` output
  get one line: phones paired before going back to an older key ask to pair again.

## 7. Hooks, dependencies, docs

- **Origin dependency.** Today the web view and the plugin gate use the build-time `bridge.config.serverURL`
  (`TalosBridgeViewController.swift:198,237-251`; `TalosPluginGate.swift:17`), while attest checks `RelayProfile.origin`. Phase 4 must not ship
  before the runtime-origin work (BYOR 8, row 4) builds the web view, `BridgeGuard` and the gate from the SAME active `RelayProfile`.
- **Hooks:** `loadRelay` (:237-251) waits for the attest to finish (10 s), then loads on a pass, or when unverified and inside the 24 hours; on a fail or a
  hard block it loads nothing; `startLaunchWatchdog` (:317-337, called at the end of `loadRelay`)
  starts only after the attest finishes, so the offline page cannot show mid-check (the launch spinner covers the wait); `startRetryTriggers`
  (:285-314) starts an attest on foreground and network change; the `BridgeGuard` methods and `TalosPluginGate.check` of section 5 read the per-profile
  state; `AddRelayFlow.save` runs only after a pass.
- **`SECURITY.md` change (not made here):** row at line 25 (stolen bridge key) gains the phone-side pin check and the rotation certificate;
  the "Bridge safety" row at line 60 and the text at 683-684 gain the attest route (public, rate limited, signs only tagged bytes) and say that
  rotation is signed by both keys at the relay and by the old key for phones.
- **Quick actions after a relay switch (4a.2).** The notification keys (seal and action keys) live in the shared Keychain group and survive a relay
  switch; only the grant is cleared (`RelayRuntime.clearRelayBoundNativeState`). So a push sealed by the OLD relay still opens on the phone. Quick-act
  (`TalosQuickAct`) must therefore refuse when the relay that sent the push is not the active one: it compares the relay that sent the push with
  `ActiveRelay` and shows its fixed "Open Talos" notice on a mismatch, before it signs anything. How the push names its relay is for 4a.2 to decide
  (not checked here). Keys per relay are the separate item 4.
- **Phase 3 parser follow-up:** `EnrollLink.swift:121-126` (and `ENROLL_FP`, `enroll-link.ts:5`) accept any 43 base64url characters; 32 bytes
  encode to 43 characters whose last one carries only 4 bits, so refuse a non-canonical last character at scan, and compare `fp` as canonical text.

## 8. Test vectors: `packages/protocol/fixtures/bridge-attest/vectors.json`

Run by the TypeScript tests (WebCrypto signs, as `bridge-auth.ts:65-67`) and the Swift twin (CryptoKit verifies). Contents: a fixed Ed25519
seed, public key, nonce, origin and relay_id; the expected attest bytes and cert bytes in hex; the signatures; bad cases (wrong nonce, origin,
fp or tag; a flipped signature bit; short signature; a 31- or 33-byte key; a non-canonical fp; a chain with a gap, a repeat, 9 entries, a wrong
`relay_id`, a start before and after the pinned key); and edge-case signatures where the two libraries may differ: S at or above the group
order, and a small-order public key. I did not check what CryptoKit does with these; the vector run decides, and where Swift accepts what
TypeScript refuses, the Swift check adds the rule itself.

## 9. Open risks

1. **Same-host proxy (accepted, owner decision 2026-11-17).** A server swapped in at the pinned origin can pass the attest on to the real relay and
   return its answer; the signed origin still matches. The attest proves only "the owner's Mac is reachable through this origin", not who the server
   is. Closing it needs the relay's own key in the QR and a second signature: a later phase. Document it in `SECURITY.md`.
2. **Liveness, not content.** Bridge frames to the app stay unsigned (`frame-base.ts:8-13`); a relay that passes can still lie about content.
3. **My numbers**, not the owner's: 5 s relay wait, 1 per second on the Mac, 0.5 per second public cap, 10-minute timer, 30 s gap.
4. **Chain loss.** Lose the rotations file, or rotate more than 8 times between a phone's checks, and that phone re-pairs.
5. **Open signing route.** Anyone can learn the public key and whether the Mac is online, and cost it a signature; both ends rate limit (section 3).
   Sending the session cookie before the check passes is acceptable: the page load sends it anyway, and a server that could use it can already pass
   the check (the accepted same-host gap).
6. **Link without `fp`.** Needs `ENROLL_LINK_FP` on and a web bundle that reads it. **Old Macs** without `attest/1` stay unverified; the banner says "update talos-app".
7. **Lookalike hosts at pairing:** a spoofed QR carries its own `fp`, so the attest passes for the attacker; the guard is the host shown to the owner and the Mac's y/N (BYOR 10(h)).
8. **Browsers and the PWA** are out of scope; they pair by passkey and never see `fp`.
9. **Read-only page, not tried on a device.** I have not checked that the page still works with the whole Capacitor bridge and the prompt() channel off while unverified.
