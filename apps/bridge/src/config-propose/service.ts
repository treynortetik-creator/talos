// O1: the agent changes the settings the table opens to it (AGENT_CONFIG_ALLOWLIST) and threads (create, rename, topic, icon,
// alerts, own session, archive, parent: `threads.<id>.<field>`); THE BRIDGE writes it, never the agent. Owner ruling 2026-11-14:
// when the owner asked in that thread (ownerAskedIn: his own words, within two hours, with no untrusted text since) and "Lock
// Talos settings" is off, the change is made straight away and he is told in the thread what changed and how to undo it.
// Otherwise (he did not ask, or the lock is on) it is a card he approves. A thread's own session may change its own thread only
// (`opts.scope`, set by the hub). Every applied change names how to revert it and emits its named events. The list is checked at
// propose time and again at write time on the payload actually written.
//
// Why it is safe to let a model start this: it can only name the paths of the closed list (never trust_mode, devices, keys, the
// relay's passkey settings); the owner's own words in that thread are required for a direct change (a share, a hook event, a
// lead's hand-off cancel them); every direct change is told to him at once with its undo; and the lock turns all of it into cards.
import {
  type AgentConfigPath,
  type AgentConfigT,
  agentConfigPatch,
  applyMergePatch,
  bindingFrom,
  Card,
  type CardBinding,
  type CardT,
  CONFIG_PROPOSE_FEATURE,
  ConfigCardPayload,
  type ConfigChange,
  CUSTOM_THEMES_FEATURE,
  configCardCandidate,
  describeChange,
  isSendKind,
  newId,
  payloadHash,
  readConfigPath,
  resolveConfigChanges,
  type SendKind,
  subThreadPatchIssue,
  subThreadWarnings,
  undoText,
  validateCard,
  verifyConfigPayload,
} from '@talos-app/protocol'
import { kindPlural } from '../always-allow.ts'
import type { LedgerRow } from '../cards-ledger.ts'
import { localClock } from '../clock-meta.ts'
import { type BridgeContext, defaultThreadRef, postSystemNotice, threadRef } from '../context.ts'
import { emitConfigEvents } from '../events.ts'
import {
  cardCreateFrame,
  cardUpdateFrame,
  configSyncFrame,
  threadArchiveFrame,
  threadUpsertFrame,
} from '../frames-out.ts'
import { MEDIA_HOLD_MS, shorteningNote } from '../media-retention.ts'
import { cardActionNotification, systemNotification } from '../notify.ts'
import { say } from '../owner-words.ts'
import { isScreenAllowCard } from '../screen-consent.ts'
import { assertFrameFits } from '../transport.ts'
import { OWNER_SPOKE_MS, outsideTextAt, ownerAskedAt, SETTINGS_LOCKED } from '../trust.ts'
import { anyLeadSpokeSince } from '../worker/handoff.ts'
import { liveThreadIds, removeGoneInboxes } from '../worker/inbox.ts'

/** How recently the owner must have spoken in the thread for the agent to propose a setting there. */
export { OWNER_SPOKE_MS, SETTINGS_LOCKED }
/** Setting proposals an hour past which the agent is warned (Pantheon 2026-11-15: a warning, not a refusal). */
export const PROPOSALS_PER_HOUR = 6
export const MAX_PENDING_CONFIG_CARDS = 5
export const CONFIG_CARD_EXPIRY_MS = 24 * 3600_000

export type ProposeResult = { ok: true; text: string } | { ok: false; text: string }

/**
 * `scope`: a thread's own session is asking (the hub proved which thread); the card goes to that thread and every change must be
 * a field of it. `tool`: `create_thread` / `archive_thread` call this; a direct one is not counted against the hourly limit
 * (the thread limits hold). Unasked, any change is a card.
 */
export type ProposeOpts = { scope?: string; tool?: boolean }

/** The result text of a saved change: what changed, then how to revert it, within the 500 characters a card result may carry. */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const savedText = (changes: ConfigChange[]) =>
  `${clip(`Saved. ${changes.map(describeChange).join('; ')}`, 280)} ${clip(undoText(changes), 200)}`
