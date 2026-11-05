// CC-C3: the session store, sheet panel, header chip and composer `/` picker, against the scripted fake session.
import { SessionControlFrame, type SessionStateT } from '@talos-app/protocol'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/features/composer/Composer.tsx'
import {
  chipParts,
  filterCommands,
  INSTALL_HINT,
  isModOnline,
  MOD_FRESH_MS,
  resetWords,
  usedPct,
  WARN_USED_PCT,
} from '../../src/features/session/logic.ts'
import { SessionPanel } from '../../src/features/session/SessionPanel.tsx'
import { SessionChip, SessionTrigger } from '../../src/features/session/SessionTrigger.tsx'
import { createSessionController, outcomeFromResult } from '../../src/features/session/store.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClientOptions } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

// The repo has no jest-dom; the four matchers this file needs.
expect.extend({
  toHaveTextContent(el: Element, want: string | RegExp) {
    const got = el.textContent ?? ''
    return { pass: typeof want === 'string' ? got.includes(want) : want.test(got), message: () => `text was "${got}"` }
  },
  toHaveAttribute(el: Element, name: string, value?: string) {
    const got = el.getAttribute(name)
    return { pass: value === undefined ? got !== null : got === value, message: () => `${name} was ${got}` }
  },
  toHaveValue(el: HTMLTextAreaElement, want: string) {
    return { pass: el.value === want, message: () => `value was "${el.value}"` }
  },
  toBeInTheDocument(el: Element) {
    return { pass: document.body.contains(el), message: () => 'not in the document' }
  },
})
declare module 'vitest' {
  interface Assertion {
    toHaveTextContent(want: string | RegExp): void
    toHaveAttribute(name: string, value?: string): void
    toHaveValue(want: string): void
    toBeInTheDocument(): void
  }
}

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

function mount(opts: FakeClientOptions = {}, ui?: (client: ReturnType<typeof setup>) => React.ReactElement) {
  const client = setup(opts)
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter>{ui ? ui(client) : <SessionPanel threadId="general" />}</MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
  return client
}

const sentControls = (c: ReturnType<typeof setup>) => c.sent.filter((f) => f.type === 'session.control')

describe('modOnline (injectable clock)', () => {
  const base = (over: Partial<SessionStateT> = {}): SessionStateT =>
    ({
      session_id: 's',
      source: 'mod',
      capabilities: ['stop'],
      rate_limits: [],
      surfaces: [],
      at: '2026-10-28T16:00:00.000Z',
      ...over,
    }) as SessionStateT
  const t0 = Date.parse('2026-10-28T16:00:00.000Z')
  it('is live only for a fresh mod state with capabilities', () => {
    expect(isModOnline(base(), t0 + 10_000)).toBe(true)
    expect(isModOnline(base(), t0 + MOD_FRESH_MS + 1)).toBe(false)
    expect(isModOnline(base({ capabilities: [] }), t0)).toBe(false)
    expect(isModOnline(base({ source: 'hooks' }), t0)).toBe(false)
    expect(isModOnline(undefined, t0)).toBe(false)
  })
  it('goes stale as the clock moves', async () => {
    let now = t0
    const client = setup()
    const ctl = createSessionController(client, { now: () => now, tickMs: 10 })
    const off = ctl.start()
    client.emit('session.state', { state: base() })
    expect(ctl.store.getState().modOnline).toBe(true)
    now = t0 + 60_000
    await wait(40)
    expect(ctl.store.getState().modOnline).toBe(false)
    off()
  })
  it('maps results to calm or plain outcomes', () => {
    expect(
      outcomeFromResult({ ok: false, code: 'model_switch_pending', text: 'Waiting for confirmation at the Mac.' }).kind,
    ).toBe('pending')
    expect(outcomeFromResult({ ok: false, code: 'effort_change_pending', text: '' }).kind).toBe('pending')
    expect(outcomeFromResult({ ok: false, code: 'stopped_at_mac', text: 'x' }).text).toBe(
      'Stopped at the Mac. Send a message to continue.',
    )
    expect(outcomeFromResult({ ok: false, code: 'model_switch_denied', text: 'Your hook said no.' })).toMatchObject({
      kind: 'error',
      text: 'Your hook said no.',
    })
  })
})

