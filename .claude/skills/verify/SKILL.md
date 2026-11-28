---

name: verify
description: The pre-commit smoke-test recipe for Talos. Run it before every commit that changes behaviour (skip docs-only and test-only changes) and before calling any Talos change done. It says what to drive on each surface (Mac app, web client in fake mode, iPhone simulator, bridge/CLI), how to capture before/after screenshots or transcripts as evidence, how to list every route the change reaches, how to check every theme (colours only, fonts identical), and how to end the commit message with a Verified trailer.
version: 1.1.0
---

# verify: run the change, attach the evidence

"Tests pass" is not "it works". Before a change counts as done, drive the REAL thing on every route it touches and keep a
picture or transcript. Say "works" after one route and you have made the exact mistake this skill exists to stop.
House rules (worktrees, group time limits, never-list) are in `talos-build`; read that first. This skill adds the run.

## Quick start (about 10 lines, pre-commit)

0. Docs-only or test-only change? Commit with `Verified: none - docs/tests only` and stop.
1. Write the **route list** (below) to a file, e.g. `$TMPDIR/routes.md`. Every sender, device, platform: EXERCISED or NOT exercised and why.
2. Before: `git worktree add --detach <wt>/verify-before <sha>^`, then `pnpm install --frozen-lockfile --ignore-scripts` there (skip for a new feature).
3. `node scripts/verify/capture.mjs web --worktree <wt>/verify-before --label before --sha <short-sha> --routes <route,route>`
4. After: `node scripts/verify/capture.mjs web --worktree <your worktree> --label after --sha <short-sha> --routes <route,route> --route-list $TMPDIR/routes.md`
5. Bridge/CLI change: `node scripts/verify/bridge-run.mjs --worktree . --label after --route <name> --cli '0::<args>' --route-list ...`
6. Read the PNGs (look at them) and `index.md`. Any `FAIL`, or any exit other than 0, means it is not done.
7. Mac app / iPhone simulator / real browser parts: the sections below.
8. Remove only the worktrees you made. Commit with the trailer: `Verified: <what you drove>; evidence <root>/<short-sha>/` (see "Landing"). Write `<root>` literally, never the absolute folder: a home path in a commit is refused by the personal check.

Both scripts stop what they started when they are interrupted (SIGINT exits 130, SIGTERM 143: the relay, build and test processes, the temp folders, a simulator they booted). Exit codes: 0 good; 1 an expectation failed (in a `before` run that is recorded as observed, because the bug is the point);
2 bad usage; 3 a surface could not be reached (printed, and written into `index.md`; never skipped quietly).

## Route list (mandatory, before any capture)

Write one line for every sender, device and platform the change reaches. `capture.mjs --label after` refuses to run without it.

```
- own device (the owner's Mac app):      EXERCISED  (Mac app, screen_shot after-02)
- beta install (another person's Mac):   NOT exercised: no second machine here; same code path as own device, read in <file>
- Mac / iOS / Android / web / Linux / Windows: one line each; "not touched by this change" needs the file that shows it
- owner as sender / agent as sender / a thread's own session: one line each
```

Rules: a line says EXERCISED with the capture that proves it, or NOT exercised with a reason. No third state, no blank. A route that
only a unit test covers is NOT exercised here (say which test). The landing note quotes this list.

## Evidence

- Folder: `<root>/<short-sha>/` where `<short-sha>` is the change's commit (`--sha`). Root: env `TALOS_VERIFY_EVIDENCE_ROOT`, default the
  macOS Shared folder's `talos-verify-evidence` (the scripts print the exact path when they finish).
- Files: `<surface>-<route>-<theme>-<before|after>.png|mp4|txt`, for example `web-desktop-wordmark-paper-after.png`,
  `ios-sim-home-talos-after.png`, `cli-own-device-bug-report-na-after.txt`.
- Before AND after for every route: before = the parent commit (`<sha>^`) in a detached worktree, after = your tree. A new feature has no
  before; say so in the route list.
- `index.md` in the folder lists each capture, what it proves, the tree it came from, a result (`ok`, `observed: ...`, `FAIL: ...`) and the
  measured facts (fonts, contrast ratios). Add a line by hand for anything you captured outside the scripts (Mac app, browser MCP).
- The landing note links the folder (`talos-build` section 8: one real-run artifact per visible change).
- Never put a secret, a real home path or a real person in a capture. Fake mode and a throwaway home have none.

## Themes (any visual change)

The theme list is read from code, not remembered: `STOCK_THEME_IDS` in `packages/protocol/src/theme.ts`. `capture.mjs` runs every route under
EVERY id in that list (today `talos` = default, `paper`, `hearth`; new ones are picked up with no edit). `--themes talos,paper` narrows it
(a change that is not visual may use `--themes talos`; say so in the route list). Themes change COLOURS ONLY. For each theme the script:

