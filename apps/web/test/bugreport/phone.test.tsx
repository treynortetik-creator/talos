// The bug reporter's phone layout against the fake client: the tick boxes live in the Preview panel and change what is sent,
// Send in the header waits for the Mac's details (fake clock, no real waiting) and then goes with a note, the header keeps
// clear of the status bar, and the phone has no ink picker. jsdom has no media queries, so the phone width is stubbed.

import { fakeClock } from '@talos-app/testkit'
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/features/bugreport/capture.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/bugreport/capture.ts')>()),
  exportPicture: vi.fn(async () => ({
    blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    type: 'image/png' as const,
  })),
}))

import { useBugReport } from '../../src/features/bugreport/store.ts'
import { bugTimers, MAC_WAIT_MS, realTimers } from '../../src/features/bugreport/useReporter.ts'
import { PHONE_QUERY } from '../../src/features/phone/PhoneChrome.tsx'
import { type Answer, DETAILS, dialog, hold, mount } from './mount.tsx'

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === PHONE_QUERY,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
})

afterEach(() => {
  act(() => useBugReport.getState().close())
  cleanup()
  vi.unstubAllGlobals()
  bugTimers.current = realTimers
})

const send = () => within(dialog()).getByRole('button', { name: 'Send' }) as HTMLButtonElement

