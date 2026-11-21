// The bug reporter component against the fake client: the attached list and its checkboxes, the required field, what Send hands
// to the client, the Mac-away note, Cancel. The picture export is stubbed (jsdom has no canvas); capture and Blur are covered by
// ink.test.ts and the browser spec.

import { fakeClock } from '@talos-app/testkit'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/features/bugreport/capture.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/bugreport/capture.ts')>()),
  exportPicture: vi.fn(async () => ({
    blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
    type: 'image/png' as const,
  })),
}))

import { useBugReport } from '../../src/features/bugreport/store.ts'
import { bugTimers, MAC_WAIT_MS, realTimers } from '../../src/features/bugreport/useReporter.ts'
import { type Answer, DETAILS as details, dialog, hold, mount } from './mount.tsx'

afterEach(() => {
  act(() => useBugReport.getState().close())
  cleanup()
  bugTimers.current = realTimers
})

describe('the Goes to line says what the relay says', () => {
  const goesTo = () => within(dialog()).getByTestId('bug-goes-to').textContent
  it('nowhere else, when the relay passes nothing on', async () => {
    mount()
    await waitFor(() =>
      expect(goesTo()).toBe(
        'Goes to: your Talos server and your Mac, with the screenshot. It is not sent anywhere else.',
      ),
    )
  })
  it('the Talos team, when this relay was deployed with the team inbox', async () => {
    mount({}, (c) => vi.spyOn(c.bugs, 'destination').mockResolvedValue({ to: 'team' }))
    await waitFor(() =>
      expect(goesTo()).toBe('Goes to: your Talos server and your Mac, then the Talos team, with the screenshot.'),
    )
  })
  it('the webhook host, when the owner set an address', async () => {
    mount({}, (c) => vi.spyOn(c.bugs, 'destination').mockResolvedValue({ to: 'webhook', host: 'hooks.example.com' }))
    await waitFor(() =>
      expect(goesTo()).toBe(
        'Goes to: your Talos server and your Mac, then hooks.example.com (the words and details, not the screenshot).',
      ),
    )
  })
  it('only what is sure while the relay has not answered, or when it cannot (an older relay)', async () => {
    mount({}, (c) => vi.spyOn(c.bugs, 'destination').mockRejectedValue(new Error('404')))
    expect(goesTo()).toBe('Goes to: your Talos server and your Mac. Talos has not said whether it passes reports on.')
    await waitFor(() => expect(within(dialog()).getByText('Recent errors (2)')).toBeTruthy())
    expect(goesTo()).toBe('Goes to: your Talos server and your Mac. Talos has not said whether it passes reports on.')
  })
})