describe('usage rows and the header chip', () => {
  it('shows weekly and context as percent used, never a cost, and never the 5-hour window the fake peer still sends', async () => {
    mount()
    expect(await screen.findByTestId('meter-week')).toHaveTextContent('60% used')
    expect(screen.getByTestId('meter-context')).toHaveTextContent('31% used · 69% left')
    expect(screen.getByTestId('meter-context')).toHaveTextContent('310k of 1M tokens')
    expect(screen.getByTestId('meter-week')).toHaveTextContent(/resets/)
    expect(screen.queryByTestId('meter-five')).toBeNull()
    expect(screen.getByTestId('session-usage').textContent).not.toMatch(/5-hour|28%/)
    expect(document.body.textContent).not.toMatch(/\$\d|list price/)
    expect(screen.getByTestId('session-model')).toHaveTextContent('Opus 5.5')
    expect(screen.getByTestId('session-busy')).toHaveTextContent('Idle')
    expect(screen.getByTestId('session-facts')).toHaveTextContent('Also open in: cli, talos')
  })
  it('says "No reading yet" for a missing window, not 0%', async () => {
    const client = mount()
    await screen.findByTestId('meter-week')
    client.session.patch({ rate_limits: [{ kind: 'spend_limit', percent: 90 }] })
    await waitFor(() => expect(screen.getByTestId('meter-week')).toHaveTextContent('No reading yet'))
    expect(screen.getByTestId('meter-week')).not.toHaveTextContent('0%')
    expect(screen.queryByText(/spend/i)).toBeNull()
  })
  it('the chip carries the two numbers and dims with "mod offline", all as visible text', async () => {
    const client = mount({}, () => <SessionChip />)
    const chip = await screen.findByTestId('session-chip')
    // The words on screen are the words a screen reader gets: no separate label that could say something else.
    expect(chip.hasAttribute('aria-label')).toBe(false)
    expect(chip.hasAttribute('role')).toBe(false)
    expect(chip).toHaveTextContent('wk 60% used')
    expect(chip).toHaveTextContent('ctx 31% used')
    expect(chip).not.toHaveTextContent('5h')
    expect(chip).not.toHaveTextContent('mod offline')
    client.session.setMod('offline')
    await waitFor(() => expect(screen.getByTestId('session-chip')).toHaveTextContent('mod offline'))
    expect(screen.getByTestId('session-chip').className).toMatch(/italic/)
  })
  it('the trigger button is named "Session: " plus the words on screen', async () => {
    mount({}, () => <SessionTrigger threadId="general">m</SessionTrigger>)
    // voice control says "click Session": the name must start with it AND keep the visible words
    const button = await screen.findByRole('button', { name: /^Session:.*wk\s*60\s*%\s*used.*ctx\s*31\s*%/ })
    expect(button.hasAttribute('aria-label')).toBe(false)
    expect(within(button).getByText(/^Session:/).className).toMatch(/sr-only/)
  })
  it('usedPct is percent USED (not left), clamped, and the warning starts at 85% used', () => {
    const st = (p: number) =>
      ({
        rate_limits: [
          { kind: 'five_hour', percent: p },
          { kind: 'seven_day', percent: 120 },
        ],
      }) as SessionStateT
    expect(usedPct(st(9), 'seven_day')).toBe(100)
    expect(usedPct(undefined, 'seven_day')).toBeUndefined()
    // an older peer still sends five_hour: it is read without error and shows nowhere
    expect(chipParts(st(9))).toEqual({ week: 100 })
    expect(chipParts({ rate_limits: [{ kind: 'five_hour', percent: 9 }] } as SessionStateT)).toBeUndefined()
    expect(WARN_USED_PCT).toBe(85)
  })
  it('hides the chip with no state and words resets in local time', () => {
    expect(chipParts(undefined)).toBeUndefined()
    const now = Date.parse('2026-10-28T16:00:00.000Z')
    expect(resetWords('2026-10-28T20:10:00.000Z', now)).toMatch(/^resets \d{1,2}:\d{2}/)
    expect(resetWords('2026-10-31T20:10:00.000Z', now)).toMatch(/^resets [A-Z][a-z]{2}$/)
    expect(resetWords('2026-11-20T20:10:00.000Z', now)).toMatch(/^resets [A-Z][a-z]{2} \d+$/)
    expect(resetWords(undefined, now)).toBe('')
  })
})

