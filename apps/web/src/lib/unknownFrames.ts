// A newer peer can send a frame type or card kind this build has never heard of. Strict parsing refuses it, and the
// owner used to get nothing. This file tells an unknown kind apart from a malformed known one and keeps the one-note rule.
import { CARD_KINDS, FRAME_TYPES, parseFrame } from '@talos-app/protocol'

export const UPDATE_NOTE = "Something arrived that this version of Talos can't show. Update the app to see it."

/** A kind name as a peer would write it. Anything else is junk, not a newer version, and gets no note. */
const KIND_NAME = /^[a-z][a-z0-9_.]{0,63}$/

export type UnknownKind = {
  /** `frame:<type>` or `card:<kind>`: what this build cannot show. */
  kind: string
  /** The frame id (for an open card in `ready`, the card id). */
  id: string | undefined
  /** The card's own id, when the thing is a card: the same on the live path and in `ready.open_cards`. */
  cardId?: string | undefined
  threadId: string | undefined
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** A card whose only fault is a kind this build does not list. Same card with a known kind must parse, else it is malformed. */
function unknownCardKind(card: unknown, wrap: (c: Record<string, unknown>) => unknown): UnknownKind | null {
  if (!isRecord(card)) return null
  const kind = card.kind
  if (typeof kind !== 'string' || !KIND_NAME.test(kind) || (CARD_KINDS as readonly string[]).includes(kind)) return null
  if (!parseFrame(wrap({ ...card, kind: 'generic' }), { direction: 'relay_to_app' }).ok) return null
  return { kind: `card:${kind}`, id: str(card.id), cardId: str(card.id), threadId: str(card.thread_id) }
}

/** A raw frame from the relay that did not parse: is it a type or card kind from a newer build? Null if it is just broken. */
export function unknownOfFrame(raw: unknown): UnknownKind | null {
  if (!isRecord(raw)) return null
  const type = raw.type
  if (typeof type !== 'string' || !KIND_NAME.test(type)) return null
  if (!(FRAME_TYPES as readonly string[]).includes(type)) {
    return { kind: `frame:${type}`, id: str(raw.id), threadId: str(raw.thread_id) }
  }
  if (type !== 'card.create') return null
  const found = unknownCardKind(raw.card, (c) => ({ ...raw, card: c }))
  return found ? { ...found, id: str(raw.id) ?? found.id } : null
}

/** The cards in a `ready` that this build dropped for their kind alone. */
export function unknownOfOpenCards(raw: unknown): UnknownKind[] {
  if (!isRecord(raw) || raw.type !== 'ready' || !Array.isArray(raw.open_cards)) return []
  const out: UnknownKind[] = []
  for (const c of raw.open_cards) {
    // Ask the same question as for a live card.create: would this card parse with a kind we know?
    const found = unknownCardKind(c, (card) => ({ v: raw.v, id: raw.id, ts: raw.ts, type: 'card.create', card }))
    if (found) out.push(found)
  }
  return out
}

/** Most notes one session will write. A peer can invent kinds and ids without limit; the owner needs to see it once. */
export const MAX_NOTES = 20
/** Most notes one thread will get, so a hostile relay cannot fill a single conversation with them. */
export const MAX_NOTES_PER_THREAD = 3

/**
 * The note rule for one client session: at most once per frame id, at most one note per thread for the same kind, at most `MAX_NOTES_PER_THREAD` per thread, and
 * at most `MAX_NOTES` in all. A thread id the client does not know (the peer chose it) is replaced by the default
 * thread. `add` writes the note into the thread (undefined means the default one); this decides only whether it is time to.
 * The note's id is the card id when there is one, so a reload that lists the card as open finds the note it already has.
 */
export function createUnknownNotes(
  add: (text: string, id: string, threadId: string | undefined) => void,
  knownThread: (threadId: string) => boolean = () => false,
) {
  const seenIds = new Set<string>()
  const seenKinds = new Set<string>()
  const perThreadCount = new Map<string, number>()
  return (found: UnknownKind | null) => {
    if (!found || seenKinds.size >= MAX_NOTES) return
    const ids = [found.id, found.cardId].filter((x): x is string => x !== undefined)
    if (ids.some((x) => seenIds.has(x))) return
    const threadId = found.threadId !== undefined && knownThread(found.threadId) ? found.threadId : undefined
    const perThread = `${threadId ?? ''}|${found.kind}`
    if (seenKinds.has(perThread)) return
    const threadKey = threadId ?? ''
    const inThread = perThreadCount.get(threadKey) ?? 0
    if (inThread >= MAX_NOTES_PER_THREAD) return
    perThreadCount.set(threadKey, inThread + 1)
    for (const x of ids) seenIds.add(x)
    seenKinds.add(perThread)
    add(UPDATE_NOTE, `unknown-${found.cardId ?? found.id ?? perThread}`, threadId)
  }
}
