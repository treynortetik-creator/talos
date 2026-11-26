// CardView (spec 8.4): the approval card. It recomputes the hash from exactly what it renders, refuses to show buttons
// for an altered or expired card, supports inline edit (edited_hash), revise, "Always allow" for a send kind, and
// collapses to one line after a decision. The owner's signed tap is the whole approval (owner ruling 2026-11-14).
import {
  type AlwaysKind,
  alwaysKindOffered,
  CARD_KIND_TABLE,
  CARD_KINDS,
  type CardIconKey,
  type CardKind,
  type CardT,
  cardExpiryMs,
  cardOffersAlways,
  type Host,
  isAlwaysKind,
  isBodyEditable,
  ScheduleCardPayload,
} from '@talos-app/protocol'
import { type ComponentType, type ReactNode, type SVGProps, useEffect, useId, useMemo, useRef, useState } from 'react'
import { NoAnswerError, NotSentError, TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { placeWords, useHost } from '../../lib/hostWords.ts'
import { HttpError } from '../../lib/http.ts'
import { cn } from '../../ui/cn.ts'
import {
  IconAlert,
  IconCardPay,
  IconChat,
  IconClip,
  IconClock,
  IconDiamond,
  IconKeyboard,
  IconMail,
  IconMegaphone,
  IconPush,
  IconRocket,
  IconScale,
  IconSettings,
  IconUndo,
} from '../../ui/icons.tsx'
import { Button, Input, Textarea } from '../../ui/index.ts'
import { StatusDot } from '../../ui/StatusDot.tsx'
import type { CardViewProps } from '../contracts.ts'
import { dateTimeLabel } from '../schedules/logic.ts'
import { spendArm, useArmedCard } from './arm.tsx'
import { DialogCard } from './DialogCard.tsx'
import {
  COUNTDOWN_WINDOW_MS,
  collapseLine,
  countdown,
  type EditDraft,
  editedHashFor,
  editsFromDraft,
  isAltered,
  isExpiredNow,
  KIND_LABEL,
  renderedHash,
} from './logic.ts'
import { PermissionCardLive } from './PermissionCard.tsx'
import { ThemePreview, themeOfCard } from './ThemePreview.tsx'
import { copyText, formatExpiry, prefersReducedMotion, revealHidden, useRelayNow } from './util.ts'

const BODY_PREVIEW_LINES = 6

type CardIcon = ComponentType<SVGProps<SVGSVGElement>>

/** One drawing per icon key the kind table names: a key missing here fails the type check. */
const ICON_BY_KEY = {
  mail: IconMail,
  chat: IconChat,
  rocket: IconRocket,
  'arrow-up': IconPush,
  megaphone: IconMegaphone,
  'card-pay': IconCardPay,
  scale: IconScale,
  diamond: IconDiamond,
  clock: IconClock,
  alert: IconAlert,
  settings: IconSettings,
  keyboard: IconKeyboard,
  undo: IconUndo,
} satisfies Record<CardIconKey, CardIcon>

/** One icon per card kind, read from the kind table (CARD_KIND_TABLE), so a kind cannot lack one. */
export const KIND_ICON = Object.fromEntries(CARD_KINDS.map((k) => [k, ICON_BY_KEY[CARD_KIND_TABLE[k].icon]])) as Record<
  CardKind,
  CardIcon
>

function KindIcon({ kind }: { kind: CardT['kind'] }) {
  // A kind this build does not know falls back rather than crashing. Strict parsing drops a newer peer's card; the
  // way one gets here is a cached snapshot (for example after rolling back to an older build). Own keys only, so a
  // kind named like an Object.prototype member ("constructor") is unknown too.
  const I: ComponentType<SVGProps<SVGSVGElement>> = Object.hasOwn(KIND_ICON, kind) ? KIND_ICON[kind] : IconDiamond
  return <I width={18} height={18} className="shrink-0 text-text" />
}

const NO_ANSWER_COPY = "Didn't hear back. Check whether it ran before trying again."

/**
 * The second button on a live card of a send kind (always-allow.ts): what it allows from now on. A table, so each kind reads
 * right ("Always allow publishing", not "publishs").
 */
export const ALWAYS_ALLOW_LABEL: Record<AlwaysKind, string> = {
  email: 'Always allow emails',
  message: 'Always allow messages',
  deploy: 'Always allow deploys',
  publish: 'Always allow publishing',
  purchase: 'Always allow purchases',
  push: 'Always allow pushing code',
  generic: 'Always allow approvals',
  schedule: 'Always allow schedule changes',
  undo: 'Always allow undos',
  config: 'Always allow settings changes',
}

/** Shown when a high-risk card was answered from a notification (error `open_in_app`). */
export const OPEN_IN_APP_COPY = 'This card is approved in the app, not from a notification.'
/** An older relay or Mac that still asks for the confirmation step this app no longer has (two old error codes). */
export const OLDER_STEP_COPY = 'Your Talos server or your Mac is older than this app. Update Talos, then try again.'

export function errorCopy(e: unknown, agent: string, host: Host | null): string {
  // The phone only says "nothing was sent" when the frame never left it, and never guesses at the outcome otherwise.
  if (e instanceof NotSentError) return `${e.message} Nothing was sent.`
  if (e instanceof NoAnswerError) return NO_ANSWER_COPY
  if (e instanceof TalosClientError) {
    switch (e.code) {
      case 'card_expired':
        return 'This card expired. Nothing ran.'
      case 'card_not_pending':
        return 'This card was already decided.'
      case 'card_hash_mismatch':
        return "This card changed after it was drafted. Don't approve it."
      case 'card_edit_forbidden':
        return "This card doesn't allow that edit."
      case 'open_in_app':
        return OPEN_IN_APP_COPY
      // no relay or Mac of this release sends these two; an older one may still
      case 'stepup_required':
      case 'stepup_invalid':
        return OLDER_STEP_COPY
      case 'mac_offline':
        return placeWords(`${agent}'s Mac is offline. Try again when it is back.`, host)
      default:
        // The relay's own sentence says more than the code. A bare `internal` is the relay failing without saying how
        // (a deploy mid-tap): the outcome is unknown, so it reads like silence. Other bare codes name themselves.
        if (e.code === 'internal' && (!e.message || e.message === e.code)) return NO_ANSWER_COPY
        return e.message && e.message !== e.code ? e.message : `Something went wrong (${e.code}).`
    }
  }
  if (e instanceof HttpError) {
    const code = (e.body as { error?: unknown } | undefined)?.error
    if (code === 'stepup_invalid' || code === 'stepup_required') return OLDER_STEP_COPY
    return `Something went wrong (${e.status}).`
  }
  if (e instanceof TypeError) return "Couldn't reach the server. Check your connection and try again."
  return 'Something went wrong.'
}

/** How long the card is on screen before an Approve tap starts its flow. */
const ARM_DELAY_MS = 350

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function CardView({ card, threadName, highlighted, armPrimary, inline = true }: CardViewProps) {
  const host = useHost()
  const client = useTalosClient()
  const agent = useTalos((s) => s.config?.agent.name ?? 'Talos')
  const timeZone = useTalos((s) => s.config?.timezone ?? 'UTC')
  // The relay's clock: `expires_at` is its time, and a phone clock minutes off must not expire a live card (or keep a dead one).
  const now = useRelayNow(1000)
  const rootRef = useRef<HTMLElement>(null)
  const titleId = useId()

  const altered = useMemo(() => isAltered(card), [card])
  const hash = useMemo(() => renderedHash(card), [card])
  const expired = isExpiredNow(card, now)
  const line = collapseLine(card, { agent, timeZone, nowMs: now, host })
  const live = card.state === 'pending' && !altered && !expired

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditDraft>({ fields: {}, body: undefined })
  const [reviseOpen, setReviseOpen] = useState(false)
  const [note, setNote] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  // Set once the Mac has been sent a decision; the card stays buttonless until `card.state` leaves 'pending'.
  const [decided, setDecided] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pulse, setPulse] = useState(false)
  // Ask again on an expired card (owner call O2): one ordinary message to the card's thread, no new frame.
  const [ask, setAsk] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'queued' } | { kind: 'failed'; text: string }
  >({ kind: 'idle' })

  useEffect(() => {
    if (!highlighted) return
    rootRef.current?.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    setPulse(true)
    const t = setTimeout(() => setPulse(false), 1200)
    return () => clearTimeout(t)
  }, [highlighted])

  // An Approve tap from a push: once, and only for a card that is still live and as rendered (live = pending, unaltered,
  // unexpired). It only puts focus on the card's button: nothing is sent until the owner taps it here. (With the
  // confirmation step gone the primary flow has no second step, so starting it from a push would approve from the
  // notification; the bridge refuses that for a high-risk card anyway, `open_in_app`.) The card is on screen for a moment
  // first, and the check is made again when the moment is up, so a card that changed or expired in between is left alone.
  const armedInMemory = useArmedCard() === card.id
  const armedOnce = useRef(false)
  const latest = useRef<{ live: boolean; busy: boolean } | null>(null)
  useEffect(() => {
    if (armedInMemory && !live) spendArm(card.id) // a card that is not live is never armed
    if (!(armPrimary || armedInMemory) || armedOnce.current || !live) return
    const t = setTimeout(() => {
      armedOnce.current = true // spent when it fires, so a StrictMode double-mount still arms once
      spendArm(card.id) // and spent at the store, so a second CardView for this card (a sheet) or a later visit does not re-arm
      const now = latest.current
      if (!now?.live || now.busy) return
      rootRef.current?.querySelector<HTMLElement>('[data-card-primary]')?.focus()
    }, ARM_DELAY_MS)
    return () => clearTimeout(t)
  }, [armPrimary, armedInMemory, live, card.id])

  const edits = useMemo(() => (editing ? editsFromDraft(card, draft) : null), [editing, card, draft])
  const editedHash = useMemo(() => (edits ? editedHashFor(card, edits) : null), [card, edits])
  const bodyEditable = isBodyEditable(card)
  const hasEditable = card.allow_edit && (card.fields.some((f) => f.editable) || bodyEditable)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorCopy(e, agent, host))
    } finally {
      setBusy(false)
    }
  }

  // "Always allow" is offered only on an action card that offers it (cardOffersAlways: never a question, a permission card or a trust-key settings card), and only by a bridge that reads it (an older one would approve
  // this card and ignore the rest). Without the feature the card is unchanged.
  // (the send kinds need always-allow/1; the newer kinds need always-allow/2, which an older bridge does not say)
  const alwaysOffered = useTalos((s) => alwaysKindOffered(s.presence.features, card.kind))
  const alwaysLabel =
    alwaysOffered && cardOffersAlways(card) && isAlwaysKind(card.kind) ? ALWAYS_ALLOW_LABEL[card.kind] : null

  const primary = (opts: { always?: true } = {}) =>
    run(async () => {
      // the card may have run out while it sat on screen: an expired card is never sent
      if (isExpiredNow(card, Date.now() + (client.store.getState().clockOffset ?? 0))) {
        setError('This card expired, so this tap was not sent.')
        return
      }
      await client.resolveCard(card.id, {
        action: 'primary',
        payloadHash: hash,
        ...(edits && editedHash ? { edited: edits, editedHash } : {}),
        ...(opts.always && alwaysLabel ? { always: true as const } : {}),
      })
      setEditing(false)
      setDecided(true)
    })
  latest.current = { live: live && !decided, busy }
  const kill = () =>
    run(async () => {
      await client.resolveCard(card.id, { action: 'kill', payloadHash: hash })
      setDecided(true)
    })
  // "Deny with a note" on a permission card: the same kill, with the owner's words signed in `note` (none: a plain kill)
  const killWithNote = (note: string | undefined) =>
    run(async () => {
      await client.resolveCard(card.id, { action: 'kill', payloadHash: hash, ...(note ? { note } : {}) })
      setDecided(true)
    })
  // a button of a needs-you dialog card; the login card's one button carries no index
  const choose = (choice: number | null, text?: string) =>
    run(async () => {
      await client.resolveCard(card.id, {
        action: 'primary',
        payloadHash: hash,
        ...(choice === null ? {} : { choice }),
        // a question's free-text option: the owner's words, signed with the rest of the frame
        ...(text === undefined ? {} : { text }),
      })
      setDecided(true)
    })
  const revise = () =>
    run(async () => {
      await client.resolveCard(card.id, { action: 'revise', payloadHash: hash, note: note.trim() })
      setReviseOpen(false)
      setNote('')
      setDecided(true)
    })

  const kindInfo = Object.hasOwn(KIND_LABEL, card.kind) ? KIND_LABEL[card.kind] : KIND_LABEL.generic
  const header = (
    <div className="flex items-center gap-2 text-sm text-text-2">
      <KindIcon kind={card.kind} />
      <span className="text-xs font-semibold uppercase tracking-[var(--tracking-caps)]">
        {kindInfo.label} · {threadName}
      </span>
      <span className="ml-auto flex items-center gap-1">
        {live && card.kind !== 'dialog' ? (
          // A solid accent pill rather than a warn-coloured Badge, so the card that needs you stands out from a status badge.
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-accent px-2 py-0.5 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-on-accent">
            <StatusDot shape="solid" size={8} />
            Needs you
          </span>
        ) : null}
      </span>
    </div>
  )

  // A card that ran out of time unseen (past `expires_at`, or the relay already marked it expired).
  const lapsed = expired || card.state === 'expired' || card.resolution?.action === 'expired'
  const askAgain = async () => {
    if (ask.kind === 'sending') return
    setAsk({ kind: 'sending' })
    try {
      // A fixed sentence and the card's id, never its title: the title is agent-written (it can derive from outside
      // content) and this message goes out signed as the owner's own words.
      const r = await client.sendMessage({
        threadId: card.thread_id,
        text: `Please ask me again about card ${card.id}. It expired before I saw it.`,
      })
      if (r.state === 'held_unpinned')
        setAsk({ kind: 'failed', text: `This device is not approved yet, so nothing was sent to ${agent}.` })
      else setAsk(r.state === 'queued' ? { kind: 'queued' } : { kind: 'sent' })
    } catch (e) {
      setAsk({
        kind: 'failed',
        text: e instanceof Error && e.message ? e.message : `Could not reach ${agent}. Try again.`,
      })
    }
  }

  // ---- needs-you dialog card (docs/OPTION-C.md): draws every state itself, so it comes before the collapsed line --------
  const shared = { card, header, titleId, rootRef, pulse, hash, now, busy, error, timeZone }
  if (card.kind === 'dialog') return <DialogCard {...shared} altered={altered} decided={decided} onChoose={choose} />

  // ---- collapsed (decided / failed / expired / superseded) ------------------------------------------------------
  if (line && !altered) {
    return (
      <article
        ref={rootRef}
        aria-labelledby={titleId}
        data-card-id={card.id}
        data-card-state={expired ? 'expired' : card.state}
        className={cn(
          'incised rounded-card bg-surface p-3 transition-[height] duration-[var(--dur-3)] ease-talos',
          pulse && 'ring-2 ring-accent',
          !inline && 'w-full',
        )}
      >
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <span data-testid="collapse-line" className="text-sm text-text" aria-live="polite">
            {revealHidden(line)}
          </span>
          <span id={titleId} className="min-w-0 flex-1 truncate text-sm text-text-2">
            {revealHidden(card.title)}
          </span>
        </button>
        {expanded ? (
          <div className="mt-2 space-y-2 border-t border-line pt-2 text-sm text-text-2">
            {header}
            {card.result ? <p>{revealHidden(card.result.text)}</p> : null}
            {card.resolution?.note ? <p>Note: {revealHidden(card.resolution.note)}</p> : null}
            <DestinationRows card={card} />
          </div>
        ) : null}
        {lapsed ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {ask.kind === 'sent' || ask.kind === 'queued' ? (
              <p role="status" data-testid="ask-again-status" className="text-sm text-text-2">
                {ask.kind === 'queued'
                  ? placeWords(`Queued. ${agent} will ask again when your Mac is back.`, host)
                  : `Asked. ${agent} will send it again.`}
              </p>
            ) : (
              <Button variant="outline" data-testid="ask-again" disabled={ask.kind === 'sending'} onClick={askAgain}>
                {ask.kind === 'sending' ? 'Asking…' : 'Ask again'}
              </Button>
            )}
            {ask.kind === 'failed' ? (
              <p role="alert" className="text-sm text-danger">
                {ask.text}
              </p>
            ) : null}
          </div>
        ) : null}
      </article>
    )
  }

  // ---- decision sent, waiting for the Mac -----------------------------------------------------------------------
  if (decided && live) {
    return (
      <article
        ref={rootRef}
        aria-labelledby={titleId}
        data-card-id={card.id}
        data-card-state="sending"
        className="incised rounded-card bg-surface p-3"
      >
        <p data-testid="collapse-line" role="status" aria-live="polite" className="text-sm text-text">
          Sending… waiting for {agent} to confirm.
        </p>
        <span id={titleId} className="block truncate text-sm text-text-2">
          {revealHidden(card.title)}
        </span>
      </article>
    )
  }

  // ---- altered --------------------------------------------------------------------------------------------------
  if (altered) {
    return (
      <article
        ref={rootRef}
        aria-labelledby={titleId}
        data-card-id={card.id}
        data-card-state="altered"
        className={cn('rounded-card border border-danger bg-surface p-3', pulse && 'ring-2 ring-accent')}
      >
        {header}
        <h3 id={titleId} className="mt-1 text-lg font-medium text-text">
          {revealHidden(card.title)}
        </h3>
        <p role="alert" className="mt-2 text-sm font-medium text-danger">
          ⚠ This card was altered in transit. Don't approve it.
        </p>
      </article>
    )
  }

  // ---- live permission card (docs/CLAUDE-CODE.md C3.2): its own layout, never the generic one ----------------------
  if (card.kind === 'permission')
    return (
      <PermissionCardLive
        {...shared}
        highlighted={highlighted}
        onAllow={() => primary()}
        onDeny={kill}
        onDenyWithNote={killWithNote}
      />
    )

  // ---- live pending card ----------------------------------------------------------------------------------------
  const body = card.body ?? ''
  const bodyLines = body.split('\n')
  const longBody = bodyLines.length > BODY_PREVIEW_LINES || body.length > 600
  const msLeft = cardExpiryMs(card) - now
  const showCountdown = msLeft <= COUNTDOWN_WINDOW_MS
  const primaryText = edits ? `${card.primary_label} edited` : card.primary_label

  return (
    <article
      ref={rootRef}
      aria-labelledby={titleId}
      data-card-id={card.id}
      data-card-state="pending"
      data-talos-protected=""
      data-payload-hash={hash}
      {...(editedHash ? { 'data-edited-hash': editedHash } : {})}
      className={cn(
        'incised rounded-card bg-surface p-4 transition-shadow duration-[var(--dur-2)] ease-talos',
        pulse && 'ring-2 ring-accent',
        card.risk === 'high' && 'border-warn',
      )}
    >
      {header}
      <div className="mt-1 flex items-start gap-2">
        <h3 id={titleId} className="flex-1 text-lg font-medium text-text">
          {revealHidden(card.title)}
        </h3>
        <OverflowMenu open={menuOpen} onToggle={() => setMenuOpen((v) => !v)} onClose={() => setMenuOpen(false)}>
          <MenuItem
            onClick={() => {
              setDetailsOpen(true)
              setMenuOpen(false)
            }}
          >
            View details
          </MenuItem>
          <MenuItem
            onClick={async () => {
              setMenuOpen(false)
              const text = [card.title, ...card.destination.map((d) => `${d.label}: ${d.value}`), body]
                .filter(Boolean)
                .join('\n')
              setCopied(await copyText(text))
            }}
          >
            Copy
          </MenuItem>
          {card.allow_revise ? (
            <MenuItem
              onClick={() => {
                setReviseOpen(true)
                setMenuOpen(false)
              }}
            >
              Tell {agent} what to change
            </MenuItem>
          ) : null}
        </OverflowMenu>
      </div>
      {card.summary ? <p className="mt-1 text-sm text-text-2">{revealHidden(card.summary)}</p> : null}
      <DestinationRows card={card} />

      {card.fields.length > 0 ? (
        <dl className="mt-2 space-y-1 text-sm">
          {card.fields.map((f) => (
            <div key={f.key} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
              <dt className="w-24 shrink-0 pt-0.5 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
                {f.label}
              </dt>
              <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-text">
                {editing && f.editable ? (
                  f.multiline ? (
                    <Textarea
                      aria-label={f.label}
                      value={draft.fields[f.key] ?? f.value}
                      onChange={(e) => setDraft((d) => ({ ...d, fields: { ...d.fields, [f.key]: e.target.value } }))}
                    />
                  ) : (
                    <Input
                      aria-label={f.label}
                      value={draft.fields[f.key] ?? f.value}
                      onChange={(e) => setDraft((d) => ({ ...d, fields: { ...d.fields, [f.key]: e.target.value } }))}
                    />
                  )
                ) : (
                  <bdi>{revealHidden(f.value)}</bdi>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {card.body !== undefined || (editing && bodyEditable) ? (
        <div className="mt-2 border-t border-line pt-2">
          {editing && bodyEditable ? (
            <Textarea
              aria-label="Message body"
              rows={8}
              value={draft.body ?? body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
            />
          ) : (
            <>
              <p
                data-testid="card-body"
                className={cn(
                  'whitespace-pre-wrap break-words text-md text-text',
                  !showAll && longBody && 'line-clamp-6',
                )}
              >
                {revealHidden(body)}
              </p>
              {longBody ? (
                <button
                  type="button"
                  className="mt-1 min-h-11 text-sm text-accent-text underline"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? 'Show less' : 'Show all'}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {card.attachments.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attachments">
          {card.attachments.map((a) => (
            <li
              key={a.media_id}
              className="inline-flex items-center gap-1.5 rounded-pill border border-line px-2.5 py-1 text-xs text-text-2"
            >
              <IconClip width={14} height={14} /> {revealHidden(a.name)}{' '}
              <span className="font-mono">{sizeLabel(a.size)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {card.kind === 'config' && themeOfCard(card.payload) ? <ThemePreview theme={themeOfCard(card.payload)} /> : null}
      {card.warning ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-warn">
          <IconAlert width={16} height={16} className="mt-0.5 shrink-0" />
          {revealHidden(card.warning)}
        </p>
      ) : null}

      {detailsOpen || card.payload !== undefined ? (
        <div className="mt-2">
          <button
            type="button"
            className="min-h-11 text-sm text-accent-text underline"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((v) => !v)}
          >
            Details
          </button>
          {detailsOpen ? (
            <pre
              data-testid="card-details"
              className="max-h-64 overflow-auto rounded-button bg-surface-2 p-2 font-mono text-xs text-text"
            >
              {revealHidden(JSON.stringify(card.payload ?? null, null, 2))}
            </pre>
          ) : null}
        </div>
      ) : null}

      {reviseOpen ? (
        <div className="mt-2 space-y-2">
          <Textarea
            aria-label={`What should ${agent} change?`}
            placeholder={`What should ${agent} change?`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy || note.trim() === ''} onClick={revise}>
              Send note
            </Button>
            <Button variant="ghost" onClick={() => setReviseOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 break-words text-sm text-danger">
          {error}
        </p>
      ) : null}
      {copied ? (
        <p role="status" className="mt-1 text-xs text-text-2">
          Copied
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="danger" disabled={busy} onClick={kill}>
          {revealHidden(card.kill_label)}
        </Button>
        {hasEditable ? (
          <Button
            variant="outline"
            disabled={busy}
            aria-pressed={editing}
            onClick={() => {
              if (editing) {
                setEditing(false)
                setDraft({ fields: {}, body: undefined })
              } else setEditing(true)
            }}
          >
            {editing ? 'Cancel edit' : 'Edit'}
          </Button>
        ) : null}
        {alwaysLabel ? (
          <Button
            variant="outline"
            className="ml-auto"
            disabled={busy}
            onClick={() => primary({ always: true })}
            data-card-always=""
          >
            {alwaysLabel}
          </Button>
        ) : null}
        <Button
          className={alwaysLabel ? undefined : 'ml-auto'}
          disabled={busy}
          onClick={() => primary()}
          data-card-primary=""
        >
          {revealHidden(primaryText)}
        </Button>
      </div>
      <p className="mt-2 font-mono text-xs text-text-2" data-testid="card-expiry">
        {showCountdown
          ? `Expires in ${countdown(msLeft)}`
          : card.origin === 'background'
            ? `Expires ${formatExpiry(new Date(cardExpiryMs(card)).toISOString(), timeZone, now)} if untouched`
            : null}
      </p>
    </article>
  )
}

/** Display only (the bound text is untouched): a schedule card's ISO "Next" in plain words, and "As" that follows the runner. */
function destinationText(card: CardT, d: { label: string; value: string }): string {
  if (card.kind !== 'schedule') return d.value
  if (d.label === 'Next' && /^\d{4}-\d\d-\d\dT/.test(d.value)) {
    const tz = ScheduleCardPayload.safeParse(card.payload).data?.preview.tz
    if (tz && !Number.isNaN(Date.parse(d.value)))
      return dateTimeLabel(d.value, tz, Intl.DateTimeFormat().resolvedOptions().timeZone)
  }
  if (
    d.label === 'As' &&
    d.value.startsWith('Full permissions') &&
    card.destination.some((x) => x.label === 'Where' && /live session/.test(x.value))
  )
    return 'As your live agent (its permissions)'
  return d.value
}

function DestinationRows({ card }: { card: CardT }) {
  if (card.destination.length === 0) return null
  // "To" fits 3rem; a schedule card's "Proposed by" and "Posts to" need more room (the label overran its value)
  const wide = card.destination.some((d) => d.label.length > 5)
  return (
    <dl className="mt-2 space-y-1 text-sm">
      {card.destination.map((d) => (
        <div key={`${d.label}:${d.value}`} className="flex gap-3">
          <dt
            className={cn(
              wide ? 'w-24' : 'w-12',
              'shrink-0 pt-0.5 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2',
            )}
          >
            {d.label}
          </dt>
          <dd className="min-w-0 break-words text-text">
            <bdi>{revealHidden(destinationText(card, d))}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  )
}

function OverflowMenu({
  open,
  onToggle,
  onClose,
  children,
}: {
  open: boolean
  onToggle: () => void
  onClose: () => void
  children: ReactNode
}) {
  const id = useId()
  return (
    <div className="relative">
      <Button
        variant="ghost"
        aria-label="More"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose()
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        …
      </Button>
      {open ? (
        <div
          id={id}
          role="menu"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
          className="absolute right-0 z-10 mt-1 min-w-48 rounded-card border border-line bg-surface p-1 shadow-[var(--inset-highlight)]"
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

function MenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex min-h-11 w-full items-center rounded-button px-3 text-left text-sm text-text hover:bg-surface-2"
      onClick={onClick}
    >
      {children}
    </button>
  )
}