1. **Sets it the way the owner does**: Settings > Appearance > Colour theme, then opens the route in the same page. (A stored value does not
   stick in fake mode: the in-memory client re-applies its own config. The script checks the theme really applied: inline `--bg` on `<html>`
   is set for a non-default theme, empty for the default; otherwise the capture fails with "the theme did not apply".)
2. **Fonts are identical across themes.** It reads the computed `font-family` and weight of the body, the wordmark, the first heading and
   any monospace text, and compares across all themes. Any difference fails, naming the element and each theme's value.
   (Until the themes' fonts are removed from the app, an `after` run fails here: that is the finding, not a script fault.)
3. **Contrast is measured.** For body, wordmark, heading and secondary text it takes the computed text colour and the page colours under it
   (backgrounds composited from the page down, through a canvas so oklch and the like become sRGB), then WCAG 2.x: ratio = (L1+0.05)/(L2+0.05).
   Body text needs 4.5:1; large text (24 px, or 18.66 px bold) needs 3:1. A colour the check cannot read is a fail, never a pass.
   `--no-contrast` skips this; use it only for a route that is not text.
4. **Light and dark.** `--scheme light|dark` (default light). A colour change gets both: run twice.
5. **Look at the picture.** A wordmark bug on Paper only showed on Paper. Measured numbers do not replace reading the PNG.

## Surface 1: the Mac app (the real installed app, ~/Applications/Talos.app)

You cannot script this from a shell: use your Talos screen tools (MCP tools of the `talos-app` server): `screen_shot`, `screen_open_app`,
`screen_click`, `screen_type`, `screen_key`, `screen_scroll`. A builder sub-agent without them says "Mac app: NOT exercised, no screen tools" in
the route list and the lead runs it.

1. `screen_open_app` with `Talos`. `screen_shot`: it is the real app, not a mock. Name what is on screen in `index.md`.
2. Does the installed app contain your change? Only a fresh build does. Build: `bash apps/desktop/scripts/build-app.sh --out <temp dir>`
   (needs the signing identity named in `build-app.sh`'s header). Installing replaces the owner's running app (`apps/desktop/scripts/install.sh`):
   that is a Mac install, allowed with a one-line notice to the owner; do it only if the brief says so. Otherwise say "installed build predates
   the change" and verify on web and the simulator.
   **To pick up a new relay or web build in the running app, press `screen_key` `cmd+r`** (View > Reload): the Talos window loads its current
   page again and keeps the route. **Never quit or relaunch Talos for that.** A quit drops every session the app owns, Main and Pantheon
   included (it happened on 2026-11-17). Reload needs the Talos web window to be the front window; a Mac build that predates View > Reload
   refuses the key with `key_not_in_menu`, and then you say "installed build predates reload" instead of relaunching.
3. Drive the change from its real entry point: `screen_click` the button, `screen_key` the shortcut, `screen_scroll` the list. Never reach
   a state by editing files or defaults.
4. `screen_type` replies say whether the text was verified. A bare "Typed N" is NOT proof: take a `screen_shot` after typing and read it.
5. Take a `screen_shot` before the action and after it. Save both under the evidence folder as `mac-<route>-<theme>-before|after.png`.
6. Themes: Settings > Appearance, pick each theme (the Mac window is a web view: WebKit), `screen_shot` each. Put the owner's original
   theme back when done.
7. Never read or write the real clipboard, never open real URLs or system panels from this run.
8. **A change to what an agent may do in Talos itself** (`docs/SECURITY.md`, "An agent in Talos") needs the real chain once, by hand,
   because no CI session delivers a posted CGEvent to WebKit: with Talos on the allowed list and a pending approval card on screen,
   `screen_click` its Approve button, `screen_key` Return with it focused, and `screen_type` a newline. Each must answer
   `protected_prompt` and leave the card pending (`screen_shot` to see it); then `screen_click` the thread list or the composer, which
   must work. Then `screen_click` and `screen_type` into a terminal pane (the Terminals window, the Terminal screen's shell): also
   `protected_prompt`, nothing typed. Finally tap Approve with your own mouse: it must answer. This is the run the automated test
   `ProtectedInputScriptGuiTests.realEventsThroughTheRealWindowIntoARealPage` stands in for (it cancels itself where the session cannot
   inject events into WebKit). Also read the answers: a `delivery_unverified` here means the system dropped the token from the posted
   event, and the design needs a look.

## Surface 2: the web client (fake mode, no pairing)

Pairing a NEW device is on the owner's ask list: do not. Fake mode needs no pairing, no relay and no account: `VITE_FAKE=1` builds the app with
the in-memory client (`apps/web/src/lib/fakeClient.ts`, chosen in `apps/web/src/main.tsx`; `apps/web/src/App.tsx` skips sign-in). Seed threads:
`/t/general`, `/t/inbox`. Query switches: `?fake_mod=offline|absent`, `?fake_agents=demo|empty`, `?fake_host=windows|linux|none`, `?fake_offline=1`.

**Headless, no MCP (what `capture.mjs` does):** builds `apps/web` with `VITE_FAKE=1 pnpm exec vite build --outDir <temp>`, serves the folder from
the script itself on a free 127.0.0.1 port (nothing to stop; the server closes when the script ends), drives each route in Playwright
(`@playwright/test` is already a repo dependency; browsers come from `pnpm exec playwright install chromium webkit`; nothing is added),
and saves one screenshot per route x theme at 2x.

```
node scripts/verify/capture.mjs web --worktree . --label after --sha <short-sha> \
  --routes wordmark,home --route-list "$TMPDIR/routes.md"
# options: --viewport desktop|phone (1280x800 | 390x844)  --engine chromium|webkit  --scheme light|dark
#          --themes talos,paper  --path /memory --route-name nyx (an ad hoc route)  --font-targets body,wordmark
```

- Routes known by name live in `scripts/verify/routes.mjs` (`home`, `wordmark`, `settings-appearance`, `nyx`).
  A change on a screen no route covers: add a route there (`path`, `ready`, optional `act`, `expect`) in the same commit; or use `--path`.
- A route's `ready` waits for the screen to really draw, never a bare sleep. `act` is what the owner does (a real mouse click at the
  note's screen position). `expect` is the claim; for a `before` run a failing claim is the proof the bug existed.
- A phone-width change: run again with `--viewport phone`. Keyboard and focus: a Playwright spec under `apps/web/test` (not this skill).
- WebKit is what the Mac app and iPhone use: run `--engine webkit` for anything layout- or font-sensitive.
- The old sha: `git worktree add --detach <wt>/verify-before <sha>^`, `pnpm install --frozen-lockfile --ignore-scripts` in it (hooks stay as they are),
  capture with `--label before --sha <the change's short sha>`, then `git worktree remove <wt>/verify-before`. Only remove ones you made.

**Real browser (`talos-browser` MCP: Playwright with its own profile):** use it when the headless path cannot reach what you need (a page that
only exists in a real session). Use an already-paired session, never pair. For fake mode: serve the build yourself
(`VITE_FAKE=1 pnpm --filter @talos-app/web exec vite build --outDir <temp>` then `pnpm --filter @talos-app/web exec vite preview --outDir <temp> --host 127.0.0.1 --port <free port> --strictPort`,
a port outside the CI slot ports 4873 to 4923; stop it by pid). Never Claude in Chrome. Save its screenshots under the same names, and
add the lines to `index.md` by hand. A sub-agent without that MCP says "real browser: NOT exercised".

## Surface 3: the iPhone simulator

The iPhone shell wraps the web app (`apps/mobile`, Capacitor). Two levels:

- **Fast (web in Mobile Safari, fake mode):** `node scripts/verify/capture.mjs sim --worktree . --label after --sha <short-sha> --routes home --udid <udid> --route-list "$TMPDIR/routes.md"`
  (`--route-list` is required for `after`, as everywhere). **You only drive a device you booted.** `--udid` names a SHUT-DOWN device: the script boots it
  and shuts it down again when it ends, also when it is interrupted. A device that is already booted is refused (exit 2: it is somebody else's); if you
  booted one yourself, say so with `--use-booted` (exactly one booted device; it is left running). With neither flag it exits 2.
  It builds fake mode, serves it, opens the URL with `xcrun simctl openurl`, waits until the device has really fetched the page's script and style
  (up to 45 s, then exit 3), settles 4 s, and saves `ios-sim-<route>-talos-<label>.png` with `xcrun simctl io <udid> screenshot`. It cannot force a
  theme there: set the theme by hand through Settings > Appearance in the simulator and take a screenshot (`xcrun simctl io <udid> screenshot <file>`).
- **The real shell:** build and run `apps/mobile` on the simulator (`docs/ios.md`: `cap:sync`, `xcodegen`, Xcode Run; `apps/mobile/scripts/ui-test.sh`
  boots a dedicated "Talos UI Test" device and drives the shell with XCUITest, which is the reference for any native flow).

```
xcrun simctl create <name> <device type> <runtime>            # your own simulator; never use talos-ci-s* or a shared device
xcrun simctl boot <udid>                                      # boot (no Simulator window needed); capture.mjs sim --udid does this for you
xcrun simctl io <udid> screenshot <file>.png                  # picture
xcrun simctl io <udid> recordVideo <file>.mp4 &               # clip; stop it by pid with kill -INT
xcrun simctl shutdown <udid>                                  # only a device you booted
```

Never touch a device you did not boot. A clip: keep it short (under 30 s), 720p is plenty.

## Surface 4: the CLI and the bridge side

For anything in `apps/bridge`, the `talos-app` CLI or the relay: run the real bridge CLI against a real relay of the checkout and a throwaway home,
and keep the transcript. Never the real `~/.talos`: the script makes its own temp folder, sets `TALOS_APP_HOME` and `HOME` to it, and removes every
`TALOS_*`, `CLAUDE_CODE_*`, `CLAUDECODE` and `CHRONOS_RUN` variable first.

```
node scripts/verify/bridge-run.mjs --worktree . --label after --sha <short-sha> --route own-device-bug-report \
  --cli '0::errors list' \
  --cli '2::errors requeue-bug-report abc' \
  --cli '1::errors requeue-bug-report 01JZZZZZZZZZZZZZZZZZZZZZZZ' \
  --cli '@stop-relay' --cli '1::errors requeue-bug-report 01JZZZZZZZZZZZZZZZZZZZZZZZ' \
  --run 'pnpm --filter @talos-app/bridge exec bun test test/problems.test.ts -t requeue' \
  --expect-text 'usage: talos-app errors requeue-bug-report' --route-list "$TMPDIR/routes.md"
```

- `--cli '<exit>::<args>'`: one `talos-app <args>` call that must exit with `<exit>` (default 0). `@stop-relay` stops the relay mid-run: the
  steps after it show what the owner reads when the relay is gone (an error, never an empty or ok answer: failure class 5).
- `--run '<cmd>'`: any other command in the checkout (a test file that covers a path you cannot reach live); its exit must be 0.
- The script: builds the relay (`pnpm --filter @talos-app/relay build`), runs `talos-app init` in the temp home, starts `apps/relay/dist/index.js` on a
  free port with the key init made, runs the steps, stops the relay by pid, removes the temp folder. Output: `cli-<route>-na-<label>.txt`.
- What it cannot do: file a bug report from a device (that needs a paired, signed-in session: a passkey step, on the owner's ask list). Say so
  in the route list; the stored-report path is covered by `apps/relay/test/core/bug-reports-reconcile.test.ts` (use `--run`).
- Linux and Windows hosts: the CLI says "this computer" / "this PC" only when the host is that; on a Mac you cannot see those sentences here.
  NOT exercised unless you ran on that host; a unit test that sets the host counts as that test, not as a run.

## Landing: the Verified trailer

End every commit message with a trailer (a last paragraph of `Key: value` lines, so `git interpret-trailers` reads it):

```
Verified: web fake mode, graph click x5, themes all; evidence <root>/96f2389/
Verified: none - docs only
```

- It says what was driven and where the evidence is, as `<root>/<short-sha>/` (an absolute path is flagged as unusable). `Verified: none - <reason>` is allowed and the reason is required (a bare `none` is
  logged as unusable), so unverified commits can be found: `git log --format='%h %(trailers:key=Verified,valueonly)'`.
- The pre-push hook checks for it in **observe** mode: a commit without it gets one line on stderr and in the log
  (`<git common dir>/talos-verified-trailer.log`); it never blocks a push. `TALOS_VERIFIED_TRAILER=off|observe|enforce` (or
  `git config talos.verifiedTrailer`) sets the mode; enforce is built and tested, and the owner decides when it goes on. See `docs/CI-LOCAL.md`.
- The landing note: the route list, the folder link, and for each failed or NOT exercised route one line why.

## When something fails

- Exit 3 (a surface not reached): fix the cause the message names (missing `node_modules`, no browser, no booted device), or write the route as
  NOT exercised with that reason. Never edit the script's result by hand to green.
- Exit 1 in an `after` run: read `index.md`, fix the code, run again. A third failed round: stop and report (the review cap).
- A `before` run that shows no bug means your test of the bug is wrong, or the bug is not on this route. Find out which before going on.
- Every process you start is stopped by pid before you report; the scripts leave none (they say so if they cannot).
- Measured on the Mac that wrote this: a web capture of 3 themes takes 3 to 8 s including the build; the bridge route about 3 s; a simulator capture 7 to 17 s once the device is booted. Phone-width wordmark captures show the page, not the wordmark (the phone header shows the thread name).

## Changelog

- 1.1.0: Mac app route: `screen_key cmd+r` reloads the Talos window for a new relay or web build; never quit or relaunch Talos.
- 1.0.0: first version. Quick start, route list, evidence, themes read from code (fonts identical, contrast measured), Mac app, web fake mode,
  iPhone simulator, bridge/CLI, the Verified trailer.
