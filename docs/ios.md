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
export TALOS_RELAY_HOST=your-relay                       # required with AppPush: the bare host, equal to the relay's RP_ID
scripts/testflight.sh --dry-run   # checks the environment and prints the commit and build number
scripts/testflight.sh             # archive, export, upload
```

What it does:

- Builds from a throwaway checkout of `origin/main` (set `TESTFLIGHT_REF` for another commit), so uncommitted work never ships.
- Build number is the UTC time, `YYYYMMDDHHMM`, passed on the command line. Every upload is higher than the last, with no file to edit. The version shown to testers is `MARKETING_VERSION` in `apps/mobile/ios/App/project.yml`; change it there (then `xcodegen`) for a new version.
- Push needs the paid Apple program: also `export TALOS_APP_ENTITLEMENTS=App/AppPush.entitlements`. The script then requires `TALOS_RELAY_HOST` and passes it to the build: the throwaway checkout has no `Local.xcconfig`, so without it the app would be signed for the placeholder host `unset.invalid` and the passkey prompt would be refused. See `docs/IOS-PUSH.md`.
- Refuses to run if any variable is missing, or if the key file is inside the repo. It never prints the key.
- Export compliance is answered in the app (`ITSAppUsesNonExemptEncryption: false` in `project.yml`), so App Store Connect does not ask on each build.

After the upload, App Store Connect processes the build (usually 5 to 30 minutes), then it appears under TestFlight. Add yourself as an internal tester once.

If Apple emails about "required reason" APIs, the first thing to check is the privacy manifest; this was not verified here.

## Checking a build by hand

On a real phone, work through the checks below (the maintainer keeps a longer private checklist that is not in this repository):

- Airplane mode, force-quit, open the app. **Expect** the Talos splash, then within 12 seconds a "Talos can't connect right now" page. **Try again** works, and so does turning airplane mode off or reopening the app.
- Open a zip, CSV, Word file or PDF from a thread. **Expect** a preview with Share and Done; a PDF never opens without Share.
- Open an mp4 attachment. **Expect** it plays (or shows the player), never "Talos could not load this file".
- Open a zip, CSV or Word file from a thread. **Expect** a preview with a Share button, never a blank sheet. A file the Mac no longer has shows a plain message.
