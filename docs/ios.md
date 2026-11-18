# iPhone app: build, install, TestFlight

**You do not need this to use Talos on an iPhone.** The default phone path is the web app added to the Home Screen (SETUP.md,
step 7): it gets messages, notifications and passkeys, and updates itself. Build the native app only if you want what the web
app cannot do, such as the share sheet extension or native push. Everything below uses your own Apple ID, team and bundle id;
nothing in this repository is signed for anyone else, and there is no shared build to download.

Pick one:

| You have                         | Path                                                                            | What you get                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A free Apple ID                  | [Personal Team build](#build-and-install-on-your-own-iphone-free-personal-team) | The app on your own phone. It stops launching after 7 days: rebuild and install again. No push entitlement. |
| The paid Apple Developer Program | [TestFlight](#testflight)                                                       | A build that stays installed, plus native push and passkeys in the app.                                     |

The iPhone app is a Capacitor shell around the Talos web app (`apps/mobile`). It loads the relay origin fixed at build time and ships no web assets of its own, except a "can't connect" page.

## What you need

- Xcode, `xcodegen` (`brew install xcodegen`), `pnpm`.
- Your Apple Team ID and a bundle id that is yours alone (the share extension becomes `<id>.share`).
- Your relay's address (`https://...`), no path.
- For TestFlight (paid program): an App Store Connect API key (Users and Access, Integrations). You get a `.p8` file, a Key ID and an Issuer ID. Keep the `.p8` outside this repo.
- For TestFlight, an app record for your `TALOS_BUNDLE_ID` in App Store Connect (My Apps, New App), created once. Without it the upload step fails after a full build. The share extension (`<id>.share`) needs no record of its own.

None of these are committed. `apps/mobile/ios/Local.xcconfig` (untracked) holds them for local Xcode builds; `scripts/testflight.sh` reads them from the environment.

## Run on a simulator or your phone

1. `echo TALOS_RELAY_URL=https://your-relay > apps/mobile/.env.local`
2. `pnpm --filter @talos-app/mobile cap:sync && pnpm --filter @talos-app/mobile xcodegen`
3. Open `apps/mobile/ios/App/App.xcodeproj`, pick a device, Run. For a real phone create `apps/mobile/ios/Local.xcconfig` with `DEVELOPMENT_TEAM` and `TALOS_BUNDLE_ID` (see `Signing.xcconfig`).

## Build and install on your own iPhone (free Personal Team)

Needs: Xcode with your Apple ID added (Settings > Accounts), Developer Mode on the phone (Settings > Privacy & Security),
the phone connected and trusted. Nothing about your team goes in the repo: two gitignored files carry it.

```sh
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
launching after 7 days: rebuild and install again. A free Personal Team cannot sign the push entitlement, so this build has
no native push (web push through the Home Screen web app still works).

## TestFlight

This needs the paid Apple Developer Program and your own App Store Connect app record. It uploads a build to your account.

```sh
export ASC_KEY_PATH=~/keys/AuthKey_XXXXXXXXXX.p8   # outside the repo
export ASC_KEY_ID=XXXXXXXXXX
export ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
export DEVELOPMENT_TEAM=YYYYYYYYYY
export TALOS_BUNDLE_ID=com.you.talos
export TALOS_RELAY_URL=https://your-relay
export TALOS_APP_ENTITLEMENTS=App/AppPush.entitlements   # only for native push and passkeys in the app
export TALOS_RELAY_HOST=your-relay                       # optional; taken from TALOS_RELAY_URL, and if you set it, it must match (the bare host, equal to the relay's RP_ID)
scripts/testflight.sh --dry-run   # checks the environment and prints the commit and build number
scripts/testflight.sh             # archive, export, upload
```

What it does:

- Builds from a throwaway checkout of `origin/main` (set `TESTFLIGHT_REF` for another commit), so uncommitted work never ships.
- Build number is the UTC time, `YYYYMMDDHHMM`, passed on the command line. Every upload is higher than the last, with no file to edit. The version shown to testers is `MARKETING_VERSION` in `apps/mobile/ios/App/project.yml`; change it there (then `xcodegen`) for a new version.
- Push needs the paid Apple program: also `export TALOS_APP_ENTITLEMENTS=App/AppPush.entitlements`. `TALOS_RELAY_HOST` is optional (taken from `TALOS_RELAY_URL`, and if you set it, it must match); the script passes the host to the build: the throwaway checkout has no `Local.xcconfig`, so without it the app would be signed for the placeholder host `unset.invalid` and the passkey prompt would be refused. See `docs/IOS-PUSH.md`.
- Refuses to ship (also in `--dry-run`) unless `RelayTrust.verifiesTheMac` is `true` in the ref's `RelayTrust.swift`; the attest commit sets it, so no build trusts a scanned relay without verifying the Mac.
- Refuses to run if any variable is missing, or if the key file is inside the repo. It never prints the key.
- Export compliance is answered in the app (`ITSAppUsesNonExemptEncryption: false` in `project.yml`), so App Store Connect does not ask on each build.

After the upload, App Store Connect processes the build (usually 5 to 30 minutes), then it appears under TestFlight. Add yourself as an internal tester once.

If Apple emails about "required reason" APIs, the first thing to check is the privacy manifest; this was not verified here.

## Checking a build by hand

On a real phone, work through the checks below (the maintainer keeps a longer private checklist that is not in this repository):

- Airplane mode, force-quit, open the app. **Expect** the Talos splash, then within 12 seconds a "Talos can't connect right now" page. **Try again** works, and so does turning airplane mode off or reopening the app.
- Open a zip, CSV, Word file or PDF from a thread. **Expect** a preview with Share and an X at the top right; a PDF never opens without Share.
- Open a long HTML attachment and swipe down to scroll, including at the very top. **Expect** it only scrolls (or bounces); the X at the top right is the only way out.
- Open an mp4 attachment. **Expect** it plays (or shows the player), never "Talos could not load this file".
- Open a zip, CSV or Word file from a thread. **Expect** a preview with a Share button, never a blank sheet. A file the Mac no longer has shows a plain message.
- Use the app, leave it for a long while (an hour, or overnight), open it again. **Expect** the page, or "Reconnecting…" with a spinner and then the page or the "can't connect" page. Never a black or blank screen that takes no touch.

## UI tests

The shell has UI tests that drive the real app on a simulator: the + menu, the photo picker, the document picker. Run them before
each TestFlight upload and after any change to `apps/mobile/ios/App/App/Plugins/TalosPicker.swift` or the composer's attach code:

```sh
bash apps/mobile/scripts/ui-test.sh        # about 3 minutes; prints "ui-test: N passed, M failed (S s)", exit 0 when all pass
```

Needs Xcode, `xcodegen`, `pnpm` and `node`. No Apple ID or signing: it is a simulator build. It is not in CI (over two minutes on
a warm machine, and it needs a desktop session for the simulator); `scripts/testflight.sh` says to run it first.

- **What it reaches.** The shell loads one origin, fixed at build time. The script builds it with `http://127.0.0.1:18791` (loopback;
  `TALOS_UITEST_PORT` changes the port) and starts a throwaway Node server there (`apps/mobile/ui-test/fixture-server.ts`) that
  serves a small composer page (`composer-fixture.html`). The page has the real composer's three menu labels and calls
  `TalosPicker` the way `useComposerAttachments.ts` does, then lists what came back. It never touches a relay or a sign-in. The
  tests cover the native half (the plugin and the system pickers); the web composer itself is covered by the web tests.
  There is no test-only code in the app: nothing is compiled in or out, the origin is the existing build-time setting.
- **What it seeds.** A dedicated simulator named "Talos UI Test" (created on first run, erased on every run, shut down after): two PNGs
  go into Photos with `simctl addmedia`, and `talos-ui-note.txt` into Files > On My iPhone.
- **What it checks.** + opens exactly one menu (Photo library, Camera, Files) and no iOS sheet; the photo picker returns two selected
  images as two attachments; the document picker has no Photos source and returns the seeded file; cancelling either picker leaves
  the plus button working and the box typing; the Camera button exists (a simulator has no camera, so it is not tapped through).
- The script puts `apps/mobile/ios/App/App/capacitor.config.json` (gitignored) back as it found it, so a later real build is not
  left pointing at the fixture.

## Coming back to the app

iOS may end or freeze the page's web process while the app is in the background. On every return to the front the shell asks the page one question (`BridgeGuard.livenessScript`) and acts on the answer (`WebViewRevival`):

- the page answers with content: nothing happens;
- the web process is gone, or the document is empty: the page is loaded again, where it was;
- no answer twice (2 s, then 5 s): the web view is replaced with a new one.

When WebKit itself reports that the web process died, the shell loads the page again through the same path. Any of these loads is watched by the launch watchdog, so a relay that does not answer ends on the "can't connect" page with **Try again**. "Reconnecting…" is on screen while a check is open for more than 0.4 seconds and while such a load runs. The watchdog stops in the background and starts again, with its full limit, on return.

`ios-repro/repro.sh` reproduces the cases on a simulator against a stub relay (`setup`, then `run <scenario> <tag>`, then `teardown`): `slow-relay` and `frozen` are the two that showed a dead screen before this was added. The screenshots it takes are in `ios-repro/shots/`. What a simulator cannot show is iOS's own memory kill of a suspended app's web process; `suspended-kill` is the nearest stand-in.
