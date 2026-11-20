import { bindingFrom, type CardT, editedHash, payloadHash, verifyOwnerFrame } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { TalosClientError } from '../src/lib/client.ts'
import { createFakeClient } from '../src/lib/fakeClient.ts'

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(TalosClientError)
  expect((e as TalosClientError).code).toBe(code)
}

function setup(over: Partial<CardT> = {}) {
  const c = createFakeClient()
  const base = c.store.getState().cards[0] as CardT
  const card: CardT = { ...base, ...over }
  c.store.setState((s) => ({ ...s, cards: [card] }))
  return { c, card, hash: payloadHash(bindingFrom(card)) }
}

describe('fake client is as strict as the spec (WP7 tests must not pass vacuously)', () => {
  it('resolveCard refuses like the real client when the socket is down or the device is not pinned, and sends nothing', async () => {
    const { c, card, hash } = setup()
    c.store.setState({ connection: 'offline' })
    await rejects(c.resolveCard(card.id, { action: 'kill', payloadHash: hash }), 'internal')
    c.store.setState({ connection: 'online', devicePinned: false })
    await rejects(c.resolveCard(card.id, { action: 'kill', payloadHash: hash }), 'device_not_pinned')
    expect(c.sent).toHaveLength(0)
    c.store.setState({ devicePinned: true })
    await c.resolveCard(card.id, { action: 'kill', payloadHash: hash }) // control: the same call works once both hold
    expect(c.sent).toHaveLength(1)
  })

  it('resolveCard rejects a hash that is not the one the card renders', async () => {
    const { c, card } = setup()
    await rejects(
      c.resolveCard(card.id, { action: 'kill', payloadHash: `sha256:${'f'.repeat(64)}` }),
      'card_hash_mismatch',
    )
    expect(c.sent).toHaveLength(0)
  })

  it.each([
    ['allow_edit', { allow_edit: false }],
    ['allow_revise', { allow_revise: false }],
    ['origin', { origin: 'background' as const }],
  ])(
    'a hash computed after the relay flipped %s no longer matches (the UI shows the altered state)',
    async (_n, flip) => {
      const { c, card } = setup({ allow_edit: true, allow_revise: true, origin: 'chat' })
      await rejects(
        c.resolveCard(card.id, { action: 'kill', payloadHash: payloadHash(bindingFrom({ ...card, ...flip })) }),
        'card_hash_mismatch',
      )
    },
  )

  it('a high-risk primary goes through on the signed tap alone (no passkey, owner ruling 2026-11-14)', async () => {
    const { c, card, hash } = setup({ risk: 'high' })
    await c.resolveCard(card.id, { action: 'primary', payloadHash: hash })
    expect(c.store.getState().cards[0]?.state).toBe('done')
    expect(c.sent.at(-1)).not.toHaveProperty('stepup_token')
  })

  it('always: true rides inside the signed card.resolve, and is left out when not asked for', async () => {
    const { c, card, hash } = setup({ risk: 'high' })
    await c.resolveCard(card.id, { action: 'primary', payloadHash: hash, always: true })
    const frame = c.sent.at(-1) as Record<string, unknown>
    expect(frame).toMatchObject({ type: 'card.resolve', action: 'primary', always: true })
    expect(await verifyOwnerFrame(frame, await c.publicJwk())).toBe(true)
    // the signature covers it: the same frame without it no longer verifies
    const { always: _a, ...stripped } = frame
    expect(await verifyOwnerFrame(stripped, await c.publicJwk())).toBe(false)
    const other = setup({})
    await other.c.resolveCard(other.card.id, { action: 'primary', payloadHash: other.hash })
    expect(other.c.sent.at(-1)).not.toHaveProperty('always')
  })

  it('kill and revise never need a step-up', async () => {
    const { c, card, hash } = setup({ risk: 'high' })
    await c.resolveCard(card.id, { action: 'kill', payloadHash: hash })
    expect(c.store.getState().cards[0]?.state).toBe('done')
  })

  it('a card that is not pending or is past its expiry cannot be resolved', async () => {
    const done = setup({ state: 'done' })
    await rejects(done.c.resolveCard(done.card.id, { action: 'kill', payloadHash: done.hash }), 'card_not_pending')
    const old = setup({ expires_at: '2020-01-01T00:00:00.000Z', created_at: '2019-01-01T00:00:00.000Z' })
    await rejects(old.c.resolveCard(old.card.id, { action: 'kill', payloadHash: old.hash }), 'card_expired')
    const twice = setup()
    await twice.c.resolveCard(twice.card.id, { action: 'kill', payloadHash: twice.hash })
    await rejects(twice.c.resolveCard(twice.card.id, { action: 'kill', payloadHash: twice.hash }), 'card_not_pending')
  })

  it('edits: only editable fields and body, with the right edited_hash', async () => {
    const { c, card, hash } = setup({
      kind: 'email',
      risk: 'low',
      fields: [
        { key: 'to', label: 'To', value: 'a@example.com', editable: true, multiline: false },
        { key: 'subject', label: 'Subject', value: 'Hi', editable: false, multiline: false },
      ],
    })
    const binding = bindingFrom(card)
    await rejects(
      c.resolveCard(card.id, {
        action: 'primary',
        payloadHash: hash,
        edited: { fields: [{ key: 'subject', value: 'x' }] },
        editedHash: 'x',
      }),
      'card_edit_forbidden',
    )
    const edited = { fields: [{ key: 'to', value: 'b@example.com' }] }
    await rejects(
      c.resolveCard(card.id, { action: 'primary', payloadHash: hash, edited, editedHash: payloadHash(binding) }),
      'card_hash_mismatch',
    )
    await c.resolveCard(card.id, {
      action: 'primary',
      payloadHash: hash,
      edited,
      editedHash: editedHash(binding, edited),
    })
    expect((c.sent.at(-1) as { edited_hash: string }).edited_hash).toBe(editedHash(binding, edited))
  })

  it('patchConfig: allowlist, no step-up anywhere, config_conflict simulation, and a good patch', async () => {
    const c = createFakeClient()
    await rejects(c.patchConfig({ trust_mode: 'yes' }), 'config_field_forbidden')
    await c.patchConfig({ trust_mode: true })
    expect(c.store.getState().config?.trust_mode).toBe(true)
    await c.patchConfig({ trust_mode: false })
    expect('trust_mode' in (c.store.getState().config ?? {})).toBe(false)
    await rejects(c.patchConfig({ rev: 9 }), 'config_field_forbidden')
    await c.patchConfig({ work: { enabled: ['slack'] } })
    expect(c.store.getState().config?.work.enabled).toEqual(['slack'])
    await c.patchConfig({ always_allow: [{ kind: 'email', destination: null }] })
    expect(c.store.getState().config?.always_allow).toEqual([{ kind: 'email', destination: null }])
    expect(c.sent.every((f) => !('stepup_token' in f))).toBe(true)
    c.failNextPatchWith('config_conflict')
    await rejects(c.patchConfig({ timezone: 'UTC' }), 'config_conflict')
    const rev = c.store.getState().config?.rev
    await c.patchConfig({ agent: { name: 'Atlas' } })
    expect(c.store.getState().config?.rev).toBe((rev ?? 0) + 1)
    expect(c.store.getState().config?.agent.name).toBe('Atlas')
    expect((c.sent.at(-1) as { base_rev: number }).base_rev).toBe(rev)
  })

  it('patchConfig rejects a patch that would make the config invalid', async () => {
    const c = createFakeClient()
    await rejects(c.patchConfig({ timezone: 'Mars/Olympus' }), 'bad_frame')
  })
})

