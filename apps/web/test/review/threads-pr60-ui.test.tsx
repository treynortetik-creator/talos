// PR #60 review (jsdom, fake client). REVIEW-FAIL tests are expected to fail on 677cf2b.
import type { ThreadT } from '@talos-app/protocol'
import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { AgentSettingsSection } from '../../src/features/agent-config/AgentSettingsSection.tsx'
import { reorderThreads } from '../../src/features/threads/manage/useThreadPatch.ts'
import { Sidebar } from '../../src/features/threads/Nav.tsx'
import { ThreadList } from '../../src/features/threads/ThreadList.tsx'
import { renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => localStorage.clear())

const mk = (id: string, order: number, kind: ThreadT['kind'] = 'fixed'): ThreadT => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  kind,
  order,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-30T00:00:00.000Z',
})

describe('PR60 review: hint copy names controls that exist', () => {
  it('Settings > Agent no longer points at a button by description: it links to Manage threads, which opens in that mode', () => {
    const client = setup()
    const s = renderWith(<AgentSettingsSection readOnly={false} />, client, '/settings')
    const link = screen.getByTestId('manage-threads-link') as HTMLAnchorElement
    expect(link.textContent).toBe('Manage threads')
    expect(link.getAttribute('href')).toBe('/threads?manage=1')
    expect(screen.queryByText(/Edit next to Threads|the ⋯ menu/)).toBeNull() // M19: a phone has no ⋯ menu
    s.unmount()
    renderWith(<ThreadList />, client, '/threads?manage=1')
    expect(screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed')).toBe('true')
    s.unmount()
    renderWith(<Sidebar />, client, '/')
    const sidebar = screen.getByLabelText('Sidebar')
    const names = within(sidebar)
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '')
    expect(names).toContain('Manage threads') // the desktop door to the same mode
  })
})

describe('PR60 review: the order the owner sets is the order the owner sees', () => {
  it('REVIEW-FAIL: reordering active threads does not silently move the inbox to the end', () => {
    const before = [mk('general', 0), mk('inbox', 1, 'system'), mk('work', 2)]
    const after = reorderThreads(before, ['work', 'general'])
    const inbox = after.find((t) => t.id === 'inbox')
    // the inbox was second; the owner only swapped work and general
    expect(inbox?.order).toBe(1)
  })

  it('REVIEW-FAIL: an agent thread dragged to the top shows at the top of the phone Threads list', () => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      threads: [mk('builds', 0, 'agent'), mk('general', 1), mk('inbox', 2, 'system')],
    }))
    renderWith(<ThreadList />, client, '/threads')
    const rows = screen.getAllByTestId(/^thread-row-/).map((r) => r.getAttribute('data-testid'))
    expect(rows[0]).toBe('thread-row-builds')
  })
})
