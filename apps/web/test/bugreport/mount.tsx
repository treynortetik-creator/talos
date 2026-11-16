// Opens the bug reporter on the thread `general` (seven messages) against the fake client, with a plain 100 x 60 picture. Not a
// test itself. Each test file mocks `exportPicture` itself (jsdom has no canvas).
import { act, screen } from '@testing-library/react'
import { vi } from 'vitest'
import { BugReporter } from '../../src/features/bugreport/BugReporter.tsx'
import { useBugReport } from '../../src/features/bugreport/store.ts'
import type { BugContext } from '../../src/lib/v2Client.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

export type Client = ReturnType<typeof setup>

export function mount(opts: { macOffline?: boolean } = {}, beforeOpen?: (client: Client) => void): Client {
  const client = setup(opts)
  client.store.setState((s) => ({
    ...s,
    messages: {
      ...s.messages,
      general: Array.from({ length: 7 }, (_, i) => ({
        id: `m_${String(i).padStart(26, '0')}`,
        thread_id: 'general',
        author: i % 2 ? 'agent' : 'owner',
        kind: 'text',
        text: `message ${i}`,
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: '2026-11-10T04:00:00.000Z',
      })) as never,
    },
  }))
  renderWith(<BugReporter />, client, '/t/general', '/t/:thread')
  beforeOpen?.(client)
  act(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 60
    useBugReport.setState({
      open: true,
      capture: { canvas, ok: true, skipped: 0 },
      takenAt: new Date(),
      returnTo: null,
    })
  })
  return client
}

export const dialog = () => screen.getByRole('dialog', { name: 'Report a bug' })

/** The Mac's answer to `context`, held until the test resolves or rejects it. */
export type Answer = { resolve: (c: BugContext) => void; reject: (e: Error) => void }
export const hold = (client: Client): Answer => {
  const answer: Answer = { resolve: () => undefined, reject: () => undefined }
  vi.spyOn(client.bugs, 'context').mockImplementation(
    () =>
      new Promise<BugContext>((resolve, reject) => {
        answer.resolve = resolve
        answer.reject = reject
      }),
  )
  return answer
}

export const DETAILS: BugContext = { bridgeVersion: '0.4.2', claudeCode: '2.1.312', recentErrors: ['boom'], logs: 'a' }