describe('fake client seam: frames, API', () => {
  it('onFrame returns an unsubscribe', async () => {
    const c = createFakeClient()
    let n = 0
    const off = c.onFrame('reply', () => n++)
    await c.sendMessage({ threadId: 'general', text: 'a' })
    await new Promise((r) => setTimeout(r, 10))
    off()
    await c.sendMessage({ threadId: 'general', text: 'b' })
    await new Promise((r) => setTimeout(r, 10))
    expect(n).toBe(1)
  })

  it('api.catalog serves the integration catalog (18 entries) for the wizard in fake mode', async () => {
    const c = createFakeClient()
    const cat = await c.api.catalog()
    expect(cat).toHaveLength(18)
    expect(
      cat
        .filter((s) => s.category === 'work')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['gmail_work', 'heartbeat', 'jira', 'salesforce', 'slack', 'zoom'])
  })

  it('api.connections is an in-memory CRUD with the shapes of the route table', async () => {
    const c = createFakeClient()
    const created = await c.api.connections.create({ integration: 'generic', name: 'My hook' })
    expect(created.hook_url).toContain(`/hook/generic/${created.id}`)
    expect(created.secret).toMatch(/^whsec_/)
    expect(await c.api.connections.list()).toHaveLength(1)
    expect((await c.api.connections.patch(created.id, { status: 'paused' })).status).toBe('paused')
    expect((await c.api.connections.rotate(created.id)).secret).not.toBe(created.secret)
    expect((await c.api.connections.test(created.id)).ok).toBe(true)
    expect(await c.api.connections.deliveries(created.id)).toEqual([])
    await c.api.connections.delete(created.id)
    expect(await c.api.connections.list()).toEqual([])
    await expect(c.api.connections.get(created.id)).rejects.toBeInstanceOf(TalosClientError)
  })

  it('api.inbox splits Priority (high+normal) from Other (low) and carries the truncated flag', async () => {
    const c = createFakeClient()
    const first = await c.api.inbox('priority')
    expect(first.counts).toEqual({ priority: 1, other: 0 })
    expect(first.items).toHaveLength(1)
    expect((await c.api.inbox('other')).items).toHaveLength(0)
    expect(first.truncated).toBeUndefined()
    c.store.setState((s) => ({ ...s, inboxTruncated: true }))
    expect((await c.api.inbox('priority')).truncated).toBe(true)
  })
})
