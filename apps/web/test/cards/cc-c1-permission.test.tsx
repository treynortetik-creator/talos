// WP-C1 (docs/CLAUDE-CODE.md C3.2): the permission card. Allow is one tap on the card's face (owner, 2026-11-21); the whole call is
// behind Details, never cut by the app, with Claude's own summary after it; a card that does not show all of its
// call keeps Allow with a note saying what is missing (only a repeated id has none), and an old card says it may already have
// been answered at the Mac.
import {
  composePermissionCard,
  PERMISSION_OLD_CLIENT_WARNING,
  PERMISSION_REPEAT_WARNING,
  permissionHiddenWarning,
} from '@talos-app/protocol'
import { permissionFixtures } from '@talos-app/testkit'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { approvalIsOpen } from '../../src/lib/approvalOpen.ts'
import { installAlwaysVisible } from '../helpers/intersection.ts'
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

let restoreIO = () => {}
beforeEach(() => {
  restoreIO = installAlwaysVisible()
})
afterEach(() => {
  restoreIO()
  vi.useRealTimers()
})

const open = async () => {
  await userEvent.click(screen.getByTestId('permission-open'))
  return screen.getByTestId('approval-sheet')
}
const allowBtn = () =>
  within(screen.getByTestId('approval-sheet')).getByRole('button', { name: /^Allow/ }) as HTMLButtonElement