/**
 * A setting that decides which alerts reach the owner: the notifications switches, the quiet window, a thread's alerts, the
 * default thread (where approval cards and security notices land). Its notice is pushed through quiet hours.
 */
export const decidesAlerts = (path: string): boolean =>
  path.startsWith('notifications.') ||
  path === 'quiet_window' ||
  path === 'default_thread' ||
  /^threads\.[^.]+\.notify$/.test(path)
/** What the owner reads in the thread after a change made because he asked: "Changed Timezone: UTC → Europe/Paris. To undo: …" */
const changedText = (changes: ConfigChange[]) =>
  `${clip(`Changed ${changes.map(describeChange).join('; ')}.`, 280)} ${clip(undoText(changes), 200)}`

/**
 * The fixed id of the line told for a card: a message id must be `m_` + 26 ULID characters, so it is the card's own 26 characters
 * reversed (the card's own row in the thread uses them as they are, and the two must differ).
 */
const toldId = (cardId: string) => `m_${[...cardId.slice(2)].reverse().join('')}`

/** The send kinds a change ADDS to always_allow (an add is always a card, Pantheon 2026-11-14); empty for none or a removal. */
export function alwaysAllowAdded(changes: readonly ConfigChange[]): SendKind[] {
  const out: SendKind[] = []
  for (const c of changes) {
    if (c.path !== 'always_allow' || !Array.isArray(c.new)) continue
    const before = Array.isArray(c.old) ? (c.old as string[]) : []
    for (const k of c.new as string[]) if (isSendKind(k) && !before.includes(k)) out.push(k)
  }
  return out
}

export class ConfigProposals {
  private relayFeatures: string[] = []
  private proposalAt: number[] = []

  constructor(private readonly ctx: BridgeContext) {}

  /** Called with every `ready`: the relay says what it supports. A relay without the feature would refuse the card. */
  setRelayFeatures(features: string[]) {
    this.relayFeatures = features
  }
  private relaySupports(): boolean {
    return this.relayFeatures.includes(CONFIG_PROPOSE_FEATURE)
  }

  /** The owner asked in `threadId` (see `ownerAskedIn`: his own words, within two hours, no untrusted text since). */
  private ownerAsked(threadId: string): number | undefined {
    return ownerAskedAt(this.ctx, threadId)
  }

