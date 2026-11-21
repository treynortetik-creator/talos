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

The steps are in [`docs/ios.md`](../../docs/ios.md), "Build and install on your own iPhone (free Personal Team)". The web app on the
Home Screen is the default phone path; this native app is optional.

## Security model (IOS-SPEC rev 2)

- The relay origin is the active relay profile (`RelayRuntime`, `TalosRelayCore`), saved only by the native scan sheet; each relay has its own WebKit data store. A debug build with nothing paired may use the build-time `server.url`; a release build shows the native first-run screen and loads no page. Page content, a deep link or a plugin argument cannot set it.
- `TalosBridgeViewController` wraps Capacitor's `bridge` script-message handler. A plugin call is delivered only from
  the top frame, on the relay origin, at a path outside `/media/` (`ios/BridgeGuard`, unit-tested with `swift test`).
- Top-level `/media/` navigations open in the in-app viewer (`MediaViewerController`, a separate web view with no bridge); files it cannot show, attachments and PDFs download to a temp file and open in the system preview with Share. Any other web link, in the page or a new window, opens outside Talos through the system (`UIApplication.open`): a universal link such as a Google Drive or Docs link opens in its app, the rest in Safari with the owner's sign-ins (the owner, 2026-11-20; it used to be `SFSafariViewController`, an in-app browser with no Safari sign-ins). Neither ever loads in the shell.
- Audio session is parked at launch (`.playback`/`.spokenAudio` + `.mixWithOthers`, never activated). The page's `audioSession.set(...)` reaches the local `TalosAudio` plugin (`setMode` playback | paused | idle; an old page's `record` is refused), which activates the session only while a reply plays. The web view never grants the page the camera or microphone (`NavigationGate` always answers deny; voice input archived, `docs/archived/voice.md`); the shell declares no `NSMicrophoneUsageDescription`. `UIBackgroundModes` is `audio` only. Haptics use `@capacitor/haptics`. The local plugins (`TalosAudio`, `TalosShare`) re-check the web view URL (relay origin, not /media/); the stock haptics plugin relies on the bridge filter alone. Leaving /drive or turning driving off sends `audioSession.set('auto')` (TalosAudio idle); a reload or web-process death resets the session natively.
- Attach (+ in the composer): in this app + opens Talos's own menu (Photos / Camera / Files) and each choice is one tap to a native picker through the local `TalosPicker` plugin (`pickPhotos` PHPicker, `takePhoto` camera, `pickFiles` document picker; it returns `{ files: [{ name, mime, base64 }] }`, the page attaches them like input files). No web file input is used here, so iOS's own sheet never appears. In iPhone Safari (not this app) + opens no menu of ours: it clicks one plain file input and iOS's own sheet (Photo Library / Take Photo / Choose File) is the single menu. Desktop shows our menu over three inputs.
- Push (WP-I5): the `TalosPush` plugin and notification categories are always built, but the push entitlement is opt-in (`TALOS_APP_ENTITLEMENTS = App/AppPush.entitlements` in `Local.xcconfig`, paid program only), so the free-tier build is unchanged. Associated Domains (passkeys in the web view, WP-I6) is in that same opt-in file only, with `TALOS_RELAY_HOST` in `Local.xcconfig`; the free-tier build has none and no signing team. Owner steps: `docs/IOS-PUSH.md`.

## Tests

- `pnpm test` (Node): config and project invariants.
- `pnpm --filter @talos-app/mobile test:swift` (needs Swift on a Mac): origin/path guard logic and the audio-session policy.
- Simulator smoke: `test/smoke/i4_diag_server.py` plays the relay on 127.0.0.1 and lists/fires the native plugins (screenshot in `docs/screenshots/ios-shell-native-plugins.png`).