describe('mod offline and absent', () => {
  it('offline: known data read-only, no controls, one hint, "Mod offline"', async () => {
    mount({ mod: 'offline' })
    await screen.findByTestId('mod-offline')
    expect(screen.getByTestId('session-model')).toHaveTextContent('Opus 5.5')
    expect(screen.queryByTestId('session-controls')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Compact' })).toBeNull()
    expect(screen.getAllByText(INSTALL_HINT)).toHaveLength(1)
  })
  it('absent: no crash, hint once, no controls, "No reading yet" rows', async () => {
    mount({ mod: 'absent' })
    await wait()
    expect(screen.getByTestId('session-panel')).toHaveAttribute('data-phase', 'absent')
    expect(screen.getAllByText(INSTALL_HINT)).toHaveLength(1)
    expect(screen.queryByTestId('session-controls')).toBeNull()
    expect(screen.getAllByText('No reading yet')).toHaveLength(2)
  })
  it('a stale mod state counts as offline', async () => {
    const client = mount()
    await screen.findByTestId('session-controls')
    client.session.pushStale(120_000)
    await waitFor(() => expect(screen.queryByTestId('session-controls')).toBeNull(), { timeout: 8000 })
    expect(screen.getByTestId('mod-offline')).toBeInTheDocument()
  })
})

describe('controls build the right signed frame', () => {
  it('Stop sends action stop with the shown turn_id, only while busy', async () => {
    const client = mount()
    await screen.findByTestId('session-controls')
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    client.session.patch({ busy: true, turn_id: 'turn_77' })
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(sentControls(client)).toHaveLength(1))
    const f = sentControls(client)[0] as Record<string, unknown>
    expect(SessionControlFrame.safeParse(f).success).toBe(true)
    expect(f).toMatchObject({ action: 'stop', turn_id: 'turn_77', thread_id: 'general' })
    expect(typeof f.control_id).toBe('string')
    await waitFor(() => expect(screen.getByTestId('session-outcome')).toHaveTextContent('Stopped.'))
  })
  it('Compact says "Compacts after this turn" while busy', async () => {
    const client = mount()
    await screen.findByTestId('session-controls')
    client.session.patch({ busy: true, turn_id: 't1' })
    expect(await screen.findByText('Compacts after this turn')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Compact' }))
    await waitFor(() => expect(screen.getByTestId('session-outcome')).toHaveTextContent('Compacts after this turn.'))
    expect(sentControls(client)[0]).toMatchObject({ action: 'compact' })
  })
  it('model switch: reread warning is inline, tap sends command model, success text shows', async () => {
    const client = mount()
    await userEvent.click(await screen.findByRole('button', { name: /^Model/ }))
    expect(screen.getByTestId('model-reread')).toHaveTextContent('Switching re-reads the whole conversation')
    expect(screen.getByText('Also becomes the default for new sessions.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Sonnet' }))
    await waitFor(() => expect(sentControls(client)).toHaveLength(1))
    const f = sentControls(client)[0] as Record<string, unknown>
    expect(SessionControlFrame.safeParse(f).success).toBe(true)
    expect(f).toMatchObject({ action: 'command', command: 'model', source: 'builtin', args: 'sonnet' })
    await waitFor(() => expect(screen.getByTestId('session-model')).toHaveTextContent('Sonnet 5.5'))
  })
  it('a pending model switch is calm, not an error', async () => {
    mount()
    await userEvent.click(await screen.findByRole('button', { name: /^Model/ }))
    await userEvent.click(screen.getByRole('radio', { name: 'Haiku' }))
    const line = await screen.findByText('Waiting for confirmation at the Mac.')
    expect(line).toHaveAttribute('data-kind', 'pending')
    expect(line.className).not.toMatch(/danger/)
  })
  it('credits models carry the credits note', async () => {
    const client = mount()
    client.store.setState((s) =>
      s.config ? { ...s, config: { ...s.config, session_models: ['default', 'fable'] } } : s,
    )
    client.session.setInventory({
      ...(client.session.inventory() as never as { commands: [] }),
      models: [
        { value: 'default', label: 'Default' },
        { value: 'fable', label: 'Fable' },
      ],
    } as never)
    await userEvent.click(await screen.findByRole('button', { name: /^Model/ }))
    expect(
      await screen.findByText('May use usage credits. The consent prompt appears only at the Mac.'),
    ).toBeInTheDocument()
  })
  it('effort sends command effort; auto is offered; notes show', async () => {
    const client = mount()
    const group = await screen.findByRole('radiogroup', { name: 'Effort' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'auto'])
    expect(screen.getByText(/Applies from the next message/)).toBeInTheDocument()
    expect(screen.getByText('This model always thinks; effort sets how much.')).toBeInTheDocument()
    expect(screen.queryByTestId('effort-may-ask')).toBeNull()
    await userEvent.click(within(group).getByRole('radio', { name: 'max' }))
    await waitFor(() => expect(sentControls(client)).toHaveLength(1))
    expect(sentControls(client)[0]).toMatchObject({ action: 'command', command: 'effort', args: 'max' })
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: 'max' })).toHaveAttribute('aria-checked', 'true'),
    )
  })
  it('effort marks "May ask at the Mac" on a model that does not keep the cache', async () => {
    const client = mount()
    await screen.findByRole('radiogroup', { name: 'Effort' })
    client.session.patch({ model: { id: 'claude-opus-4-1', display: 'Opus 4.1' } })
    expect(await screen.findByTestId('effort-may-ask')).toHaveTextContent('May ask at the Mac')
  })
  it('New conversation asks in-app first, then sends clear', async () => {
    const client = mount()
    await userEvent.click(await screen.findByRole('button', { name: 'New conversation' }))
    expect(sentControls(client)).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Start new' }))
    await waitFor(() => expect(sentControls(client)).toHaveLength(1))
    expect(sentControls(client)[0]).toMatchObject({ action: 'clear' })
    expect(sentControls(client)[0]).not.toHaveProperty('args')
  })
})

