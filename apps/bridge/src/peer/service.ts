// Linked agents on the Mac: `peer_send` (the checks, then a durable outbox) and the loop that delivers the outbox to the other
// install's inbox. The text of a message is never logged. Every rule of the loop guard is read from the ledger of what THIS bridge
// received and accepted to send, never from a peer's claims.

import { lookup as dnsLookup } from 'node:dns/promises'
import {
  newPeerMessageId,
  PEER_CHAIN_MAX,
  PEER_RETRY_HOURS,
  type PeerLabelT,
  PeerMessageId,
  type PeerMessageT,
  PeerName,
  parsePeerMessage,
  type SecretStore,
} from '@talos-app/protocol'
import { BlockedAddressError, createGuardedFetch } from '@talos-app/protocol/guarded-fetch'
import type { Clock } from '../clock.ts'
import { type BridgeContext, defaultThreadRef, postSystemNotice, type threadRef } from '../context.ts'
import { redact } from '../redact.ts'
import { openSecretStore } from '../secrets/store.ts'
import { cleanHandoffText } from '../worker/handoff.ts'
import { PeerLedger } from './ledger.ts'
import { PEER_SECRET_SERVICE, peerSecretAccount } from './records.ts'
import { signPeerMessage } from './sign.ts'
import { readTaint } from './taint.ts'

const DAY_MS = 24 * 3600_000
/** One try gets this long. */
const TRY_TIMEOUT_MS = 10_000
const BACKOFF_FIRST_MS = 15_000
const BACKOFF_MAX_MS = 30 * 60_000
/** A receiver's UTC day rolls over at midnight; the retry waits this much past it. */
const MIDNIGHT_SLACK_MS = 30_000
/** The name sent as `from`: shown only, the receiver uses the name of its own connection. */
const SENDER_NAME = 'linked'

export { notePeerChanges } from './changes.ts'
export type PeerFetch = (url: string, init: RequestInit) => Promise<Response>
export type PeerServiceOptions = {
  secrets?: SecretStore
  fetch?: PeerFetch
  clock?: Clock
  /** Tests: the name lookup of the real guarded fetch. */
  resolve?: (host: string) => Promise<readonly string[]>
}
export type SendArgs = {
  peer: string
  text: string
  label?: PeerLabelT | undefined
  in_reply_to?: string | undefined
  thread?: ReturnType<typeof threadRef> | undefined
}
export type SendResult = { ok: boolean; text: string }

export { notePeerTaint } from './taint.ts'

export const utcDayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS

/** The first ~200 characters as one clean line, for the thread's rows. */
export function glimpse(text: string, max = 200): string {
  const one = cleanHandoffText(text)
  const chars = Array.from(one)
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : one
}

/** How many `[redacted]` marks the pass added. */
function redactedCount(before: string, after: string): number {
  const marks = (s: string) => (s.match(/\[redacted\]/g) ?? []).length
  return Math.max(marks(after) - marks(before), after === before ? 0 : 1)
}

export class PeerService {
  readonly ledger: PeerLedger
  private readonly clock: Clock
  private readonly fetchFn: PeerFetch
  private secrets: SecretStore | undefined
  private timer: unknown = null
  private running = false
  private again = false
  private stopped = false

  constructor(
    private readonly ctx: BridgeContext,
    readonly opts: PeerServiceOptions = {},
  ) {
    this.ledger = new PeerLedger(ctx.store.db)
    this.clock = opts.clock ?? ctx.clock
    this.secrets = opts.secrets
    this.fetchFn = opts.fetch ?? guardedWith(opts.resolve)
  }

