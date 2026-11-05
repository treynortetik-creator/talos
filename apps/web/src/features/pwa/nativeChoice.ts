// What the owner chose about iPhone notifications, kept on the phone. Split out of nativePush.ts so sign-out
// (`clearLocalData`) can forget it without pulling in the whole push module.
//
//   choice      'on' after Turn on, 'off' after Turn off or after iOS says notifications are blocked.
//   text        'on' ONLY after a tap that made a grant (Show message text); 'off' otherwise. A grant is made or renewed only
//               while this says 'on', so message text never returns by itself. Sign-out, a revoked pairing and a blocked
//               permission all put it back to off.
//   grantStored the phone holds a grant in its Keychain (set after the shell accepted it, cleared with it).
const CHOICE_KEY = 'talos.nativePush.choice'
const TEXT_KEY = 'talos.nativePush.text'
const STORED_KEY = 'talos.nativePush.grantStored'

type Two = 'on' | 'off'
const memory: { choice: Two | null; text: Two | null; stored: boolean } = { choice: null, text: null, stored: false }
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
  memory.choice = v
  write(CHOICE_KEY, v)
}
export function textChoice(): Two | null {
  return agree(read(TEXT_KEY), memory.text)
}
export function setTextChoice(v: Two) {
  memory.text = v
  write(TEXT_KEY, v)
}
export function grantStored(): boolean {
  return read(STORED_KEY) === '1' || memory.stored
}
export function setGrantStored(v: boolean) {
  memory.stored = v
  write(STORED_KEY, v ? '1' : null)
}

/** Sign-out, a 401 and a revoke: the next owner of this page starts with notifications' text off and no grant on record. */
export function forgetNativeChoices(): void {
  generation++
  memory.choice = null
  memory.text = 'off'
  memory.stored = false
  write(CHOICE_KEY, null)
  write(TEXT_KEY, 'off')
  write(STORED_KEY, null)
}

/** Tests only. */
export function resetNativeChoicesForTests(): void {
  memory.choice = null
  memory.text = null
  memory.stored = false
  write(CHOICE_KEY, null)
  write(TEXT_KEY, null)
  write(STORED_KEY, null)
}
