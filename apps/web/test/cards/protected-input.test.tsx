// Inside the Mac app, an agent that drives Talos with synthetic clicks and keys can never answer a card (docs/SECURITY.md "An agent
// in Talos"). The page half of that is a script the Mac app injects (apps/desktop ProtectedInputScript.swift); this file runs that
// very script, byte for byte, against the real card components. The native half (who sent each event) is the Swift tests and the
// GUI test: here the stamp the window would send is set by hand.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALWAYS_ALLOW_FEATURE, composeDialogCard, composePermissionCard } from '@talos-app/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { installAlwaysVisible } from '../helpers/intersection.ts'
import { LiveCard, makeCard, renderWith, setup } from './helpers.tsx'

const SWIFT = join(import.meta.dirname, '../../../desktop/Sources/TalosDesktopCore/ProtectedInputScript.swift')

/** The text between the markers in the Swift file, with the one test-only change: jsdom's own events are never `isTrusted`. */
function scriptText(): string {
  const file = readFileSync(SWIFT, 'utf8')
  const m = file.match(/\/\/ begin-script\n[^\n]*#"""\n([\s\S]*?)\n\s*"""#\n\s*\/\/ end-script/)
  if (!m) throw new Error('the script markers are not in ProtectedInputScript.swift')
  const text = m[1] as string
  expect(text.match(/const REQUIRE_TRUSTED = true;/g)).toHaveLength(1)
  return text.replace('const REQUIRE_TRUSTED = true;', 'const REQUIRE_TRUSTED = false;')
}

const dropped = vi.fn()
type Stamp = (origin: 'human' | 'synthetic', type: string, token?: number, keyCode?: number) => void
const stamp: Stamp = (o, t, tok, code) =>
  (window as unknown as { __talosGuardStamp: Stamp }).__talosGuardStamp(o, t, tok, code)
const ack = (token: number) => (window as unknown as { __talosGuardAck: (t: number) => void }).__talosGuardAck(token)
const KEY_CODE: Record<string, number> = { Enter: 36, ' ': 49 }
let now = 1000

beforeAll(() => {
  ;(window as unknown as { webkit: unknown }).webkit = { messageHandlers: { talosGuard: { postMessage: dropped } } }
  new Function(scriptText())()
})
let restoreIO = () => {}
beforeEach(() => {
  restoreIO = installAlwaysVisible()
  now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  dropped.mockClear()
  stamp('synthetic', 'none') // each test starts with nothing human
})
afterEach(() => {
  restoreIO()
  vi.restoreAllMocks()
})

/** Lets a card's answer (signed, then sent) finish, so an expected-nothing check is not just early. */
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 60))))
const resolves = (c: ReturnType<typeof setup>) => c.sent.filter((f) => f.type === 'card.resolve')
/** What the window does for a person's click: stamp the press, the release, then the browser's click (a pointer click: detail 1). */
const humanClick = (el: Element, token = 0) => {
  stamp('human', 'leftMouseDown', token)
  fireEvent.mouseDown(el)
  stamp('human', 'leftMouseUp', token)
  fireEvent.mouseUp(el)
  fireEvent.click(el, { detail: 1 })
}
/** An agent's click: the window stamps it synthetic (with the token of its request), and the same events follow. */
const agentClick = (el: Element, token = 0) => {
  stamp('synthetic', 'leftMouseDown', token)
  fireEvent.mouseDown(el)
  stamp('synthetic', 'leftMouseUp', token)
  fireEvent.mouseUp(el)
  fireEvent.click(el, { detail: 1 })
}
const press = (el: Element, key: string, origin: 'human' | 'synthetic', token = 0) => {
  stamp(origin, 'keyDown', token, KEY_CODE[key])
  const down = fireEvent.keyDown(el, { key })
  // a button turns Enter (on press) and Space (on release) into a click with no pointer (detail 0), as the browser does
  if (down && key === 'Enter') fireEvent.click(el)
  stamp(origin, 'keyUp', token, KEY_CODE[key])
  const up = fireEvent.keyUp(el, { key })
  if (up && key === ' ') fireEvent.click(el)
}
/** The rest of the event loop turn: what the page does "after" an event. */
const nextTurn = () => new Promise((r) => setTimeout(r, 0))