  start(): void {
    this.stopped = false
    try {
      this.ledger.prune(this.clock.now())
    } catch (e) {
      this.ctx.log.warn('peer records not pruned', { error: (e as Error).message })
    }
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private async secretStore(): Promise<SecretStore> {
    this.secrets ??= await openSecretStore({ home: this.ctx.env.home })
    return this.secrets
  }

  private async secretOf(name: string): Promise<string | undefined> {
    return (await this.secretStore()).get(PEER_SECRET_SERVICE, peerSecretAccount(name))
  }

  private peerConfig(name: string) {
    this.ctx.config.refresh()
    return this.ctx.config.config.peers.find((p) => p.name === name)
  }

  // ---- peer_send -------------------------------------------------------------------------------------------------------

  async send(a: SendArgs): Promise<SendResult> {
    const no = (text: string): SendResult => ({ ok: false, text })
    const { peer } = a
    if (!PeerName.safeParse(peer).success) return no(`"${peer}" is not a name a linked agent can have.`)
    const cfg = this.peerConfig(peer)
    const unlinked = `"${peer}" is not linked to this Talos. Link it with: talos-app peer add ${peer} --url <the other install's inbox url> --secret-file <the secret file its peer create wrote> (while "Lock Talos settings" is on, the owner does it at the computer)`
    if (!cfg) return no(unlinked)
    let secret: string | undefined
    try {
      secret = await this.secretOf(peer)
    } catch {
      return no(`The secret of "${peer}" could not be read from the key store. Nothing was sent; tell the owner.`)
    }
    if (!secret) return no(unlinked)
    if (this.ledger.isRevoked(peer))
      return no(`${peer} no longer accepts messages; run talos-app peer add again once it is linked.`)

    // 1. the redact pass, then the message's own limits on what is left
    const redacted = redact(a.text, { userHome: this.ctx.env.userHome, appHome: this.ctx.paths.home })
    const hidden = redactedCount(a.text, redacted)
    const now = this.clock.now()
    // The taint: while a linked agent's message may still be what main is working on, main sends only back to that agent, and a
    // send without in_reply_to is the reply it stands for. Leaving the field out dodges neither the no-chaining rule nor the cap.
    const taint = readTaint(this.ctx)
    let replyTo = a.in_reply_to
    if (taint) {
      if (taint.peers.length !== 1 || taint.peers[0] !== peer)
        return no(
          `Not sent: a message from ${taint.peers.join(' and ')} reached you since the owner last spoke to you, so nothing goes to ${peer} now. Answer ${taint.peers.length === 1 ? taint.peers[0] : 'them'} with peer_send, or ask the owner.`,
        )
      replyTo ??= taint.last_msg_id
    }
    const draft = (chain: number, fromTask: boolean, id: string): PeerMessageT | string => {
      const parsed = parsePeerMessage({
        v: 1,
        id,
        from: SENDER_NAME,
        ...(a.label ? { label: a.label } : {}),
        text: redacted,
        ...(replyTo ? { in_reply_to: replyTo } : {}),
        chain,
        from_peer_task: fromTask,
        sent_at: new Date(now).toISOString(),
      })
      return parsed.success ? parsed.data : (parsed.error.issues[0]?.message ?? 'the message is not valid')
    }
    const id = newPeerMessageId()
    const probe = draft(0, false, id)
    if (typeof probe === 'string') return no(`Not sent: ${probe}.`)

    // 2. the loop guard and the chain, from this bridge's own records
    let chain = 0
    let fromTask = false
    if (replyTo) {
      if (!PeerMessageId.safeParse(replyTo).success) return no('Not sent: in_reply_to is not a message id.')
      const rec = this.ledger.get(replyTo)
      if (rec?.dir !== 'in')
        return no('Not sent: in_reply_to must be a message this Talos received from a linked agent, and it was not.')
      if (rec.peer !== peer)
        return no(
          `Not sent: that message came from ${rec.peer}. Work a linked agent asked for goes back to ${rec.peer} only, never on to ${peer}.`,
        )
      if (rec.label === 'RESULT') return no('Not sent: a RESULT expects no reply.')
      chain = rec.chain + 1
      if (chain > PEER_CHAIN_MAX)
        return no(`Not sent: this exchange has gone back and forth ${rec.chain} times; ask the owner.`)
      fromTask = true
    }
    const message = draft(chain, fromTask, id)
    if (typeof message === 'string') return no(`Not sent: ${message}.`)

    // 3. the sender's daily cap (per UTC day, counting what was accepted)
    if (this.ledger.sentSince(peer, utcDayStart(now)) >= cfg.daily_cap)
      return no(
        `Not sent: ${cfg.daily_cap} messages to ${peer} have gone today (UTC). It resets at 00:00 UTC; tell the owner if it cannot wait.`,
      )

    // 4. one durable row, then answer at once: the network is the loop's business
    this.ledger.queue(
      { id, peer, dir: 'out', label: a.label ?? null, chain, in_reply_to: replyTo ?? null, at: now },
      JSON.stringify(message),
    )
    await this.row(
      `Sent to ${peer}${a.label ? ` (${a.label})` : ''}: ${glimpse(redacted)}`,
      a.label,
      `Talos → ${peer}`,
      a.thread,
    )
    void this.drain()
    return {
      ok: true,
      text: `queued for ${peer} (${id})${hidden ? `; ${hidden} item${hidden === 1 ? '' : 's'} redacted from the text` : ''}`,
    }
  }

  /** A silent system row (no push). The hand-off label keeps a peer's words from reading as a Talos notice. */
  async row(
    text: string,
    type: PeerLabelT | undefined,
    label: string,
    thread = defaultThreadRef(this.ctx),
  ): Promise<void> {
    try {
      await postSystemNotice(this.ctx, text, { silent: true, thread, handoff: { label, type: type ?? 'TASK' } })
    } catch (e) {
      this.ctx.log.warn('peer row not posted', { error: (e as Error).message })
    }
  }

  private notice(text: string): Promise<void> {
    return postSystemNotice(this.ctx, text, { silent: true }).catch((e) =>
      this.ctx.log.warn('peer notice not posted', { error: (e as Error).message }),
    )
  }

  // ---- the sender loop -------------------------------------------------------------------------------------------------

  private arm(): void {
    if (this.timer) this.clock.clearTimeout(this.timer)
    this.timer = null
    if (this.stopped) return
    const next = this.ledger.nextDueAt()
    if (next === undefined) return
    this.timer = this.clock.setTimeout(() => void this.drain(), Math.max(0, next - this.clock.now()))
  }

  /** Tries every message that is due, one after the other, then sets the timer for the next. */
  async drain(): Promise<void> {
    if (this.stopped || this.ctx.closing) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      do {
        this.again = false
        for (const row of this.ledger.due(this.clock.now())) {
          if (this.stopped || this.ctx.closing) return
          await this.attempt(row)
        }
      } while (this.again)
    } catch (e) {
      this.ctx.log.warn('peer sender failed', { error: (e as Error).message })
    } finally {
      this.running = false
      this.arm()
    }
  }

