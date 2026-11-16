// A newer peer can send a frame type or card kind this build has never heard of. Strict parsing refuses it, and the
// owner used to get nothing. This file tells an unknown kind apart from a malformed known one and keeps the one-note rule.
import { CARD_KINDS, classifyUnparsed, newerInParsed, parseFrame } from '@talos-app/protocol'

export const UPDATE_NOTE = 'Talos on your phone or Mac is newer than this app; update to see everything.'

/** Every update note's row id starts with this (`addSystemRow` in socket-dispatch.ts prefixes `m_` to `unknown-...`). */
export const UPDATE_NOTE_ID_PREFIX = 'm_unknown-'

/**
 * An update note is about this page's own code, so it lives as long as the page does: the saved cache never brings one back.
 * Written into the thread and saved with it, a note from an older build used to stay for good, after the app had updated
 * and could show the thing. A build that still cannot show an open card or a `ready` field hears it again on connect and
 * says so again; a live frame it could not read is not sent again (catch-up resumes past it), so its note ends with the page.
 */
export const isUpdateNote = (m: { id?: unknown; author?: unknown }): boolean =>
  m.author === 'system' && typeof m.id === 'string' && m.id.startsWith(UPDATE_NOTE_ID_PREFIX)

/** A kind name as a peer would write it. Anything else is junk, not a newer version, and gets no note. */
const KIND_NAME = /^[a-z][a-z0-9_.]{0,63}$/

export type UnknownKind = {
  /** `frame:<type>`, `card:<kind>` or `ready:<field>`: what this build cannot show. */
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

/**
 * A raw frame from the relay that did not parse: is it from a newer build (a frame type, or a known type with a field or
 * enum value this build does not list, or a card kind it does not list)? Null if it is just broken.
 */
export function unknownOfFrame(raw: unknown): UnknownKind | null {
  if (!isRecord(raw)) return null
  const why = classifyUnparsed(raw, 'relay_to_app')
  if (why.kind === 'broken') return null
  if (why.type === 'card.create') {
    const card = unknownCardKind(raw.card, (c) => ({ ...raw, card: c }))
    if (card) return { ...card, id: str(raw.id) ?? card.id }
  }
  return { kind: `frame:${why.type}`, id: str(raw.id), threadId: str(raw.thread_id) }
}

/**
 * A frame that parsed but carried an error code this build does not list: it arrives with the code read as 'internal'
 * (protocol audit O5), and is still from a newer build, so it is noted like a newer shape. Null for anything else.
 */
export function unknownOfParsed(raw: unknown): UnknownKind | null {
  if (!isRecord(raw)) return null
  const why = newerInParsed(raw)
  if (why.kind === 'broken') return null
  return { kind: `frame:${why.type}`, id: str(raw.id), threadId: str(raw.thread_id) }
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

/**
 * The parts of a `ready` this build left out (audit O2): the frame reads per element, so a thread, a status or a session
 * field a newer Mac or relay sent is dropped rather than the whole frame. The owner still hears that something is not shown.
 */
export function unknownOfReady(
  raw: unknown,
  frame: {
    threads?: readonly unknown[] | undefined
    statuses?: readonly unknown[] | undefined
    session_list?: readonly unknown[] | undefined
    session_state?: unknown
    session_inventory?: unknown
    session_agents?: unknown
  },
): UnknownKind[] {
  if (!isRecord(raw) || raw.type !== 'ready') return []
  const out: UnknownKind[] = []
  const note = (field: string) => out.push({ kind: `ready:${field}`, id: str(raw.id), threadId: undefined })
  for (const k of ['threads', 'statuses', 'session_list'] as const) {
    const sent = raw[k]
    if (Array.isArray(sent) && sent.length > (frame[k]?.length ?? 0)) note(k)
  }
  for (const k of ['session_state', 'session_inventory', 'session_agents'] as const)
    if (raw[k] !== undefined && raw[k] !== null && frame[k] === undefined) note(k)
  return out
}

/** Most notes one session will write. A peer can invent kinds and ids without limit; the owner needs to see it once. */
export const MAX_NOTES = 20
/** Most notes one thread will get, so a hostile relay cannot fill a single conversation with them. */
export const MAX_NOTES_PER_THREAD = 3

/**
 * The note rule for one client session: at most once per frame id, one note per frame type, one per thread for the same card kind, at most `MAX_NOTES_PER_THREAD` per thread, and
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
    // A frame type is told once per session, wherever it came from; a card kind once per thread it lands in.
    const perThread = found.kind.startsWith('frame:') ? found.kind : `${threadId ?? ''}|${found.kind}`
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