  async propose(args: Record<string, unknown>, opts: ProposeOpts = {}): Promise<ProposeResult> {
    const { ctx } = this
    const fail = (text: string): ProposeResult => ({ ok: false, text })
    if (ctx.worker || ctx.mode !== 'live') return fail('config_propose is for the main session of a live bridge.')
    if (!this.relaySupports())
      return fail(
        "The relay doesn't support settings proposals yet. Ask the owner to update the relay first; nothing was proposed.",
      )
    const threadId = typeof args.thread_id === 'string' ? args.thread_id : undefined
    if (!threadId || !ctx.config.thread(threadId))
      return fail(`Unknown thread "${threadId ?? ''}". Valid thread ids: ${ctx.config.threadIds().join(', ')}`)
    const reason = (typeof args.reason === 'string' ? args.reason : '').trim().slice(0, 280)
    if (!reason) return fail('reason is required (up to 280 characters): say why you are proposing this.')
    if (opts.scope !== undefined && threadId !== opts.scope)
      return fail(
        `This session belongs to thread "${opts.scope}" and can only propose into its own thread. Nothing was proposed.`,
      )
    ctx.config.refresh()
    const resolved = resolveConfigChanges(args.changes, ctx.config.config, opts.scope ? { thread: opts.scope } : {})
    if (!resolved.ok) return fail(resolved.error)
    // the sub-thread rule, judged now on what the change would write, so the owner is never asked to approve a card the
    // write would then refuse (archiving a parent alone while its sub-threads still run, say)
    const preview = applyMergePatch(
      ctx.config.config,
      agentConfigPatch(resolved.changes, ctx.config.config),
    ) as AgentConfigT
    const subIssue = subThreadPatchIssue(ctx.config.config, preview, ctx.config.subThreadOpts())
    if (subIssue) return fail(`Nothing was proposed: ${subIssue}`)
    // A relay and web build from before K9c would carry the card but the app could not preview it.
    if (resolved.changes.some((c) => c.path === 'theme') && !this.relayFeatures.includes(CUSTOM_THEMES_FEATURE))
      return fail(
        'Nothing was proposed: the app needs updating before it can preview themes. Ask the owner to update the relay and the app, then try again.',
      )
    // The owner's ruling (2026-11-14): when he asked in this thread and the settings lock is off, the change is made, and he is
    // told at once what changed and how to undo it (a wrong change is one tap to undo; a refused right one is friction). Not
    // asked, or locked: a card, which is his check. The rows the agent may never name (trust_mode, devices, keys, the relay's
    // passkey settings) are not on its list at all (settings-table.ts), so they never reach here.
    // A theme too: applying it is the preview, and its undo line names "reset the theme" (Pantheon, 2026-11-14).
    const askedAt = this.ownerAsked(threadId)
    const asked = askedAt !== undefined
    const locked = ctx.config.config.settings_lock === true
    // ADDING an always-allow is always a one-tap card, asked or not, lock or not (Pantheon 2026-11-14): it is a standing grant to
    // send or pay as him, and the two-hour window must never lead to one. Removing one stays direct.
    const addsAlways = alwaysAllowAdded(resolved.changes)
    // the owner's ruling 2026-11-16: fence off is like any other row (direct when he asked, a card otherwise)
    // The owner's ruling (2026-11-16) makes the fence direct when he asked; it stays a card when any other session or outside
    // text reached main since his words, because the fence is what holds those sessions back.
    const opensFence = resolved.changes.some((c) => c.path === 'dev.thread_fence' && c.new === false)
    const fenceQuiet =
      !opensFence ||
      (askedAt !== undefined &&
        !anyLeadSpokeSince(ctx.store.db, askedAt, ctx.clock.now()) &&
        !ctx.config.config.threads.some((t) => (outsideTextAt(ctx, t.id) ?? Number.NEGATIVE_INFINITY) >= askedAt))
    const direct = asked && !locked && addsAlways.length === 0 && fenceQuiet
    const now = ctx.clock.now()
    this.proposalAt = this.proposalAt.filter((t) => now - t < 3600_000)
    const warnings = [...(resolved.warnings ?? [])]
    // what the change newly does to a sub-thread's folder (it keeps its own, so no instructions from its parent)
    const had = new Set(subThreadWarnings(ctx.config.config))
    for (const w of subThreadWarnings(preview)) if (!had.has(w)) warnings.push(w)
    if (!(direct && opts.tool) && this.proposalAt.length >= PROPOSALS_PER_HOUR)
      warnings.push(
        `that is more than ${PROPOSALS_PER_HOUR} setting proposals this hour; ask the owner what they want and propose once`,
      )
    const warned = (r: ProposeResult): ProposeResult =>
      warnings.length ? { ...r, text: `${r.text} Warning: ${warnings.join('; ')}.` } : r
    if (direct) {
      if (!opts.tool) this.proposalAt.push(now)
      return warned(await this.applyDirect(threadId, reason, resolved.changes))
    }
    const lockedNote = asked && locked ? `${SETTINGS_LOCKED} It went to the owner as a card instead. ` : ''
    const pending = ctx.ledger
      .list('pending')
      .filter((r) => r.actor === 'bridge' && r.binding.kind === 'config' && !isScreenAllowCard(r.binding))
    if (pending.length >= MAX_PENDING_CONFIG_CARDS)
      return fail(`There are already ${MAX_PENDING_CONFIG_CARDS} settings cards waiting for the owner. Wait for them.`)

    const drawn = configCardCandidate({
      cardId: newId('c'),
      threadId,
      now: new Date(now).toISOString(),
      expiresAt: new Date(now + CONFIG_CARD_EXPIRY_MS).toISOString(),
      origin: 'chat',
      baseRev: ctx.config.config.rev,
      reason,
      changes: resolved.changes,
    })
    // An always-allow add: the button says what the tap grants ("Always allow emails"; with several kinds "Always allow 2 kinds",
    // the body lists them old → new), within the card's 32-character button. And it is high risk, so it is approved on the card
    // in the app, never from a notification where only the agent's reason shows (Delphi's review of 79f646aa).
    const candidate = addsAlways.length
      ? {
          ...drawn,
          primary_label:
            addsAlways.length === 1
              ? `Always allow ${kindPlural(addsAlways[0] as SendKind)}`
              : `Always allow ${addsAlways.length} kinds`,
          risk: 'high' as const,
        }
      : drawn
    const parsed = Card.safeParse(candidate)
    if (!parsed.success) return fail(`The card could not be drawn: ${parsed.error.issues[0]?.path.join('.')}`)
    const card: CardT = parsed.data
    const issues = validateCard(card)
    if (issues.length) return fail(`The card could not be drawn: ${issues.join(', ')}`)
    card.payload_hash = payloadHash(bindingFrom(card))
    try {
      assertFrameFits(cardCreateFrame(now, card))
    } catch (e) {
      return fail((e as Error).message)
    }
    ctx.ledger.create(card, 'bridge')
    try {
      await ctx.transport.sendDurable(cardCreateFrame(now, card))
    } catch (e) {
      ctx.ledger.expire(card.id)
      ctx.expiry?.cancel(card.id)
      return fail(`The card could not be sent to the app: ${(e as Error).message}`)
    }
    this.proposalAt.push(now)
    ctx.expiry?.sync()
    return warned({ ok: true, text: `${lockedNote}card ${card.id} pending, expires ${card.expires_at}` })
  }

