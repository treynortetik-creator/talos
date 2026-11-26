// The plain explanation on a permission card: the card shows at once, the sentence fills in later, a mismatch makes Deny the main
// button and Allow read "Allow anyway", and a failed or silent explainer says "Couldn't explain this one". The explanation is an
// EXTRA sentence, never instead of the call: the start of the call and its "Ends with:" line are always on the card's face, with
// Allow, never inside a closed disclosure (jsdom does not hide a closed <details>, so each test looks at the element's ancestors).
// Allow does not wait for the explanation. Only the whole body is behind Details.
import {
  composePermissionCard,
  EXPLAIN_FAILED_TEXT,
  EXPLAIN_GIVE_UP_MS,
  type PermissionExplainT,
  permissionHiddenWarning,
} from '@talos-app/protocol'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installAlwaysVisible } from '../helpers/intersection.ts'
import { LiveCard, renderWith, setup } from './helpers.tsx'

const CMD = 'rm -rf build/ ~/Downloads/*'
const make = (explain: boolean, ageMs = 1000, over: { input_preview?: string; repeated?: boolean } = {}) =>
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
    ...(over.repeated ? { repeated: true } : {}),
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

/** On the card's face: present, and not a descendant of a <details> that is closed (a closed one hides it in a browser). */
const onFace = (id: string) => {
  const el = screen.getByTestId(id)
  expect(el.closest('details:not([open])'), `${id} sits inside a closed <details>`).toBeNull()
  return el
}
const callOnFace = () => {
  expect(onFace('permission-preview').textContent).toContain(CMD.slice(0, 20))
  expect(onFace('permission-tail').textContent).toContain('Ends with:')
}

const show = (c: ReturnType<typeof withExplain>) => renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))

describe('waiting for the explanation', () => {
  it('shows the card at once with the call and its tail on the face and no claim yet', () => {
    show(withExplain({ status: 'pending' }))
    expect(screen.getByTestId('permission-explain-waiting').textContent).toContain('Reading the command')
    callOnFace()
    expect(document.querySelector('details')).toBeNull()
    expect(screen.queryByTestId('permission-explain-chip')).toBeNull()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
  })

  it('Allow does not wait for the explanation: one tap sends the allow while it is still coming', async () => {
    const c = withExplain({ status: 'pending' })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() =>
      expect(client.sent.some((f) => f.type === 'card.resolve' && f.action === 'primary' && f.card_id === c.id)).toBe(
        true,
      ),
    )
  })

  it('Deny works while it is still waiting', async () => {
    const c = withExplain({ status: 'pending' })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    // the resolve is signed before it is sent, so it lands a moment after the click
    await waitFor(() => expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(true))
  })

  it('an explanation that never came, past the give-up time, reads as failed, with the call on the face', () => {
    show(withExplain({ status: 'pending' }, EXPLAIN_GIVE_UP_MS + 1000))
    expect(screen.getByTestId('permission-explain-failed').textContent).toBe(EXPLAIN_FAILED_TEXT)
    callOnFace()
  })
})

describe('an explanation', () => {
  it('shows the tag chip and the sentence, and the call and its tail stay on the face; the buttons are as before', () => {
    show(withExplain(READY))
    expect(screen.getByTestId('permission-explain-chip').textContent).toBe('Changes files')
    expect(screen.getByTestId('permission-explain-sentence').textContent).toBe(
      READY.status === 'ready' ? READY.sentence : '',
    )
    callOnFace()
    expect(screen.getByTestId('permission-tail').textContent).toContain('Downloads')
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' }).className).not.toContain('bg-accent')
  })

  it('no disclosure on the card at all, and a re-render keeps the call on the face', () => {
    const c = withExplain(READY)
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    expect(document.querySelector('details')).toBeNull()
    act(() =>
      client.store.setState((s) => ({
        ...s,
        cards: s.cards.map((x) => ({ ...x, explain: { status: 'failed' } as const })),
      })),
    )
    callOnFace()
    expect(document.querySelector('details')).toBeNull()
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
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  })

  it('Allow anyway is one tap on the face; Details opens the whole call with Allow anyway there too', async () => {
    show(withExplain(MISMATCH))
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
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
    // the resolve is signed before it is sent, so it lands a moment after the click
    await waitFor(() =>
      expect(client.sent.at(-1)).toMatchObject({ type: 'card.resolve', action: 'kill', card_id: c.id }),
    )
  })
})

describe('a failed explainer', () => {
  it('says so, with the call on the face', () => {
    show(withExplain({ status: 'failed' }))
    expect(screen.getByTestId('permission-explain-failed').textContent).toBe("Couldn't explain this one")
    callOnFace()
    expect(screen.queryByTestId('permission-explain-chip')).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
  })
})

describe('the sheet shows the explanation too', () => {
  it('a normal explanation sits above the call in the sheet', async () => {
    show(withExplain(READY))
    await userEvent.click(screen.getByRole('button', { name: 'Details' }))
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
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
  })

  it('a deny-only card (a repeated id) keeps the whole call in view even with an explanation, and offers no Allow', () => {
    const c = withExplain(READY, 1000, { repeated: true })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByTestId('permission-call')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull()
  })

  it('a card with a hidden part keeps its way to Allow beside the explanation, and shows the note', () => {
    const c = withExplain(READY, 1000, { input_preview: '{"command": "cat <<EOF ⋯ 4812 code points elided ⋯ EOF"}' })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain(permissionHiddenWarning(['elided']))
  })
})
