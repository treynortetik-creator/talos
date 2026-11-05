// Pure card logic (spec 8.4). No React here, so the hash rules are unit-testable.
import {
  bindingFrom,
  type CardEditsT,
  type CardKind,
  type CardT,
  isBodyEditable,
  payloadHash,
  editedHash as protocolEditedHash,
} from '@talos-app/protocol'
import { formatClock } from './util.ts'

/** The hash of exactly what the card renders. `card.resolve` carries this and never `card.payload_hash`. */
export function renderedHash(card: CardT): string {
  return payloadHash(bindingFrom(card))
}

/** A pending card whose render no longer matches the hash the Mac signed is never approvable. */
export function isAltered(card: CardT): boolean {
  return card.state === 'pending' && renderedHash(card) !== card.payload_hash
}

/** Still waiting on the owner: pending, approvable and not past its expiry. The one rule behind every "Needs you" count. */
export function awaitsOwner(card: CardT, nowMs: number): boolean {
  return card.state === 'pending' && Date.parse(card.expires_at) > nowMs && !isAltered(card)
}

/**
 * True while the card still needs the owner: pending and not past its expiry. This is the only state a card is kept
 * at the bottom of its thread for. Altered (hash mismatch) cards count: they must stay visible, and are flagged.
 */
export function needsOwnerNow(card: CardT, nowMs: number): boolean {
  return card.state === 'pending' && Date.parse(card.expires_at) > nowMs
}

/**
 * When the card takes its place among the messages. The moment the owner acted on it when there is one (their tap is
 * the event they remember); otherwise when it was created.
 */
export function placedAt(card: CardT): string {
  return card.resolution?.at ?? card.created_at
}

/** An approved card waits this long for the agent's `card_result` before the card says no result has come. */
export const RESULT_OVERDUE_MS = 60 * 60 * 1000

/**
 * When the Mac took the decision (its own clock), for "how long has it been running" and "done today". `resolution.at` is
 * the owner's tap, which can be hours older when the Mac was asleep; an older Mac sends no `taken_at`, so fall back to it.
 */
export function takenAt(card: CardT): string | undefined {
  return card.resolution?.taken_at ?? card.resolution?.at
}

/** An approved card the agent has not reported on for longer than RESULT_OVERDUE_MS. Thread and Home share this check. */
export function resultOverdue(card: CardT, nowMs: number): boolean {
  const since = takenAt(card)
  return (
    card.state === 'resolved' &&
    card.resolution?.action === 'primary' &&
    since !== undefined &&
    nowMs - Date.parse(since) > RESULT_OVERDUE_MS
  )
}

export type EditDraft = { fields: Record<string, string>; body: string | undefined }

/** Only what changed. Null when nothing differs from the card as rendered. */
export function editsFromDraft(card: CardT, draft: EditDraft): CardEditsT | null {
  const fields = card.fields
    .filter((f) => f.editable && draft.fields[f.key] !== undefined && draft.fields[f.key] !== f.value)
    .map((f) => ({ key: f.key, value: draft.fields[f.key] as string }))
  const bodyChanged = isBodyEditable(card) && draft.body !== undefined && draft.body !== (card.body ?? '')
  if (fields.length === 0 && !bodyChanged) return null
  return { fields, ...(bodyChanged ? { body: draft.body as string } : {}) }
}

export function editedHashFor(card: CardT, edits: CardEditsT): string {
  return protocolEditedHash(bindingFrom(card), edits)
}

const DONE_VERB: Record<CardT['kind'], string> = {
  email: 'Sent',
  message: 'Sent',
  deploy: 'Deployed',
  publish: 'Published',
  purchase: 'Paid',
  decision: 'Approved',
  generic: 'Done',
  schedule: 'Saved',
  permission: 'Sent',
  app_action: 'Done',
  config: 'Changed',
}
const FAIL_VERB: Record<CardT['kind'], string> = {
  email: 'send',
  message: 'send',
  deploy: 'deploy',
  publish: 'publish',
  purchase: 'pay',
  decision: 'finish',
  generic: 'finish',
  schedule: 'save',
  permission: 'finish',
  app_action: 'finish',
  config: 'change it',
}

