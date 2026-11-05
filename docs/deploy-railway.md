# Deploying the relay on Railway (reference)

The walkthrough for the whole setup, in plain words, is [`SETUP.md`](SETUP.md). This page is the short reference for the
Railway side.

- **One service**, built from `apps/relay/Dockerfile` (`railway.json` selects it). One replica, **sleep off**: the Mac's
  connection must stay up. Health check `/healthz`; restart on failure.
- **One volume** mounted at `/data` (SQLite database and uploaded media). One gigabyte is enough. There is brief
  downtime on each deploy while the old container stops; the app and the bridge reconnect with backoff.
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