describe('every button that answers a card ignores an agent and obeys the owner', () => {
  it('Send, Kill, Edit and Always allow on a send card', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    client.store.setState((s) => ({ ...s, presence: { ...s.presence, features: [ALWAYS_ALLOW_FEATURE] } }))
    renderWith(<LiveCard id={card.id} />, client)
    for (const name of ['Send', 'Kill draft', 'Always allow emails']) agentClick(screen.getByRole('button', { name }))
    await settle()
    expect(resolves(client)).toHaveLength(0)
    expect(dropped).toHaveBeenCalled()
    humanClick(screen.getByRole('button', { name: 'Always allow emails' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    await settle()
    expect(resolves(client)).toHaveLength(1)
    expect(resolves(client)[0]).toMatchObject({ action: 'primary', always: true })
  })

  it('a click with no stamp at all (an Accessibility press, a lost message) answers nothing', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settle()
    expect(resolves(client)).toHaveLength(0)
  })

  it('a stale human stamp is not a person: it lapses', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    const send = screen.getByRole('button', { name: 'Send' })
    stamp('human', 'leftMouseUp')
    now += 701
    fireEvent.click(send, { detail: 1 })
    await settle()
    expect(resolves(client)).toHaveLength(0)
  })

  it("a person's stamp is spent by the click it let through: a second click with no new press does nothing", async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    const send = screen.getByRole('button', { name: 'Send' })
    stamp('human', 'leftMouseUp')
    fireEvent.click(send, { detail: 1 })
    fireEvent.click(send, { detail: 1 })
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    await settle()
    expect(resolves(client)).toHaveLength(1)
  })

  it('an agent event right after the owner’s presses nothing: the newest stamp is the agent’s', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    stamp('human', 'leftMouseUp')
    stamp('synthetic', 'leftMouseUp')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }), { detail: 1 })
    await settle()
    expect(resolves(client)).toHaveLength(0)
  })

  it('Return and Space on the focused button: an agent’s do nothing, the owner’s answer', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    const send = screen.getByRole('button', { name: 'Send' })
    send.focus()
    press(send, 'Enter', 'synthetic')
    press(send, ' ', 'synthetic')
    await settle()
    expect(resolves(client)).toHaveLength(0)
    expect(dropped).toHaveBeenCalled()
    press(send, 'Enter', 'human')
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    await settle()
    expect(resolves(client)).toHaveLength(1)
  })

  it('Space as the owner’s own key also answers (the click comes on release)', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    const send = screen.getByRole('button', { name: 'Send' })
    send.focus()
    press(send, ' ', 'human')
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    await settle()
    expect(resolves(client)).toHaveLength(1)
  })

  it('a permission card: Deny, and Allow inside the approval sheet', async () => {
    const c = composePermissionCard({
      request: {
        request_id: 'abcde',
        tool_name: 'Bash',
        description: 'Run the tests',
        input_preview: '{"command": "pnpm test"}',
      },
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
      thread_id: 'general',
      now: Date.parse('2026-10-28T15:00:00.000Z'),
      client_version: '2.1.312',
    })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} highlighted />, client)
    const sheet = screen.getByTestId('approval-sheet')
    expect(sheet.hasAttribute('data-talos-protected')).toBe(true)
    agentClick(within(sheet).getByRole('button', { name: 'Deny' }))
    const allow = within(sheet).getByRole('button', { name: /^Allow/ }) as HTMLButtonElement
    allow.disabled = false
    agentClick(allow)
    // the compact card behind the sheet too
    agentClick(screen.getAllByRole('button', { name: 'Deny' })[0] as Element)
    await settle()
    expect(resolves(client)).toHaveLength(0)
    humanClick(within(sheet).getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    await settle()
    expect(resolves(client)).toHaveLength(1)
    expect(resolves(client)[0]).toMatchObject({ action: 'kill' })
  })

  it('a needs-you dialog card: every option, and the login button', async () => {
    const d = {
      id: 'k3Xv9QpT2mLw8ZrNa5HdBe',
      kind: 'trust' as const,
      subject: '~/Documents/x',
      options: ['No, exit', 'Yes, I trust this folder'],
      cursor: 1,
      seen_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    }
    const card = composeDialogCard({
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E1',
      dialog: d,
      thread_id: 'general',
      thread_name: 'General',
      now: Date.now(),
    })
    if (!card) throw new Error('no dialog card')
    const client = setup({ cards: [card as never] })
    renderWith(<LiveCard id={card.id} />, client)
    const buttons = within(screen.getByTestId('dialog-buttons')).getAllByRole('button')
    expect(buttons).toHaveLength(2)
    for (const b of buttons) agentClick(b)
    for (const b of buttons) press(b, 'Enter', 'synthetic')
    await settle()
    expect(resolves(client)).toHaveLength(0)
    humanClick(buttons[1] as Element)
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    await settle()
    expect(resolves(client)).toHaveLength(1)
    expect(resolves(client)[0]).toMatchObject({ action: 'primary', choice: 1 })
  })

  it('the agent can still click and type in the rest of Talos (a card’s header and the page around it)', async () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    const onClick = vi.fn()
    renderWith(
      <div>
        <button type="button" onClick={onClick}>
          Elsewhere
        </button>
        <input aria-label="note" />
        <LiveCard id={card.id} />
      </div>,
      client,
    )
    agentClick(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(onClick).toHaveBeenCalledTimes(1)
    const input = screen.getByLabelText('note')
    press(input, 'Enter', 'synthetic')
    fireEvent.keyDown(input, { key: 'a' })
    expect(dropped).not.toHaveBeenCalled()
  })
})

