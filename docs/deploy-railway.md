# Deploying the relay on Railway (reference)

The walkthrough for the whole setup, in plain words, is [`SETUP.md`](SETUP.md). This page is the short reference for the
Railway side.

- **One service**, built from `apps/relay/Dockerfile` (`railway.json` selects it). One replica, **sleep off**: the Mac's
  connection must stay up. Health check `/healthz`; restart on failure.
- **Which release it is.** A relay built from a release image (`--build-arg TALOS_RELEASE=0.1.8`, which the Dockerfile turns into the
  `TALOS_RELEASE` variable) says so: `/healthz`, `/api/me` and the health report's `relay` carry `release` (a plain `X.Y.Z`, read once
  at start; anything else is ignored and logged once). `version`, the commit, is unchanged. A relay that deploys from `main` sets
  nothing and reports no `release`; `talos-app doctor` and `status` never call it behind. For one that does report it, they count the
  published releases newer than it ("2 releases behind"), see [`bridge.md`](bridge.md).
- **Release images.** Each published release (`mac-v<X.Y.Z>`) of the public repository builds this Dockerfile with
  `TALOS_RELEASE=<X.Y.Z>` (`.github/workflows/relay-image.yml`) and pushes `ghcr.io/<owner>/talos-relay:<X.Y.Z>`, a tag that is never
  overwritten, and then `:stable` to the same image. `:stable` moves only on a release, never on a push to `main`, and a rebuild of an
  older release, a prerelease or a draft leaves it where it is (a rebuild by hand, with the `version` input, must name a published release). There is no `:latest`. Before anything is pushed, the built image's `/app` folder (what the Dockerfile adds, not the base image) is exported and
  scanned (`scripts/relay-image-scan.sh`): secret-looking files (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`), a token in an `.npmrc`, a
  `.git` folder, an absolute link, a private key or a GitHub, Anthropic, AWS or Slack token, and the personal-data rules fail the build, as does a checkout that is not exactly the tag's tracked files. A relay
  that follows `:stable` runs the newest release. **One-time owner step:** after the first push, make the `talos-relay` package public
  (GitHub, Packages, Package settings, Change visibility), or Railway cannot pull it. A rebuild by hand for a tag made before this workflow existed fails closed: the scan script comes from the tag's own checkout, which does not have it.
- **Keeping a release relay up to date.** Run `talos-app relay connect` once, in a terminal. It walks you through making a Railway
  **project token** (Project, Settings, Tokens, for the relay's environment; Railway lets you mint one only in the dashboard), reads it
  hidden (a token on the command line is refused), finds your relay's service by matching this install's relay address against the
  environment's service domains (else you paste the service ID), shows "relay service: <name>, environment <name>" and asks you to
  confirm. The token goes in this computer's key store (item `com.talos.app.railway.<h>`, account `relay`, one per Talos home), never in a
  file. `relay-connect.json` in the Talos home holds the ids, the names and the switch. A project token "can read your relay's
  settings" and nothing outside that project; an **account or workspace token** is accepted too, but "can change every project in
  your Railway account; a project key is safer", so it is kept only if you type `yes`. The bridge sends Railway one redeploy
  request (`serviceInstanceRedeploy`) and a few read-only questions that find the service; nothing else (`apps/bridge/src/relay/railway.ts`
  is the one module that talks to Railway, with a test that fails on any other operation).
  - `talos-app relay update` moves a `behind` relay to the newest release now and watches `/healthz` (every 10 seconds, up to 10
    minutes). Your agent may run it unless "Lock Talos settings" is on (the same rule as `peer link`); it never runs `connect`.
    A relay that deploys from `main` is refused ("it isn't updated from releases"); one already on the latest does nothing.
  - **Auto-update is on once connected.** At most once an hour the bridge compares its relay with the published releases; when the relay
    is `behind` and that release was not already tried, it redeploys once and says so in the default thread ("Your online relay is
    updating to X", then "is on X" or "didn't update to X: <reason>. Run talos-app relay update to try again"). After a failure it does
    not retry the same release by itself for 24 hours. `talos-app relay auto off` turns it off (always allowed to an agent), `relay auto on`
    turns it on. `talos-app relay status` shows what is connected, the switch and the last attempt (never the token);
    `talos-app relay disconnect` forgets the token and the file; your agent may run it unless "Lock Talos settings" is on (the same rule as `relay update`).
  - **A relay the Mac app set up** holds the Railway login in the app (the app refreshes it; the bridge never sees a Railway token). The
    app writes `relay-connect.json` itself with `via: "app"` and no token. The bridge then asks through two files in the Talos home;
    their shapes are `RelayConnectFile`, `RelayRedeployRequest` and `RelayRedeployResult` in `packages/protocol/src/relay-redeploy.ts`
    (fixtures in `packages/protocol/fixtures/relay-redeploy`). The bridge writes `relay-redeploy-request.json` (0600, atomic, never
    through a symlink): `{v:1, id, release, requested_at}`; a new request replaces the old, and the bridge writes one at most once an
    hour on its own. The app ignores a request older than 10 minutes, keeps one in flight (the newest `id`), redeploys, and writes
    `relay-redeploy-result.json`: `{v:1, id, release, ok, code?, error?, done_at}`. The bridge believes only a result with the same `id`
    AND `release`, confirms the move by `/healthz`, and after 10 minutes with no result says it didn't update. `code` is one of
    `not_signed_in`, `no_card`, `railway_down`, `not_found`, `other` (an unknown one reads as `other`) and maps to a plain fix in the
    thread row. When an app update and a relay update are both due the relay goes first, and the app does not start its own install while a
    relay request is in flight. `relay disconnect` for such a relay only clears the bridge's files; the app's Railway login is removed in
    the app.
- **One volume** mounted at `/data` (SQLite database and uploaded media). One gigabyte is enough. There is brief
  downtime on each deploy while the old container stops; the app and the bridge reconnect with backoff.
- **Which branch a relay deploys from.** A relay service deploys on a push to its trigger branch, which is set in Railway (Service,
  Settings, Source), not in this repository. A beta relay's trigger branch is `green`: main's newest commit that CI passed on all six
  checks (the repository's CI keeps `green` pointing at it). The owner's own relay tracks `main` for now; whether it moves to `green` is his
  call. Which relays exist, and which must run only six-green commits, is a list kept outside the repository (the repository variable
  `CI_RELAY_DEPLOYS`, and `~/.config/talos-ci/relay-deploys.txt` on the lead's Mac; the format is `scripts/relay-deploys.example.txt`).
  `ci-runner.sh relays` raises an alert when a `green` relay runs a commit whose own six CI statuses are not green.
- **The lag.** A commit reaches a beta relay only after CI has passed on it and `green` has moved, about 25 to 35 minutes after it
  lands on `main`, then the build and deploy. A fix is not live on a beta relay the moment it lands.
- **Hotfixes.** (a) The normal way: the fix lands on `main`, CI goes green on all six checks, `green` moves by itself and the relay
  deploys. If the fix is green but `green` did not move (the `green` job failed), the lead moves it with the CI job's own step, by hand
  and with its checks: `bash scripts/ci-runner.sh green`, with the job's own variables (`GITHUB_EVENT_NAME=push`,
  `GITHUB_REF=refs/heads/main`, `GITHUB_REPOSITORY`, `CI_PLAN_SHA=<the fix's full sha>`; never a bare `git push`, never forced).
  `CI_GREEN_TRUST_RUN=<run id>` is added only when the fix's six passes came from a dispatch run rather than a push run.
  The relays check trusts push runs only, so a relay that then runs that commit also needs a line in the hand-deploy list,
  or the check reports it as not green.
  (b) Emergency only: the lead deploys a commit that is not green yet by hand in Railway, adds a line for it to the hand-deploy list
  (`<full sha>`, the environment, the date, the reason: the repository variable `CI_RELAY_HAND_DEPLOYS` and
  `~/.config/talos-ci/relay-hand-deploys.txt`; format in `scripts/relay-hand-deploys.example.txt`), and says so in the landing note.
  That line is what keeps the relays check quiet; there is no script that bypasses `green`. Deploy by hand through the service's GitHub
  source (deploy that commit from the service in Railway), never with `railway up`: an upload by the CLI probably creates no GitHub
  deployment, so the check cannot see it.
- **Deploys only for relay changes.** `railway.json` `build.watchPatterns` lists what the image is built from (the relay,
  the web app, `packages/`, the workspace manifests and lockfile); a push touching nothing there does not redeploy.
  `apps/relay/test/deploy-watch.test.ts` fails if the Dockerfile copies something no pattern covers.
- **Daily backups** of the volume: switch them on in the volume's **Backups** tab. They hold the passkey registration, the
  device list and the integration connections. They are useless without `DATA_KEY`, which you must keep separately.
- **Domain.** Use the generated `*.up.railway.app` address. **Moving to a custom domain later voids every passkey and
  every enrolled device**: set `PUBLIC_ORIGIN` and `RP_ID` to the new host, redeploy, then enroll each device again and
  revoke the old ones (see decision [0001](decisions/0001-domain-and-rp-id.md)).
- **Variables.** `.env.example` lists every variable the relay reads, with its default and a one-line explanation. The
  relay validates them at start and names the ones that are wrong.
- **Order of operations.** Create the project and volume, set the variables except `BRIDGE_PUBKEY`, deploy, run
  `talos-app init` on the Mac, set `BRIDGE_PUBKEY`, redeploy, run `talos-app enroll`, add the phone.
- **Update order.** Deploy the relay before updating the Mac. A new Mac behind an old relay refuses the old app's unsigned `media.fetch`, and the old relay turns each refusal into a row in the default thread.
- **Rollback.** Redeploy the previous build in Railway. The database only gains columns, so older code mostly still runs. One exception: inbox and webhook events are stored sealed from the release that encrypts them (`hooks_events.event_enc`). Rolling back to the release just before that one is safe, because it already reads sealed rows. Rolling back to a build older than that cannot read them: the inbox fails to load and webhook delivery stops until you redeploy a newer build.
- **Cost.** Roughly $1.50 to $2.50 a month of usage for the relay (memory, a little CPU, one gigabyte of volume). The Hobby
  plan's included credit is shared with your other projects, so check the usage page.
- **Building the image yourself.** From the repository root: `docker build -f apps/relay/Dockerfile -t talos-relay .`. The
  container runs as a non-root user, listens on `PORT` (default 8080) and expects the volume at `/data`.
