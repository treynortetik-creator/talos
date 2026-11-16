// First run (src/features/agent-config/firstRun.ts): after the bridge says a pin was the agent's `first`, the app opens the
// Setup thread and sends the kickoff once, and its card skips with one tap. Once per agent: any Setup thread means no.
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirstRunCard, FirstRunGate } from '../../src/features/agent-config/FirstRun.tsx'
import { markFirstRun, resetFirstRun, runFirstRun, useFirstRun } from '../../src/features/agent-config/firstRun.ts'
import { SETUP_KICKOFF, SETUP_SKIP, SETUP_THREAD_ID, startSetup } from '../../src/features/agent-config/setupThread.ts'
import { firstPinned } from '../../src/lib/firstPin.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => resetFirstRun())
afterEach(cleanup)

const texts = (c: ReturnType<typeof setup>, text: string) =>
  c.sent.filter((f) => f.type === 'message' && (f as { text?: string }).text === text)
const setupThread = (c: ReturnType<typeof setup>) => c.store.getState().threads.find((t) => t.id === SETUP_THREAD_ID)

describe('first run', () => {
  it('pending and ready: the gate opens the Setup thread and sends the kickoff once', async () => {
    const c = setup()
    markFirstRun()
    renderWith(<FirstRunGate />, c)
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/t/${SETUP_THREAD_ID}`))
    expect(texts(c, SETUP_KICKOFF)).toHaveLength(1)
    expect(useFirstRun.getState()).toEqual({ stage: null, card: true })
  })

  it('not pending (no `first` from the bridge): nothing happens', async () => {
    const c = setup()
    renderWith(<FirstRunGate />, c)
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    expect(screen.getByTestId('location').textContent).toBe('/')
    expect(setupThread(c)).toBeUndefined()
    expect(texts(c, SETUP_KICKOFF)).toHaveLength(0)
  })

  it('waits until the app is ready (pinned, online, config in), then runs', async () => {
    const c = setup()
    c.store.setState({ devicePinned: false })
    markFirstRun()
    renderWith(<FirstRunGate />, c)
    await act(async () => new Promise((r) => setTimeout(r, 50)))
    expect(texts(c, SETUP_KICKOFF)).toHaveLength(0)
    act(() => c.store.setState({ devicePinned: true }))
    await waitFor(() => expect(texts(c, SETUP_KICKOFF)).toHaveLength(1))
  })

  it('a Setup thread already there (another phone, or an earlier Skip): no kickoff, and pending is spent', async () => {
    const c = setup()
    await startSetup(c)
    c.sent.length = 0
    markFirstRun()
    expect(await runFirstRun(c)).toBe(false)
    expect(texts(c, SETUP_KICKOFF)).toHaveLength(0)
    expect(useFirstRun.getState().stage).toBeNull()
  })

  it('double start: first run racing a Settings tap, and two first runs at once, send one kickoff', async () => {
    const c = setup()
    markFirstRun()
    await Promise.all([runFirstRun(c), runFirstRun(c), startSetup(c)])
    expect(c.store.getState().threads.filter((t) => t.id === SETUP_THREAD_ID)).toHaveLength(1)
    expect(texts(c, SETUP_KICKOFF)).toHaveLength(1)
  })

  it('a reload after first run does not start it again; the card comes back with the reload', async () => {
    const c = setup()
    markFirstRun()
    await runFirstRun(c)
    expect(sessionStorage.getItem('talos.firstRun')).toBeNull()
    expect(sessionStorage.getItem('talos.firstRunCard')).toBe('1')
    vi.resetModules() // a reload: the module reads sessionStorage again
    const again = await import('../../src/features/agent-config/firstRun.ts')
    expect(again.useFirstRun.getState()).toEqual({ stage: null, card: true })
    expect(await again.runFirstRun(c)).toBe(false)
    expect(texts(c, SETUP_KICKOFF)).toHaveLength(1)
  })

  it('a kickoff that failed is sent again at the next try, though the thread it made is there', async () => {
    const c = setup()
    const send = c.sendMessage.bind(c)
    let fail = true
    c.sendMessage = (async (...a: Parameters<typeof send>) => {
      if (fail) throw new Error('offline')
      return send(...a)
    }) as typeof c.sendMessage
    markFirstRun()
    await expect(runFirstRun(c)).rejects.toThrow('offline')
    expect(c.store.getState().threads.some((t) => t.id === SETUP_THREAD_ID)).toBe(true)
    expect(useFirstRun.getState().stage).toBe('started')
    fail = false
    expect(await runFirstRun(c)).toBe(true)
    expect(texts(c, SETUP_KICKOFF)).toHaveLength(1)
  })

  it('the client heard `first` (lib/firstPin.ts): first run is due, and the gate runs it', async () => {
    const c = setup()
    firstPinned()
    expect(sessionStorage.getItem('talos.firstRun')).toBe('pending')
    renderWith(<FirstRunGate />, c)
    await waitFor(() => expect(texts(c, SETUP_KICKOFF)).toHaveLength(1))
  })

  it('the card: one tap on Skip archives the thread, tells the agent, says where setup lives; nothing starts again', async () => {
    const c = setup()
    markFirstRun()
    await runFirstRun(c)
    renderWith(<FirstRunCard />, c)
    expect(screen.getByText('You can start setup any time from Settings → Agent.')).toBeTruthy()
    await userEvent.click(screen.getByTestId('first-run-skip'))
    await waitFor(() => expect(screen.queryByTestId('first-run-card')).toBeNull())
    expect(setupThread(c)?.archived).toBe(true)
    expect(texts(c, SETUP_SKIP)).toHaveLength(1)
    markFirstRun() // say a second phone heard `first` too
    expect(await runFirstRun(c)).toBe(false)
    expect(texts(c, SETUP_KICKOFF)).toHaveLength(1)
    // Settings → Agent afterwards brings it back and asks once
    const r = await startSetup(c)
    expect(r.asked).toBe(true)
    expect(setupThread(c)?.archived).toBe(false)
    expect(texts(c, SETUP_KICKOFF)).toHaveLength(2)
  })
})

describe('first-run card', () => {
  it('goes once the owner answers in the thread, and a retried Skip tells the agent only once', async () => {
    const c = setup()
    markFirstRun()
    await runFirstRun(c)
    renderWith(<FirstRunCard />, c)
    expect(screen.getByTestId('first-run-card')).toBeTruthy()
    await act(async () => {
      await c.sendMessage({ threadId: SETUP_THREAD_ID, text: 'Call me Sam.' })
    })
    await waitFor(() => expect(screen.queryByTestId('first-run-card')).toBeNull())
    expect(useFirstRun.getState().card).toBe(false)
    const patch = c.patchConfig.bind(c)
    let failOnce = true
    c.patchConfig = (async (...a: Parameters<typeof patch>) => {
      if (failOnce) {
        failOnce = false
        throw new Error('conflict')
      }
      return patch(...a)
    }) as typeof c.patchConfig
    const { skipSetup } = await import('../../src/features/agent-config/setupThread.ts')
    await expect(skipSetup(c)).rejects.toThrow('conflict')
    await skipSetup(c)
    expect(texts(c, SETUP_SKIP)).toHaveLength(1)
    expect(setupThread(c)?.archived).toBe(true)
  })

  it('stays while a Skip whose archive failed is on screen, says so, and a retry after an agent reply does not resend', async () => {
    const c = setup()
    markFirstRun()
    await runFirstRun(c)
    const patch = c.patchConfig.bind(c)
    let fail = true
    c.patchConfig = (async (...a: Parameters<typeof patch>) => {
      if (fail) throw new Error('conflict')
      return patch(...a)
    }) as typeof c.patchConfig
    renderWith(<FirstRunCard />, c)
    await userEvent.click(screen.getByTestId('first-run-skip'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByTestId('first-run-card')).toBeTruthy() // the Skip message alone does not hide it
    act(() =>
      c.store.setState((s) => ({
        messages: {
          ...s.messages,
          [SETUP_THREAD_ID]: [
            ...(s.messages[SETUP_THREAD_ID] ?? []),
            {
              ...(s.messages[SETUP_THREAD_ID]?.at(-1) as object),
              id: 'm_agentreply0000000000000',
              author: 'agent',
              text: 'OK.',
            } as never,
          ],
        },
      })),
    )
    fail = false
    await userEvent.click(screen.getByTestId('first-run-skip'))
    await waitFor(() => expect(screen.queryByTestId('first-run-card')).toBeNull())
    expect(texts(c, SETUP_SKIP)).toHaveLength(1)
    expect(setupThread(c)?.archived).toBe(true)
  })
})
