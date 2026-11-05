// Settings → Agent: Restart agent only. Restoring the last good setup is done at the Mac, and the screen says so.
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

  it('a failed answer is shown as an alert', async () => {
    const c = setup()
    c.failNextRecoverWith('There is no saved setup to put back.')
    renderWith(<AgentSettingsSection readOnly={false} />, c)
    await userEvent.click(await screen.findByRole('button', { name: 'Restart agent' }))
    expect((await screen.findByRole('alert')).textContent).toContain('no saved setup')
  })

  it('with the Mac offline the button is still there, the screen says recovery needs the Mac app, and nothing is sent', async () => {
    const c = setup()
    renderWith(<AgentSettingsSection readOnly={true} />, c)
    const restart = await screen.findByRole('button', { name: 'Restart agent' })
    expect((restart as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('agent-recover-offline').textContent).toContain('Recovery needs the Mac app running')
    await userEvent.click(restart)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Recovery needs the Mac app running'))
    expect(recoverFrames(c)).toHaveLength(0)
  })
})
