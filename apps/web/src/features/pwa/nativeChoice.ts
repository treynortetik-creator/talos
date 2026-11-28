// What the owner chose about iPhone notifications, kept on the phone. Split out of nativePush.ts so sign-out
// (`clearLocalData`) can forget it without pulling in the whole push module.
//
//   choice      'on' after Turn on, 'off' after Turn off or after iOS says notifications are blocked.
//   text        what is applied now: 'on' ONLY after a grant was made and stored (by the Turn on tap when the owner's decision or
//               the default says words, or by a tap on Show message text); 'off' otherwise. A grant is renewed on open only
//               while this says 'on', so opening the app never turns words on by itself. Turn off, sign-out, a revoked pairing
//               and a blocked permission all put it back to off; the owner's decision (textPref) is what the next Turn on reads.
//   textPref    the owner's DECISION about text, kept apart from `text` (what is applied right now, which Turn off, a block and
//               sign-out all put back to off). absent = never decided: the Turn on tap uses PUSH_TEXT_DEFAULT. 'on' / 'off' = a tap
//               on Show message text / Use a fixed phrase only. 'legacy' = a page from before the default existed that had
//               recorded keys: its stored "off" cannot be told from "never tapped", so it is kept off (never flipped) and offered
//               words once. A real sign-out puts it back to absent; an expired session keeps it.
//   grantStored the phone holds a grant in its Keychain (set after the shell accepted it, cleared with it).
import { PUSH_TEXT_DEFAULT } from '@talos-app/protocol'

const CHOICE_KEY = 'talos.nativePush.choice'
const TEXT_KEY = 'talos.nativePush.text'
const STORED_KEY = 'talos.nativePush.grantStored'
const PREF_KEY = 'talos.nativePush.textPref'
const PREF_VERSION_KEY = 'talos.nativePush.prefV'
const OFFER_KEY = 'talos.nativePush.wordsOffer'

type Two = 'on' | 'off'
export type TextPref = 'on' | 'off' | 'legacy'
const memory: { choice: Two | null; text: Two | null; stored: boolean; pref: TextPref | null; offerHidden: boolean } = {
  choice: null,
  text: null,
  stored: false,
  pref: null,
  offerHidden: false,
}
/** Bumped by sign-out / revoke. A grant request that began before it must not store anything afterwards. */
let generation = 0
export function choiceGeneration(): number {
  return generation
}

/**
 * Two copies exist (page storage and this page load's memory) and a failed write can leave them apart. They fail toward
 * off: if either says off the answer is off, so a lost write of "off" can never leave "on" standing.
 */
function agree(stored: string | null, mem: Two | null): Two | null {
  const s = stored === 'on' || stored === 'off' ? stored : null
  if (s === 'off' || mem === 'off') return 'off'
  return s ?? mem
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(key)
    else localStorage.setItem(key, v)
  } catch {
    /* the in-memory copy still holds for this page load */
  }
}

export function choice(): Two | null {
  return agree(read(CHOICE_KEY), memory.choice)
}
export function setChoice(v: Two) {
  textPref() // classify an older page before this write makes every page look recorded
  memory.choice = v
  write(CHOICE_KEY, v)
}
export function textChoice(): Two | null {
  return agree(read(TEXT_KEY), memory.text)
}
export function setTextChoice(v: Two) {
  textPref() // classify an older page before this write makes every page look recorded
  memory.text = v
  write(TEXT_KEY, v)
}
function readPref(): TextPref | null {
  const v = read(PREF_KEY)
  return v === 'on' || v === 'off' || v === 'legacy' ? v : memory.pref
}
/**
 * The owner's decision about text, or null for "never decided" (the Turn on tap then uses PUSH_TEXT_DEFAULT). The first read on
 * a page classifies it once: a page that already recorded a choice or a text state came from an earlier build, so its text is
 * 'legacy' (kept off) unless it had text on; a page with nothing recorded is new.
 */
export function textPref(): TextPref | null {
  if (read(PREF_VERSION_KEY) !== '1') {
    const t = read(TEXT_KEY)
    const recorded = read(CHOICE_KEY) !== null || t !== null
    if (recorded && readPref() === null) setPref(t === 'on' ? 'on' : 'legacy')
    write(PREF_VERSION_KEY, '1')
  }
  return readPref()
}
function setPref(v: TextPref | null) {
  memory.pref = v
  write(PREF_KEY, v)
}
/** A tap on Show message text / Use a fixed phrase only: the owner's decision, kept across Turn off and Turn on. */
export function setTextPref(v: 'on' | 'off') {
  textPref() // classify an older page first, so this tap is not overwritten by it
  setPref(v)
}
/** What the Turn on tap does about text: the owner's decision if there is one, else the shared default. */
export function wantsText(): boolean {
  const p = textPref()
  return p === null ? PUSH_TEXT_DEFAULT : p === 'on'
}
/** The one-time "Show message words in notifications?" question: only for a kept-off older page, until Not now. */
export function wordsOfferWanted(): boolean {
  return textPref() === 'legacy' && read(OFFER_KEY) !== 'hidden' && !memory.offerHidden
}
export function hideWordsOffer() {
  memory.offerHidden = true
  write(OFFER_KEY, 'hidden')
}
export function grantStored(): boolean {
  return read(STORED_KEY) === '1' || memory.stored
}
export function setGrantStored(v: boolean) {
  memory.stored = v
  write(STORED_KEY, v ? '1' : null)
}

/** Sign-out, a 401 and a revoke: the next owner of this page starts with notifications' text off and no grant on record. */
export function forgetNativeChoices(opts: { keepDecision?: boolean } = {}): void {
  generation++
  memory.choice = null
  memory.text = 'off'
  memory.stored = false
  write(PREF_VERSION_KEY, '1') // classified: the next person on this page is new, not an older page
  // An expired session is the same owner coming back: their decision about words (and a hidden offer) stays. Only a real
  // sign-out hands the page to a new person, who gets the default.
  if (!opts.keepDecision) {
    memory.pref = null
    memory.offerHidden = false
    write(PREF_KEY, null)
    write(OFFER_KEY, null)
  }
  write(CHOICE_KEY, null)
  write(TEXT_KEY, 'off')
  write(STORED_KEY, null)
}

/** Tests only. */
export function resetNativeChoicesForTests(opts: { keepStorage?: boolean } = {}): void {
  memory.choice = null
  memory.text = null
  memory.stored = false
  memory.pref = null
  memory.offerHidden = false
  if (opts.keepStorage) return // a page reload: memory is gone, page storage stays
  for (const k of [CHOICE_KEY, TEXT_KEY, STORED_KEY, PREF_KEY, PREF_VERSION_KEY, OFFER_KEY]) write(k, null)
}