describe('the compact card in the thread', () => {
  it('shows the start of the call, the tail, Deny, and a way into the sheet; Allow is not in the thread', () => {
    const c = make({ input_preview: `${'a'.repeat(400)}; rm -rf ~` })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const preview = screen.getByTestId('permission-preview')
    expect(preview.textContent?.endsWith('…')).toBe(true)
    expect(preview.textContent?.length).toBeLessThan(200)
    expect(screen.getByTestId('permission-tail').textContent).toContain('; rm -rf ~')
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy() // one tap, on the face
    expect(screen.queryByTestId('approval-sheet')).toBeNull()
    expect(approvalIsOpen()).toBe(false)
  })

  it('Allow on the card face is one tap: it sends a primary resolve with the rendered hash and opens no sheet', async () => {
    const c = make()
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(true))
    expect(client.sent.at(-1)).toMatchObject({
      type: 'card.resolve',
      card_id: c.id,
      action: 'primary',
      payload_hash: c.payload_hash,
    })
    expect(client.sent.at(-1)).not.toHaveProperty('always')
    expect(screen.queryByTestId('approval-sheet')).toBeNull()
    expect(approvalIsOpen()).toBe(false)
  })

  it('offers no Always allow (a permission rule needs Claude Code to suggest one first), even with the feature on', () => {
    const c = make()
    const client = setup({ cards: [c] })
    client.store.setState((st) => ({ ...st, presence: { ...st.presence, features: ['always-allow/1'] } }))
    renderWith(<LiveCard id={c.id} />, client)
    expect(screen.queryByRole('button', { name: /^Always allow/ })).toBeNull()
  })

  it('a card with no Allow shows no Allow on the face either', () => {
    const c = make({}, { repeated: true })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  })

  it('a card with no Allow (a repeated id) keeps the whole call in its scrolling box and has no way into the sheet', () => {
    const c = make({}, { repeated: true })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByTestId('permission-call').className).toContain('max-h-80')
    expect(screen.queryByTestId('permission-open')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain(PERMISSION_REPEAT_WARNING)
  })

  it('a card with a part Claude Code hid keeps its way into the sheet, with the note naming what is not shown', () => {
    const c = make({ input_preview: '{"command": "cat <<EOF \u22ef 4812 code points elided \u22ef EOF"}' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain(permissionHiddenWarning(['elided']))
    expect(screen.getByRole('status').textContent).not.toMatch(/at the Mac/)
  })

  it('has no Edit, no menu and no "tell Talos what to change"', () => {
    const c = make()
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
    expect(screen.queryByText(/what to change/i)).toBeNull()
  })

  it('Deny from the thread sends card.resolve kill with the app-computed hash', async () => {
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
})

describe('the full-screen approval sheet', () => {
  it('opens when the card is tapped, shows the whole call, the summary and the pinned tail, and owns the screen', async () => {
    const c = make({ input_preview: 'echo <img src=x onerror=alert(1)>', description: 'Say hi **bold**' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const sheet = await open()
    expect(sheet.style.position).toBe('fixed')
    expect(Number(sheet.style.zIndex)).toBeGreaterThan(1_000_000)
    const call = within(sheet).getByTestId('permission-call')
    expect(call.textContent).toBe(c.body)
    expect(call.querySelector('img')).toBeNull()
    expect(within(sheet).getByTestId('permission-summary').textContent).toContain('Say hi **bold**')
    expect(within(sheet).getByTestId('permission-tail').textContent).toContain('onerror=alert(1)>')
    expect(within(sheet).getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(approvalIsOpen()).toBe(true) // every floating thing is told to stand down
  })

  it('does not open by itself when the card is opened from a push or /card/:id (highlighted): the card is armed, Details is there', () => {
    const c = make()
    renderWith(<LiveCard id={c.id} highlighted />, setup({ cards: [c] }))
    expect(screen.queryByTestId('approval-sheet')).toBeNull()
    expect(approvalIsOpen()).toBe(false)
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy()
  })

  it('Close closes it without sending anything and clears the flag', async () => {
    const c = make()
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await open()
    await userEvent.click(screen.getByTestId('approval-close'))
    expect(screen.queryByTestId('approval-sheet')).toBeNull()
    expect(approvalIsOpen()).toBe(false)
    expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(false)
  })

  it('is sized from the visual viewport, so a keyboard or a pan cannot move it', async () => {
    const listeners: Record<string, () => void> = {}
    const vv = {
      offsetTop: 0,
      offsetLeft: 0,
      width: 320,
      height: 500,
      scale: 1,
      addEventListener: (n: string, f: () => void) => {
        listeners[n] = f
      },
      removeEventListener: () => {},
    }
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
    const c = make()
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const sheet = await open()
    expect([sheet.style.width, sheet.style.height]).toEqual(['320px', '500px'])
    vv.height = 260 // the keyboard came up
    vv.offsetTop = 40 // and the browser panned
    act(() => listeners.resize?.())
    expect([sheet.style.height, sheet.style.top]).toEqual(['260px', '40px'])
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
  })

  it('Allow from the sheet is enabled at once and sends a primary resolve with the same hash', async () => {
    const c = make()
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await open()
    expect(allowBtn().disabled).toBe(false)
    await userEvent.click(allowBtn())
    await waitFor(() => expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(true))
    expect(c.risk).toBe('low')
    expect(client.sent.at(-1)).toMatchObject({
      type: 'card.resolve',
      card_id: c.id,
      action: 'primary',
      payload_hash: c.payload_hash,
    })
  })

  it('Deny from the sheet sends a kill; the call need not have been read', async () => {
    const c = make({ input_preview: 'x'.repeat(5000) })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await open()
    expect(allowBtn().disabled).toBe(false)
    const deny = within(screen.getByTestId('approval-sheet')).getByRole('button', { name: 'Deny' }) as HTMLButtonElement
    expect(deny.disabled).toBe(false)
    await userEvent.click(deny)
    await waitFor(() => expect(client.sent.at(-1)).toMatchObject({ action: 'kill', card_id: c.id }))
  })

  it('hidden characters are shown as markers, CJK and emoji as they are, and the call stays approvable', async () => {
    const c = make({ input_preview: 'echo ok \u202e~ fr- mr \u6f22\u5b57 \u{1F600}' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const sheet = await open()
    const text = within(sheet).getByTestId('permission-call').textContent ?? ''
    expect(text).toContain('[U+202E]')
    expect(text).not.toContain('\u202e')
    expect(text).toContain('\u6f22\u5b57 \u{1F600}')
    await waitFor(() => expect(allowBtn().disabled).toBe(false))
  })
})

describe('nothing may run off the side of the sheet', () => {
  it('keeps clear of the notch: header, scroll area and footer pad left and right by the safe-area insets (landscape iPhone)', async () => {
    const c = make()
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const sheet = await open()
    const parts = [
      within(sheet).getByTestId('approval-scroll'),
      within(sheet).getByRole('heading', { name: /Allow Bash/ }).parentElement as HTMLElement,
      within(sheet).getByRole('button', { name: 'Deny' }).closest('div.border-t') as HTMLElement,
    ]
    for (const el of parts) {
      expect(el, 'part present').toBeTruthy()
      expect(el.className).toContain('pl-[max(0.75rem,env(safe-area-inset-left))]')
      expect(el.className).toContain('pr-[max(0.75rem,env(safe-area-inset-right))]')
    }
    expect(parts[1]?.className).toContain('pt-[max(0.75rem,env(safe-area-inset-top))]')
    expect(parts[2]?.className).toContain('pb-[max(0.75rem,env(safe-area-inset-bottom))]')
  })

  it('wraps anywhere: the call, the summary, the title and the tail carry overflow-wrap anywhere and break-all', async () => {
    const c = make({ input_preview: `echo ${'\u1100'.repeat(300)}SECRETTAIL` })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const sheet = await open()
    for (const el of [
      within(sheet).getByTestId('permission-call'),
      within(sheet).getByTestId('permission-summary').querySelector('p:last-child') as HTMLElement,
      within(sheet).getByTestId('permission-tail'),
      within(sheet).getByRole('heading', { name: /Allow Bash/ }),
    ]) {
      expect(el.className).toContain('[overflow-wrap:anywhere]')
      expect(el.className).toContain('break-all')
    }
  })
})

describe('the sheet gates nothing: no scroll gate, no zoom gate, no hint', () => {
  it('Allow is enabled with a long call unread and no IntersectionObserver at all', async () => {
    const g = globalThis as unknown as { IntersectionObserver: unknown }
    const saved = g.IntersectionObserver
    g.IntersectionObserver = undefined
    const c = make({ input_preview: 'x'.repeat(5000) })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    await open()
    expect(allowBtn().disabled).toBe(false)
    expect(screen.queryByTestId('approval-hint')).toBeNull()
    expect(screen.queryByTestId('approval-end')).toBeNull()
    g.IntersectionObserver = saved
  })

  it('a pinch zoom does not disable Allow', async () => {
    const listeners: Record<string, () => void> = {}
    const vv = {
      offsetTop: 0,
      offsetLeft: 0,
      width: 320,
      height: 500,
      scale: 2.2,
      addEventListener: (n: string, f: () => void) => {
        listeners[n] = f
      },
      removeEventListener: () => {},
    }
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv })
    const c = make()
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    await open()
    expect(allowBtn().disabled).toBe(false)
    expect(screen.queryByTestId('approval-hint')).toBeNull()
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
  })
})

describe('Allow on every card but a repeated id (every fixture)', () => {
  for (const fx of permissionFixtures) {
    it(`${fx.name}: ${fx.allow ? 'Allow on the face' : 'Deny only'}`, () => {
      const c = make(fx.params, { card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E1', ...(fx.repeated ? { repeated: true } : {}) })
      renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
      expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: 'Allow' }) !== null).toBe(fx.allow)
      if (fx.repeated) expect(screen.getByRole('status').textContent).toContain(PERMISSION_REPEAT_WARNING)
      else if (fx.hidden.length > 0)
        expect(screen.getByRole('status').textContent).toContain(permissionHiddenWarning(fx.hidden))
    })
  }

  it('an old Claude Code (below 2.1.234) says so and keeps the way to Allow', () => {
    const c = make({}, { client_version: '2.1.210' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByText(PERMISSION_OLD_CLIENT_WARNING)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy()
  })

  it('a tampered card (body changed after hashing) is not offered at all', () => {
    const c = { ...make(), body: '{"command": "rm -rf /"}' }
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })

  it('another channel adds a one-line note and the way to Allow stays', () => {
    const c = make({}, { other_channels: ['discord'] })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy()
    // the note lives with the warning line of the card
    expect(c.warning).toBe('discord can also approve this.')
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

// A call with no description (a Bash call Claude gave none for): never a bare "Claude's summary" heading with nothing under
// it (the owner's phone, 2026-11-12 19:04, a long heredoc). Blank means empty or only spaces. The protocol already shows a
// line break or a tab as a mark (⏎ ⇥), and an invisible character as [U+XXXX]: those are shown, not replaced.
describe('a call with no description', () => {
  const HEREDOC = `{"command": "cat > /tmp/t/run.sh <<'EOF'\\n${'echo step\\n'.repeat(300)}EOF\\nbash /tmp/t/run.sh"}`
  for (const [name, description, input_preview] of [
    ['empty', '', undefined],
    ['only spaces', '   ', undefined],
    ['empty, on a long heredoc', '', HEREDOC],
  ] as const) {
    it(`${name}: the sheet says "No description given" under the heading`, async () => {
      const c = make({ description, ...(input_preview ? { input_preview } : {}) })
      renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
      const s = within(await open()).getByTestId('permission-summary')
      expect(s.textContent).toBe("Claude's summaryNo description given")
    })
    it(`${name}: a card without Allow says it in the thread too`, () => {
      const c = make({ description, ...(input_preview ? { input_preview } : {}) }, { repeated: true })
      renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
      expect(screen.getByTestId('permission-summary').textContent).toBe("Claude's summaryNo description given")
    })
  }
  it('line breaks and tabs are not blank: their marks are shown, not replaced', async () => {
    const c = make({ description: '\n\t \n' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const s = within(await open()).getByTestId('permission-summary')
    expect(s.textContent).toBe("Claude's summary\u23ce\u21e5 \u23ce")
  })
  it('an invisible character is not blank: it is shown, not replaced', async () => {
    const c = make({ description: '​' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    const s = within(await open()).getByTestId('permission-summary')
    expect(s.textContent).not.toContain('No description given')
    expect(s.textContent).toContain('U+200B')
  })
  it('a real description is shown as before', async () => {
    const c = make({ description: 'Run the tests' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(within(await open()).getByTestId('permission-summary').textContent).toBe("Claude's summaryRun the tests")
  })
})
