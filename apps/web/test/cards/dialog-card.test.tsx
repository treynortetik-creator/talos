// The needs-you card for a Claude Code dialog (trust, MCP consent, login): one real button per option as read from the screen,
// the answered, pressing, nothing-pressed, closed and expired states, and the same hidden-character treatment as every card.
import {
  type CardT,
  composeDialogCard,
  DIALOG_UNVERIFIED_TEXT,
  dialogFallbackLine,
  dialogNothingPressedText,
  type WorkerDialogT,
} from '@talos-app/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { TalosClientError } from '../../src/lib/client.ts'
import { LiveCard, renderWith as renderThread, renderWith, setup, setup as setupThread } from './helpers.tsx'

const NOW = Date.now()
const iso = (ms: number) => new Date(ms).toISOString()
const trustDialog = (over: Partial<WorkerDialogT> = {}): WorkerDialogT => ({
  id: 'k3Xv9QpT2mLw8ZrNa5HdBe',
  kind: 'trust',
  subject: '~/Documents/x',
  options: ['No, exit', 'Yes, I trust this folder'],
  cursor: 1,
  seen_at: iso(NOW),
  expires_at: iso(NOW + 900_000),
  ...over,
})
const mcpDialog = (): WorkerDialogT =>
  trustDialog({
    id: 'Zt7Rm2QxW9cKpL4vNaH8dB',
    kind: 'mcp_consent',
    subject: 'github',
    options: [
      'Use this and all future MCP servers in this project',
      'Use this MCP server',
      'Continue without using this MCP server',
    ],
  })
const loginDialog = (): WorkerDialogT =>
  trustDialog({ id: 'Hc4Pq9ZtLm2Xw7RvNa5KdB', kind: 'login', subject: null, options: [], cursor: null })

function dialogCard(d: WorkerDialogT = trustDialog(), over: Partial<CardT> = {}, madeAt = NOW): CardT {
  const card = composeDialogCard({
    card_id: `c_01JBF3V7Q8K2M4N6P8R0S${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`,
    dialog: d,
    thread_id: 'general',
    thread_name: 'General',
    now: madeAt,
  }) as CardT
  return { ...card, ...over }
}
const at = iso(NOW)
const answered = (text: string, by: string | undefined, over: Partial<CardT> = {}): Partial<CardT> => ({
  state: 'done',
  resolution: { action: 'primary', at, edited: false, payload_hash: 'sha256:x', ...(by ? { by } : {}) },
  result: { ok: true, text, at, ran: true },
  ...over,
})

const show = (card: CardT) => {
  const client = setup({ cards: [card] })
  renderWith(<LiveCard id={card.id} />, client)
  return client
}
const buttons = () => within(screen.getByTestId('dialog-buttons')).getAllByRole('button')

