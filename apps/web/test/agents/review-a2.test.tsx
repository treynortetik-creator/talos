// Regression tests for the agents panel. Each `it` names the bug it pins (F1..Fn); `guard` tests
// pin behaviour that already held. Real components over the real session store and the scripted fake session.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Profiler } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentsList, useAgentsView } from '../../src/features/agents/AgentsList.tsx'
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

function ListProbe() {
  const view = useAgentsView()
  return <AgentsList threadId="general" view={view} />
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

describe('F1: counts and labels', () => {
  it('F1c: the "N active" beside the Agents heading counts what the Agents list holds, not shells', async () => {
    mount({ agents: 'demo' }, <SessionPanel threadId="general" />)
    const section = await screen.findByTestId('session-agents')
    // demo: 3 live agents (Explore, reviewer, the folded Explore) + 2 shells + 1 monitor. The heading says "3 active"
    // above the list, never "6 active".
    expect(visibleText(section)).toMatch(/3 active/)
    expect(visibleText(section)).not.toMatch(/6 active/)
  })
})

describe('F2: with no agents snapshot (old relay/bridge, mod without `agents`) the section is empty, and does not blame the mod', () => {
  it('F2a: the Agents section is there and says "No agents running."', async () => {
    mount({}, <SessionPanel threadId="general" />) // agents: 'none' = an old relay/bridge or a mod without `agents`
    const section = await screen.findByTestId('session-agents')
    expect(visibleText(section)).toContain('No agents running.')
  })

  it('F2b: with the Mac offline and no snapshot the panel does not say "Needs the Talos mod"', async () => {
    const client = mount({}, <SessionPanel threadId="general" />)
    act(() => client.setMacOnline(false))
    await wait(50)
    expect(screen.queryByText('Needs the Talos mod (Settings → Session).')).toBeNull()
    expect(screen.getByTestId('session-agents')).toBeTruthy()
  })
})

describe('F3: Stop failure handling', () => {
  it('F3a: a Stop error that lands after the owner went back to the list is still shown there', async () => {
    const client = mount({ agents: 'demo' }, <ListProbe />)
    client.session.mute(true)
    await userEvent.click(await screen.findByRole('button', { name: /research mods API/ }))
    await userEvent.click(screen.getByTestId('agent-stop'))
    await userEvent.click(screen.getByRole('button', { name: /All agents/ })) // back to the list while "Stopping…"
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
    // The result lives in the store by agent id, not in the detail view's own state: going back never loses it.
    expect(screen.queryByText('TaskStop failed: no such task')).not.toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /research mods API/ })) // and it is still there on reopening
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
    const client = mount({ agents: 'demo' }, <ListProbe />)
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
    const client = mount({ agents: 'empty' }, <ListProbe />)
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
        <ListProbe />
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

describe('F5: keyboard focus when a row opens its detail', () => {
  it('F5a: opening a row moves focus into the detail, not to <body>', async () => {
    mount({ agents: 'demo' }, <ListProbe />)
    const row = await screen.findByRole('button', { name: /research mods API/ })
    row.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByTestId('agent-detail')).not.toBeNull()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('F5b: "All agents" returns focus to the row that was opened', async () => {
    mount({ agents: 'demo' }, <ListProbe />)
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
    const client = mount({ agents: 'empty' }, <ListProbe />)
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
    const detail = screen.getByTestId('agent-detail')
    expect(detail.querySelector('img,b')).toBeNull()
    expect(detail.textContent).toContain('<b>bold</b>')
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })
})