describe('BugReporter', () => {
  it('shows the tools, three inks, both fields, the attached list and the privacy lines', async () => {
    mount()
    const d = within(dialog())
    for (const t of ['Pen', 'Arrow', 'Box', 'Text', 'Blur', 'Undo'])
      expect(d.getByRole('button', { name: t })).toBeTruthy()
    expect(d.getAllByRole('radio').map((x) => x.getAttribute('aria-label'))).toEqual([
      'Amber ink',
      'Blue ink',
      'White ink',
    ])
    expect(d.getByLabelText('What went wrong?')).toBeTruthy()
    expect(d.getByLabelText('What did you expect? (optional)')).toBeTruthy()
    expect(d.getByText('Attached automatically')).toBeTruthy()
    expect(d.getByText(/Keys, sign-in codes and your home folder are removed/)).toBeTruthy()
    expect(
      await d.findByText('Goes to: your Talos server and your Mac, with the screenshot. It is not sent anywhere else.'),
    ).toBeTruthy()
    await waitFor(() => expect(d.getByText('Recent errors (2)')).toBeTruthy())
    // the four automatic parts are on, the last five messages are off
    const on = d.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).checked)
    expect(on).toEqual([true, true, true, true, false])
  })

  it('leaving a part out takes it out of what is sent and of the preview', async () => {
    const client = mount()
    const d = within(dialog())
    await waitFor(() => expect(d.getByText('Recent errors (2)')).toBeTruthy())
    fireEvent.click(d.getByRole('checkbox', { name: 'Recent errors (2)' }))
    fireEvent.click(d.getByRole('checkbox', { name: 'Logs, last 200 lines, cleaned' }))
    fireEvent.click(d.getByRole('checkbox', { name: 'This thread and screen' }))
    fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(d.getByRole('button', { name: 'Preview everything that will be sent' }))
    expect(d.getByTestId('bug-preview').textContent).not.toContain('thread_id')
    fireEvent.click(await d.findByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(client.bugReports).toHaveLength(1))
    const sent = client.bugReports[0]?.report
    expect(sent?.recent_errors).toEqual([])
    expect(sent?.logs).toBe('')
    expect(sent?.thread_id).toBeUndefined()
    expect(sent?.screen).toBeUndefined()
    expect(sent?.versions.bridge).toBe('0.4.2')
  })

  it('needs the words before it sends anything', async () => {
    const client = mount()
    const send = vi.spyOn(client.bugs, 'send')
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Send report' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Tell us what went wrong first.')
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the report with the Mac’s details and a picture; the thread messages stay out while that box is off', async () => {
    const client = mount()
    const d = within(dialog())
    await waitFor(() => expect(d.getByText('Recent errors (2)')).toBeTruthy())
    fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'It broke' } })
    fireEvent.click(await d.findByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(client.bugReports).toHaveLength(1))
    const sent = client.bugReports[0]
    expect(sent?.report.what_went_wrong).toBe('It broke')
    expect(sent?.report.versions.bridge).toBe('0.4.2')
    expect(sent?.report.versions.claude_code).toBe('2.1.312')
    expect(sent?.report.thread_id).toBe('general')
    expect(sent?.report.messages).toBeUndefined()
    expect(sent?.picture.type).toBe('image/png')
    await screen.findByText('Sent. Thank you.')
  })

  it('with that box ticked, the last 5 messages of this thread go along, and the preview shows them', async () => {
    const client = mount()
    const d = within(dialog())
    fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(d.getByRole('checkbox', { name: 'Last 5 messages in this thread' }))
    fireEvent.click(d.getByRole('button', { name: 'Preview everything that will be sent' }))
    const preview = d.getByTestId('bug-preview').textContent ?? ''
    expect(preview).toContain('message 6')
    expect(preview).toContain('message 2')
    expect(preview).not.toContain('message 1"')
    fireEvent.click(await d.findByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(client.bugReports).toHaveLength(1))
    expect(client.bugReports[0]?.report.messages).toHaveLength(5)
  })

  it('with the Mac away it says so, and the report can still be sent', async () => {
    const client = mount({ macOffline: true })
    const d = within(dialog())
    await waitFor(() => expect(d.getByText(/Not available from this Mac yet/)).toBeTruthy())
    fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(await d.findByRole('button', { name: 'Send report' }))
    await waitFor(() => expect(client.bugReports).toHaveLength(1))
    expect(client.bugReports[0]?.report.versions.bridge).toBe('unknown')
  })

  it('a refused send says so and keeps the form', async () => {
    const client = mount()
    vi.spyOn(client.bugs, 'send').mockRejectedValue(new Error('no'))
    const d = within(dialog())
    fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
    fireEvent.click(await d.findByRole('button', { name: 'Send report' }))
    expect((await screen.findByText(/Could not send the report/)).textContent).toBeTruthy()
    expect((d.getByLabelText('What went wrong?') as HTMLTextAreaElement).value).toBe('x')
  })

  describe('Send waits for the Mac’s details', () => {
    it('is disabled and says it is gathering details while the Mac has not answered', async () => {
      mount({}, hold)
      const d = within(dialog())
      const send = d.getByRole('button', { name: 'Gathering details…' }) as HTMLButtonElement
      expect(send.disabled).toBe(true)
      expect(d.queryByRole('button', { name: 'Send report' })).toBeNull()
      // still waiting is not "without Mac details": the preview does not say so yet
      fireEvent.click(d.getByRole('button', { name: 'Preview everything that will be sent' }))
      expect(d.getByTestId('bug-preview').textContent).not.toContain('Sent without Mac details')
    })

    it('is enabled once the Mac has answered', async () => {
      let answer: Answer = { resolve: () => undefined, reject: () => undefined }
      mount({}, (c) => {
        answer = hold(c)
      })
      await act(async () => answer.resolve(details))
      const send = (await within(dialog()).findByRole('button', { name: 'Send report' })) as HTMLButtonElement
      expect(send.disabled).toBe(false)
    })

    it('is enabled when the Mac fails to answer, and the report says it went without Mac details', async () => {
      let answer: Answer = { resolve: () => undefined, reject: () => undefined }
      const client = mount({}, (c) => {
        answer = hold(c)
      })
      await act(async () => answer.reject(new Error('away')))
      const d = within(dialog())
      fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
      fireEvent.click(await d.findByRole('button', { name: 'Send report' }))
      await waitFor(() => expect(client.bugReports).toHaveLength(1))
      expect(client.bugReports[0]?.report.logs).toBe('Sent without Mac details.')
      expect(client.bugReports[0]?.report.recent_errors).toEqual([])
    })

    it('is enabled after 10 seconds with no answer, and the report says it went without Mac details', async () => {
      const clock = fakeClock()
      bugTimers.current = clock
      const client = mount({}, hold)
      const d = within(dialog())
      act(() => clock.advance(MAC_WAIT_MS - 1))
      expect((d.getByRole('button', { name: 'Gathering details…' }) as HTMLButtonElement).disabled).toBe(true)
      act(() => clock.advance(1))
      expect(clock.pending).toBe(0)
      fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
      fireEvent.click(await d.findByRole('button', { name: 'Send report' }))
      await waitFor(() => expect(client.bugReports).toHaveLength(1))
      expect(client.bugReports[0]?.report.logs).toBe('Sent without Mac details.')
    })

    it('an answer that comes after the 10 seconds still replaces the note with the details', async () => {
      const clock = fakeClock()
      bugTimers.current = clock
      let answer: Answer = { resolve: () => undefined, reject: () => undefined }
      const client = mount({}, (c) => {
        answer = hold(c)
      })
      act(() => clock.advance(MAC_WAIT_MS))
      await act(async () => answer.resolve(details))
      const d = within(dialog())
      fireEvent.change(d.getByLabelText('What went wrong?'), { target: { value: 'x' } })
      fireEvent.click(await d.findByRole('button', { name: 'Send report' }))
      await waitFor(() => expect(client.bugReports).toHaveLength(1))
      expect(client.bugReports[0]?.report.logs).toBe('a')
      expect(client.bugReports[0]?.report.versions.bridge).toBe('0.4.2')
    })
  })

  it('Cancel closes it without sending', async () => {
    const client = mount()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(useBugReport.getState().open).toBe(false))
    expect(client.bugReports).toHaveLength(0)
  })
})

describe('pasting into the sheet', () => {
  afterEach(cleanup)
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })

  it('words copied from a document that also carry an image stay words: the picture is not replaced', async () => {
    mount()
    const before = useBugReport.getState().capture
    const field = within(dialog()).getByLabelText('What went wrong?')
    fireEvent.paste(field, {
      clipboardData: { types: ['text/plain', 'Files'], files: [image], getData: () => 'words' },
    })
    await act(async () => {})
    expect(useBugReport.getState().capture).toBe(before)
  })
})