describe('a card that has been answered carries no protected buttons to press', () => {
  it('the collapsed line is not marked, so nothing is blocked there', async () => {
    const at = '2026-10-28T08:41:00.000Z'
    const card = makeCard({
      state: 'done',
      resolution: { action: 'primary', at, edited: false, payload_hash: 'sha256:x' },
      result: { ok: true, text: 'Sent', at },
    })
    renderWith(<LiveCard id={card.id} />, setup({ cards: [card] }))
    expect(document.querySelector('[data-talos-protected]')).toBeNull()
  })
})

describe('a stamp belongs to its own event (review R1-4)', () => {
  const sendCard = () => {
    const card = makeCard()
    const client = setup({ cards: [card] })
    renderWith(<LiveCard id={card.id} />, client)
    return { client, send: screen.getByRole('button', { name: 'Send' }) }
  }

  it('a pointer click is not let through by a fresh human KEY stamp', async () => {
    const { client, send } = sendCard()
    stamp('human', 'keyDown', 0, 36)
    fireEvent.click(send, { detail: 1 })
    await settle()
    expect(resolves(client)).toHaveLength(0)
  })

  it('an unstamped keyboard-style click (an Accessibility press) is refused while human key stamps are fresh', async () => {
    const { client, send } = sendCard()
    // the owner just typed Return somewhere else in Talos; a key stamp is fresh, and no key event reached the card's button
    stamp('human', 'keyDown', 0, 36)
    stamp('human', 'keyUp', 0, 36)
    fireEvent.click(send) // detail 0: no pointer, no key event seen
    await settle()
    expect(resolves(client)).toHaveLength(0)
    expect(dropped).toHaveBeenCalledWith(expect.objectContaining({ dropped: 'click' }))
  })

  it('a human key stamp is spent with its key event: a press made one turn later rides nothing', async () => {
    const { client, send } = sendCard()
    send.focus()
    stamp('human', 'keyDown', 0, 36)
    fireEvent.keyDown(send, { key: 'Enter', preventDefault: true } as never) // seen by the page, then the turn ends
    await nextTurn()
    fireEvent.click(send) // an Accessibility press now
    await settle()
    expect(resolves(client)).toHaveLength(0)
  })

  it('a mouse-release stamp cannot make a keyboard click, and a key stamp cannot make a pointer click', async () => {
    const { client, send } = sendCard()
    stamp('human', 'leftMouseUp', 0, 0)
    fireEvent.click(send) // detail 0
    stamp('human', 'keyDown', 0, 36)
    fireEvent.click(send, { detail: 1 })
    await settle()
    expect(resolves(client)).toHaveLength(0)
  })

  it('the wrong key: Tab, or a letter, never opens the way for a click', async () => {
    const { client, send } = sendCard()
    stamp('human', 'keyDown', 0, 48)
    fireEvent.keyDown(send, { key: 'Tab' })
    fireEvent.click(send)
    stamp('human', 'keyDown', 0, 0)
    fireEvent.keyDown(send, { key: 'a' })
    fireEvent.click(send)
    await settle()
    expect(resolves(client)).toHaveLength(0)
  })

  it('a queued synthetic release after the owner typed does not ride the typing', async () => {
    const { client, send } = sendCard()
    const input = document.createElement('input')
    document.body.append(input)
    press(input, 'Enter', 'human') // the owner sends a message with Return: key stamps are fresh
    stamp('synthetic', 'leftMouseUp', 12) // the agent's release, delivered late
    fireEvent.click(send, { detail: 1 })
    await settle()
    expect(resolves(client)).toHaveLength(0)
    expect(dropped).toHaveBeenCalledWith({ dropped: 'click', token: 12 })
    input.remove()
  })

  it('a cancelled event is reported with its stamp token, and the answer for a token follows its drops', async () => {
    const { send } = sendCard()
    agentClick(send, 41)
    ack(41)
    const calls = dropped.mock.calls.map((c) => c[0] as { dropped?: string; token?: number; ack?: number })
    const firstAck = calls.findIndex((c) => c.ack === 41)
    expect(calls.some((c) => c.dropped && c.token === 41)).toBe(true)
    expect(firstAck).toBeGreaterThan(calls.findIndex((c) => c.dropped && c.token === 41))
    expect(calls[firstAck]).toEqual({ ack: 41 })
  })

  it('one attribute covers more elements: anything marked data-talos-protected is guarded the same way', async () => {
    const onClick = vi.fn()
    renderWith(
      <button type="button" data-talos-protected="" onClick={onClick}>
        Later
      </button>,
      setup(),
    )
    agentClick(screen.getByRole('button', { name: 'Later' }), 3)
    expect(onClick).not.toHaveBeenCalled()
    humanClick(screen.getByRole('button', { name: 'Later' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
