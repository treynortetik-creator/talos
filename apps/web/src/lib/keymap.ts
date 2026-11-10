// The one keymap table: every shortcut chord, palette item label and action, as SHIPPED DEFAULTS. useKeyboard.ts and the palette read only from
// here; no chord literal lives anywhere else.
//
// The owner's own bindings are a separate thing. `resolveKeymap(DEFAULT_KEYMAP, overrides)` lays an override map over the defaults and
// returns a new table; the defaults are never edited, so an update that ships new defaults cannot overwrite what the owner chose.
// Not built yet (a later package): the rebinding screen, the per-device overrides file, and the named event `keymap:changed` that
// the screen will emit when a binding changes. Nothing emits it today.
//
// Cmd+N is not here on purpose: browsers keep it for a new window and the Mac app's menu already gives it to Quick compose, so
// "New thread" has no chord and lives in the palette. Cmd+[ and Cmd+] are Mac-app-only (in a browser they stay Back and Forward).

export type Chord = {
  /** KeyboardEvent.code (layout independent). */
  code: string
  /** Needs Cmd or Ctrl. False only for Esc: no plain letter, arrow or Enter is ever a global chord. */
  mod?: boolean
  shift?: boolean
  /** Cmd only (not Ctrl): the Call chord, as it has always been. */
  metaOnly?: boolean
}

/** What an entry does. One dispatcher (features/palette/actions.ts) runs these for the keyboard and the palette alike. */
export type ActionSpec =
  | { kind: 'thread'; index: number }
  | { kind: 'threadStep'; by: -1 | 1 }
  | { kind: 'nav'; to: string }
  | {
      kind: 'ui'
      name:
        | 'palette'
        | 'needs'
        | 'topCard'
        | 'newThread'
        | 'findInThread'
        | 'sessionPanel'
        | 'sidebar'
        | 'call'
        | 'close'
    }

export type KeyEntry = {
  id: string
  label: string
  group: 'Go to' | 'Threads' | 'Panels' | 'App'
  chord: Chord | null
  /** 'mac-app': the chord is only live inside the Mac app's web view. */
  scope: 'web' | 'mac-app'
  act: ActionSpec
  /** False: a held key must not strobe it (toggles and openers). */
  repeat: boolean
  /** False: the focused text field uses this chord itself, so it does not fire while typing. */
  inField: boolean
}

export type Overrides = Record<string, Chord | null>

const e = (
  id: string,
  label: string,
  group: KeyEntry['group'],
  chord: Chord | null,
  act: ActionSpec,
  more: Partial<Pick<KeyEntry, 'scope' | 'repeat' | 'inField'>> = {},
): KeyEntry => ({ id, label, group, chord, act, scope: 'web', repeat: false, inField: true, ...more })

const thread = (n: number): KeyEntry =>
  e(`thread${n}`, `Thread ${n}`, 'Threads', { code: `Digit${n}` }, { kind: 'thread', index: n - 1 }, { repeat: true })

export const DEFAULT_KEYMAP: readonly KeyEntry[] = [
  e('palette', 'Command palette', 'Go to', { code: 'KeyK' }, { kind: 'ui', name: 'palette' }),
  e('needsYou', 'Needs-you list', 'Go to', { code: 'KeyJ' }, { kind: 'ui', name: 'needs' }),
  e('topCard', 'Open top Needs-you card', 'Go to', null, { kind: 'ui', name: 'topCard' }),
  e('searchMessages', 'Search messages', 'Go to', null, { kind: 'nav', to: '/search' }),
  e('schedules', 'Schedules', 'Go to', null, { kind: 'nav', to: '/schedules' }),
  e('memory', 'Memory', 'Go to', null, { kind: 'nav', to: '/memory' }),
  e('settings', 'Settings', 'Go to', null, { kind: 'nav', to: '/settings' }),
  e('shortcuts', 'Keyboard shortcuts', 'Go to', { code: 'Slash' }, { kind: 'nav', to: '/settings/shortcuts' }),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(thread),
  e(
    'threadPrev',
    'Previous thread',
    'Threads',
    { code: 'BracketLeft' },
    { kind: 'threadStep', by: -1 },
    {
      scope: 'mac-app',
      repeat: true,
      inField: false,
    },
  ),
  e(
    'threadNext',
    'Next thread',
    'Threads',
    { code: 'BracketRight' },
    { kind: 'threadStep', by: 1 },
    {
      scope: 'mac-app',
      repeat: true,
      inField: false,
    },
  ),
  e('newThread', 'New thread', 'Threads', null, { kind: 'ui', name: 'newThread' }),
  e('findInThread', 'Search this thread', 'Threads', { code: 'KeyF' }, { kind: 'ui', name: 'findInThread' }),
  e('sessionPanel', 'Session panel', 'Panels', { code: 'Period' }, { kind: 'ui', name: 'sessionPanel' }),
  e('sidebar', 'Fold or unfold the sidebar', 'Panels', { code: 'Backslash' }, { kind: 'ui', name: 'sidebar' }),
  e('call', 'Start a call', 'App', { code: 'KeyK', shift: true, metaOnly: true }, { kind: 'ui', name: 'call' }),
  e('close', 'Close', 'App', { code: 'Escape', mod: false }, { kind: 'ui', name: 'close' }, { repeat: true }),
]

