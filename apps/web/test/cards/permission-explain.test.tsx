// The plain explanation on a permission card: the card shows at once, the sentence fills in later, the command sits behind
// "Show the command", a mismatch makes Deny the main button and Allow read "Allow anyway", and a failed or silent explainer
// says "Couldn't explain this one" and opens the command. Allow still lives in the full-screen sheet, behind the whole call.
import {
  composePermissionCard,
  EXPLAIN_FAILED_TEXT,
  EXPLAIN_GIVE_UP_MS,
  type PermissionExplainT,
} from '@talos-app/protocol'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installAlwaysVisible } from '../helpers/intersection.ts'
import { LiveCard, renderWith, setup } from './helpers.tsx'

const CMD = 'rm -rf build/ ~/Downloads/*'
const make = (explain: boolean, ageMs = 1000, over: { input_preview?: string } = {}) =>
  composePermissionCard({
    request: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'cleans up the build folder',
      input_preview: over.input_preview ?? JSON.stringify({ command: CMD }),
    },
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
    thread_id: 'general',
    now: Date.now() - ageMs,
    client_version: '2.1.312',
    ...(explain ? { explain: true } : {}),
  })

/** The card as the store holds it once the explanation arrived. */
const withExplain = (explain: PermissionExplainT, ageMs = 1000, over = {}) => ({ ...make(true, ageMs, over), explain })

const READY: PermissionExplainT = {
  status: 'ready',
  tag: 'Changes files',
  mismatch: false,
  sentence: "Moves last week's meeting notes into the archive folder. Nothing is deleted or sent anywhere.",
}
const MISMATCH: PermissionExplainT = {
  status: 'ready',
  tag: 'Deletes',
  mismatch: true,
  sentence:
    'Claude says this "cleans up the build folder", but it also deletes everything in your Downloads folder. Check before allowing.',
}

let restoreIO = () => {}
beforeEach(() => {
  restoreIO = installAlwaysVisible()
})
afterEach(() => restoreIO())

const show = (c: ReturnType<typeof withExplain>) => renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))

describe('waiting for the explanation', () => {
  it('shows the card at once with the command behind "Show the command" and no claim yet', () => {
    show(withExplain({ status: 'pending' }))
    expect(screen.getByTestId('permission-explain-waiting').textContent).toContain('Reading the command')
    const details = screen.getByTestId('permission-command') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(details).getByText('Show the command')).toBeTruthy()
    expect(screen.queryByTestId('permission-explain-chip')).toBeNull()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review to allow' })).toBeTruthy()
  })

  it('Deny works while it is still waiting', async () => {
    const c = withExplain({ status: 'pending' })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(true)
  })

  it('an explanation that never came, past the give-up time, reads as failed', () => {
    show(withExplain({ status: 'pending' }, EXPLAIN_GIVE_UP_MS + 1000))
    expect(screen.getByTestId('permission-explain-failed').textContent).toBe(EXPLAIN_FAILED_TEXT)
    expect((screen.getByTestId('permission-command') as HTMLDetailsElement).open).toBe(true)
  })
})

describe('an explanation', () => {
  it('shows the tag chip and the sentence; the command stays closed; the buttons are as before', () => {
    show(withExplain(READY))
    expect(screen.getByTestId('permission-explain-chip').textContent).toBe('Changes files')
    expect(screen.getByTestId('permission-explain-sentence').textContent).toBe(
      READY.status === 'ready' ? READY.sentence : '',
    )
    expect((screen.getByTestId('permission-command') as HTMLDetailsElement).open).toBe(false)
    expect(screen.getByRole('button', { name: 'Review to allow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' }).className).not.toContain('bg-accent')
  })

  it('"Show the command" is a real disclosure that reveals the call and its tail', async () => {
    show(withExplain(READY))
    const details = screen.getByTestId('permission-command') as HTMLDetailsElement
    await userEvent.click(within(details).getByText('Show the command'))
    expect(details.open).toBe(true)
    expect(screen.getByTestId('permission-preview').textContent).toContain(CMD.slice(0, 20))
    expect(screen.getByTestId('permission-tail').textContent).toContain('Downloads')
  })

  it('the sentence is text, never markup', () => {
    show(withExplain({ ...READY, sentence: 'Opens <img src=x onerror=alert(1)> **now**' } as PermissionExplainT))
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByTestId('permission-explain-sentence').textContent).toContain('<img src=x')
  })

  it('hidden characters in the sentence are shown as markers', () => {
    show(withExplain({ ...READY, sentence: 'Safe‮.' } as PermissionExplainT))
    expect(screen.getByTestId('permission-explain-sentence').textContent).toContain('U+202E')
  })
})