  private async attempt(row: NonNullable<ReturnType<PeerLedger['outbox']>>): Promise<void> {
    const now = this.clock.now()
    const cfg = this.peerConfig(row.peer)
    let secret: string | undefined
    try {
      secret = cfg ? await this.secretOf(row.peer) : undefined
    } catch {
      return this.retry(row, now, 'the key store could not be read')
    }
    if (!cfg || !secret) {
      this.ledger.finish(row.id, 'refused', 'not_linked')
      return void (await this.notice(`A message to ${row.peer} was not sent: ${row.peer} is no longer linked.`))
    }
    let res: Response
    try {
      const headers = signPeerMessage({ secret, id: row.id, timestampS: Math.floor(now / 1000), body: row.body })
      res = await this.fetchFn(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: row.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
      })
    } catch (e) {
      if (e instanceof BlockedAddressError) {
        this.ledger.finish(row.id, 'refused', 'blocked_address')
        return void (await this.notice(
          `A message to ${row.peer} was not sent: its address is one Talos will not contact.`,
        ))
      }
      return this.retry(row, now, 'network')
    }
    const code = await errorCode(res)
    const status = res.status
    if (status >= 200 && status < 300) return this.ledger.finish(row.id, 'sent')
    if (status === 404 && code === 'not_found') {
      // the relay's own answer for an inbox that is gone: remembered, so peer_send refuses until `peer add` links it again
      this.ledger.setRevoked(row.peer, now)
      for (const p of this.ledger.pendingFor(row.peer)) this.ledger.finish(p.id, 'revoked', code)
      return void (await this.notice(
        `${row.peer} no longer accepts messages; nothing more will be sent until it is linked again.`,
      ))
    }
    if (status === 429 && code === 'daily_cap') {
      const at = utcDayStart(now) + DAY_MS + MIDNIGHT_SLACK_MS
      if (at - row.created_at > PEER_RETRY_HOURS * 3600_000) return void (await this.giveUp(row))
      return this.ledger.retryAt(row.id, at)
    }
    // 404 and 410 without the relay's code are a platform page, and a 408 is a slow server: all retried like a 5xx
    if (status >= 400 && status < 500 && ![404, 408, 410, 429].includes(status)) {
      this.ledger.finish(row.id, 'refused', code)
      return void (await this.notice(`${row.peer} refused a message (${code}). It was not retried.`))
    }
    if (status >= 300 && status < 400) {
      this.ledger.finish(row.id, 'refused', `http_${status}`)
      return void (await this.notice(
        `${row.peer} answered a message with a redirect (${status}). It was not followed or retried.`,
      ))
    }
    return this.retry(row, now, code)
  }

  private async retry(row: NonNullable<ReturnType<PeerLedger['outbox']>>, now: number, why: string): Promise<void> {
    const at = now + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** row.attempts)
    if (at - row.created_at > PEER_RETRY_HOURS * 3600_000) return this.giveUp(row, why)
    this.ledger.retryAt(row.id, at)
  }

  private async giveUp(row: NonNullable<ReturnType<PeerLedger['outbox']>>, why = 'daily_cap'): Promise<void> {
    this.ledger.finish(row.id, 'gave_up', why)
    await this.notice(`Gave up sending a message to ${row.peer} after ${PEER_RETRY_HOURS} hours (${why}).`)
  }
}

/** The guarded fetch. A name that resolves to nothing is an error (retried), not a blocked address: only a real private or loopback address stops a message at once. */
function guardedWith(resolve?: PeerServiceOptions['resolve']): PeerFetch {
  const lookup = resolve ?? (async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address))
  const fetchGuarded = createGuardedFetch({
    timeoutMs: TRY_TIMEOUT_MS,
    resolve: async (host) => {
      const addrs = await lookup(host)
      if (addrs.length === 0) throw new Error(`no addresses for ${host}`)
      return addrs
    },
  })
  return (url, init) => fetchGuarded(url, init)
}

/** The relay's error code (`daily_cap`, `bad_body`...), or `http_<status>`: only short lower-case words are shown. */
async function errorCode(res: Response): Promise<string> {
  try {
    const b = (await res.json()) as { error?: unknown }
    if (typeof b.error === 'string' && /^[a-z_]{1,40}$/.test(b.error)) return b.error
  } catch {
    // not JSON
  }
  return `http_${res.status}`
}