/** The verb for a kind, or the generic card's verb for a kind this build does not know (own keys only: "constructor" is unknown). */
function verbFor(table: Record<CardT['kind'], string>, kind: string): string {
  return Object.hasOwn(table, kind) ? table[kind as CardT['kind']] : table.generic
}

/** True once the card can no longer be acted on (decided, failed, expired, superseded or past `expires_at`). */
export function isExpiredNow(card: CardT, nowMs: number): boolean {
  return card.state === 'pending' && Date.parse(card.expires_at) <= nowMs
}

/**
 * The one-line summary shown after a decision (8.4 / 8.7). Null for a live pending card.
 */
export function collapseLine(card: CardT, o: { agent: string; timeZone?: string; nowMs: number }): string | null {
  const at = (iso: string | undefined) => (iso ? ` ${formatClock(iso, o.timeZone)}` : '')
  // Only that it expired: a card the relay left out of `ready`, or one past its time, may still have been decided here or
  // on another device, so the phone does not say what ran.
  const expired = () => '⌛ Expired'
  switch (card.state) {
    case 'pending':
      return isExpiredNow(card, o.nowMs) ? expired() : null
    case 'expired':
      return expired()
    case 'superseded':
      return '↻ Replaced by a newer draft'
    case 'failed':
      // The Mac says nothing ran (the request was gone, Apps were off), or that it cannot tell whether the agent got the
      // decision ('unknown'): "ask it to retry" would be wrong either way. Show the Mac's own words.
      if (card.result?.ran === false || card.result?.ran === 'unknown') return `⚠ ${card.result.text}`
      if (card.kind === 'schedule' && /changed on your Mac/i.test(card.result?.text ?? ''))
        return '⚠ The job changed on your Mac before you approved. Nothing was saved.'
      return `⚠ Couldn't ${verbFor(FAIL_VERB, card.kind)} · Ask ${o.agent} to retry`
    case 'resolved':
    case 'done': {
      const r = card.resolution
      if (r?.action === 'kill') return `✕ Killed${at(r.at)}`
      if (r?.action === 'revise') return `↻ Asked ${o.agent} to change it${at(r.at)}`
      if (r?.action === 'expired') return expired()
      if (card.state === 'resolved') {
        if (resultOverdue(card, o.nowMs)) return `⚠ No result reported yet · Ask ${o.agent} how it went`
        return `… Working on it${at(r?.at)}`
      }
      if (card.result && !card.result.ok) return `⚠ Couldn't ${verbFor(FAIL_VERB, card.kind)} · Ask ${o.agent} to retry`
      // Nothing says it was approved (no approval on record, no result): never claim it was sent.
      if (r?.action !== 'primary' && !card.result) return '✓ Finished'
      return `✓ ${verbFor(DONE_VERB, card.kind)}${at(card.result?.at ?? r?.at)}`
    }
  }
}

/** One entry per card kind: a kind missing here fails the type check. */
export const KIND_LABEL: Record<CardKind, { icon: string; label: string }> = {
  email: { icon: '✉', label: 'Email' },
  message: { icon: '💬', label: 'Message' },
  deploy: { icon: '🚀', label: 'Deploy' },
  publish: { icon: '📣', label: 'Publish' },
  purchase: { icon: '💳', label: 'Purchase' },
  decision: { icon: '⚖', label: 'Decision' },
  generic: { icon: '◇', label: 'Card' },
  schedule: { icon: '⏱', label: 'Schedule' },
  permission: { icon: '⚠', label: 'Permission' },
  app_action: { icon: '◇', label: 'App request' },
  config: { icon: '⚙', label: 'Setting' },
}

/** "m:ss" for a countdown. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Under this much time left, the countdown replaces the clock time. */
export const COUNTDOWN_WINDOW_MS = 15 * 60 * 1000
