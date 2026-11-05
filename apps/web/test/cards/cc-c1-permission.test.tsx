// WP-C1 (docs/CLAUDE-CODE.md C3.2): the permission card. The raw call comes first and is never cut by the app, Claude's
// own summary comes after it, Allow exists only when the whole call is on screen, and an old card says it may already
// have been answered at the Mac.
import { composePermissionCard, PERMISSION_HIDDEN_WARNING, PERMISSION_OLD_CLIENT_WARNING } from '@talos-app/protocol'
import { permissionFixtures } from '@talos-app/testkit'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveCard, renderWith, setup } from './helpers.tsx'

const NOW = Date.parse('2026-10-28T15:00:00.000Z')
const make = (
  over: Partial<Parameters<typeof composePermissionCard>[0]['request']> = {},
  extra: Partial<Parameters<typeof composePermissionCard>[0]> = {},
) =>
  composePermissionCard({
    request: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run the tests',
      input_preview: '{"command": "pnpm test"}',
      ...over,
    },
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
    thread_id: 'general',
    now: NOW,
    client_version: '2.1.312',
    ...extra,
  })

afterEach(() => vi.useRealTimers())

describe('permission card layout', () => {
  it("shows the raw call first, then Claude's summary, as plain text", () => {
    const c = make({
      input_preview: '{"command": "echo <img src=x onerror=alert(1)>"}',
      description: 'Say hi **bold**',
    })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const call = screen.getByTestId('permission-call')
    const summary = screen.getByTestId('permission-summary')
    expect(call.textContent).toBe(c.body)
    expect(call.className).toContain('font-mono')
    expect(call.querySelector('img')).toBeNull()
    expect(summary.textContent).toContain('Say hi **bold**')
    expect(call.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Allow Bash?' })).toBeTruthy()
  })

  it('never cuts a long call: no clamp, no "Show all", the whole text is in the page', () => {
    const long = JSON.stringify({ command: Array.from({ length: 60 }, (_, i) => `echo line-${i}`).join('\n') })
    const c = make({ input_preview: long })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByRole('button', { name: /show all/i })).toBeNull()
    const call = screen.getByTestId('permission-call')
    expect(call.className).not.toContain('line-clamp')
    expect(call.textContent).toBe(c.body)
    expect(call.textContent).toContain('line-59')
  })

  it('has no Edit, no menu and no "tell Talos what to change"', () => {
    const c = make()
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByText(/what to change/i)).toBeNull()
  })

  it('Deny sends card.resolve kill with the app-computed hash', async () => {
    const c = make()
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(true))
    expect(client.sent.at(-1)).toMatchObject({
      type: 'card.resolve',
      card_id: c.id,
      action: 'kill',
      payload_hash: c.payload_hash,
    })
  })

  it('Allow (high risk) takes a step-up, then sends a primary resolve with the same hash', async () => {
    const c = make()
    const client = setup({ cards: [c] })
    const stepup = vi.spyOn(client, 'stepup')
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: /^Allow/ }))
    await waitFor(() => expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(true))
    expect(stepup).toHaveBeenCalledWith(`card:${c.id}`)
    expect(client.sent.at(-1)).toMatchObject({
      type: 'card.resolve',
      card_id: c.id,
      action: 'primary',
      payload_hash: c.payload_hash,
    })
  })
})

describe('Allow only for a whole, safe call (every fixture)', () => {
  for (const fx of permissionFixtures) {
    it(`${fx.name}: ${fx.allow ? 'Allow and Deny' : 'Deny only'}`, () => {
      const c = make(fx.params, { card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E1', ...(fx.repeated ? { repeated: true } : {}) })
      renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
      expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /^Allow/ }) !== null).toBe(fx.allow)
      if (!fx.allow) expect(screen.getByRole('status').textContent).toMatch(/at the Mac/)
    })
  }

  it('a hidden part shows the hidden warning and nothing that looks like Allow', () => {
    const c = make({ input_preview: '{"command": "cat <<EOF ⋯ 4812 code points elided ⋯ EOF"}' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByText(PERMISSION_HIDDEN_WARNING)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull()
  })

  it('a right-to-left override is shown as [U+202E], not obeyed, and there is no Allow', () => {
    const c = make({ input_preview: '{"command": "echo ok ‮~ fr- mr"}' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const call = screen.getByTestId('permission-call')
    expect(call.textContent).toContain('[U+202E]')
    expect(call.textContent).not.toContain('‮')
    expect(screen.queryByRole('button', { name: /^Allow/ })).toBeNull()
  })

  it('an old Claude Code (below 2.1.211) says so and has no Allow', () => {
    const c = make({}, { client_version: '2.1.210' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByText(PERMISSION_OLD_CLIENT_WARNING)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Allow/ })).toBeNull()
  })

  it('a tampered card (body changed after hashing) is not offered at all', () => {
    const c = { ...make(), body: '{"command": "rm -rf /"}' }
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByRole('button', { name: /^Allow/ })).toBeNull()
  })
})

describe('fix round: notes and visible controls', () => {
  it('another channel adds a one-line note and Allow stays', () => {
    const c = make({}, { other_channels: ['discord'] })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByText('discord can also approve this.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Allow/ })).toBeTruthy()
  })
  it('a newline in the call shows as ⏎ and there is no Allow', () => {
    const c = make({ input_preview: '{"command": "echo hi\nrm -rf ~"}' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByTestId('permission-call').textContent).toContain('echo hi⏎rm -rf ~')
    expect(screen.queryByRole('button', { name: /^Allow/ })).toBeNull()
  })
})

describe('"May already be answered at the Mac"', () => {
  it('appears 60 s after the request, not before', () => {
    vi.useFakeTimers({ now: NOW + 5_000 })
    const c = make()
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByText('May already be answered at the Mac')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByText('May already be answered at the Mac')).toBeTruthy()
    // Allow and Deny stay: the line is a hint, the bridge decides
    expect(within(screen.getByRole('article')).getByRole('button', { name: 'Deny' })).toBeTruthy()
  })
})