describe('"Show the command" follows the owner, not the other way round', () => {
  const touch = (client: ReturnType<typeof setup>) =>
    act(() => client.store.setState((s) => ({ ...s, cards: s.cards.map((c) => ({ ...c, title: `${c.title} ` })) })))

  it('what the owner opened or closed by hand stays so when the card re-renders', async () => {
    const c = withExplain(READY)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    const d = screen.getByTestId('permission-command') as HTMLDetailsElement
    await userEvent.click(within(d).getByText('Show the command'))
    expect(d.open).toBe(true)
    touch(client)
    expect(d.open).toBe(true)
    await userEvent.click(within(d).getByText('Show the command'))
    expect(d.open).toBe(false)
    touch(client)
    expect(d.open).toBe(false)
  })

  it('a card that was waiting and turns failed opens the command by itself, and a manual close after that is respected', async () => {
    const c = withExplain({ status: 'pending' })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    const d = screen.getByTestId('permission-command') as HTMLDetailsElement
    expect(d.open).toBe(false)
    act(() =>
      client.store.setState((s) => ({
        ...s,
        cards: s.cards.map((x) => ({ ...x, explain: { status: 'failed' } as const })),
      })),
    )
    expect(d.open).toBe(true)
  })
})

describe('a mismatch', () => {
  it('chip reads "<Tag> · Doesn\'t match", Deny is the main button, Allow reads "Allow anyway" and is not', () => {
    show(withExplain(MISMATCH))
    expect(screen.getByTestId('permission-explain-chip').textContent).toBe("Deletes · Doesn't match")
    expect(screen.getByTestId('permission-explain-sentence').textContent).toContain(
      'also deletes everything in your Downloads',
    )
    const deny = screen.getByRole('button', { name: 'Deny' })
    const allow = screen.getByRole('button', { name: 'Allow anyway' })
    expect(deny.className).toContain('bg-accent')
    expect(allow.className).not.toContain('bg-accent')
    expect(screen.queryByRole('button', { name: 'Review to allow' })).toBeNull()
  })

  it('Allow anyway still goes through the sheet: the whole call, scrolled to its end, then Allow anyway there too', async () => {
    show(withExplain(MISMATCH))
    await userEvent.click(screen.getByRole('button', { name: 'Allow anyway' }))
    const sheet = screen.getByTestId('approval-sheet')
    expect(within(sheet).getByTestId('permission-explain-chip').textContent).toBe("Deletes · Doesn't match")
    expect(within(sheet).getByTestId('permission-call').textContent).toContain(CMD)
    expect(within(sheet).getByRole('button', { name: 'Deny' }).className).toContain('bg-accent')
    const allow = within(sheet).getByRole('button', { name: /^Allow anyway/ }) as HTMLButtonElement
    expect(allow.className).not.toContain('bg-accent')
  })

  it('Deny from the main button sends the kill', async () => {
    const c = withExplain(MISMATCH)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(client.sent.at(-1)).toMatchObject({ type: 'card.resolve', action: 'kill', card_id: c.id })
  })
})

describe('a failed explainer', () => {
  it('says so and opens the command', () => {
    show(withExplain({ status: 'failed' }))
    expect(screen.getByTestId('permission-explain-failed').textContent).toBe("Couldn't explain this one")
    expect((screen.getByTestId('permission-command') as HTMLDetailsElement).open).toBe(true)
    expect(screen.queryByTestId('permission-explain-chip')).toBeNull()
    expect(screen.getByRole('button', { name: 'Review to allow' })).toBeTruthy()
  })
})

describe('the sheet shows the explanation too', () => {
  it('a normal explanation sits above the call in the sheet', async () => {
    show(withExplain(READY))
    await userEvent.click(screen.getByRole('button', { name: 'Review to allow' }))
    const sheet = screen.getByTestId('approval-sheet')
    expect(within(sheet).getByTestId('permission-explain-chip').textContent).toBe('Changes files')
    expect(within(sheet).getByRole('button', { name: /^Allow/ }).textContent).not.toContain('anyway')
  })
})

describe("a card with no explanation field is today's card", () => {
  it('no explain block, no disclosure, the same buttons', () => {
    const c = make(false)
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByTestId('permission-explain')).toBeNull()
    expect(screen.queryByTestId('permission-command')).toBeNull()
    expect(screen.getByTestId('permission-preview')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Review to allow' })).toBeTruthy()
  })

  it('a deny-only card (a hidden part) keeps the whole call in view even with an explanation, and offers no Allow', () => {
    const c = withExplain(READY, 1000, { input_preview: '{"command": "cat <<EOF ⋯ 4812 code points elided ⋯ EOF"}' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByTestId('permission-call')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull()
  })
})