describe('a waiting dialog card', () => {
  it('says what the design says: header, title, folder in monospace, body, footnote', () => {
    show(dialogCard())
    const card = screen.getByRole('article')
    expect(card.getAttribute('data-card-kind')).toBe('dialog')
    expect(card.textContent).toMatch(/needs you/i)
    expect(card.textContent).toContain('General')
    expect(screen.getByRole('heading', { name: 'Trust this folder?' })).toBeTruthy()
    const subject = screen.getByTestId('dialog-subject')
    expect(subject.textContent).toBe('~/Documents/x')
    expect(subject.className).toContain('font-mono')
    expect(screen.getByTestId('dialog-body').textContent).toBe(
      "General's session wants to work in this folder. Claude will be able to read, change and run files in it, and in folders inside it.",
    )
    expect(screen.getByTestId('dialog-footnote').textContent).toBe(
      'Your Mac presses the key for you. The session answers your message once it is in.',
    )
  })

  it('has one real button per option, in screen order, each at least 44 px tall', () => {
    show(dialogCard())
    const b = buttons()
    expect(b.map((x) => x.textContent)).toEqual(['No, exit', 'Yes, I trust this folder'])
    for (const x of b) {
      expect(x.tagName).toBe('BUTTON')
      expect(x.className).toContain('min-h-11')
    }
  })

  it('MCP consent shows all three options as read, including "all future servers"', () => {
    show(dialogCard(mcpDialog()))
    expect(screen.getByRole('heading', { name: 'Allow this MCP server?' })).toBeTruthy()
    expect(screen.getByTestId('dialog-subject').textContent).toBe('github')
    expect(buttons().map((x) => x.textContent)).toEqual([
      'Use this and all future MCP servers in this project',
      'Use this MCP server',
      'Continue without using this MCP server',
    ])
    expect(screen.getByTestId('dialog-body').textContent).toBe(
      "General's session wants to turn on this server's tools for its folder.",
    )
  })

  it('login has one button, "Open on the Mac", and no folder line', () => {
    show(dialogCard(loginDialog()))
    expect(screen.getByRole('heading', { name: 'General needs you to sign in' })).toBeTruthy()
    expect(buttons().map((x) => x.textContent)).toEqual(['Open on the Mac'])
    expect(screen.queryByTestId('dialog-subject')).toBeNull()
    expect(screen.getByTestId('dialog-body').textContent).toBe(
      "General's session needs you to sign in to Claude on the Mac.",
    )
  })

  it('a subject the Mac could not read shows no subject at all', () => {
    show(dialogCard(trustDialog({ subject: null })))
    expect(screen.queryByTestId('dialog-subject')).toBeNull()
    expect(buttons()).toHaveLength(2)
  })

  it('hidden characters in the folder and in the labels show as tokens, and are never raw', () => {
    show(dialogCard(trustDialog({ subject: '~/proj‮gpj​', options: ['No‮, exit', 'Yes⁠, I trust this folder'] })))
    const shown = screen.getByRole('article').textContent ?? ''
    for (const raw of ['‮', '​', '⁠']) expect(shown).not.toContain(raw)
    expect(screen.getByTestId('dialog-subject').textContent).toBe('~/proj⟦U+202E⟧gpj⟦U+200B⟧')
    expect(buttons()[0]?.textContent).toBe('No⟦U+202E⟧, exit')
    expect(buttons()[1]?.textContent).toBe('Yes⟦U+2060⟧, I trust this folder')
  })

  it('a label cannot print a marker of its own: its brackets are marked too', () => {
    show(dialogCard(trustDialog({ subject: '~/⟦U+202E⟧x', options: ['No, exit', 'Yes ⟦U+200B⟧'] })))
    expect(screen.getByTestId('dialog-subject').textContent).toBe('~/⟦U+27E6⟧U+202E⟦U+27E7⟧x')
    expect(buttons()[1]?.textContent).toBe('Yes ⟦U+27E6⟧U+200B⟦U+27E7⟧')
  })

  it('shows markup in the folder or a label as plain text', () => {
    show(
      dialogCard(
        trustDialog({ subject: '<img src=x onerror=alert(1)>', options: ['**No**', '[Yes](https://evil.example)'] }),
      ),
    )
    expect(screen.getByTestId('dialog-subject').textContent).toBe('<img src=x onerror=alert(1)>')
    expect(buttons().map((x) => x.textContent)).toEqual(['**No**', '[Yes](https://evil.example)'])
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('a')).toBeNull()
  })

  it('pressing an option sends one signed-card resolve carrying that index and the rendered hash', async () => {
    const card = dialogCard()
    const client = show(card)
    fireEvent.click(buttons()[1] as HTMLElement)
    await waitFor(() => expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(true))
    const f = client.sent.find((x) => x.type === 'card.resolve') as Record<string, unknown>
    expect(f).toMatchObject({ card_id: card.id, action: 'primary', choice: 1, payload_hash: card.payload_hash })
  })

  it('the login button sends no choice', async () => {
    const card = dialogCard(loginDialog())
    const client = show(card)
    fireEvent.click(buttons()[0] as HTMLElement)
    await waitFor(() => expect(client.sent.some((f) => f.type === 'card.resolve')).toBe(true))
    const f = client.sent.find((x) => x.type === 'card.resolve') as Record<string, unknown>
    expect(f.action).toBe('primary')
    expect('choice' in f).toBe(false)
  })

  it('a double tap sends once', async () => {
    const card = dialogCard()
    const client = show(card)
    const spy = vi.spyOn(client, 'resolveCard')
    const b = buttons()[1] as HTMLElement
    fireEvent.click(b)
    fireEvent.click(b)
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a tap that lost to another device shows the already-decided copy', async () => {
    const card = dialogCard()
    const client = show(card)
    vi.spyOn(client, 'resolveCard').mockRejectedValue(new TalosClientError('card_not_pending'))
    fireEvent.click(buttons()[1] as HTMLElement)
    expect((await screen.findByRole('alert')).textContent).toBe('This card was already decided.')
  })
})