/** The table with the owner's overrides laid over it: a chord replaces the default, `null` unbinds. Pure; unknown ids are ignored. */
export function resolveKeymap(defaults: readonly KeyEntry[], overrides?: Overrides): KeyEntry[] {
  if (!overrides) return [...defaults]
  return defaults.map((d) => (Object.hasOwn(overrides, d.id) ? { ...d, chord: overrides[d.id] ?? null } : d))
}

export function isActive(entry: KeyEntry, macApp: boolean): boolean {
  return entry.scope === 'web' || macApp
}

const KEY_NAMES: Record<string, string> = {
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  BracketLeft: '[',
  BracketRight: ']',
}

/** How a chord reads to a person: ⌘K on a Mac, Ctrl+K elsewhere. No chord reads as ''. */
export function chordLabel(chord: Chord | null, mac: boolean): string {
  if (!chord) return ''
  if (chord.mod === false) return chord.code === 'Escape' ? 'Esc' : chord.code
  const key =
    /^Key([A-Z])$/.exec(chord.code)?.[1] ?? /^Digit(\d)$/.exec(chord.code)?.[1] ?? KEY_NAMES[chord.code] ?? chord.code
  return mac ? `⌘${chord.shift ? '⇧' : ''}${key}` : `Ctrl+${chord.shift ? 'Shift+' : ''}${key}`
}

export const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')

/** A plain ASCII character: a layout that types Latin letters. Anything else (Cyrillic, Greek, a dead key) goes by the key's place. */
const ASCII_KEY = /^[\x21-\x7e]$/

/**
 * Does the key event type the chord's key? Letters and punctuation go by what the key TYPES (Dvorak's Cmd+V stays paste), the
 * digit row by its place (AZERTY types & on the 1 key), and a layout that does not type Latin falls back to the place.
 */
function keyMatches(ev: KeyboardEvent, code: string): boolean {
  if (/^Digit\d$/.test(code)) return ev.code === code
  const want = /^Key([A-Z])$/.exec(code)?.[1]?.toLowerCase() ?? KEY_NAMES[code]
  if (want && ASCII_KEY.test(ev.key)) return ev.key.toLowerCase() === want
  return ev.code === code
}

/** Does this key event press the chord? Alt is always another chord; Shift must match exactly. A Mac takes Cmd only, the rest Ctrl only. */
export function chordMatches(ev: KeyboardEvent, chord: Chord, mac: boolean): boolean {
  if (chord.code === 'Escape' && chord.mod === false) return ev.key === 'Escape' || ev.code === 'Escape'
  if (ev.altKey || ev.shiftKey !== Boolean(chord.shift) || !keyMatches(ev, chord.code)) return false
  if (chord.metaOnly) return ev.metaKey
  return mac ? ev.metaKey : ev.ctrlKey
}

export type Conflict = { chord: string; ids: string[] }

/** Entries that share one chord (Cmd-only or not makes no difference on a Mac). */
export function keymapConflicts(entries: readonly KeyEntry[]): Conflict[] {
  const groups = new Map<string, KeyEntry[]>()
  for (const e of entries) {
    if (!e.chord) continue
    const k = `${e.chord.code}|${e.chord.mod === false ? 'bare' : 'mod'}|${e.chord.shift ? 's' : ''}`
    groups.set(k, [...(groups.get(k) ?? []), e])
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({ chord: chordLabel(g[0]?.chord ?? null, true), ids: g.map((e) => e.id) }))
}

/** resolveKeymap, plus the chords that two entries now share. The override still applies; a later screen says what clashes. */
export function resolveKeymapChecked(
  defaults: readonly KeyEntry[],
  overrides?: Overrides,
): { keymap: KeyEntry[]; conflicts: Conflict[] } {
  const keymap = resolveKeymap(defaults, overrides)
  return { keymap, conflicts: keymapConflicts(keymap) }
}

/** The chord that opens thread number `n` (1 to 9), written for a person; '' past nine. */
export function threadChordLabel(n: number, mac: boolean): string {
  return chordLabel(DEFAULT_KEYMAP.find((x) => x.id === `thread${n}`)?.chord ?? null, mac)
}
