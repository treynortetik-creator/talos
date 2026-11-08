// Agents panel WP-A2 (docs/SUBAGENTS.md 6, 7 "Web"): the view contract over the REAL session store, the row helpers,
// and the list, rail and Stop against the scripted fake session.
import {
  AGENT_LIMITS,
  type AgentRowT,
  type FrameOf,
  type FrameType,
  parseFrame,
  SessionControlFrame,
} from '@talos-app/protocol'
import { agentRowSample, defineAgentsViewContract } from '@talos-app/testkit'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { AgentsList, useAgentsView } from '../../src/features/agents/AgentsList.tsx'
import {
  agentTree,
  chipLabel,
  EMPTY_TEXT,
  elapsedMs,
  formatElapsed,
  formatTokens,
  groupAgents,
  isExpired,
  MOD_MISSING_TEXT,
} from '../../src/features/agents/logic.ts'
import { SessionPanel } from '../../src/features/session/SessionPanel.tsx'
import { createSessionController, showsAgentStop, visibleAgents } from '../../src/features/session/store.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import type { FakeClientOptions } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

// The repo has no jest-dom; the two matchers this file needs.
expect.extend({
  toHaveAttribute(el: Element, name: string, value?: string) {
    const got = el.getAttribute(name)
    return { pass: value === undefined ? got !== null : got === value, message: () => `${name} was ${got}` }
  },
  toBeInTheDocument(el: Element) {
    return { pass: document.body.contains(el), message: () => 'not in the document' }
  },
})
declare module 'vitest' {
  interface Assertion {
    toHaveAttribute(name: string, value?: string): void
    toBeInTheDocument(): void
  }
}

// ---- the view contract over the real store --------------------------------------------------------------------------

/** The real controller over a client whose frames arrive exactly as the socket client delivers them: parsed, then fanned out. */
function storeHarness() {
  const listeners = new Map<string, Set<(f: unknown) => void>>()
  const client = {
    store: createStore(() => ({ config: undefined })),
    onFrame<T extends FrameType>(type: T, l: (f: FrameOf<T>) => void) {
      const s = listeners.get(type) ?? new Set()
      s.add(l as (f: unknown) => void)
      listeners.set(type, s)
      return () => void s.delete(l as (f: unknown) => void)
    },
  } as unknown as TalosClient
  const ctl = createSessionController(client, { now: () => Date.parse('2026-10-30T12:00:00.000Z'), tickMs: 60_000 })
  const off = ctl.start()
  return {
    receive(raw: Record<string, unknown>) {
      const r = parseFrame(raw, { direction: 'relay_to_app' })
      if (!r.ok) return
      for (const l of listeners.get(r.frame.type) ?? []) l(r.frame)
    },
    agents: () => visibleAgents(ctl.store.getState()),
    showsStop: (id: string) => showsAgentStop(ctl.store.getState(), id),
    stop: off,
  }
}
defineAgentsViewContract('web session store', storeHarness)

// ---- helpers ------------------------------------------------------------------------------------------------------

