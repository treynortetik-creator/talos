// Settings → Agent: Restart agent only. Restoring the last good setup is done at the computer, and the screen says where.
import { AgentRecoverFrame, RECOVER_SENT_TEXT } from '@talos-app/protocol'
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSettingsSection } from '../../src/features/agent-config/AgentSettingsSection.tsx'
import { resetAgentDraft } from '../../src/features/agent-config/draftStore.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => resetAgentDraft())
afterEach(cleanup)

const recoverFrames = (c: ReturnType<typeof setup>) => c.sent.filter((f) => f.type === 'agent.recover')

describe('recover buttons', () => {
  it('Restart agent sends one signed frame and shows the Mac’s answer; there is no restore button, only the line pointing to the Mac menu', async () => {
    const c = setup()
    renderWith(<AgentSettingsSection readOnly={false} />, c)
    await userEvent.click(await screen.findByRole('button', { name: 'Restart agent' }))
    expect(await screen.findByText(RECOVER_SENT_TEXT)).toBeTruthy()
    const [f] = recoverFrames(c)
    expect(AgentRecoverFrame.safeParse(f).success).toBe(true)
    expect(f).toMatchObject({ action: 'restart' })
    expect(f?.stepup_token).toBeUndefined()
    expect(screen.queryByRole('button', { name: /restore/i })).toBeNull()
    expect(screen.getByTestId('agent-recover-restore-note').textContent).toBe(
      'To put back the last good setup, use the Talos menu on your Mac: Restore last good setup.',
    )
    expect(recoverFrames(c)).toHaveLength(1)
  })

  it('on a Windows PC the line points to the tray: the Talos icon by the clock, Restore last good setup', async () => {
    const c = setup()
    c.store.setState((s) => ({ presence: { ...s.presence, features: ['host/windows'] } }))
    renderWith(<AgentSettingsSection readOnly={false} />, c)
    expect((await screen.findByTestId('agent-recover-restore-note')).textContent).toBe(
      'To put back the last good setup, use the Talos icon by the clock on your PC: Restore last good setup.',
    )
  })

  it('with no known host the line is the generic one', async () => {
    const c = setup()
    c.store.setState((s) => ({ presence: { ...s.presence, features: [] } }))
    renderWith(<AgentSettingsSection readOnly={false} />, c)
    expect((await screen.findByTestId('agent-recover-restore-note')).textContent).toBe(
      'To put back the last good setup, do it on your computer, not from here.',
    )
  })

  it('a failed answer is shown as an alert', async () => {
    const c = setup()
    c.failNextRecoverWith('There is no saved setup to put back.')
    renderWith(<AgentSettingsSection readOnly={false} />, c)
    await userEvent.click(await screen.findByRole('button', { name: 'Restart agent' }))
    expect((await screen.findByRole('alert')).textContent).toContain('no saved setup')
  })

  it('with the Mac offline the button is still there, the screen says recovery needs the Mac app, and nothing is sent', async () => {
    const c = setup()
    c.setMacOnline(false) // the row reads the Mac's presence itself (settings/offline.ts), as the screen does
    renderWith(<AgentSettingsSection readOnly={true} />, c)
    const restart = await screen.findByRole('button', { name: 'Restart agent' })
    expect((restart as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('agent-recover-offline').textContent).toContain('Recovery needs the Mac app running')
    await userEvent.click(restart)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Recovery needs the Mac app running'))
    expect(recoverFrames(c)).toHaveLength(0)
  })

  const setStatus = (
    c: ReturnType<typeof setup>,
    state: 'working' | 'idle' | 'needs_you',
    since = new Date().toISOString(),
  ) => c.store.setState((s) => ({ statuses: { ...s.statuses, general: { thread_id: 'general', state, since } } }))

  it('mid-task it says plainly that the agent is working and offers Restart now or Cancel; nothing is sent first', async () => {
    const c = setup()
    setStatus(c, 'working')
    renderWith(<AgentSettingsSection readOnly={false} />, c)
    await userEvent.click(await screen.findByRole('button', { name: 'Restart agent' }))
    expect((await screen.findByRole('status')).textContent).toContain('The agent is working on a task.')
    expect(recoverFrames(c)).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull()
    expect(recoverFrames(c)).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Restart agent' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Restart now' }))
    await waitFor(() => expect(recoverFrames(c)).toHaveLength(1))
  })

  it('idle, or waiting on the owner, restarts at once with nothing asked', async () => {
    for (const state of ['idle', 'needs_you'] as const) {
      const c = setup()
      setStatus(c, state)
      renderWith(<AgentSettingsSection readOnly={false} />, c)
      await userEvent.click(await screen.findByRole('button', { name: 'Restart agent' }))
      await waitFor(() => expect(recoverFrames(c)).toHaveLength(1))
      expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull()
      cleanup()
    }
  })

  it('an old working row is still working: the Mac said so, and the app does not guess it away', async () => {
    const c = setup()
    setStatus(c, 'working', new Date(Date.now() - 7 * 3_600_000).toISOString())
    renderWith(<AgentSettingsSection readOnly={false} />, c)
    await userEvent.click(await screen.findByRole('button', { name: 'Restart agent' }))
    expect(await screen.findByRole('button', { name: 'Restart now' })).toBeTruthy()
    expect(recoverFrames(c)).toHaveLength(0)
  })
})
