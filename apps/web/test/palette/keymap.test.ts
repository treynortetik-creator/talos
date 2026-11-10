// The one keymap table: shipped defaults, a pure resolver that lets the owner's overrides sit beside them, and no chord
// literals anywhere else in the app.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chordLabel,
  DEFAULT_KEYMAP,
  isActive,
  type KeyEntry,
  resolveKeymap,
  resolveKeymapChecked,
} from '../../src/lib/keymap.ts'

const byId = (id: string) => DEFAULT_KEYMAP.find((e) => e.id === id)

describe('the default table', () => {
  it('has every chord the owner asked for', () => {
    const want: Record<string, string> = {
      palette: 'KeyK',
      thread1: 'Digit1',
      thread9: 'Digit9',
      threadPrev: 'BracketLeft',
      threadNext: 'BracketRight',
      findInThread: 'KeyF',
      sessionPanel: 'Period',
      needsYou: 'KeyJ',
      shortcuts: 'Slash',
      sidebar: 'Backslash',
      call: 'KeyK',
      close: 'Escape',
    }
    for (const [id, code] of Object.entries(want)) expect(byId(id)?.chord?.code, id).toBe(code)
  })
  it('gives New thread no chord (Cmd+N is the browser’s, and the Mac app’s Quick compose)', () => {
    expect(byId('newThread')?.chord).toBeNull()
  })
  it('keeps Cmd+[ and Cmd+] for the Mac app only', () => {
    expect(byId('threadPrev')?.scope).toBe('mac-app')
    expect(byId('threadNext')?.scope).toBe('mac-app')
    expect(isActive(byId('threadPrev') as KeyEntry, false)).toBe(false)
    expect(isActive(byId('threadPrev') as KeyEntry, true)).toBe(true)
    expect(isActive(byId('palette') as KeyEntry, false)).toBe(true)
  })
  it('has unique ids, a label on every entry, and no two entries on one chord', () => {
    const ids = DEFAULT_KEYMAP.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of DEFAULT_KEYMAP) expect(e.label.trim(), e.id).not.toBe('')
    const seen = new Map<string, string>()
    for (const e of DEFAULT_KEYMAP) {
      if (!e.chord) continue
      const k = `${e.chord.code}|${e.chord.mod === false ? 'bare' : 'mod'}|${e.chord.shift ? 's' : ''}`
      expect(seen.get(k), `${e.id} shares a chord with ${seen.get(k)}`).toBeUndefined()
      seen.set(k, e.id)
    }
  })
  it('has no bare letter, arrow or Enter chord: only Esc may act without Cmd/Ctrl', () => {
    for (const e of DEFAULT_KEYMAP) if (e.chord?.mod === false) expect(e.chord.code, e.id).toBe('Escape')
  })
})

describe('resolveKeymap', () => {
  it('returns the defaults untouched when there are no overrides (a reset restores them)', () => {
    expect(resolveKeymap(DEFAULT_KEYMAP, undefined)).toEqual(DEFAULT_KEYMAP)
    expect(resolveKeymap(DEFAULT_KEYMAP, {})).toEqual(DEFAULT_KEYMAP)
  })
  it('lets an override win, and never mutates the defaults', () => {
    const before = JSON.stringify(DEFAULT_KEYMAP)
    const out = resolveKeymap(DEFAULT_KEYMAP, { palette: { code: 'KeyP' } })
    expect(out.find((e) => e.id === 'palette')?.chord?.code).toBe('KeyP')
    expect(out.find((e) => e.id === 'needsYou')?.chord?.code).toBe('KeyJ')
    expect(JSON.stringify(DEFAULT_KEYMAP)).toBe(before)
  })
  it('lets null unbind a chord, and ignores an id the table does not have', () => {
    const out = resolveKeymap(DEFAULT_KEYMAP, { sidebar: null, nope: { code: 'KeyZ' } })
    expect(out.find((e) => e.id === 'sidebar')?.chord).toBeNull()
    expect(out.some((e) => e.id === 'nope')).toBe(false)
    expect(out).toHaveLength(DEFAULT_KEYMAP.length)
  })
  it('keeps the owner’s override when an update ships a changed default or a new entry', () => {
    const overrides = { palette: { code: 'KeyP' } }
    const shipped: KeyEntry[] = [
      ...DEFAULT_KEYMAP.map((e) => (e.id === 'palette' ? { ...e, chord: { code: 'KeyO' } } : e)),
      { ...(byId('sidebar') as KeyEntry), id: 'brandNew', chord: { code: 'KeyY' } },
    ]
    const out = resolveKeymap(shipped, overrides)
    expect(out.find((e) => e.id === 'palette')?.chord?.code).toBe('KeyP')
    expect(out.find((e) => e.id === 'brandNew')?.chord?.code).toBe('KeyY')
  })
})

describe('two entries on one chord', () => {
  it('the defaults have none', () => {
    expect(resolveKeymapChecked(DEFAULT_KEYMAP, {}).conflicts).toEqual([])
  })
  it('an override onto a taken chord is reported with both ids, and the override still applies', () => {
    const out = resolveKeymapChecked(DEFAULT_KEYMAP, { sidebar: { code: 'KeyK' } })
    expect(out.conflicts).toEqual([{ chord: '\u2318K', ids: ['palette', 'sidebar'] }])
    expect(out.keymap.find((e) => e.id === 'sidebar')?.chord?.code).toBe('KeyK')
  })
  it('the same key with Shift is another chord, and an unbound entry never conflicts', () => {
    expect(resolveKeymapChecked(DEFAULT_KEYMAP, { sidebar: { code: 'KeyJ', shift: true } }).conflicts).toEqual([])
    expect(resolveKeymapChecked(DEFAULT_KEYMAP, { palette: null, needsYou: null }).conflicts).toEqual([])
  })
  it('three on one chord is one conflict naming all three', () => {
    const out = resolveKeymapChecked(DEFAULT_KEYMAP, { sidebar: { code: 'KeyK' }, shortcuts: { code: 'KeyK' } })
    expect(out.conflicts).toHaveLength(1)
    expect(out.conflicts[0]?.ids).toEqual(['palette', 'shortcuts', 'sidebar'])
  })
})

describe('chordLabel', () => {
  it('writes the Mac glyphs on a Mac and Ctrl+ elsewhere', () => {
    expect(chordLabel(byId('palette')?.chord ?? null, true)).toBe('⌘K')
    expect(chordLabel(byId('palette')?.chord ?? null, false)).toBe('Ctrl+K')
    expect(chordLabel(byId('thread3')?.chord ?? null, true)).toBe('⌘3')
    expect(chordLabel(byId('call')?.chord ?? null, true)).toBe('⌘⇧K')
    expect(chordLabel(byId('close')?.chord ?? null, true)).toBe('Esc')
    expect(chordLabel(byId('newThread')?.chord ?? null, true)).toBe('')
  })
})

describe('no chord literals outside the table', () => {
  const SRC = join(__dirname, '../../src')
  const files: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.tsx?$/.test(n)) files.push(p)
    }
  }
  walk(SRC)
  it('useKeyboard.ts and the palette read only from keymap.ts', () => {
    const offenders = files.filter(
      (f) =>
        !f.endsWith('lib/keymap.ts') &&
        /['"](Digit[1-9]|KeyK|KeyJ|Backslash|BracketLeft|BracketRight)['"]|\bDigit\$\{/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