  /**
   * Trust mode, after `ownerAsked`, for a change whose every part is LOW: the same checks as an approved card (the closed list,
   * current values, `applyPatch`), with no card in between. The owner is told in the thread, in words that name old and new and
   * how to revert it.
   */
  private async applyDirect(threadId: string, reason: string, changes: ConfigChange[]): Promise<ProposeResult> {
    const { ctx } = this
    ctx.config.refresh()
    const cur: AgentConfigT = ctx.config.config
    const candidate = configCardCandidate({
      cardId: 'direct',
      threadId,
      now: new Date(ctx.clock.now()).toISOString(),
      expiresAt: new Date(ctx.clock.now() + CONFIG_CARD_EXPIRY_MS).toISOString(),
      origin: 'chat',
      baseRev: cur.rev,
      reason,
      changes,
    })
    const v = verifyConfigPayload(candidate.payload, cur, new Date(ctx.clock.now()).toISOString())
    if (!v.ok) return { ok: false, text: `Nothing was changed: ${v.error}` }
    // the lock is judged again on the config this writes on: the owner may have turned it on from the phone meanwhile
    if (cur.settings_lock === true) return { ok: false, text: `Nothing was changed: ${SETTINGS_LOCKED}` }
    // The agent never writes trust_mode, whatever a card or a direct call says: the app's config.patch (with the passkey
    // checked by the relay) and `talos-app trust` are the only writers. applyPatch accepts the field for the owner's patch,
    // so this is the explicit second layer behind the payload schema.
    if ('trust_mode' in v.patch)
      return {
        ok: false,
        text: "Nothing was changed: trust_mode can't be changed by you. The owner changes it in Settings.",
      }
    const r = ctx.config.applyPatch(cur.rev, v.patch, ctx.clock.now(), { agent: true })
    if (!r.ok)
      return {
        ok: false,
        text: say({
          mac: `Your Mac didn't accept it: ${r.message}. Nothing was changed.`,
          linux: `Your computer didn't accept it: ${r.message}. Nothing was changed.`,
        }),
      }
    await this.commit(cur, r.config, 'agent_asked')
    ctx.log.info('config applied as the owner asked', { rev: r.config.rev, paths: v.changes.map((c) => c.path) })
    await this.tellOwner(threadId, v.changes)
    return { ok: true, text: `${savedText(v.changes)} (applied: the owner asked; he was told how to undo it)` }
  }