const T = Date.parse('2026-10-28T16:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const row = (over: Partial<AgentRowT> & { id: string }): AgentRowT => agentRowSample(over)

describe('row helpers', () => {
  it('formats tokens and elapsed like the CLI', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_300)).toBe('12.3k')
    expect(formatTokens(4000)).toBe('4k')
    expect(formatTokens(123_456)).toBe('123k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
    expect(formatElapsed(45_000)).toBe('45s')
    expect(formatElapsed(134_000)).toBe('2m 14s')
    expect(formatElapsed(3_780_000)).toBe('1h 3m')
  })
  it('elapsed runs from started_at and freezes at ended_at', () => {
    const live = row({ id: 'a', started_at: iso(T - 10_000) })
    expect(elapsedMs(live, T)).toBe(10_000)
    expect(elapsedMs(live, T + 5000)).toBe(15_000)
    const done = row({ id: 'b', status: 'completed', started_at: iso(T - 10_000), ended_at: iso(T - 4000) })
    expect(elapsedMs(done, T)).toBe(6000)
    expect(elapsedMs(done, T + 60_000)).toBe(6000)
    expect(elapsedMs(row({ id: 'c', started_at: undefined }), T)).toBeUndefined()
  })
  it('nests children one level and folds deeper rows into (+N)', () => {
    const t = agentTree([
      row({ id: 'root' }),
      row({ id: 'kid', parent_id: 'root' }),
      row({ id: 'grand', parent_id: 'kid' }),
      row({ id: 'great', parent_id: 'grand' }),
      row({ id: 'orphan', parent_id: 'gone' }),
    ])
    expect(t.map((n) => `${n.row.id}:${n.depth}:${n.more}`)).toEqual(['root:0:0', 'kid:1:2', 'orphan:0:0'])
  })
  it('ended rows leave 10 minutes after ended_at; live rows never expire', () => {
    const ended = (s: AgentRowT['status']) => row({ id: s, status: s, ended_at: iso(T - AGENT_LIMITS.keepEndedMs - 1) })
    expect(isExpired(ended('completed'), T)).toBe(true)
    expect(isExpired(ended('failed'), T)).toBe(true)
    expect(isExpired(row({ id: 'k', status: 'killed', ended_at: iso(T - 60_000) }), T)).toBe(false)
    expect(isExpired(row({ id: 'r', ended_at: iso(T - 3_600_000) }), T)).toBe(false)
  })
  it('groups agents first, then shells and monitors with a count', () => {
    const snap = {
      session_id: 's',
      source: 'mod' as const,
      can_stop: true,
      at: iso(T),
      rows: [
        row({ id: 'a' }),
        row({ id: 's1', kind: 'shell', type: 'shell' }),
        row({ id: 's2', kind: 'shell', type: 'shell', status: 'idle' }),
        row({ id: 'm1', kind: 'monitor', type: 'monitor' }),
        row({ id: 's3', kind: 'shell', type: 'shell', status: 'completed' }),
      ],
    }
    const g = groupAgents(snap, T)
    expect(g.agents.map((n) => n.row.id)).toEqual(['a'])
    expect(g.shells.map((n) => n.row.id)).toEqual(['s1', 's2', 'm1', 's3'])
    expect(g.shellSummary).toBe('2 shells · 1 monitor')
    // like the CLI's pill: mixed kinds are "tasks", and a shell is never called an agent
    expect(chipLabel(snap)).toMatchObject({
      count: 4,
      unit: 'tasks',
      agents: 1,
      busy: true,
      full: '1 agent, 2 shells, 1 monitor, running',
    })
    const shellsOnly = { ...snap, rows: snap.rows.filter((r) => r.kind === 'shell') }
    expect(chipLabel(shellsOnly)).toMatchObject({ count: 2, unit: 'shells', agents: 0 })
  })
})

// ---- components ---------------------------------------------------------------------------------------------------

function ListProbe({ threadId }: { threadId: string }) {
  const view = useAgentsView()
  return <AgentsList threadId={threadId} view={view} />
}

function mount(opts: FakeClientOptions, ui: React.ReactElement = <ListProbe threadId="general" />) {
  const client = setup(opts)
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter>{ui}</MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
  return client
}
const agentControls = (c: ReturnType<typeof setup>) =>
  c.sent.filter((f) => f.type === 'session.control' && f.action === 'agent_stop')

