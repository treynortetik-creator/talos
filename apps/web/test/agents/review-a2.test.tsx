// Regression tests for the agents panel. Each `it` names the bug it pins (F1..Fn); `guard` tests
// pin behaviour that already held. Real components over the real session store and the scripted fake session.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Profiler } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentsChip } from '../../src/features/agents/AgentsChip.tsx'
import { AgentsList, useAgentsView } from '../../src/features/agents/AgentsList.tsx'
import { AgentsRail, setRailPref } from '../../src/features/agents/AgentsRail.tsx'
import { SessionPanel } from '../../src/features/session/SessionPanel.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClientOptions } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)
const iso = (ms: number) => new Date(ms).toISOString()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** matchMedia stub: `px` is the viewport width; min-width queries match against it. */
function viewport(px: number) {
  window.matchMedia = ((q: string) => {
    const m = /min-width:\s*(\d+)px/.exec(q)
    return { matches: m ? px >= Number(m[1]) : false, media: q, addEventListener() {}, removeEventListener() {} }
  }) as unknown as typeof window.matchMedia
}

function ListProbe({ mode }: { mode: 'inline' | 'push' }) {
  const view = useAgentsView()
  return <AgentsList threadId="general" mode={mode} view={view} />
}

function mount(opts: FakeClientOptions, ui: React.ReactElement) {
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

/** Text a sighted user sees (drops .sr-only). */
const visibleText = (el: Element) => {
  const c = el.cloneNode(true) as Element
  for (const s of c.querySelectorAll('.sr-only')) s.remove()
  return (c.textContent ?? '').replace(/\s+/g, ' ').trim()
}

const SHELLS_ONLY = [
  { id: 's1', kind: 'shell' as const, type: 'shell', title: 'dev server', status: 'running' as const },
  { id: 's2', kind: 'shell' as const, type: 'shell', title: 'tsc --watch', status: 'running' as const },
  { id: 'm1', kind: 'monitor' as const, type: 'monitor', title: 'CI', status: 'running' as const },
]

describe('F1: counts and labels', () => {
  beforeEach(() => setRailPref(null))

  it('F1a: the chip never calls a shell or a monitor an "agent" (CLI 2.1.312 says "2 shells, 1 monitor")', async () => {
    viewport(800)
    const client = mount({ agents: 'empty' }, <AgentsChip threadId="general" variant="header" />)
    act(() => client.session.setAgents(SHELLS_ONLY))
    const chip = await screen.findByTestId('agents-chip')
    await waitFor(() => expect(screen.getByTestId('agents-chip-count').textContent).toBe('3'))
    // Today: "3 agents" with zero agents running. The CLI pill (S_o in the 2.1.312 bundle) names the kind when every
    // task is one kind ("2 shells, 1 monitor") and says "N background tasks" when they are mixed.
    expect(visibleText(chip)).not.toMatch(/\b3\s*agents\b/)
  })

  it('F1b: the demo chip does not say "6 agents" when 3 agents and 3 shells/monitors are live', async () => {
    viewport(800)
    mount({ agents: 'demo' }, <AgentsChip threadId="general" variant="header" />)
    const chip = await screen.findByTestId('agents-chip')
    await waitFor(() => expect(screen.getByTestId('agents-chip-count').textContent).not.toBe('0'))
    // Its own accessible name contradicts itself today: "6 agents (6 active: 3 agents, 2 shells, 1 monitor, running)".
    expect(visibleText(chip)).not.toMatch(/\b6\s*agents\b/)
  })

  it('F1c: the "N active" beside the Agents heading counts what the Agents list holds, not shells', async () => {
    viewport(1440)
    mount({ agents: 'demo' }, <AgentsRail threadId="general" />)
    const rail = await screen.findByTestId('agents-rail')
    await waitFor(() => expect(rail.getAttribute('data-state')).toBe('open'))
    const header = rail.querySelector('h2')?.parentElement as HTMLElement
    // demo: 3 live agents (Explore, reviewer, the folded Explore) + 2 shells + 1 monitor. Header says "6 active" above
    // a list of 4 agent rows, 2 of them done/failed.
    expect(visibleText(header)).toMatch(/\b3 active\b/)
  })

  it('F1d: the count live region says what it counts (a bare "6" is announced out of context)', async () => {
    viewport(1440)
    mount({ agents: 'demo' }, <AgentsRail threadId="general" />)
    await screen.findByTestId('agents-count')
    await waitFor(() => expect(screen.getByTestId('agents-rail').getAttribute('data-state')).toBe('open'))
    const live = screen.getByTestId('agents-count')
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toMatch(/\d+\s+\w+/)
  })
})

describe('F2: the panel hides when there is no agents snapshot (old relay/bridge, mod without `agents`)', () => {
  beforeEach(() => setRailPref(null))

  it('F2a: no rail strip on a 1440 px thread when the mod sends no snapshot', async () => {
    viewport(1440)
    mount({}, <AgentsRail threadId="general" />) // agents: 'none' = an old relay/bridge or a mod without `agents`
    await wait(50)
    // Today: a 44 px strip with "0" on every thread; opening it blames the mod.
    expect(screen.queryByTestId('agents-rail')).toBeNull()
  })

  it('F2b: with the Mac offline and no snapshot the panel does not say "Needs the Talos mod"', async () => {
    viewport(1440)
    setRailPref('open')
    const client = mount({}, <AgentsRail threadId="general" />)
    act(() => client.setMacOnline(false))
    await wait(50)
    expect(screen.queryByText('Needs the Talos mod (Settings → Session).')).toBeNull()
  })
})

describe('F3: Stop failure handling', () => {
  it('F3a: a Stop error that lands after the row was collapsed is still shown somewhere', async () => {
    viewport(1440)
    setRailPref('open')
    const client = mount({ agents: 'demo' }, <AgentsRail threadId="general" />)
    client.session.mute(true)
    const row = await screen.findByRole('button', { name: /research mods API/ })
    await userEvent.click(row)
    await userEvent.click(screen.getByTestId('agent-stop'))
    await userEvent.click(row) // collapse while "Stopping…"
    await waitFor(() =>
      expect(client.sent.some((f) => f.type === 'session.control' && f.action === 'agent_stop')).toBe(true),
    )
    const sent = client.sent.filter((f) => f.type === 'session.control' && f.action === 'agent_stop').at(-1) as {
      control_id: string
    }
    act(() =>
      client.emit('session.control.result', {
        control_id: sent.control_id,
        ok: false,
        code: 'internal',
        text: 'TaskStop failed: no such task',
        at: iso(Date.now()),
      }),
    )
    await userEvent.click(row) // reopen
    // Today the result lived in AgentDetail's useState and died with the collapse: the owner never learns it failed.
    expect(screen.queryByText('TaskStop failed: no such task')).not.toBeNull()
  })

  it('F3b: in the session sheet, one Stop is announced once (two aria-live regions say it today)', async () => {
    viewport(1100)
    const client = mount({ agents: 'demo' }, <SessionPanel threadId="general" />)
    client.session.mute(true)
    const section = await screen.findByTestId('session-agents')
    await userEvent.click(within(section).getByRole('button', { name: /research mods API/ }))
    await userEvent.click(within(section).getByTestId('agent-stop'))
    await waitFor(() => expect(screen.getAllByText('Waiting for the Mac…').length).toBeGreaterThan(0))
    const live = screen
      .getAllByText('Waiting for the Mac…')
      .filter((el) => el.closest('[aria-live]') !== null && el.closest('[aria-live]') !== el.closest('[aria-hidden]'))
    expect(live).toHaveLength(1)
  })

  it('guard: a send that throws settles as an error and Stop comes back', async () => {
    viewport(1440)
    setRailPref('open')
    const client = mount({ agents: 'demo' }, <AgentsRail threadId="general" />)
    client.sendOwnerFrame = async () => {
      throw new Error('socket closed')
    }
    await userEvent.click(await screen.findByRole('button', { name: /research mods API/ }))
    await userEvent.click(screen.getByTestId('agent-stop'))
    await waitFor(() => expect(screen.getByTestId('agent-outcome').textContent).toBe("Couldn't reach the Mac."))
    expect(screen.getByTestId('agent-stop').hasAttribute('disabled')).toBe(false)
  })
})

describe('F4: elapsed timers', () => {
  it('F4a: an ended row without ended_at does not keep counting up', async () => {
    const client = mount({ agents: 'empty' }, <ListProbe mode="inline" />)
    act(() =>
      client.session.setAgents([
        { id: 'done', title: 'finished', status: 'completed', started_at: iso(Date.now() - 10_000), tokens: 5 },
      ]),
    )
    const fig = await screen.findByTestId('agent-figures')
    const first = fig.textContent
    await wait(2200)
    // ended_at is optional in AgentRow (agentRowsFromEngine leaves it out when the engine has none).
    expect(screen.getByTestId('agent-figures').textContent).toBe(first)
  })

  it('F4b: nothing live on screen = no 1 s re-render of the whole list', async () => {
    let commits = 0
    const client = mount(
      { agents: 'empty' },
      <Profiler id="list" onRender={() => void commits++}>
        <ListProbe mode="inline" />
      </Profiler>,
    )
    act(() =>
      client.session.setAgents([
        {
          id: 'done',
          title: 'finished',
          status: 'completed',
          started_at: iso(Date.now() - 10_000),
          ended_at: iso(Date.now() - 2000),
        },
      ]),
    )
    await screen.findByTestId('agent-figures')
    const before = commits
    await wait(3200)
    expect(commits - before).toBeLessThanOrEqual(1)
  })
})

describe('F5: keyboard focus in push mode (sheets)', () => {
  it('F5a: opening a row moves focus into the detail, not to <body>', async () => {
    mount({ agents: 'demo' }, <ListProbe mode="push" />)
    const row = await screen.findByRole('button', { name: /research mods API/ })
    row.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('agent-detail')).not.toBeNull()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('F5b: "All agents" returns focus to the row that was opened', async () => {
    mount({ agents: 'demo' }, <ListProbe mode="push" />)
    ;(await screen.findByRole('button', { name: /research mods API/ })).focus()
    await userEvent.keyboard('{Enter}')
    screen.getByRole('button', { name: /All agents/ }).focus()
    await userEvent.keyboard('{Enter}')
    const active = document.activeElement as HTMLElement | null
    expect(active?.tagName).toBe('BUTTON')
    expect(active?.textContent).toContain('research mods API')
  })
})

describe('F6: untrusted text', () => {
  it('guard: HTML in title/activity/recent renders as text, never markup', async () => {
    const client = mount({ agents: 'empty' }, <ListProbe mode="inline" />)
    const evil = '<img src=x onerror="window.__pwned=1"><b>bold</b>'
    act(() =>
      client.session.setAgents([
        {
          id: 'x',
          title: evil,
          activity: evil,
          activity_source: 'tool',
          recent: [{ at: iso(Date.now() - 1000), text: evil }],
        },
      ]),
    )
    await userEvent.click(await screen.findByRole('button', { name: /bold/ }))
    const row = screen.getByTestId('agent-row')
    expect(row.querySelector('img,b')).toBeNull()
    expect(row.textContent).toContain('<b>bold</b>')
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })
})
