# Deploying the relay on Railway (reference)

The walkthrough for the whole setup, in plain words, is [`SETUP.md`](SETUP.md). This page is the short reference for the
Railway side.

- **One service**, built from `apps/relay/Dockerfile` (`railway.json` selects it). One replica, **sleep off**: the Mac's
  connection must stay up. Health check `/healthz`; restart on failure.
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
  plan's included credit is shared with your other projects, so check the usage page. Live voice is billed separately by
  OpenAI at about five cents a minute.
- **Building the image yourself.** From the repository root: `docker build -f apps/relay/Dockerfile -t talos-relay .`. The
  container runs as a non-root user, listens on `PORT` (default 8080) and expects the volume at `/data`.
