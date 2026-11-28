// Adapted from t3code apps/web/src/lib/announce.ts, commit a22a4f9b.
// MIT, Copyright (c) 2026 T3 Tools Inc. Licence text: THIRD_PARTY_NOTICES.md.
// Changes: reformatted for Biome (single quotes, no semicolons). Ours, not T3's: (1) the regions live in one container with an id,
// and each has a test id; (2) an assertive mode, for an error or a failed action: it skips the focus wait and has its own pair of
// alternating regions; (3) a cap of 3 polite messages per spoken batch (the newest 3 win); (4) a repeat guard: the same message
// is not taken again within 1 second of being spoken; (5) `resetAnnouncerForTests`. `CLEAR_SPOKEN_AFTER_MS` is no longer exported.
//
// Screen readers skip a live region that appears already filled, and moving focus cuts off
// whatever they were saying. So the regions exist before the first message lands, and
// messages wait until focus has stayed put for a moment, then are spoken together.
const FOCUS_SETTLE_MS = 250

// NVDA reads a polite region's leftover text again when focus returns from a
// dialog, so an announcement is cleared once it has had time to be spoken.
// Clearing doesn't cut off speech that already started.
const CLEAR_SPOKEN_AFTER_MS = 7_000

// A burst of events is spoken as at most this many sentences.
const MAX_SPOKEN_TOGETHER = 3
// The same words are not taken again this soon after they were spoken (a double tap, a repeated event).
const REPEAT_GUARD_MS = 1_000

export const ANNOUNCER_ID = 'talos-announcer'

type Pair = readonly [HTMLElement, HTMLElement]
type Mode = 'polite' | 'assertive'

let regions: Pair | null = null
let urgentRegions: Pair | null = null
let pending: { message: string; source: string | undefined }[] = []
let spokenSources: (string | undefined)[] = []
let lastSpoken: { message: string; at: number } | null = null
let flushTimer: ReturnType<typeof setTimeout> | undefined
let clearTimer: ReturnType<typeof setTimeout> | undefined
let urgentTimer: ReturnType<typeof setTimeout> | undefined
let onFocusIn: (() => void) | null = null

function scheduleFlush() {
  clearTimeout(flushTimer)
  flushTimer = setTimeout(flush, FOCUS_SETTLE_MS)
}

function clearSpoken() {
  clearTimeout(clearTimer)
  spokenSources = []
  for (const region of regions ?? []) region.textContent = ''
}

function flush() {
  if (!regions || pending.length === 0) return
  clearSpoken()
  // Alternating between two regions lets the same message be spoken twice in a row.
  const [target, other] = regions
  regions = [other, target]
  const spoken = pending.slice(-MAX_SPOKEN_TOGETHER)
  target.textContent = spoken.map((entry) => entry.message).join('. ')
  spokenSources = spoken.map((entry) => entry.source)
  lastSpoken = { message: spoken.at(-1)?.message ?? '', at: Date.now() }
  pending = []
  clearTimer = setTimeout(clearSpoken, CLEAR_SPOKEN_AFTER_MS)
}

function createRegion(mode: Mode) {
  const region = document.createElement('div')
  region.setAttribute('data-testid', `announcer-${mode}`)
  region.setAttribute('aria-live', mode)
  region.setAttribute('aria-atomic', 'true')
  return region
}

function ensureRegions() {
  if (regions && urgentRegions) return
  const container = document.createElement('div')
  container.id = ANNOUNCER_ID
  container.className = 'sr-only'
  regions = [createRegion('polite'), createRegion('polite')]
  urgentRegions = [createRegion('assertive'), createRegion('assertive')]
  container.append(...regions, ...urgentRegions)
  document.body.append(container)
  onFocusIn = () => {
    if (pending.length > 0) scheduleFlush()
  }
  document.addEventListener('focusin', onFocusIn)
}

function speakNow(message: string) {
  if (!urgentRegions) return
  clearTimeout(urgentTimer)
  const [target, other] = urgentRegions
  urgentRegions = [other, target]
  other.textContent = ''
  target.textContent = message
  lastSpoken = { message, at: Date.now() }
  urgentTimer = setTimeout(() => {
    for (const region of urgentRegions ?? []) region.textContent = ''
  }, CLEAR_SPOKEN_AFTER_MS)
}

/**
 * Tells screen reader users what an action did when focus alone doesn't show it. A message
 * replaces one still waiting from the same `source`, so a superseded status isn't read out.
 * `assertive` is for an error: it is spoken at once, over what is being read.
 */
export function announce(message: string, source?: string, mode: Mode = 'polite') {
  // Stores announce without a mounted owner, so they also run where no DOM exists (unit tests).
  if (typeof document === 'undefined') return
  ensureRegions()
  if (lastSpoken && lastSpoken.message === message && Date.now() - lastSpoken.at < REPEAT_GUARD_MS) return
  if (mode === 'assertive') {
    speakNow(message)
    return
  }
  if (source !== undefined) pending = pending.filter((entry) => entry.source !== source)
  if (pending.at(-1)?.message !== message) pending.push({ message, source })
  scheduleFlush()
}

/** Drops a message from `source`, waiting or already spoken, once it no longer applies. */
export function cancelAnnouncement(source: string) {
  pending = pending.filter((entry) => entry.source !== source)
  if (spokenSources.includes(source)) clearSpoken()
}

/** Test only: removes the regions and every timer, so the next test starts with no announcer. */
export function resetAnnouncerForTests() {
  clearTimeout(flushTimer)
  clearTimeout(clearTimer)
  clearTimeout(urgentTimer)
  if (onFocusIn) document.removeEventListener('focusin', onFocusIn)
  onFocusIn = null
  document.getElementById(ANNOUNCER_ID)?.remove()
  regions = null
  urgentRegions = null
  pending = []
  spokenSources = []
  lastSpoken = null
}
