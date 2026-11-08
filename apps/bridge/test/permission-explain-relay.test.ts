// The explanation on a permission card, end to end through the live bridge: the card goes out at once with `explain: pending`,
// the sentence follows as a card.update, both permission paths (the channel relay and the PermissionRequest hook) get it, an
// answer never waits for it, one that arrives after the card was answered is dropped, and with no explainer the card is exactly
// what it was. A fake claude stands in for the CLI (fixtures/fake-explain-claude.sh); the real one is never run.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CardT, type PermissionExplainT, permissionCardAllowsPrimary } from '@talos-app/protocol'
import { permissionFixture } from '@talos-app/testkit'
import { createExplainer, type Explainer, type ExplainOutcome } from '../src/permission/explainer.ts'
import { eventually, fixture, type Harness, sleep, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function start(explainer?: Explainer) {
  h = await startHarness()
  h.bridge.ctx.config.config.permission_relay = true
  h.bridge.setClientVersion(() => '2.1.312')
  h.bridge.ctx.permission.setHookTimings({ graceMs: 20 })
  if (explainer) h.bridge.ctx.permission.setExplainer(explainer)
  return h
}

const fakeCli = (answer: unknown, mode = 'ok') => {
  const dir = mkdtempSync(join(tmpdir(), 'explain-rel-'))
  writeFileSync(join(dir, 'mode'), mode)
  writeFileSync(
    join(dir, 'stdout'),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer) }),
  )
  return createExplainer({
    claude: fixture('fake-explain-claude.sh'),
    env: { PATH: process.env.PATH ?? '', HOME: dir, FAKE_DIR: dir },
  })
}

const created = async (x: Harness, id: string): Promise<CardT> =>
  (
    await x.relay.expectFrame('card.create', (f) => (f.card.payload as { request_id?: string })?.request_id === id, {
      direction: 'from_bridge',
    })
  ).card
const explainUpdates = (x: Harness, cardId: string) =>
  x.relay.frames.filter(
    (f) =>
      f.direction === 'from_bridge' &&
      f.frame.type === 'card.update' &&
      f.frame.card_id === cardId &&
      (f.frame as { explain?: unknown }).explain !== undefined,
  )
const nextExplain = async (x: Harness, cardId: string) =>
  (await x.relay.expectFrame(
    'card.update',
    (f) => f.card_id === cardId && (f as { explain?: unknown }).explain !== undefined,
    {
      direction: 'from_bridge',
    },
  )) as unknown as { state: string; explain: PermissionExplainT }

