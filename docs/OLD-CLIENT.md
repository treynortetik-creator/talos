# Old clients are tested

Room decision 4. A phone, the iPhone shell or the Mac window keeps running the web bundle it last loaded, often from its
service worker's cache, after the relay and the bridge under it have changed. So a change to the protocol, the relay or
the bridge's hello is tested against the bundle that is live now, before it ships.

## The saved bundles

- **Who saves them:** `.github/workflows/web-bundle.yml`, after every successful production deploy of talos-app. Railway
  posts a GitHub `deployment_status` per deploy; `web-bundle-deploy.yml` only notices the successful production one, and
  `web-bundle.yml` runs on its completion (`workflow_run`, on main's ref: a `deployment_status` run has no ref, and the
  Actions cache that carries the bundle between its jobs refuses it). It builds `apps/web` at the deployed sha exactly as
  `apps/relay/Dockerfile` does, with the deploy's short sha as the version, as on Railway. A missed one can be saved by
  hand: `gh workflow run web-bundle.yml -f sha=<deployed sha>`, only for the live one (the newest successful production
  deploy). A rollback to a commit older than this workflow change (2026-11-17) is not saved: that commit's own workflow
  files run, and they had no working save; save it by hand once it is live.
- **Seen when it fails:** its `report` job posts the commit status `web-bundle/save` on the deployed commit, success or
  failure, with a link to the run. From 2026-11-16 to 11-17 the publish step failed on every deploy and nothing said so.
- **Where:** a prerelease named `web-bundle-<sha8>`, never marked latest. It holds two files: `web-bundle.tar.gz` (the
  built app without source maps or `.md` files) and `manifest.json`. A redeploy of a sha already saved (a rollback)
  replaces its release, so it is the newest again: "newest" means published last, and that is what is live.
- **Only main:** a deployed sha that is not on main is not saved.
- **What the manifest holds:** sha, version, deployed_at and a sha-256 per file. Nothing else: no environment, no host, no
  names.
- **How many:** the newest 3, by when they were published. The gate uses only the newest, the one live now. The two before it are kept for a phone left
  closed over several deploys.
- **Personal data:** the job runs `scripts/check-no-personal.sh`'s generic rules over what it publishes: the manifest, the
  release's name and notes, and every bundle file outside the hashed `assets/`. Those are compiled from sources every
  push already scans; their minified text throws up random look-alikes, so they are left out.
- **Permissions:** three jobs, so no code from the repository or its dependencies runs where the write token is. `build`
  (read-only) checks out, installs, builds, scans and uploads a workflow artifact. `publish` (contents: write, and
  actions: read for the artifact) does no checkout and no install, only `gh`. `specs` (read-only) runs the old-client
  specs. Actions are pinned by commit sha. The workflow runs on `deployment_status` only, never on a pull request.
- **If the repository's visibility ever changes** (made public, or squashed into a new public repository), delete every
  `web-bundle-*` prerelease first: they are built copies of the private app.

## The gate's step

- **When it runs:** `scripts/gate.sh` adds the step "tests (old client: the saved web bundle)" when a change touches
  `packages/protocol/src/`, `apps/relay/src/`, `apps/relay/migrations/`, `apps/relay/package.json`, the bridge's
  `handshake.ts`, `relay-client.ts`, `bridge.ts` or `frames-out.ts`, the old-client specs, the e2e harness, or the step's
  own scripts. `--full` runs it too.
- **How it runs:** like any suite, under the heavy lock. The specs run in a process group of their own with a time limit
  on the whole group (`OLD_CLIENT_LIMIT`, 600 s).
- **The script:** `scripts/old-client.sh` fetches the newest prerelease with `gh`, once, into
  `~/.cache/talos/web-bundles/<tag>/`, and checks every file against the manifest. It then serves that bundle from this
  tree's relay (the e2e harness's `E2E_WEB_DIST`) next to this tree's bridge, and runs `e2e/tests/old-client/`.
- **What is never a pass:** no `gh`; a listing or download that fails or takes over 120 s (each in its own time-limited
  process group); a cached file that no longer matches its manifest, or a manifest for another commit; a relay that does
  not build; specs that time out, are stopped or cannot start; no saved bundle at all. Each refuses with what to fix.

### Gating (advisory at first)

The step gates: `GATING=1` in `scripts/old-client.sh`, so a failing old-client spec refuses the push. It started
**advisory** (2026-11-12): the first saved bundle was the one from the day this landed, so a failing spec printed
`old-client: ADVISORY: ...` and the gate went on. It flipped on 2026-11-13, after the save job had passed on saved bundles
and the newest one passed against main. Setting `GATING=0` again makes only a failing spec (Playwright's exit 1) advisory;
that exit also covers "no tests found" and a config error, so tell those apart before trusting an advisory pass.

## The specs: role and visible name only

The specs in `e2e/tests/old-client/` run on yesterday's page, so they find things the way a person does, by role and
visible name, **never by test-id**: a test-id renamed today is not in the saved bundle. If a spec needs something the page
has never shown, it waits one deploy, until a saved bundle has it. The plain e2e run also runs them on today's bundle, so
a spec that drifts from the page shows at once. The save job runs them once on each new bundle with that sha's own relay
(`OLD_CLIENT_STRICT=1`): a red there is about the specs, not the release.

They cover:

- pairing and the hello, with every keep-list feature reaching the page
  (`apps/bridge/test/features-budget.test.ts`) and no "newer than this app" note;
- a message and its reply, in two threads kept apart;
- Run;
- a message written offline, delivered once.

## What a red means

The change would break a phone that has not reloaded. Make the relay or the bridge accept the old page, or make the change
show itself through the needs-update path (`e2e/tests/15-needs-update.spec.ts`).
