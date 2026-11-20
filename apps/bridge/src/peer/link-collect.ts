// The side that showed a link code (`peer link`) collects what the other install sent back. Called from the bridge's poll, before
// the owner-facing rows (peer/changes.ts) are looked at. For every inbox record of a link still being watched it asks its relay about
// the code (signed): when the other side has redeemed it, the relay hands over its inbox url and secret ONCE; we check both again, keep
// the secret in the key store, add the peer to config.json, and the owner gets "Linked with <name>" (changes.ts). A second use of the
// same valid code, noticed by the relay, is told as "Link to <name> was taken by another install; run talos-app peer remove <name>".
// Nothing here is ever logged but the peer's name; the secret and the url never leave this function except into the key store and config.
import { checkPeerInboxUrl, isPeerSecret, PEER_DAILY_CAP_DEFAULT, PEER_MAX, PeerName } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice } from '../context.ts'
import { RelayHttpError } from '../relay-http.ts'
import { openSecretStore } from '../secrets/store.ts'
import { PeerLedger } from './ledger.ts'
import {
  addInboundPeer,
  type InboundPeer,
  PEER_SECRET_SERVICE,
  peerSecretAccount,
  readInboundPeers,
} from './records.ts'

/** The poll keeps asking this long past the code's expiry, so a use that raced the clock is still seen. */
const WATCH_SLACK_MS = 60_000

const unfinishedText = (name: string): string =>
  `Link with ${name} didn't finish on this side; run talos-app peer remove ${name} and link again.`
const takenText = (name: string): string =>
  `Link to ${name} was taken by another install; run talos-app peer remove ${name}`
let running: Promise<void> = Promise.resolve()

export function collectPeerLinks(ctx: BridgeContext, now: number = Date.now()): Promise<void> {
  running = running.then(() => look(ctx, now)).catch(() => undefined)
  return running
}

const watched = (p: InboundPeer, now: number): boolean =>
  p.link?.by === 'link' && (p.link.state === 'open' || (p.link.state === 'done' && now < p.link.until + WATCH_SLACK_MS))

async function look(ctx: BridgeContext, now: number): Promise<void> {
  if (ctx.mode !== 'live' || ctx.worker) return
  for (const rec of readInboundPeers(ctx.env.home)) {
    if (!watched(rec, now) || !PeerName.safeParse(rec.name).success) continue
    try {
      await one(ctx, rec, now)
    } catch (e) {
      ctx.log.warn('peer link not collected', {
        peer: rec.name,
        error: e instanceof RelayHttpError ? `relay ${e.status}` : 'failed',
      })
    }
  }
}

function setLink(ctx: BridgeContext, rec: InboundPeer, patch: Partial<NonNullable<InboundPeer['link']>>): InboundPeer {
  const cur = readInboundPeers(ctx.env.home).find((p) => p.name === rec.name) ?? rec
  const next = { ...cur, link: { ...(cur.link as NonNullable<InboundPeer['link']>), ...patch } }
  addInboundPeer(ctx.env.home, next)
  return next
}

async function one(ctx: BridgeContext, rec: InboundPeer, now: number): Promise<void> {
  const link = rec.link as NonNullable<InboundPeer['link']>
  let st: Awaited<ReturnType<typeof ctx.http.getPeerLink>>
  try {
    st = await ctx.http.getPeerLink(rec.name)
  } catch (e) {
    if (e instanceof RelayHttpError && e.status === 404) {
      // the relay has no such inbox or code any more: a link still open here did not finish, and the owner is told
      if (link.state === 'open') await unfinished(ctx, rec)
      else setLink(ctx, rec, { until: 0 })
      return
    }
    throw e
  }
  let state = link.state
  // handed over (and wiped) by a read whose answer never got here: nothing is left to collect
  if (st.state === 'collected' && link.state === 'open') return unfinished(ctx, rec)
  if (st.state === 'redeemed' && link.state === 'open') {
    const ok = await accept(ctx, rec, st.back_url, st.back_secret)
    if (ok === 'invalid') return unfinished(ctx, rec)
    if (ok === 'store') {
      setLink(ctx, rec, { state: 'closed', taken: true })
      await postSystemNotice(ctx, takenText(rec.name), { silent: true })
      return
    }
    state = 'done'
  }
  if (st.replayed && !link.taken) {
    setLink(ctx, rec, { taken: true })
    await postSystemNotice(ctx, takenText(rec.name), { silent: true })
  }
  // an open code that ran out, or a link watched past its slack, stops being asked about
  const l = readInboundPeers(ctx.env.home).find((p) => p.name === rec.name)?.link
  if (
    l &&
    ((state === 'open' && (st.state === 'expired' || now > link.until + WATCH_SLACK_MS)) ||
      (state === 'done' && now >= link.until + WATCH_SLACK_MS))
  )
    setLink(ctx, rec, state === 'done' ? { until: 0 } : { state: 'closed', until: 0, expired: true })
}

/** The link ended without a stored peer on this side: closed (never silently), and the owner gets one fixed row. */
async function unfinished(ctx: BridgeContext, rec: InboundPeer): Promise<void> {
  setLink(ctx, rec, { state: 'closed', until: 0 })
  await postSystemNotice(ctx, unfinishedText(rec.name), { silent: true })
}

/** Checks what the relay handed over again, then stores it. False when anything is wrong or cannot be written (nothing is left half done). */
async function accept(
  ctx: BridgeContext,
  rec: InboundPeer,
  url: string | undefined,
  secret: string | undefined,
): Promise<'ok' | 'invalid' | 'store'> {
  const checked = checkPeerInboxUrl(url)
  if (checked === null || typeof secret !== 'string' || !isPeerSecret(secret)) return 'invalid'
  const name = rec.name
  const store = ctx.peers?.opts.secrets ?? (await openSecretStore({ home: ctx.env.home }))
  const file = ctx.config
  file.refresh()
  const had = file.config.peers.find((p) => p.name === name)
  if (!had && file.config.peers.length >= PEER_MAX) return 'store'
  const cap = rec.link?.cap ?? had?.daily_cap ?? PEER_DAILY_CAP_DEFAULT
  try {
    await store.set(PEER_SECRET_SERVICE, peerSecretAccount(name), secret)
    setLink(ctx, rec, { state: 'done' }) // before the config entry, so its row reads "Linked with", not "Linked peer added"
    file.update((c) => ({
      ...c,
      peers: [...c.peers.filter((p) => p.name !== name), { name, url: checked, daily_cap: cap }],
    }))
    new PeerLedger(ctx.store.db).clearRevoked(name) // linked again: sending is allowed once more
    return 'ok'
  } catch {
    setLink(ctx, rec, { state: 'closed' })
    await store.delete(PEER_SECRET_SERVICE, peerSecretAccount(name)).catch(() => undefined)
    return 'store'
  }
}
