# @talos-app/mobile

Capacitor 8.5.3 iOS shell (WP-I0). It wraps the Talos web app by loading the relay origin; it ships no web assets
(`www/` is a one-page "no relay configured" stub).

## Build

```bash
export TALOS_RELAY_URL=https://your-relay.example   # https only (http only for localhost). No default is committed.
pnpm install
pnpm --filter @talos-app/mobile cap:sync            # writes ios/App/App/capacitor.config.json (gitignored)
brew install xcodegen
pnpm --filter @talos-app/mobile xcodegen            # regenerates App.xcodeproj + App/Info.plist from ios/App/project.yml
open apps/mobile/ios/App/App.xcodeproj
```

`ios/App/project.yml` is the single source of truth: never hand-edit `App.xcodeproj` or `App/Info.plist`.
Capacitor is SPM-only (`ios/App/CapApp-SPM`, managed by `cap sync`); no CocoaPods.

## Build and install on your own iPhone (free Personal Team)

Needs: Xcode with your Apple ID added (Settings > Accounts), Developer Mode on the phone (Settings > Privacy & Security),
the phone connected and trusted. Nothing about your team goes in the repo: two gitignored files carry it.

```bash
cd apps/mobile
printf 'TALOS_RELAY_URL=https://<your-relay-host>\n' > .env.local          # origin only, https
printf 'DEVELOPMENT_TEAM = <TeamID>\nTALOS_BUNDLE_ID = com.<you>.talos\n' > ios/Local.xcconfig   # ids you own; share extension = <id>.share
pnpm cap:sync && pnpm xcodegen
xcrun devicectl list devices                                             # note the phone's identifier
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -destination 'id=<device-id>' \
  -derivedDataPath /tmp/talos-dd -allowProvisioningUpdates build
xcrun devicectl device install app --device <device-id> /tmp/talos-dd/Build/Products/Debug-iphoneos/App.app
```

First launch: on the phone, Settings > General > VPN & Device Management > your Apple ID > Trust. Free-tier installs stop
launching after 7 days: rebuild and install again.

## Security model (IOS-SPEC rev 2)

- The relay origin is fixed at build time (`server.url`). Page content cannot change it.
- `TalosBridgeViewController` wraps Capacitor's `bridge` script-message handler. A plugin call is delivered only from
  the top frame, on the relay origin, at a path outside `/media/` (`ios/BridgeGuard`, unit-tested with `swift test`).
- Top-level `/media/` navigations open in the in-app viewer (`MediaViewerController`, a separate web view with no bridge); files it cannot show, attachments and PDFs download to a temp file and open in the system preview with Share. Other new-window requests open in `SFSafariViewController`. Neither ever loads in the shell.
- Audio session is parked at launch (`.playback`/`.spokenAudio` + `.mixWithOthers`, never activated). The page's `audioSession.set(...)` reaches the local `TalosAudio` plugin (`setMode` playback | record | idle), which activates the session only while a reply plays or a note records. `UIBackgroundModes` is `audio` only. Haptics use `@capacitor/haptics`. The local plugins (`TalosAudio`, `TalosShare`) re-check the web view URL (relay origin, not /media/); the stock haptics plugin relies on the bridge filter alone. Leaving /drive or turning driving off sends `audioSession.set('auto')` (TalosAudio idle); a reload or web-process death resets the session natively.
- Push (WP-I5): the `TalosPush` plugin and notification categories are always built, but the push entitlement is opt-in (`TALOS_APP_ENTITLEMENTS = App/AppPush.entitlements` in `Local.xcconfig`, paid program only), so the free-tier build is unchanged. Associated Domains (passkeys in the web view, WP-I6) is in that same opt-in file only, with `TALOS_RELAY_HOST` in `Local.xcconfig`; the free-tier build has none and no signing team. Owner steps: `docs/IOS-PUSH.md`.

## Tests

- `pnpm test` (Node): config and project invariants.
- `pnpm --filter @talos-app/mobile test:swift` (needs Swift on a Mac): origin/path guard logic and the audio-session policy.
- Simulator smoke: `test/smoke/i4_diag_server.py` plays the relay on 127.0.0.1 and lists/fires the native plugins (screenshot in `docs/screenshots/ios-shell-native-plugins.png`).