describe('failures show the result text', () => {
  it.each([
    ['model_switch_denied', 'Your PreModelSwitch hook refused: no Opus before noon.'],
    ['control_stale', 'That tap is more than 2 minutes old. Try again.'],
    ['turn_mismatch', 'That turn already ended. Nothing was stopped.'],
    ['capability_missing', 'This Claude Code cannot do that.'],
  ] as const)('%s', async (code, text) => {
    const client = mount()
    await screen.findByTestId('session-controls')
    client.session.failNext(code, text)
    await userEvent.click(screen.getByRole('button', { name: 'Compact' }))
    const line = await screen.findByText(text)
    expect(line).toHaveAttribute('data-kind', 'error')
  })
  it('stopped_at_mac shows the fixed sentence', async () => {
    const client = mount()
    await screen.findByTestId('session-controls')
    client.session.failNext('stopped_at_mac', 'whatever the engine said')
    await userEvent.click(screen.getByRole('button', { name: 'Compact' }))
    expect(await screen.findByText('Stopped at the Mac. Send a message to continue.')).toBeInTheDocument()
  })
  it('no answer within the wait says so', async () => {
    const client = setup()
    const ctl = createSessionController(client, { timeoutMs: 40 })
    ctl.start()
    await wait()
    client.session.mute(true)
    const o = await ctl.compact('general')
    expect(o).toMatchObject({ kind: 'error', text: 'The Mac did not answer' })
    expect(Object.keys(ctl.store.getState().pending)).toHaveLength(0)
  })
  it('refuses on the phone, before sending, what the policy would refuse', async () => {
    const client = setup()
    const ctl = createSessionController(client)
    ctl.start()
    await wait()
    const o = await ctl.stopTurn('general') // not busy: no turn to stop
    expect(o).toMatchObject({ kind: 'error', local: true })
    const o2 = await ctl.command('general', 'model', 'gpt-9')
    expect(o2).toMatchObject({ kind: 'error', local: true, code: 'model_not_allowed' })
    expect(sentControls(client)).toHaveLength(0)
  })
  it('a client that cannot send owner frames says so', async () => {
    const client = setup()
    const bare = { ...client, sendOwnerFrame: undefined } as never
    const ctl = createSessionController(bare)
    ctl.start()
    await wait()
    expect(await ctl.compact('general')).toMatchObject({ kind: 'error', local: true })
  })
})

