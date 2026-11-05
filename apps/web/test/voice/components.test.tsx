import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallController } from '../../src/features/voice/callController.ts'
import {
  CallBar,
  getCallController,
  HandoffChip,
  LiveCallButton,
  setCallController,
  VOICE_CHOICES,
  VoiceSettingsSection,
} from '../../src/features/voice/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { fakeDeps } from './fakes.ts'

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  setCallController(null)
  localStorage.clear()
})

describe('LiveCallButton', () => {
  it('starts a call on tap and is disabled while one is running or when told to be', async () => {
    const f = fakeDeps()
    const c = new CallController(f.deps)
    setCallController(c)
    const { rerender } = render(
      <ClientProvider client={createFakeClient()}>
        <LiveCallButton threadId="general" />
      </ClientProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Start a live call' }))
    await waitFor(() => expect(c.store.getState().phase).toBe('connecting'))
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Start a live call' }) as HTMLButtonElement).disabled).toBe(true),
    )
    await c.end()
    rerender(
      <ClientProvider client={createFakeClient()}>
        <LiveCallButton threadId="general" disabled />
      </ClientProvider>,
    )
    expect((screen.getByRole('button', { name: 'Start a live call' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps the reason out of the button (it is shown by the composer line)', async () => {
    const f = fakeDeps({
      fetchResponses: [Response.json({ message: "Today's live-voice limit is used up." }, { status: 429 })],
    })
    setCallController(new CallController(f.deps))
    render(
      <ClientProvider client={createFakeClient()}>
        <LiveCallButton threadId="general" />
      </ClientProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Start a live call' }))
    // The reason is the controller's to hold; the composer shows it in its own line (see call-error-line.test.tsx),
    // never as a bubble floating over the thread from the button.
    await waitFor(() => expect(getCallController().store.getState().error).toBe("Today's live-voice limit is used up."))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('CallBar', () => {
  it('has Mute, End and a labelled control group; End hangs up and calls onEnd', async () => {
    const f = fakeDeps()
    const c = new CallController(f.deps)
    setCallController(c)
    const client = createFakeClient()
    const started = c.start(client, 'general')
    await new Promise((r) => setTimeout(r, 10))
    f.peer.dc.emit({ type: 'session.started' })
    await started
    let ended = 0
    render(
      <ClientProvider client={client}>
        <CallBar threadId="general" onEnd={() => ended++} />
      </ClientProvider>,
    )
    expect(screen.getByRole('toolbar', { name: 'Call controls' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Mute' }))
    expect(f.track.enabled).toBe(false)
    expect(screen.getByRole('button', { name: 'Unmute' }).getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'End call' }))
    await waitFor(() => expect(ended).toBe(1))
  })

  it('captions are announced politely', async () => {
    const f = fakeDeps()
    const c = new CallController(f.deps)
    setCallController(c)
    const client = createFakeClient()
    const started = c.start(client, 'general')
    await new Promise((r) => setTimeout(r, 10))
    f.peer.dc.emit({ type: 'session.started' })
    await started
    render(
      <ClientProvider client={client}>
        <CallBar threadId="general" onEnd={() => {}} />
      </ClientProvider>,
    )
    f.peer.dc.emit({ type: 'session.input_transcript.delta', delta: 'Remind me at five' })
    const line = await screen.findByText('Remind me at five')
    expect(line.closest('[aria-live="polite"]')).toBeTruthy()
    await c.end()
  })
})

describe('HandoffChip', () => {
  it('names the agent and the exact question, in each state', () => {
    const base = { delegationId: 'd', question: 'Book a table for two' }
    const { rerender, container } = render(<HandoffChip handoff={{ ...base, state: 'working' }} agentName="Talos" />)
    expect(container.textContent).toBe('Handed to Talos: Book a table for two · working')
    rerender(<HandoffChip handoff={{ ...base, state: 'done', answer: 'Booked for 7pm' }} agentName="Talos" />)
    expect(container.textContent).toBe('Talos answered: Booked for 7pm')
    rerender(<HandoffChip handoff={{ ...base, state: 'failed' }} agentName="Talos" />)
    expect(container.textContent).toBe("Couldn't hand to Talos: Book a table for two")
  })
})

describe('VoiceSettingsSection', () => {
  it('shows the configured voice and patches only agent.voice', async () => {
    const client = createFakeClient()
    render(
      <ClientProvider client={client}>
        <VoiceSettingsSection readOnly={false} />
      </ClientProvider>,
    )
    const select = screen.getByLabelText('Live-call voice') as HTMLSelectElement
    expect(select.value).toBe('meridian')
    expect(VOICE_CHOICES[0]).toBe('meridian')
    await userEvent.selectOptions(select, 'marin')
    await waitFor(() => expect(client.store.getState().config?.agent.voice).toBe('marin'))
    expect((await screen.findByRole('status')).textContent).toMatch(/next call/)
  })

  it('is read-only while the Mac is offline', () => {
    render(
      <ClientProvider client={createFakeClient({ macOffline: true })}>
        <VoiceSettingsSection readOnly />
      </ClientProvider>,
    )
    expect((screen.getByLabelText('Live-call voice') as HTMLSelectElement).disabled).toBe(true)
  })

  it('remembers hands-free versus hold-to-talk on this device', async () => {
    render(
      <ClientProvider client={createFakeClient()}>
        <VoiceSettingsSection readOnly={false} />
      </ClientProvider>,
    )
    expect((screen.getByLabelText(/Hands-free/) as HTMLInputElement).checked).toBe(true)
    await userEvent.click(screen.getByLabelText(/Hold to talk/))
    expect(localStorage.getItem('talos.voice.mode')).toBe('hold')
  })

  it('reports a failed change', async () => {
    const client = createFakeClient()
    client.failNextPatchWith('config_conflict')
    render(
      <ClientProvider client={client}>
        <VoiceSettingsSection readOnly={false} />
      </ClientProvider>,
    )
    await userEvent.selectOptions(screen.getByLabelText('Live-call voice'), 'cedar')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn't change the voice/)
  })
})