describe('the list', () => {
  it('renders every status as a mark with its word, never colour only', async () => {
    const client = mount({ agents: 'empty' })
    const statuses = ['pending', 'running', 'waiting', 'idle', 'completed', 'failed', 'killed', 'unknown'] as const
    act(() =>
      client.session.setAgents(
        statuses.map((s) => ({ id: `r_${s}`, status: s, started_at: iso(Date.now() - 5000), stoppable: false })),
      ),
    )
    const list = await screen.findByRole('list', { name: 'Agents' })
    const words = within(list)
      .getAllByRole('img')
      .map((e) => e.getAttribute('aria-label'))
    expect(words).toEqual(['starting', 'running', 'waiting', 'idle', 'done', 'failed', 'stopped', 'unknown'])
    expect(within(list).getAllByRole('listitem')).toHaveLength(8)
  })

  it('line 1 is type · title with tokens · elapsed; line 2 is the activity, italic for a tool line', async () => {
    mount({ agents: 'demo' })
    const rows = await screen.findAllByTestId('agent-row')
    const explore = rows.find((r) => r.dataset.id === 'a00f4f30ac1399f7f') as HTMLElement
    expect(explore.textContent).toContain('Explore · research mods API')
    expect(within(explore).getAllByTestId('agent-figures')[0]?.textContent).toMatch(/^12\.3k · 2m 1\ds$/)
    expect(within(explore).getAllByTestId('agent-activity')[0]?.textContent).toBe(
      'Running memory and search vitest suites',
    )
    const reviewer = rows.find((r) => r.dataset.id === 'tm_reviewer_1') as HTMLElement
    expect(reviewer.textContent).toContain('reviewer · Review the protocol diff')
    expect(reviewer.textContent).toContain('(+1)') // its nested Explore is folded
    expect(within(reviewer).getByTestId('agent-activity').className).toContain('italic')
  })

  it('elapsed ticks once a second on the client', async () => {
    const client = mount({ agents: 'empty' })
    act(() => client.session.setAgents([{ id: 'tick', started_at: iso(Date.now() - 3000), tokens: 10 }]))
    const fig = await screen.findByTestId('agent-figures')
    const first = fig.textContent
    await waitFor(() => expect(screen.getByTestId('agent-figures').textContent).not.toBe(first), { timeout: 2500 })
  })

  it('shells and monitors are collapsed by default behind a count', async () => {
    mount({ agents: 'demo' })
    const toggle = await screen.findByTestId('agents-shells-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle.textContent).toContain('2 shells · 1 monitor')
    expect(screen.queryByRole('list', { name: 'Shells and monitors' })).toBeNull()
    await userEvent.click(toggle)
    expect(within(screen.getByRole('list', { name: 'Shells and monitors' })).getAllByRole('listitem')).toHaveLength(3)
  })

  it('a tap opens the detail in place of the list, with the recent lines and a way back', async () => {
    mount({ agents: 'demo' })
    const btn = await screen.findByRole('button', { name: /research mods API/ })
    await userEvent.click(btn)
    const recent = screen.getByTestId('agent-recent')
    expect(recent.textContent).toContain('Run vitest suites')
    expect(recent.textContent).toMatch(/\ds ago/)
    expect(screen.getByTestId('agent-detail').textContent).toContain('Sonnet 5.5')
    expect(screen.queryByRole('list', { name: 'Agents' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /All agents/ }))
    expect(screen.getByRole('list', { name: 'Agents' })).toBeInTheDocument()
  })

  it('Stop shows only for a stoppable live row and sends a signed agent_stop', async () => {
    const client = mount({ agents: 'demo' })
    const back = () => userEvent.click(screen.getByRole('button', { name: /All agents/ }))
    await userEvent.click(await screen.findByRole('button', { name: /Draft release notes/ }))
    expect(screen.queryByTestId('agent-stop')).toBeNull() // completed
    await back()
    await userEvent.click(screen.getByRole('button', { name: /Fix the flaky e2e spec/ }))
    expect(screen.queryByTestId('agent-stop')).toBeNull() // failed
    await back()
    await userEvent.click(screen.getByRole('button', { name: /research mods API/ }))
    await userEvent.click(screen.getByTestId('agent-stop'))
    await waitFor(() => expect(agentControls(client)).toHaveLength(1))
    const f = agentControls(client)[0] as Record<string, unknown>
    expect(SessionControlFrame.safeParse(f).success).toBe(true)
    expect(f).toMatchObject({ action: 'agent_stop', agent_id: 'a00f4f30ac1399f7f', thread_id: 'general' })
    expect(typeof f.osig).toBe('string')
    await waitFor(() => expect(screen.getByTestId('agent-outcome').textContent).toBe('Stopped.'))
    await userEvent.click(screen.getByRole('button', { name: /All agents/ }))
    await waitFor(() =>
      expect(screen.getAllByTestId('agent-row').find((r) => r.dataset.id === 'a00f4f30ac1399f7f')?.dataset.status).toBe(
        'killed',
      ),
    )
    expect(screen.queryByTestId('agent-stop')).toBeNull()
  })

  it('no Stop when the snapshot cannot stop, or the Mac is offline', async () => {
    const client = mount({ agents: 'empty' })
    act(() => client.session.setAgents([{ id: 'x', title: 'one agent', stoppable: true }], { can_stop: false }))
    await userEvent.click(await screen.findByRole('button', { name: /one agent/ }))
    expect(screen.queryByTestId('agent-stop')).toBeNull()
    act(() => client.session.setAgents([{ id: 'x', title: 'one agent', stoppable: true }]))
    expect(await screen.findByTestId('agent-stop')).toBeInTheDocument()
    act(() => client.setMacOnline(false))
    await waitFor(() => expect(screen.queryByTestId('agent-stop')).toBeNull())
    expect(screen.getByTestId('agents-list')).toHaveAttribute('data-offline', 'mac')
  })

  it('a refused Stop shows the bridge text', async () => {
    const client = mount({ agents: 'demo' })
    client.session.failNext('agent_not_found', 'That agent already ended. Nothing was stopped.')
    await userEvent.click(await screen.findByRole('button', { name: /research mods API/ }))
    await userEvent.click(screen.getByTestId('agent-stop'))
    await waitFor(() =>
      expect(screen.getByTestId('agent-outcome').textContent).toBe('That agent already ended. Nothing was stopped.'),
    )
  })

  it('empty, mod offline and mod absent states', async () => {
    mount({ agents: 'empty' })
    expect((await screen.findByTestId('agents-empty')).textContent).toBe(EMPTY_TEXT)
    cleanup()
    mount({ agents: 'demo', mod: 'offline' })
    const list = await screen.findByTestId('agents-list')
    expect(list).toHaveAttribute('data-offline', 'mod')
    expect(within(list).getAllByRole('img', { name: 'unknown' }).length).toBeGreaterThan(0)
    cleanup()
    mount({ agents: 'demo', mod: 'absent' })
    expect((await screen.findByTestId('agents-mod-missing')).textContent).toBe(MOD_MISSING_TEXT)
  })

  it('never draws a leftover snapshot of another session', async () => {
    const client = mount({ agents: 'demo' })
    await screen.findAllByTestId('agent-row')
    act(() => client.session.patch({ session_id: 'sess_next' }))
    await waitFor(() => expect(screen.queryAllByTestId('agent-row')).toHaveLength(0))
    expect(screen.getByTestId('agents-mod-missing')).toBeInTheDocument()
  })
})

describe('session sheet section', () => {
  it('Agents sits right after the meters, before the tabs', async () => {
    mount({ agents: 'demo' }, <SessionPanel threadId="general" inline />)
    const section = await screen.findByTestId('session-agents')
    const panel = screen.getByTestId('session-panel')
    const order = [
      ...panel.querySelectorAll(
        '[data-testid="session-context"],[data-testid="session-usage"],[data-testid="session-agents"],[role="tablist"]',
      ),
    ]
    expect(order.map((e) => e.getAttribute('data-testid') ?? e.getAttribute('role'))).toEqual([
      'session-context',
      'session-usage',
      'session-agents',
      'tablist',
    ])
    expect(section.textContent).toContain('3 active') // the Agents group only; shells have their own count
  })
  it('no snapshot (old relay or bridge, a mod without `agents`, no mod) still shows the section, empty, and never blames the mod', async () => {
    mount({}, <SessionPanel threadId="general" />)
    await screen.findByTestId('session-panel')
    expect((await screen.findByTestId('session-agents')).textContent).toContain(EMPTY_TEXT)
    expect(screen.queryByText(MOD_MISSING_TEXT)).toBeNull()
    cleanup()
    mount({ mod: 'absent' }, <SessionPanel threadId="general" />)
    await screen.findByTestId('session-panel')
    expect((await screen.findByTestId('session-agents')).textContent).toContain(EMPTY_TEXT)
  })
})
