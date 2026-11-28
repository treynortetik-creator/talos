// (`touch probe-N` here is only a synthetic hook input. Which commands Claude Code offers a rule for is its own choice and differs by version:
// on 2.1.332 `touch` and `rm -rf` got no rule, and `python3 -c "open('probe-N','w').close()"` did.)
// "Allow for this session" (Wave 1, 1.10). A card raised for a PermissionRequest hook that carries `session_allow` (a rule Claude Code
// offered, with content) shows a third button under Allow, in plain words naming what it allows. Tapping it signs the same primary
// card.resolve with `session: true`. A card without it, a broken offer, a card with no Allow, and a card the explainer says does not
// match show no third button. The rule is Claude Code's text, so it is drawn as text, with hidden characters marked.
import {
  type CardT,
  composePermissionCard,
  type PermissionExplainT,
  sessionAllowWords,
  sessionRulesHash,
} from '@talos-app/protocol'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installAlwaysVisible } from '../helpers/intersection.ts'
import { LiveCard, renderWith, setup } from './helpers.tsx'

const RULES = [{ tool: 'Bash', content: 'touch probe-*' }]
const WORDS = 'Allow `touch probe-*` for the rest of this session'

const make = (extra: { session_allow?: { rules: unknown }; repeated?: boolean } = {}): CardT =>
  composePermissionCard({
    request: {
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Make a probe file',
      input_preview: '{"command": "touch probe-1"}',
    },
    card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4F1',
    thread_id: 'general',
    now: Date.parse('2026-10-28T15:00:00.000Z'),
    client_version: '2.1.312',
    deny_note: true,
    ...extra,
  })
/** A card as a (hostile or newer) bridge could hand it over, bypassing the composer's own checks. */
const raw = (c: CardT, session_allow: unknown): CardT => ({ ...c, session_allow }) as unknown as CardT

let restoreIO = () => {}
beforeEach(() => {
  restoreIO = installAlwaysVisible()
})
afterEach(() => restoreIO())

const third = () => screen.queryByRole('button', { name: /for the rest of this session/ })
const resolves = (client: ReturnType<typeof setup>) => client.sent.filter((f) => f.type === 'card.resolve')

describe('a card that offers a rule', () => {
  it('shows a third button in plain words that name what it allows', () => {
    const c = make({ session_allow: { rules: RULES } })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(sessionAllowWords(RULES)).toBe(WORDS)
    expect(third()?.textContent).toBe(WORDS)
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy() // plain Allow and Deny are still there
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
  })

  it('tapping it signs a primary card.resolve with session: true and the card hash', async () => {
    const c = make({ session_allow: { rules: RULES } })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(third() as HTMLElement)
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({
      type: 'card.resolve',
      card_id: c.id,
      action: 'primary',
      payload_hash: c.payload_hash,
      session: true,
      // the owner signs the hash of the rules the button showed, so the bridge and the hook can tell a rewritten button
      session_hash: sessionRulesHash(RULES),
    })
  })

  it('plain Allow on the same card sends no session key; Deny sends none either', async () => {
    const c = make({ session_allow: { rules: RULES } })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({ action: 'primary' })
    expect('session' in (resolves(client)[0] as object)).toBe(false)
  })

  it('Deny sends a plain kill', async () => {
    const c = make({ session_allow: { rules: RULES } })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({ action: 'kill' })
    expect('session' in (resolves(client)[0] as object)).toBe(false)
  })

  it('the full-screen sheet offers it too, and signs the same way', async () => {
    const c = make({ session_allow: { rules: RULES } })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    await userEvent.click(screen.getByTestId('permission-open'))
    const sheet = screen.getByTestId('approval-sheet')
    await userEvent.click(within(sheet).getByRole('button', { name: /for the rest of this session/ }))
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect(resolves(client)[0]).toMatchObject({
      action: 'primary',
      session: true,
      session_hash: sessionRulesHash(RULES),
    })
  })

  it('the hash is of the rules in the card as it reached the app (a relay that rewrote them signs for the rewrite, and is caught)', async () => {
    const rewritten = [{ tool: 'Bash', content: 'rm probe-1' }]
    const c = raw(make(), { rules: rewritten })
    const client = setup({ cards: [c] })
    renderWith(<LiveCard id={c.id} />, client)
    expect(third()?.textContent).toBe('Allow `rm probe-1` for the rest of this session')
    await userEvent.click(third() as HTMLElement)
    await waitFor(() => expect(resolves(client)).toHaveLength(1))
    expect((resolves(client)[0] as { session_hash: string }).session_hash).toBe(sessionRulesHash(rewritten))
    expect((resolves(client)[0] as { session_hash: string }).session_hash).not.toBe(sessionRulesHash(RULES))
  })

  it('several rules are all named', () => {
    const rules = [
      { tool: 'Bash', content: 'ls *' },
      { tool: 'Bash', content: 'cat *' },
    ]
    const c = make({ session_allow: { rules } })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(third()?.textContent).toBe('Allow `ls *` and `cat *` for the rest of this session')
  })
})

