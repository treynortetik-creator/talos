// Ctrl/Cmd+1..9 open "thread N". The sidebar tells a screen reader each row's chord ("Ctrl+2") and numbers the rows it
// draws: the threads without the Inbox, which has its own row at the bottom. The keyboard (Shell) and the palette count in
// `useVisibleThreads()`, which still holds the Inbox at its config slot. The Inbox is the second thread of a new config
// and keeps its slot through every reorder, so each thread made after it is announced one number lower than the chord
// that really opens it: the row that says Ctrl+2 is opened by Ctrl+3, and Ctrl+2 opens the Inbox.
import type { ThreadT } from '@talos-app/protocol'
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type ActionCtx, runAction } from '../../src/features/palette/actions.ts'
import { buildItems } from '../../src/features/palette/items.ts'
import { Sidebar } from '../../src/features/threads/Nav.tsx'
import { useVisibleThreads } from '../../src/features/threads/useThreads.ts'
import { DEFAULT_KEYMAP } from '../../src/lib/keymap.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

const work: ThreadT = {
  id: 'work',
  name: 'Work',
  kind: 'fixed',
  order: 2, // where ThreadEditor puts a new thread: after everything, the Inbox included
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
}

let visible: ThreadT[] = []
function Probe() {
  visible = useVisibleThreads() // exactly what Shell hands the keyboard and the palette
  return null
}

describe('thread number chords', () => {
  it('the chord a sidebar row announces is the chord that opens that thread', async () => {
    const client = setup({ cards: [] })
    // the seed config is General (order 0), Inbox (order 1); the owner adds Work
    client.store.setState((s) => ({ ...s, threads: [...s.threads, work] }))
    renderWith(
      <>
        <Sidebar />
        <Probe />
      </>,
      client,
    )
    const row = await screen.findByRole('link', { name: /Work/ })
    const announced = /Ctrl\+(\d)/.exec(row.textContent ?? '')?.[1]
    expect(announced).toBe('2') // the second row of the list

    const nav = vi.fn()
    const ctx = { nav, threads: visible, currentThreadId: null, topCardId: null } as unknown as ActionCtx
    const entry = DEFAULT_KEYMAP.find((e) => e.id === `thread${announced}`)
    expect(entry).toBeTruthy()
    if (entry) runAction(entry.act, ctx)
    expect(nav).toHaveBeenCalledWith('/t/work')
  })

  it('the palette shows the same chord for a thread as the sidebar announces', async () => {
    const client = setup({ cards: [] })
    client.store.setState((s) => ({ ...s, threads: [...s.threads, work] }))
    renderWith(
      <>
        <Sidebar />
        <Probe />
      </>,
      client,
    )
    const row = await screen.findByRole('link', { name: /Work/ })
    const announced = /Ctrl\+\d/.exec(row.textContent ?? '')?.[0]
    const items = buildItems({
      mode: 'palette',
      query: '',
      keymap: DEFAULT_KEYMAP,
      macApp: false,
      mac: false,
      showKeys: true,
      threads: visible.map((t) => ({ id: t.id, name: t.name })),
      cards: [],
      currentThreadId: null,
      commands: [],
      hasSession: false,
      hasSidebar: true,
    })
    expect(items.find((i) => i.id === 'thread-work')?.shortcut).toBe(announced)
  })
})
