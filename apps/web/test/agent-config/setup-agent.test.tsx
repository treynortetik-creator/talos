// Settings → Agent: Set up my agent. One Setup thread per agent, however many times Start is tapped.
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentSettingsSection } from '../../src/features/agent-config/AgentSettingsSection.tsx'
import { resetAgentDraft } from '../../src/features/agent-config/draftStore.ts'
import { newThread } from '../../src/features/agent-config/patch.ts'
import { SETUP_KICKOFF, SETUP_THREAD_ID, startSetup } from '../../src/features/agent-config/setupThread.ts'
import { wireThreads } from '../../src/features/threads/manage/useThreadPatch.ts'
import { TalosClientError } from '../../src/lib/client.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

const wire = (t: unknown) => wireThreads([t as never], false)[0]

beforeEach(() => resetAgentDraft())
afterEach(cleanup)

const setupThreads = (c: ReturnType<typeof setup>) => c.store.getState().threads.filter((t) => t.id === SETUP_THREAD_ID)
const kickoffs = (c: ReturnType<typeof setup>) =>
  c.sent.filter((f) => f.type === 'message' && (f as { text?: string }).text === SETUP_KICKOFF)

describe('Set up my agent', () => {
  it('two taps of Start make one Setup thread and ask the agent once', async () => {
    const c = setup()
    renderWith(<AgentSettingsSection readOnly={false} />, c)
    const button = await screen.findByRole('button', {
      name: 'Set up my agent',
    })
    await Promise.all([userEvent.click(button), userEvent.click(button)])
    await waitFor(() => expect(setupThreads(c)).toHaveLength(1))
    expect(c.sent.filter((f) => f.type === 'config.patch')).toHaveLength(1)
    expect(kickoffs(c)).toHaveLength(1)
    expect(setupThreads(c)[0]).toMatchObject({
      name: 'Setup',
      kind: 'fixed',
      archived: false,
    })
  })

  it('two calls at the same moment share one run', async () => {
    const c = setup()
    const [a, b] = await Promise.all([startSetup(c), startSetup(c)])
    expect(a).toBe(b)
    expect(setupThreads(c)).toHaveLength(1)
    expect(kickoffs(c)).toHaveLength(1)
  })

  it('a second tap after the first finished adds no thread and does not ask again while the agent has not answered', async () => {
    const c = setup({ replyDelayMs: 60_000 })
    await startSetup(c)
    const again = await startSetup(c)
    expect(again).toMatchObject({ created: false, asked: false })
    expect(setupThreads(c)).toHaveLength(1)
    expect(kickoffs(c)).toHaveLength(1)
  })

  it('resumes: once the agent has spoken, Start asks again in the same thread', async () => {
    const c = setup()
    await startSetup(c)
    await waitFor(() => expect(c.store.getState().messages[SETUP_THREAD_ID]?.at(-1)?.author).toBe('agent'))
    const again = await startSetup(c)
    expect(again).toMatchObject({ created: false, asked: true })
    expect(setupThreads(c)).toHaveLength(1)
    expect(kickoffs(c)).toHaveLength(2)
  })

  it('brings back an archived Setup thread instead of making a second one', async () => {
    const c = setup()
    await startSetup(c)
    c.store.setState((s) => ({
      ...s,
      threads: s.threads.map((t) => (t.id === SETUP_THREAD_ID ? { ...t, archived: true } : t)),
    }))
    await startSetup(c)
    expect(setupThreads(c)).toHaveLength(1)
    expect(setupThreads(c)[0]?.archived).toBe(false)
  })

  it('with the Mac offline it says so and sends nothing', async () => {
    const c = setup()
    renderWith(<AgentSettingsSection readOnly={true} />, c)
    await userEvent.click(await screen.findByRole('button', { name: 'Set up my agent' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Mac is offline')
    expect(c.sent).toHaveLength(0)
  })

  it('a refused save shows in words and sends no message', async () => {
    const c = setup()
    c.failNextPatchWith('bad_frame', 'too many threads')
    renderWith(<AgentSettingsSection readOnly={false} />, c)
    await userEvent.click(await screen.findByRole('button', { name: 'Set up my agent' }))
    expect((await screen.findByRole('alert')).textContent).toContain('too many threads')
    expect(kickoffs(c)).toHaveLength(0)
  })

  it('the Setup thread id is one no thread name can slug to', () => {
    const names = ['Setup', 'setup', 'Talos setup', 'talos  setup', 'talos__setup', 'Talos Setup v1', '_talos__setup_']
    for (const name of names) expect(newThread(name, [], '2026-01-01T00:00:00Z').id).not.toBe(SETUP_THREAD_ID)
    expect(SETUP_THREAD_ID).toMatch(/^[a-z][a-z0-9_]{0,31}$/)
  })

  it("a thread the owner named 'Setup' is never adopted: the interview gets its own thread", async () => {
    const c = setup()
    const mine = newThread('Setup', c.store.getState().threads, '2026-01-01T00:00:00Z')
    await c.patchConfig({
      threads: [...c.store.getState().threads, mine].map(wire),
    })
    const r = await startSetup(c)
    expect(r.threadId).toBe(SETUP_THREAD_ID)
    expect(r.threadId).not.toBe(mine.id)
    expect(c.store.getState().threads.filter((t) => t.name === 'Setup')).toHaveLength(2)
    expect(c.store.getState().messages[mine.id] ?? []).toHaveLength(0)
    expect(kickoffs(c)).toHaveLength(1)
  })

  it('adopts the Setup thread after the owner renamed it', async () => {
    const c = setup()
    await startSetup(c)
    c.store.setState((s) => ({
      ...s,
      threads: s.threads.map((t) => (t.id === SETUP_THREAD_ID ? { ...t, name: 'Agent tuning' } : t)),
    }))
    const r = await startSetup(c)
    expect(r).toMatchObject({ threadId: SETUP_THREAD_ID, created: false })
    expect(c.store.getState().threads.filter((t) => t.id === SETUP_THREAD_ID)).toHaveLength(1)
  })

  it('unarchives a renamed, archived Setup thread without an error', async () => {
    const c = setup()
    await startSetup(c)
    c.store.setState((s) => ({
      ...s,
      threads: s.threads.map((t) => (t.id === SETUP_THREAD_ID ? { ...t, name: 'Budget', archived: true } : t)),
    }))
    await startSetup(c)
    const t = c.store.getState().threads.find((x) => x.id === SETUP_THREAD_ID)
    expect(t).toMatchObject({ name: 'Budget', archived: false })
  })

  // Another device wins the race: its thread (and maybe its kickoff) lands while this client's patch is in flight, and this
  // client's patch is refused with config_conflict.
  function loseRaceTo(c: ReturnType<typeof setup>, kickoffSent: boolean) {
    const other = {
      ...newThread('Setup', [], '2026-01-01T00:00:00Z'),
      id: SETUP_THREAD_ID,
    }
    c.patchConfig = async () => {
      c.store.setState((s) => ({
        ...s,
        threads: [...s.threads, other],
        messages: kickoffSent
          ? {
              ...s.messages,
              [SETUP_THREAD_ID]: [
                {
                  id: 'm_other',
                  thread_id: SETUP_THREAD_ID,
                  author: 'owner',
                  text: SETUP_KICKOFF,
                },
              ] as never,
            }
          : s.messages,
      }))
      throw new TalosClientError('config_conflict')
    }
  }

  it('config_conflict because another device made the thread: not created, and no second kickoff', async () => {
    const c = setup()
    loseRaceTo(c, true)
    const r = await startSetup(c)
    expect(r).toMatchObject({ created: false, asked: false })
    expect(kickoffs(c)).toHaveLength(0)
  })

  it('config_conflict with the thread there but nobody asked yet: this client asks, once', async () => {
    const c = setup()
    loseRaceTo(c, false)
    const r = await startSetup(c)
    expect(r).toMatchObject({ created: false, asked: true })
    expect(kickoffs(c)).toHaveLength(1)
  })
})
