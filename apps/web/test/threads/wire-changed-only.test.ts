// @vitest-environment node
// Audit O4: a thread patch carries only what the owner changed. The app reads a value it does not understand as a
// fallback (`idle_park_min` past this build's range reads as the default, a `session_opts` it cannot read as
// `{ mcp_allow: [] }`); echoing that back on a rename or reorder overwrote the Mac's real setting, because the Mac's merge
// (resolveThreadsPatch) only keeps keys the app leaves out.
import { resolveThreadsPatch, Thread, type ThreadT } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { reorderThreads, wireThreads } from '../../src/features/threads/manage/useThreadPatch.ts'

const at = '2026-11-01T10:00:00.000Z'
// what a newer Mac stores and sends
const macThreads = [
  {
    id: 'inbox',
    name: 'Inbox',
    kind: 'system',
    order: 0,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: at,
  },
  {
    id: 'work',
    name: 'Work',
    kind: 'fixed',
    order: 1,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: at,
    session: 'dedicated',
    session_opts: { mcp_allow: ['github'], idle_park_min: 1000 }, // a range this build does not allow
  },
  {
    id: 'home',
    name: 'Home',
    kind: 'fixed',
    order: 2,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: at,
    session: 'dedicated',
    session_opts: { mcp_allow: { newer: 'shape' } }, // unreadable here: the app sees { mcp_allow: [] }
  },
]
// what this (older) app holds after reading them
const appThreads: ThreadT[] = macThreads.map((t) => Thread.parse(t))
const macView = (wire: unknown) => resolveThreadsPatch(macThreads, wire) as Array<Record<string, unknown>>

describe('a thread patch carries only what the owner changed', () => {
  it('the app did read fallbacks (the precondition)', () => {
    expect(appThreads[1]?.session_opts?.idle_park_min).not.toBe(1000)
    expect(appThreads[2]?.session_opts?.mcp_allow).toEqual([])
  })

  it('renaming one thread leaves every setting the app could not read as the Mac had it', () => {
    const renamed = appThreads.map((t) => (t.id === 'inbox' ? { ...t, name: 'Mail' } : t))
    const wire = wireThreads(renamed, true, { base: appThreads })
    const after = macView(wire)
    expect(after.find((t) => t.id === 'work')?.session_opts).toEqual({ mcp_allow: ['github'], idle_park_min: 1000 })
    expect(after.find((t) => t.id === 'home')?.session_opts).toEqual({ mcp_allow: { newer: 'shape' } })
    expect(after.find((t) => t.id === 'inbox')?.name).toBe('Mail')
    // an untouched thread is sent as its id and its place, nothing else
    expect(wire.find((t) => t.id === 'home')).toEqual({ id: 'home', order: 2 })
  })

  it('a reorder sends the new places and nothing else', () => {
    const wire = wireThreads(reorderThreads(appThreads, ['home', 'work']), true, { base: appThreads })
    expect(wire.map((t) => Object.keys(t).sort())).toEqual([
      ['id', 'order'],
      ['id', 'order'],
      ['id', 'order'],
    ])
    const after = macView(wire)
    expect(after.map((t) => t.id)).toEqual(['inbox', 'home', 'work'])
    expect(after.find((t) => t.id === 'work')?.session_opts).toEqual({ mcp_allow: ['github'], idle_park_min: 1000 })
  })

  it('a changed session setting goes alone; the rest of session_opts stays the Mac’s', () => {
    const edited = appThreads.map((t) =>
      t.id === 'work' ? { ...t, session_opts: { ...t.session_opts, mcp_allow: ['github', 'linear'] } } : t,
    ) as ThreadT[]
    const wire = wireThreads(edited, true, { base: appThreads })
    expect(wire.find((t) => t.id === 'work')).toEqual({
      id: 'work',
      order: 1,
      session_opts: { mcp_allow: ['github', 'linear'] },
    })
    expect(macView(wire).find((t) => t.id === 'work')?.session_opts).toEqual({
      mcp_allow: ['github', 'linear'],
      idle_park_min: 1000,
    })
  })

  it('a new thread goes whole; a cleared colour is said as null to a threads/2 Mac only', () => {
    const fresh = { ...appThreads[1], id: 'new', name: 'New', order: 3, session: undefined, session_opts: undefined }
    const coloured = appThreads.map((t) => (t.id === 'home' ? { ...t, color: 'red' } : t)) as ThreadT[]
    const base = coloured
    const cleared = coloured.map((t) => (t.id === 'home' ? { ...t, color: undefined } : t)) as ThreadT[]
    const wire = wireThreads([...cleared, fresh as ThreadT], true, { base })
    expect(wire.find((t) => t.id === 'new')).toMatchObject({ id: 'new', name: 'New', kind: 'fixed', created_at: at })
    expect(wire.find((t) => t.id === 'home')).toEqual({ id: 'home', order: 2, color: null })
    expect(wireThreads(cleared, false, { base }).find((t) => t.id === 'home')).toEqual({ id: 'home', order: 2 })
  })
})
