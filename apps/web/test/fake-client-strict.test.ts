import { bindingFrom, type CardT, editedHash, payloadHash } from '@talos-app/protocol'
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

  it('a high-risk primary needs a step-up token minted for exactly that card, once', async () => {
    const { c, card, hash } = setup({ risk: 'high' })
    await rejects(c.resolveCard(card.id, { action: 'primary', payloadHash: hash }), 'stepup_required')
    await rejects(
      c.resolveCard(card.id, { action: 'primary', payloadHash: hash, stepupToken: 'st_made_up' }),
      'stepup_invalid',
    )
    await rejects(
      c.resolveCard(card.id, { action: 'primary', payloadHash: hash, stepupToken: await c.stepup('config:work') }),
      'stepup_invalid',
    )
    const token = await c.stepup(`card:${card.id}`)
    await c.resolveCard(card.id, { action: 'primary', payloadHash: hash, stepupToken: token })
    expect(c.store.getState().cards[0]?.state).toBe('done')
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

  it('patchConfig: allowlist, work.enabled step-up, config_conflict simulation, and a good patch', async () => {
    const c = createFakeClient()
    await rejects(c.patchConfig({ trust_mode: true }), 'config_field_forbidden')
    await rejects(c.patchConfig({ rev: 9 }), 'config_field_forbidden')
    await rejects(c.patchConfig({ work: { enabled: ['slack'] } }), 'stepup_required')
    await c.patchConfig({ work: { enabled: ['slack'] } }, { stepupToken: await c.stepup('config:work') })
    expect(c.store.getState().config?.work.enabled).toEqual(['slack'])
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

describe('fake client seam: voice, frames, API', () => {
  it('sendVoiceAsk signs a voice.ask and emits voice.state and a reply carrying voice_delegation_id', async () => {
    const c = createFakeClient()
    const states: string[] = []
    const replies: Array<{ voice_delegation_id?: string; speak?: string }> = []
    c.onFrame('voice.state', (f) => states.push(f.state))
    c.onFrame('reply', (f) =>
      replies.push({
        ...(f.voice_delegation_id ? { voice_delegation_id: f.voice_delegation_id } : {}),
        ...(f.speak ? { speak: f.speak } : {}),
      }),
    )
    await c.sendVoiceAsk({
      voiceSessionId: 'v_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      delegationId: 'vd_1',
      threadId: 'general',
      question: 'What is on today?',
      transcriptTail: [{ who: 'owner', text: 'hi' }],
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(states).toEqual(['delegating', 'live'])
    expect(replies[0]?.voice_delegation_id).toBe('vd_1')
    expect((c.sent[0] as { type: string; question: string }).type).toBe('voice.ask')
  })

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