  /**
   * The owner is told at once, in the thread: what changed and how to undo it, and for the one change whose undo has a deadline
   * (shorter attachment keeping: the hour's hold, then files go) what goes and until when undo stops it. A direct change and an
   * approved card post the same line; a thread that is gone gets it in the default thread.
   */
  private async tellOwner(threadId: string, changes: ConfigChange[], id?: string) {
    const { ctx } = this
    const until = new Date(ctx.clock.now() + MEDIA_HOLD_MS).toISOString()
    const notes = changes.flatMap((c) =>
      c.path === 'media_keep_days' && typeof c.new === 'number' && (typeof c.old !== 'number' || c.new < c.old)
        ? (shorteningNote(ctx, c.new, ctx.clock.now(), localClock(ctx, until).local_time ?? until.slice(11, 16)) ?? [])
        : [],
    )
    await postSystemNotice(ctx, [changedText(changes), ...notes].join(' '), {
      thread: ctx.config.thread(threadId) ? threadRef(ctx, threadId) : defaultThreadRef(ctx),
      ...(id ? { id } : {}),
      settingsChanged: changes.some((c) => decidesAlerts(c.path)),
    }).catch(() => {})
  }

  /**
   * After a write, like an owner patch: the relay learns a created or archived thread, every app learns the new config, the
   * permission relay re-reads it, a thread that is gone keeps no copies of the owner's files, and the named events are written.
   */
  private async commit(before: AgentConfigT, after: AgentConfigT, source: 'agent_card' | 'agent_asked') {
    const { ctx } = this
    const warn = (what: string) => (e: unknown) => ctx.log.warn(`${what} not sent`, { error: (e as Error).message })
    const was = new Map(before.threads.map((t) => [t.id, t]))
    for (const t of after.threads) {
      const w = was.get(t.id)
      if (!w) await ctx.transport.sendDurable(threadUpsertFrame(ctx.clock.now(), t)).catch(warn('thread.upsert'))
      else if (t.archived && !w.archived)
        await ctx.transport.sendDurable(threadArchiveFrame(ctx.clock.now(), t.id)).catch(warn('thread.archive'))
    }
    await ctx.transport.sendDurable(configSyncFrame(ctx.clock.now(), after)).catch(warn('config.sync'))
    ctx.config.markSynced(after)
    ctx.permission.reconcile()
    removeGoneInboxes(ctx.paths.inbox, liveThreadIds(after))
    emitConfigEvents(ctx.log, before, after, source)
  }

  /**
   * A restart between "the owner approved" and `end()` leaves a settings card on `resolved` with nobody to finish it (the
   * Schedules sweep only runs with the scheduler on, and its words are about schedules). Once per process: read the config
   * and say what is true. Everything the card named already holds the new value -> it was saved; nothing does -> it was not;
   * anything else the owner changed meanwhile, so point them at Settings rather than guess.
   */
  async recover() {
    const { ctx } = this
    ctx.config.refresh()
    const cur = ctx.config.config
    for (const row of ctx.ledger.list('resolved')) {
      if (row.actor !== 'bridge' || row.binding.kind !== 'config' || row.resolution?.action !== 'primary') continue
      if (isScreenAllowCard(row.binding)) continue // ScreenConsent.recover() ends its own
      const p = ConfigCardPayload.safeParse(row.binding.payload)
      const fresh = (path: AgentConfigPath, want: unknown) =>
        JSON.stringify(readConfigPath(cur, path)) === JSON.stringify(want)
      let text = 'The bridge restarted before this was saved. Check Settings, then ask again if it is not there.'
      let ok = false
      if (p.success) {
        if (p.data.changes.every((c) => fresh(c.path, c.new))) {
          ok = true
          // the restart may have come before the line was posted; its fixed id says whether it was
          if (!ctx.store.getMessage(toldId(row.id)))
            await this.tellOwner(
              row.thread_id,
              p.data.changes.map((c) => ({ path: c.path, old: c.old, new: c.new })),
              toldId(row.id),
            )
          text = savedText(p.data.changes.map((c) => ({ path: c.path, old: c.old, new: c.new })))
        } else if (p.data.changes.every((c) => fresh(c.path, c.old)))
          text = 'The bridge restarted before this was saved. Nothing was changed. Ask again.'
      }
      await this.end(row, row.id, ok, text)
    }
  }