describe('BugReporter on a phone', () => {
  it("says where the report goes, in the relay's words", async () => {
    mount({}, (c) => vi.spyOn(c.bugs, 'destination').mockResolvedValue({ to: 'team' }))
    await waitFor(() =>
      expect(within(dialog()).getByTestId('bug-goes-to').textContent).toBe(
        'Goes to: your Talos server and your Mac, then the Talos team, with the screenshot.',
      ),
    )
  })

  it('has Cancel, the title and Send in the header, the tools without an ink picker, and no expected field', async () => {
    mount()
    const d = within(dialog())
    const header = d.getByTestId('bug-phone-header')
    expect(within(header).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(within(header).getByText('Report a bug')).toBeTruthy()
    await waitFor(() => expect(within(header).getByRole('button', { name: 'Send' })).toBeTruthy())
    for (const t of ['Pen', 'Arrow', 'Box', 'Text', 'Blur', 'Undo'])
      expect(d.getByRole('button', { name: t })).toBeTruthy()
    expect(d.queryByRole('radiogroup')).toBeNull()
    expect(d.queryByLabelText('What did you expect? (optional)')).toBeNull()
    expect(d.getByText('Versions, recent errors, cleaned logs')).toBeTruthy()
    expect(d.getByText('Keys and sign-in codes are removed. Nothing is sent until you tap Send.')).toBeTruthy()
  })

  it('the header leaves room for the status bar', () => {
    mount()
    expect(within(dialog()).getByTestId('bug-phone-header').className).toContain('env(safe-area-inset-top)')
  })

  it('the tick boxes are in the Preview panel: closed, none show; open, all five, the messages off', async () => {
    mount()
    const d = within(dialog())
    expect(d.queryAllByRole('checkbox')).toHaveLength(0)
    const preview = d.getByRole('button', { name: 'Preview' })
    expect(preview.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(preview)
    expect(preview.getAttribute('aria-expanded')).toBe('true')
    expect(d.getByRole('heading', { name: 'Attached automatically' })).toBeTruthy()
    expect(d.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ])
    expect(d.getByTestId('bug-preview')).toBeTruthy()
  })

  it('unticking a part in the Preview panel takes it out of the preview and of what is sent', async () => {
    const client = mount()
    const d = within(dialog())
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.click(d.getByRole('button', { name: 'Preview' }))
    fireEvent.click(d.getByRole('checkbox', { name: 'Recent errors (2)' }))
    fireEvent.click(d.getByRole('checkbox', { name: 'Logs, last 200 lines, cleaned' }))
    fireEvent.click(d.getByRole('checkbox', { name: 'Versions: app, bridge, relay, Claude Code' }))
    expect(d.getByTestId('bug-preview').textContent).not.toContain('0.4.2')
    fireEvent.click(d.getByRole('checkbox', { name: 'Last 5 messages in this thread' }))
    fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'Two messages stuck' } })
    fireEvent.click(send())
    await waitFor(() => expect(client.bugReports).toHaveLength(1))
    const sent = client.bugReports[0]?.report
    expect(sent?.what_went_wrong).toBe('Two messages stuck')
    expect(sent?.recent_errors).toEqual([])
    expect(sent?.logs).toBe('')
    expect(sent?.versions.bridge).toBe('unknown')
    expect(sent?.thread_id).toBe('general')
    expect(sent?.messages).toHaveLength(5)
    await d.findByText('Sent. Thank you.')
    expect(d.getByRole('button', { name: 'Done' })).toBeTruthy()
  })

  it('left alone, every automatic part goes and the messages stay out', async () => {
    const client = mount()
    const d = within(dialog())
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(send())
    await waitFor(() => expect(client.bugReports).toHaveLength(1))
    const sent = client.bugReports[0]?.report
    expect(sent?.recent_errors).toHaveLength(2)
    expect(sent?.versions.bridge).toBe('0.4.2')
    expect(sent?.messages).toBeUndefined()
  })

  describe('Send waits for the Mac’s details', () => {
    const gathering = () => within(dialog()).getByRole('button', { name: 'Gathering details…' }) as HTMLButtonElement

    it('says it is gathering details, disabled, until the Mac answers; then it is Send', async () => {
      let answer: Answer = { resolve: () => undefined, reject: () => undefined }
      mount({}, (c) => {
        answer = hold(c)
      })
      expect(gathering().disabled).toBe(true)
      expect(within(dialog()).queryByText('Not available from this Mac yet')).toBeNull()
      await act(async () => answer.resolve(DETAILS))
      expect(send().disabled).toBe(false)
    })

    it('after 10 seconds with no answer it enables, says the details are not there, and sends with the note', async () => {
      const clock = fakeClock()
      bugTimers.current = clock
      const client = mount({}, hold)
      const d = within(dialog())
      act(() => clock.advance(MAC_WAIT_MS - 1))
      expect(gathering().disabled).toBe(true)
      act(() => clock.advance(1))
      expect(send().disabled).toBe(false)
      expect(d.getByText('Not available from this Mac yet')).toBeTruthy()
      fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
      fireEvent.click(send())
      await waitFor(() => expect(client.bugReports).toHaveLength(1))
      expect(client.bugReports[0]?.report.logs).toBe('Sent without Mac details.')
    })

    it('when the Mac fails to answer it enables at once and sends with the note', async () => {
      let answer: Answer = { resolve: () => undefined, reject: () => undefined }
      const client = mount({}, (c) => {
        answer = hold(c)
      })
      await act(async () => answer.reject(new Error('away')))
      const d = within(dialog())
      expect(d.getByText('Not available from this Mac yet')).toBeTruthy()
      fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
      fireEvent.click(send())
      await waitFor(() => expect(client.bugReports).toHaveLength(1))
      expect(client.bugReports[0]?.report.logs).toBe('Sent without Mac details.')
      expect(client.bugReports[0]?.report.versions.bridge).toBe('unknown')
    })
  })

  it('Send without the words says so and sends nothing', async () => {
    const client = mount()
    const spy = vi.spyOn(client.bugs, 'send')
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.click(send())
    expect((await within(dialog()).findByRole('alert')).textContent).toContain('Tell us what went wrong first.')
    expect(spy).not.toHaveBeenCalled()
  })

  it('a refused send says so and keeps the words', async () => {
    const client = mount()
    vi.spyOn(client.bugs, 'send').mockRejectedValue(new Error('no'))
    const d = within(dialog())
    await waitFor(() => expect(send().disabled).toBe(false))
    fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(send())
    await d.findByText(/Could not send the report/)
    expect((d.getByLabelText('What went wrong?') as HTMLTextAreaElement).value).toBe('x')
  })
})