describe('after the tap', () => {
  it('while the Mac presses the key: no buttons, a status line', () => {
    show(
      dialogCard(trustDialog(), {
        state: 'resolved',
        resolution: { action: 'primary', at, edited: false, payload_hash: 'sha256:x', by: 'Test device' },
      }),
    )
    expect(screen.queryByTestId('dialog-buttons')).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('Pressing')
  })

  it('answered: the past tense of the choice, and who, when, and that the session is starting', () => {
    show(dialogCard(trustDialog(), answered('Trusted ~/Documents/x', "Alex's iPhone")))
    expect(screen.queryByTestId('dialog-buttons')).toBeNull()
    expect(screen.getByTestId('dialog-result').textContent).toBe('Trusted ~/Documents/x')
    expect(screen.getByTestId('dialog-meta').textContent).toMatch(
      /^Answered on Alex's iPhone · \d{2}:\d{2} · the session is starting$/,
    )
  })

  it('answered with the plain option label when there is no natural past tense', () => {
    show(dialogCard(mcpDialog(), answered('Use this MCP server', 'this Mac')))
    expect(screen.getByTestId('dialog-result').textContent).toBe('Use this MCP server')
    expect(screen.getByTestId('dialog-meta').textContent).toContain('Answered on this Mac')
  })

  it('answered by a device an older Mac did not name: just "Answered"', () => {
    show(dialogCard(trustDialog(), answered('Trusted ~/Documents/x', undefined)))
    expect(screen.getByTestId('dialog-meta').textContent).toMatch(/^Answered · \d{2}:\d{2}/)
  })

  it('login opened: says so, with no "session is starting"', () => {
    show(dialogCard(loginDialog(), answered('Opened on the Mac', 'Test device')))
    expect(screen.getByTestId('dialog-result').textContent).toBe('Opened on the Mac')
    expect(screen.getByTestId('dialog-meta').textContent).not.toContain('starting')
  })

  it('nothing pressed: the title and the explanation, no buttons', () => {
    show(
      dialogCard(trustDialog(), {
        state: 'failed',
        resolution: { action: 'primary', at, edited: false, payload_hash: 'sha256:x', by: 'Test device' },
        result: { ok: false, text: dialogNothingPressedText('General'), at, ran: false },
      }),
    )
    expect(screen.getByRole('heading', { name: 'Nothing pressed' })).toBeTruthy()
    expect(screen.getByTestId('dialog-result').textContent).toBe(
      "General's screen showed something different when Talos went to answer, so it left it alone. A new card comes if it still needs you.",
    )
    expect(screen.queryByTestId('dialog-buttons')).toBeNull()
  })

  it('unverified: the Mac could not check the answer, so the card says "Answer on the Mac"', () => {
    show(
      dialogCard(trustDialog(), {
        state: 'failed',
        resolution: { action: 'primary', at, edited: false, payload_hash: 'sha256:x', by: 'Test device' },
        result: { ok: false, text: DIALOG_UNVERIFIED_TEXT, at, ran: false },
      }),
    )
    expect(screen.getByTestId('dialog-result').textContent).toBe('Answer on the Mac')
    expect(screen.queryByTestId('dialog-buttons')).toBeNull()
    expect(screen.queryByTestId('dialog-meta')).toBeNull() // it did not run, so it is not "Answered"
  })

  it('closed because the dialog went away: the bridge words, no buttons', () => {
    show(
      dialogCard(trustDialog(), {
        state: 'superseded',
        result: { ok: true, text: "The session isn't waiting on this any more.", at, ran: false },
      }),
    )
    expect(screen.getByTestId('dialog-result').textContent).toBe("The session isn't waiting on this any more.")
    expect(screen.queryByTestId('dialog-buttons')).toBeNull()
  })

  it('a hidden character in a result shows as a token', () => {
    show(dialogCard(trustDialog(), answered('Trusted ~/a‮b', 'Test device')))
    expect(screen.getByTestId('dialog-result').textContent).toBe('Trusted ~/a⟦U+202E⟧b')
  })
})

describe('expired', () => {
  it('a card the owner never answered says it expired and has no buttons', () => {
    show(dialogCard(trustDialog(), { state: 'expired' }))
    expect(screen.getByTestId('dialog-result').textContent).toMatch(/^Expired/)
    expect(screen.queryByTestId('dialog-buttons')).toBeNull()
  })

  it('a pending card past its time reads the same without waiting for the relay', () => {
    show(dialogCard(trustDialog(), {}, NOW - 1_000_000))
    expect(screen.getByTestId('dialog-result').textContent).toMatch(/^Expired/)
    expect(screen.queryByTestId('dialog-buttons')).toBeNull()
  })

  describe('in the thread', () => {
    beforeEach(() => {
      Element.prototype.scrollIntoView = vi.fn()
    })
    it('sits above the one fallback line, which says what to do at the Mac', async () => {
      const card = dialogCard(trustDialog(), { state: 'expired' })
      const client = setupThread({ cards: [card] })
      const line = dialogFallbackLine('trust', 'General')
      client.store.setState((s) => ({
        ...s,
        messages: {
          ...s.messages,
          general: [
            {
              id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4V9',
              thread_id: 'general',
              author: 'system',
              kind: 'text',
              text: line,
              format: 'plain',
              attachments: [],
              via: 'app',
              seq: 1,
              created_at: iso(NOW),
            },
          ],
        },
      }))
      renderThread(<ThreadScreen />, client, '/t/general', '/t/:thread')
      await act(async () => {})
      expect(await screen.findByTestId('dialog-result')).toBeTruthy()
      expect(screen.getAllByText(line)).toHaveLength(1)
      expect(screen.getByTestId('dialog-result').textContent).toMatch(/^Expired/)
    })
  })
})