const HOOK_CALL = {
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf build/ ~/Downloads/*', description: 'cleans up the build folder' },
}
const startHook = (x: Harness) => {
  const ac = new AbortController()
  const done = x.bridge.ctx.permission.onHookRequest(HOOK_CALL, ac.signal)
  return { done, ac }
}
const hookCard = async (x: Harness): Promise<CardT> => {
  let c: CardT | undefined
  await eventually(() => {
    c = x.relay.frames
      .filter((f) => f.direction === 'from_bridge' && f.frame.type === 'card.create')
      .map((f) => (f.frame as { card: CardT }).card)
      .find((k) => k.kind === 'permission')
    expect(c).toBeDefined()
  })
  return c as CardT
}

describe('the channel relay path', () => {
  test('the card goes out at once marked pending; the sentence follows as a card.update that keeps the card pending', async () => {
    const x = await start(
      fakeCli({
        tag: 'Deletes',
        mismatch: true,
        sentence: 'Claude says it tidies up, but it deletes your Downloads. Check before allowing.',
      }),
    )
    const fx = permissionFixture('plain_bash').params
    await x.bridge.ctx.permission.onRequest(fx)
    const card = await created(x, fx.request_id)
    expect(card.explain).toEqual({ status: 'pending' })
    expect(card.state).toBe('pending')
    const u = await nextExplain(x, card.id)
    expect(u.state).toBe('pending')
    expect(u.explain).toEqual({
      status: 'ready',
      tag: 'Deletes',
      mismatch: true,
      sentence: 'Claude says it tidies up, but it deletes your Downloads. Check before allowing.',
    })
  })

  test('the explanation is not part of what the owner approves: Allow still works, the hash is the one the card shipped with', async () => {
    const x = await start(fakeCli({ tag: 'Reads files', mismatch: false, sentence: 'Lists the files.' }))
    const fx = permissionFixture('plain_bash').params
    await x.bridge.ctx.permission.onRequest(fx)
    const card = await created(x, fx.request_id)
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    await nextExplain(x, card.id)
    let verdict: unknown
    x.bridge.setPermissionSender(async (v) => {
      verdict = v
    })
    await x.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: x.relay.mintStepup(`card:${card.id}`) })
    await eventually(() => expect(verdict).toEqual({ request_id: fx.request_id, behavior: 'allow' }))
  })

  test('a failed run becomes a failed explanation', async () => {
    const x = await start(fakeCli({}, 'exit1'))
    const fx = permissionFixture('plain_bash').params
    await x.bridge.ctx.permission.onRequest(fx)
    const card = await created(x, fx.request_id)
    expect((await nextExplain(x, card.id)).explain).toEqual({ status: 'failed' })
  })

  test('an explainer that throws never breaks the card', async () => {
    const x = await start({
      explain: async () => {
        throw new Error('boom')
      },
    })
    const fx = permissionFixture('plain_bash').params
    await x.bridge.ctx.permission.onRequest(fx)
    const card = await created(x, fx.request_id)
    expect((await nextExplain(x, card.id)).explain).toEqual({ status: 'failed' })
  })

  test('the answer does not wait: Deny before the explanation lands works, and the late explanation is dropped', async () => {
    let release: (o: ExplainOutcome) => void = () => {}
    const gate = new Promise<ExplainOutcome>((r) => {
      release = r
    })
    const x = await start({ explain: () => gate })
    const fx = permissionFixture('plain_bash').params
    await x.bridge.ctx.permission.onRequest(fx)
    const card = await created(x, fx.request_id)
    let verdict: unknown
    x.bridge.setPermissionSender(async (v) => {
      verdict = v
    })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(verdict).toEqual({ request_id: fx.request_id, behavior: 'deny' }))
    const before = x.relay.frames.length
    release({ ok: true, tag: 'Reads files', mismatch: false, sentence: 'Lists files.' })
    await sleep(250)
    expect(explainUpdates(x, card.id)).toHaveLength(0)
    expect(
      x.relay.frames.slice(before).filter((f) => f.direction === 'from_bridge' && f.frame.type === 'card.update'),
    ).toHaveLength(0)
  })

  test("no explainer (no claude found, or switched off): the card is exactly today's card and nothing follows", async () => {
    const x = await start()
    const fx = permissionFixture('plain_bash').params
    await x.bridge.ctx.permission.onRequest(fx)
    const card = await created(x, fx.request_id)
    expect('explain' in card).toBe(false)
    await sleep(250)
    expect(explainUpdates(x, card.id)).toHaveLength(0)
  })
})

describe('shutdown', () => {
  test('when this bridge stops being the live one, running explainers are closed', async () => {
    let closed = 0
    const x = await start({
      explain: () => new Promise(() => {}),
      close: () => {
        closed++
      },
    })
    const fx = permissionFixture('plain_bash').params
    await x.bridge.ctx.permission.onRequest(fx)
    await created(x, fx.request_id)
    x.bridge.ctx.permission.closeAll()
    expect(closed).toBe(1)
  })
})

describe('the hook path', () => {
  test('a hook card gets the same pending marker and the same explanation, including the floor', async () => {
    // the fake model talks the delete down; the shown tag is still Deletes and the sentence says why
    const x = await start(fakeCli({ tag: 'Reads files', mismatch: false, sentence: 'Cleans up the build folder.' }))
    const { done, ac } = startHook(x)
    const card = await hookCard(x)
    expect(card.explain).toEqual({ status: 'pending' })
    const u = await nextExplain(x, card.id)
    expect(u.explain).toEqual({
      status: 'ready',
      tag: 'Deletes',
      mismatch: true,
      sentence: 'Cleans up the build folder. Talos also sees that it deletes files.',
    })
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await done).toMatchObject({ decision: 'deny' })
    ac.abort()
  })

  test('the model is given the command and Claude\'s own description, not the "asked by pid" note the bridge adds', async () => {
    const seen: { tool: string; input: string; description: string }[] = []
    const x = await start({
      explain: async (r) => {
        seen.push(r)
        return { ok: false, reason: 'test' }
      },
    })
    const { done } = startHook(x)
    const card = await hookCard(x)
    await nextExplain(x, card.id)
    expect(seen).toEqual([
      { tool: 'Bash', input: 'rm -rf build/ ~/Downloads/*', description: 'cleans up the build folder' },
    ])
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await done
  })

  test('Deny before the explanation: answered at once, late explanation dropped', async () => {
    let release: (o: ExplainOutcome) => void = () => {}
    const gate = new Promise<ExplainOutcome>((r) => {
      release = r
    })
    const x = await start({ explain: () => gate })
    const { done } = startHook(x)
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await done).toMatchObject({ decision: 'deny' })
    release({ ok: true, tag: 'Reads files', mismatch: false, sentence: 'Lists files.' })
    await sleep(250)
    expect(explainUpdates(x, card.id)).toHaveLength(0)
  })

  test('no explainer: the hook card carries no explain field', async () => {
    const x = await start()
    const { done } = startHook(x)
    const card = await hookCard(x)
    expect('explain' in card).toBe(false)
    await x.app.resolveCard(card, 'kill', card.payload_hash)
    await done
  })
})