describe('no third button', () => {
  it('a card without the field (a channel-relay card, an older bridge)', async () => {
    const c = make()
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(third()).toBeNull()
    await userEvent.click(screen.getByTestId('permission-open'))
    expect(
      within(screen.getByTestId('approval-sheet')).queryByRole('button', { name: /for the rest of this session/ }),
    ).toBeNull()
  })

  it.each<[string, unknown]>([
    ['a whole-tool rule (no content)', { rules: [{ tool: 'Bash' }] }],
    ['an empty list', { rules: [] }],
    ...['*', '**', ':*', '* *', '*:*', '//**'].map(
      (c) => [`wildcards only (${c})`, { rules: [{ tool: 'Bash', content: c }] }] as [string, unknown],
    ),
    ['domain:* (every site)', { rules: [{ tool: 'Bash', content: 'domain:*' }] }],
    ['too many rules', { rules: [1, 2, 3, 4].map((i) => ({ tool: 'Bash', content: `ls ${i}` })) }],
    ['a rule over the length limit', { rules: [{ tool: 'Bash', content: 'a'.repeat(161) }] }],
    ['not the shape', 'yes'],
  ])('a broken offer: %s', (_why, offer) => {
    const c = raw(make(), offer)
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(third()).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
  })

  it('a card with no Allow (a repeated prompt id) offers none', () => {
    const c = make({ session_allow: { rules: RULES }, repeated: true })
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(third()).toBeNull()
  })

  it('a card the explainer says does not match (Allow reads "Allow anyway")', () => {
    const mismatch: PermissionExplainT = {
      status: 'ready',
      tag: 'Deletes',
      mismatch: true,
      sentence: 'It deletes more than it says.',
    }
    const c = { ...make({ session_allow: { rules: RULES } }), explain: mismatch }
    renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(screen.getByRole('button', { name: 'Allow anyway' })).toBeTruthy()
    expect(third()).toBeNull()
  })
})

describe('the rule is Claude Code text: drawn as text, never as markup', () => {
  it('markup in a rule stays visible text', () => {
    const content = '<img src=x onerror=alert(1)>'
    const c = make({ session_allow: { rules: [{ tool: 'Bash', content }] } })
    const { container } = renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
    expect(third()?.textContent).toBe(`Allow \`${content}\` for the rest of this session`)
    expect(container.querySelector('img')).toBeNull()
  })

  it('a hidden character never reaches the button: no button at all', () => {
    for (const bad of ['ls ‮*', 'ls​ *', 'ls\n*']) {
      const c = raw(make(), { rules: [{ tool: 'Bash', content: bad }] })
      const { unmount } = renderWith(<LiveCard id={c.id} />, setup({ cards: [c] }))
      expect(third()).toBeNull()
      unmount()
    }
  })
})