describe('tabs', () => {
  it('lists commands by group with route badges and the Mac-only mark', async () => {
    mount()
    const panel = await screen.findByTestId('session-panel')
    for (const g of ['Built-in', 'Skills', 'Plugins', 'MCP prompts'])
      expect(within(panel).getByRole('region', { name: g })).toBeInTheDocument()
    const skills = within(panel).getByRole('region', { name: 'Skills' })
    expect(within(skills).getByText('/deploy').closest('li')).toHaveTextContent('At the Mac only')
    expect(within(skills).getByText('/release-notes').closest('li')).toHaveTextContent('Sends as message')
    expect(
      within(within(panel).getByRole('region', { name: 'Built-in' }))
        .getByText('/context')
        .closest('li'),
    ).toHaveTextContent('Runs here')
  })
  it('lists MCP servers and plugins', async () => {
    mount()
    await userEvent.click(await screen.findByRole('tab', { name: 'MCP servers' }))
    expect(await screen.findByText('github')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    expect(await screen.findByText('old-linter')).toBeInTheDocument()
  })
})

describe('composer / picker', () => {
  const composer = (opts: FakeClientOptions = {}) => mount(opts, () => <Composer threadId="general" />)
  const box = () => screen.getByLabelText('Message')

  it('opens on "/", groups with badges, greys built-ins that are Mac-only, filters as you type', async () => {
    composer()
    await wait()
    await userEvent.type(box(), '/')
    const list = await screen.findByRole('listbox', { name: 'Commands' })
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(8)
    const perms = within(list).getByText('/permissions').closest('[role=option]') as HTMLElement
    expect(perms).toHaveAttribute('aria-disabled', 'true')
    expect(perms).toHaveTextContent('Run this at the Mac')
    const deploy = within(list).getByText('/deploy').closest('[role=option]') as HTMLElement
    expect(deploy).toHaveAttribute('aria-disabled', 'true')
    await userEvent.type(box(), 'rel')
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.getAttribute('data-name')),
    ).toEqual(['release-notes'])
  })
  it('keyboard: arrows move, Enter picks a skill and sends the plain text message, Esc closes', async () => {
    const client = composer()
    await wait()
    await userEvent.type(box(), '/rel')
    expect(box()).toHaveAttribute('aria-activedescendant')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(client.sent.some((f) => f.type === 'message')).toBe(true))
    const msg = client.sent.find((f) => f.type === 'message') as Record<string, unknown>
    expect(msg.text).toBe('/release-notes')
    expect(sentControls(client)).toHaveLength(0)
    expect(box()).toHaveValue('')
    await userEvent.type(box(), '/')
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    const opts = screen.getAllByRole('option')
    expect(opts[2]).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowUp}')
    expect(opts[1]).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('picking a greyed built-in does nothing but say so', async () => {
    const client = composer()
    await wait()
    await userEvent.type(box(), '/perm')
    await userEvent.click(await screen.findByText('/permissions'))
    expect(await screen.findByTestId('composer-note')).toHaveTextContent('Run this at the Mac.')
    expect(client.sent.filter((f) => f.type === 'message' || f.type === 'session.control')).toHaveLength(0)
  })
  it('picking /compact runs the own action; typing /clear maps to it too', async () => {
    const client = composer()
    await wait()
    await userEvent.type(box(), '/compa')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(sentControls(client)).toHaveLength(1))
    expect(sentControls(client)[0]).toMatchObject({ action: 'compact' })
    await userEvent.type(box(), '/clear')
    await userEvent.keyboard('{Escape}{Enter}')
    await waitFor(() => expect(sentControls(client)).toHaveLength(2))
    expect(sentControls(client)[1]).toMatchObject({ action: 'clear' })
    expect(client.sent.filter((f) => f.type === 'message')).toHaveLength(0)
  })
  it('a command that needs an argument keeps typing: /model becomes "/model "', async () => {
    const client = composer()
    await wait()
    await userEvent.type(box(), '/model')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(box()).toHaveValue('/model '))
    await userEvent.type(box(), 'sonnet{Enter}')
    await waitFor(() => expect(sentControls(client)).toHaveLength(1))
    expect(sentControls(client)[0]).toMatchObject({ action: 'command', command: 'model', args: 'sonnet' })
  })
  it('with no inventory: one install hint, the composer still sends normally', async () => {
    const client = composer({ mod: 'absent' })
    await wait()
    await userEvent.type(box(), '/')
    expect(await screen.findByTestId('slash-hint')).toHaveTextContent(INSTALL_HINT)
    await userEvent.type(box(), 'compact{Enter}')
    await waitFor(() => expect(client.sent.some((f) => f.type === 'message')).toBe(true))
    expect((client.sent.find((f) => f.type === 'message') as Record<string, unknown>).text).toBe('/compact')
  })
  it('a skill with a typed argument goes out as an ordinary message', async () => {
    const client = composer()
    await wait()
    await userEvent.type(box(), '/release-notes v2{Enter}')
    await waitFor(() => expect(client.sent.some((f) => f.type === 'message')).toBe(true))
    expect((client.sent.find((f) => f.type === 'message') as Record<string, unknown>).text).toBe('/release-notes v2')
  })
  it('plain text is unaffected', async () => {
    const client = composer()
    await wait()
    await userEvent.type(box(), 'hello{Enter}')
    await waitFor(() => expect(client.sent.some((f) => f.type === 'message')).toBe(true))
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('filter', () => {
  it('ranks prefix matches first', () => {
    const cmds = [
      { name: 'x-review', description: 'a', source: 'user', route: 'message' },
      { name: 'review', description: 'b', source: 'user', route: 'message' },
    ] as never
    expect((filterCommands(cmds, 'rev') as { name: string }[]).map((c) => c.name)).toEqual(['review', 'x-review'])
  })
})

vi.setConfig({ testTimeout: 15000 })