  /** The owner pressed a button on a config card (inbound has already run the SPEC 4.5 checks and moved the ledger). */
  onCardResolved(
    row: LedgerRow,
    action: 'primary' | 'kill' | 'revise',
    approved: CardBinding,
    cardId: string,
    note?: string,
  ) {
    const { ctx } = this
    if (action !== 'primary') {
      // KILL and REVISE reach the agent like any card: REVISE is how the owner steers a proposal
      void ctx.emit(
        cardActionNotification({
          thread: threadRef(ctx, row.thread_id),
          card: { id: cardId, title: row.binding.title, primary_label: row.binding.primary_label },
          action,
          ts: new Date(ctx.clock.now()).toISOString(),
          note,
          clock: localClock(ctx, new Date(ctx.clock.now()).toISOString()),
        }),
      )
      return
    }
    void this.apply(row, approved, cardId).catch((e) =>
      ctx.log.warn('config card apply failed', { card: cardId, error: (e as Error).message }),
    )
  }

  /**
   * Checks the BOUND payload again against the allowlist and the live config, then writes through ConfigFile.applyPatch (the
   * same path an owner `config.patch` takes) and syncs. No await sits between the check and the write, so two cards racing
   * for one setting have exactly one winner and the other fails in words.
   */
  private async apply(row: LedgerRow, approved: CardBinding, cardId: string) {
    const { ctx } = this
    const payload = ConfigCardPayload.safeParse(approved.payload)
    if (!payload.success) return this.end(row, cardId, false, 'The card could not be read. Nothing was changed.')
    ctx.config.refresh()
    const cur: AgentConfigT = ctx.config.config
    const v = verifyConfigPayload(approved.payload, cur, new Date(ctx.clock.now()).toISOString())
    if (!v.ok) {
      if (!v.stale) ctx.log.security('config card refused at apply', { card: cardId })
      return this.end(row, cardId, false, v.error)
    }
    // the agent never writes trust_mode (see applyDirect): the explicit layer behind the payload schema
    if ('trust_mode' in v.patch) {
      ctx.log.security('config card naming trust_mode refused at apply', { card: cardId })
      return this.end(row, cardId, false, "trust_mode is the owner's to change, in Settings. Nothing was changed.")
    }
    const r = ctx.config.applyPatch(cur.rev, v.patch, ctx.clock.now(), { agent: true })
    if (!r.ok) {
      ctx.log.warn('config card not applied', { card: cardId, code: r.code })
      return this.end(
        row,
        cardId,
        false,
        say({
          mac: `Your Mac didn't accept it: ${r.message}. Nothing was changed.`,
          linux: `Your computer didn't accept it: ${r.message}. Nothing was changed.`,
        }),
      )
    }
    await this.commit(cur, r.config, 'agent_card')
    ctx.log.info('config card applied', { rev: r.config.rev, paths: v.changes.map((c) => c.path) })
    await this.tellOwner(row.thread_id, v.changes, toldId(cardId))
    return this.end(row, cardId, true, savedText(v.changes))
  }

  private async end(row: LedgerRow, cardId: string, ok: boolean, text: string) {
    const { ctx } = this
    const at = new Date(ctx.clock.now()).toISOString()
    ctx.ledger.finish(cardId, ok)
    await ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), { card_id: cardId, state: ok ? 'done' : 'failed', result: { ok, text, at } }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
    const thread = ctx.config.thread(row.thread_id) ? threadRef(ctx, row.thread_id) : defaultThreadRef(ctx)
    await ctx
      .emit(
        systemNotification({
          thread,
          text: `Card ${cardId} → PRIMARY. The bridge ${ok ? 'applied' : 'could not apply'} it: ${text} Nothing for you to do${ok ? '' : ' unless the owner asks again'}.`,
          ts: at,
          id: `${cardId}-applied`,
        }),
      )
      .catch(() => {})
  }
}
