// WP-C1 (docs/CLAUDE-CODE.md C3.1-C3.5, C3.8): a permission prompt Claude Code relays becomes a card on the phone, and an
// owner-signed Allow/Deny becomes the verdict. Driven through the REAL stdio server with the testkit's FakeClaude (which
// models Claude Code's side of the relay: capability gating, first answer wins, repeated ids), the real FakeRelay and a
// FakeApp holding a pinned device key.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  type CardT,
  type JwkP256T,
  PERMISSION_HIDDEN_WARNING,
  PERMISSION_OLD_CLIENT_WARNING,
  type PermissionRequestT,
  permissionCardAllowsPrimary,
} from '@talos-app/protocol'
import {
  FakeApp,
  FakeClaude,
  FakeRelay,
  loadExampleConfig,
  mkFrame,
  type PermissionFixture,
  permissionFixture,
  sleep,
} from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { nullLogger } from '../src/log.ts'
import { eventually, pushCardResolvePastRelay, startHarness, stopRelay, tempHome } from './helpers.ts'

const BRIDGE_DIR = resolve(import.meta.dir, '..')
/**
 * A signed card.resolve handed straight to the Mac. The relay turns away a wrong hash itself, and cannot tell a hidden
 * call's forged Allow from a real one, so what the Mac does with them is played by a relay that lets them through.
 */
async function resolvePastRelay(r: Rig, card: CardT, hash: string) {
  const signed = await r.app.sign({
    ...mkFrame('card.resolve'),
    card_id: card.id,
    action: 'primary',
    payload_hash: hash,
  })
  return r.relay.sendToBridge(signed) as { id: string }
}
type Rig = { relay: FakeRelay; app: FakeApp; claude: FakeClaude; home: string; stop(): Promise<void> }
const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop()
})

async function rig(opts: { relayOn?: boolean; version?: string; pin?: boolean; others?: string } = {}): Promise<Rig> {
  const relay = await new FakeRelay().start()
  const home = tempHome('talos-cc-c1-')
  mkdirSync(home, { recursive: true })
  const cfg = { ...loadExampleConfig('default'), permission_relay: opts.relayOn ?? true }
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg), { mode: 0o600 })
  writeFileSync(
    join(home, 'bridge.key'),
    JSON.stringify({
      v: 1,
      pkcs8: relay.bridgeKey.privateKeyPkcs8B64,
      public: relay.bridgeKey.publicKeyB64,
      key_id: relay.bridgeKey.keyId,
    }),
    { mode: 0o600 },
  )
  const app = new FakeApp({ relayWs: relay.wsBase })
  await app.connect()
  const pinned: Record<string, JwkP256T> = opts.pin === false ? {} : { [app.device.deviceId]: app.device.publicJwk }
  writeFileSync(
    join(home, 'devices.json'),
    JSON.stringify({
      version: 1,
      devices: Object.entries(pinned).map(([id, jwk]) => ({ id, name: 'Test', pubkey_jwk: jwk })),
    }),
    { mode: 0o600 },
  )
  const claude = new FakeClaude({
    command: 'bun',
    args: ['run', join(BRIDGE_DIR, 'src', 'server.ts')],
    cwd: BRIDGE_DIR,
    clientVersion: opts.version ?? '2.1.312',
    env: {
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: relay.httpUrl,
      TALOS_APP_BRIDGE: '1',
      TALOS_APP_OTHER_CHANNELS: opts.others ?? '', // never read the developer's own claude command line
    },
  })
  await claude.start()
  const r: Rig = {
    relay,
    app,
    claude,
    home,
    async stop() {
      await claude.stop().catch(() => {})
      await app.close()
      await stopRelay(relay)
    },
  }
  rigs.push(r)
  // the bridge connects to the relay after Claude Code's `initialized`
  await relay.expectFrame('ready', () => true, { direction: 'to_bridge' })
  await sleep(100)
  return r
}

const cardFor = async (r: Rig, requestId: string): Promise<CardT> =>
  (
    await r.relay.expectFrame(
      'card.create',
      (f) => f.card.kind === 'permission' && (f.card.payload as { request_id?: string })?.request_id === requestId,
      { direction: 'from_bridge' },
    )
  ).card

describe('C3.1-C3.3 the relay through the real stdio server', () => {
  test('with permission_relay off the capability is not declared and no card appears', async () => {
    const r = await rig({ relayOn: false })
    const out = await r.claude.openPermission(permissionFixture('plain_bash').params)
    expect(out.relayed).toBe(false)
    await sleep(150)
    expect(r.relay.frames.some((f) => f.frame.type === 'card.create')).toBe(false)
  })

  test('plain_bash: the raw call first, Allow bound to it, an owner-signed Allow sends allow once', async () => {
    const r = await rig()
    const fx = permissionFixture('plain_bash')
    expect((await r.claude.openPermission(fx.params)).relayed).toBe(true)
    const card = await cardFor(r, fx.params.request_id)
    expect(card.kind).toBe('permission')
    expect(card.title).toBe('Allow Bash?')
    expect(card.body).toBe(fx.params.input_preview)
    expect(card.body_format).toBe('plain')
    expect(card.fields[0]?.value).toBe(fx.params.description)
    expect(card.risk).toBe('high')
    expect(card.origin).toBe('background')
    expect(card.warning).toBeUndefined()
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    await r.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: r.relay.mintStepup(`card:${card.id}`) })
    const v = await r.claude.waitForVerdict(fx.params.request_id)
    expect(v).toMatchObject({ behavior: 'allow', outcome: 'applied' })
    expect(r.claude.permissionState(fx.params.request_id)).toBe('allowed')
    // the agent never hears about it: no card_action notification
    await sleep(100)
    expect(r.claude.notifications.some((n) => n.meta.kind === 'card_action')).toBe(false)
    const done = await r.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done', {
      direction: 'from_bridge',
    })
    expect(done.result?.ok).toBe(true)
    // a replayed resolve cannot make a second verdict
    await r.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: r.relay.mintStepup(`card:${card.id}`) })
    await sleep(200)
    await eventually(() =>
      expect(r.claude.permissionVerdicts.filter((x) => x.request_id === fx.params.request_id)).toHaveLength(1),
    )
  })

  test('a loaded other channel: one-line note on the card, Allow still works (the owner chose this)', async () => {
    const r = await rig({ others: 'discord' })
    const fx = permissionFixture('plain_bash')
    await r.claude.openPermission(fx.params)
    const card = await cardFor(r, fx.params.request_id)
    expect(card.warning).toBe('discord can also approve this.')
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    await r.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: r.relay.mintStepup(`card:${card.id}`) })
    expect(await r.claude.waitForVerdict(fx.params.request_id)).toMatchObject({ behavior: 'allow', outcome: 'applied' })
  })

  test('Deny sends deny', async () => {
    const r = await rig()
    const fx = permissionFixture('write_file')
    await r.claude.openPermission(fx.params)
    const card = await cardFor(r, fx.params.request_id)
    await r.app.resolveCard(card, 'kill', card.payload_hash)
    expect(await r.claude.waitForVerdict(fx.params.request_id)).toMatchObject({ behavior: 'deny', outcome: 'applied' })
    expect(r.claude.permissionState(fx.params.request_id)).toBe('denied')
    // a denied permission card is finished, not left "resolved" for ever
    await r.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', {
      direction: 'from_bridge',
    })
  })

  test('the redacted fixture gets no Allow (the mask also hits key names)', async () => {
    const r = await rig()
    const fx = permissionFixture('redacted')
    await r.claude.openPermission(fx.params)
    const card = await cardFor(r, fx.params.request_id)
    expect(permissionCardAllowsPrimary(card)).toBe(false)
  })

  for (const name of ['elided', 'unserializable', 'legacy_cut']) {
    test(`${name}: no Allow, a forged PRIMARY is refused with permission_hidden, Deny still works`, async () => {
      const r = await rig()
      const fx = permissionFixture(name)
      await r.claude.openPermission(fx.params)
      const card = await cardFor(r, fx.params.request_id)
      expect(card.warning).toBe(PERMISSION_HIDDEN_WARNING)
      expect(permissionCardAllowsPrimary(card)).toBe(false)
      const f = await resolvePastRelay(r, card, card.payload_hash)
      const err = await r.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })
      expect(err.code).toBe('permission_hidden')
      await sleep(150)
      expect(r.claude.permissionVerdicts).toHaveLength(0)
      expect(r.claude.permissionState(fx.params.request_id)).toBe('open')
      await r.app.resolveCard(card, 'kill', card.payload_hash)
      expect(await r.claude.waitForVerdict(fx.params.request_id)).toMatchObject({
        behavior: 'deny',
        outcome: 'applied',
      })
    })
  }

  test('a right-to-left override in the command: no Allow, the character shows as [U+202E]', async () => {
    const r = await rig()
    const params: PermissionRequestT = {
      request_id: 'bcdfg',
      tool_name: 'Bash',
      description: 'Run the check',
      input_preview: '{"command": "echo ok ‮~ fr- mr"}',
    }
    await r.claude.openPermission(params)
    const card = await cardFor(r, 'bcdfg')
    expect(card.body).toContain('[U+202E]')
    expect(card.body).not.toContain('‮')
    expect(permissionCardAllowsPrimary(card)).toBe(false)
    const f = await r.app.resolveCard(card, 'primary', card.payload_hash, {
      stepup_token: r.relay.mintStepup(`card:${card.id}`),
    })
    expect((await r.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })).code).toBe(
      'permission_hidden',
    )
    expect(r.claude.permissionVerdicts).toHaveLength(0)
  })

  for (const version of ['2.1.210', '2.0.0', '0.0.0']) {
    test(`Claude Code ${version} (below the 2.1.211 floor): deny-only with the old-client warning`, async () => {
      const r = await rig({ version })
      const fx = permissionFixture('plain_bash')
      await r.claude.openPermission(fx.params)
      const card = await cardFor(r, fx.params.request_id)
      expect(card.warning).toBe(PERMISSION_OLD_CLIENT_WARNING)
      const f = await r.app.resolveCard(card, 'primary', card.payload_hash, {
        stepup_token: r.relay.mintStepup(`card:${card.id}`),
      })
      expect((await r.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })).code).toBe(
        'permission_hidden',
      )
      expect(r.claude.permissionVerdicts).toHaveLength(0)
    })
  }

  test('repeated id: the second card is deny-only and no verdict can reach Claude Code', async () => {
    const r = await rig()
    const fx: PermissionFixture = permissionFixture('repeated_id')
    await r.claude.openPermission(fx.params)
    const first = await cardFor(r, fx.params.request_id)
    await r.claude.openPermission(fx.params)
    await r.relay.expectFrame('card.create', (f) => f.card.id !== first.id && f.card.kind === 'permission', {
      direction: 'from_bridge',
    })
    const second = r.relay.frames
      .map((x) => x.frame)
      .filter((f) => f.type === 'card.create' && f.card.kind === 'permission')
      .map((f) => (f as { card: CardT }).card)
      .find((c) => c.id !== first.id) as CardT
    expect(second.warning).toBeDefined()
    expect(permissionCardAllowsPrimary(second)).toBe(false)
    // the first card's id is poisoned too: Claude Code drops every verdict for it, so none may be sent
    const f = await r.app.resolveCard(first, 'primary', first.payload_hash, {
      stepup_token: r.relay.mintStepup(`card:${first.id}`),
    })
    expect((await r.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })).code).toBe(
      'permission_closed',
    )
    expect(r.claude.permissionVerdicts).toHaveLength(0)
  })

  test('answered at the Mac first: a later Allow from the phone is ignored by Claude Code', async () => {
    const r = await rig()
    const fx = permissionFixture('plain_bash')
    await r.claude.openPermission(fx.params)
    const card = await cardFor(r, fx.params.request_id)
    r.claude.answerAtTerminal(fx.params.request_id, 'deny')
    await r.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: r.relay.mintStepup(`card:${card.id}`) })
    // The bridge reports the phone's Allow exactly as chosen; Claude Code (the fake enforces its first-answer rule) closes it.
    expect(await r.claude.waitForVerdict(fx.params.request_id)).toMatchObject({ behavior: 'allow', outcome: 'closed' })
    expect(r.claude.permissionState(fx.params.request_id)).toBe('denied')
  })

  test('only an owner-signed frame approves: an unpinned device and an unsigned frame do nothing', async () => {
    const r = await rig({ pin: false })
    const fx = permissionFixture('plain_bash')
    await r.claude.openPermission(fx.params)
    const card = await cardFor(r, fx.params.request_id)
    await r.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: r.relay.mintStepup(`card:${card.id}`) }) // signed, but this device is not pinned
    r.app.send({
      type: 'card.resolve',
      device_id: r.app.device.deviceId,
      card_id: card.id,
      action: 'primary',
      payload_hash: card.payload_hash,
      stepup_token: r.relay.mintStepup(`card:${card.id}`),
    }) // no osig at all
    await sleep(300)
    expect(r.claude.permissionVerdicts).toHaveLength(0)
    expect(r.claude.permissionState(fx.params.request_id)).toBe('open')
  })

  test('a wrong hash is refused and sends nothing', async () => {
    const r = await rig()
    const fx = permissionFixture('plain_bash')
    await r.claude.openPermission(fx.params)
    const card = await cardFor(r, fx.params.request_id)
    const f = await resolvePastRelay(r, card, `sha256:${'a'.repeat(64)}`)
    expect((await r.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })).code).toBe(
      'card_hash_mismatch',
    )
    expect(r.claude.permissionVerdicts).toHaveLength(0)
  })

  test('two concurrent prompts stay independent', async () => {
    const r = await rig()
    const a = permissionFixture('plain_bash').params
    const b = permissionFixture('write_file').params
    await r.claude.openPermission(a)
    await r.claude.openPermission(b)
    const ca = await cardFor(r, a.request_id)
    const cb = await cardFor(r, b.request_id)
    await r.app.resolveCard(cb, 'primary', cb.payload_hash, { stepup_token: r.relay.mintStepup(`card:${cb.id}`) })
    await r.claude.waitForVerdict(b.request_id)
    expect(r.claude.permissionState(a.request_id)).toBe('open')
    await r.app.resolveCard(ca, 'kill', ca.payload_hash)
    await r.claude.waitForVerdict(a.request_id)
    expect(r.claude.permissionState(a.request_id)).toBe('denied')
    expect(r.claude.permissionState(b.request_id)).toBe('allowed')
  })
})

describe('fail closed on errors, timeouts and restarts', () => {
  async function live() {
    const h = await startHarness()
    h.bridge.ctx.config.config.permission_relay = true
    h.bridge.setClientVersion(() => '2.1.312')
    return h
  }
  const waitCard = async (h: Awaited<ReturnType<typeof live>>, id: string) =>
    (
      await h.relay.expectFrame('card.create', (f) => (f.card.payload as { request_id?: string })?.request_id === id, {
        direction: 'from_bridge',
      })
    ).card

  test('a verdict that fails to send never reports success; the card fails and the prompt stays open', async () => {
    const h = await live()
    try {
      h.bridge.setPermissionSender(async () => {
        throw new Error('pipe closed')
      })
      const fx = permissionFixture('plain_bash').params
      await h.bridge.ctx.permission.onRequest(fx)
      const card = await waitCard(h, fx.request_id)
      await h.app.resolveCard(card, 'primary', card.payload_hash, {
        stepup_token: h.relay.mintStepup(`card:${card.id}`),
      })
      const u = await h.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'failed', {
        direction: 'from_bridge',
      })
      expect(u.reason).toBe('send_failed')
    } finally {
      await h.stop()
    }
  })

  test('a request that is not in the documented format is ignored: no card, no verdict', async () => {
    const h = await live()
    try {
      const sent: unknown[] = []
      h.bridge.setPermissionSender(async (v) => void sent.push(v))
      for (const bad of [
        {},
        null,
        'abcde',
        { request_id: 'abcdl', tool_name: 'Bash', description: 'x', input_preview: '{}' }, // an `l` is never in an id
        { request_id: 'abcde', tool_name: '', description: 'x', input_preview: '{}' },
        { request_id: 'abcde', tool_name: 'Bash', description: 1, input_preview: '{}' },
      ])
        await h.bridge.ctx.permission.onRequest(bad)
      await sleep(100)
      expect(h.relay.frames.some((f) => f.frame.type === 'card.create')).toBe(false)
      expect(sent).toEqual([])
    } finally {
      await h.stop()
    }
  })

  test('the relay off in config: onRequest does nothing', async () => {
    const h = await startHarness({ config: (c) => ({ ...c, permission_relay: false }) })
    try {
      h.bridge.setPermissionSender(async () => {})
      await h.bridge.ctx.permission.onRequest(permissionFixture('plain_bash').params)
      await sleep(100)
      expect(h.relay.frames.some((f) => f.frame.type === 'card.create')).toBe(false)
    } finally {
      await h.stop()
    }
  })

  test('a card that cannot be delivered closes its id; nothing is left to answer', async () => {
    const h = await live()
    try {
      const sent: unknown[] = []
      h.bridge.setPermissionSender(async (v) => void sent.push(v))
      h.bridge.ctx.transport.sendDurable = async () => {
        throw new Error('relay rejected')
      }
      await h.bridge.ctx.permission.onRequest(permissionFixture('plain_bash').params)
      expect(h.bridge.ctx.permission.openCount).toBe(0)
      expect(h.bridge.ctx.ledger.list('pending')).toHaveLength(0)
    } finally {
      await h.stop()
    }
  })

  test('after a restart a pending permission card expires: its request id died with the old process', async () => {
    const h = await live()
    try {
      h.bridge.setPermissionSender(async () => {})
      const fx = permissionFixture('plain_bash').params
      await h.bridge.ctx.permission.onRequest(fx)
      const card = await waitCard(h, fx.request_id)
      // A real restart: the first process stops, a second Bridge opens the same folder and starts. Nothing here calls the
      // sweep by hand, so it only passes if Bridge.start() itself runs it.
      await h.bridge.stop()
      const second = await Bridge.create({
        env: loadEnv({
          TALOS_APP_HOME: h.home,
          TALOS_APP_RELAY_URL: h.relay.httpUrl,
          TALOS_APP_BRIDGE: '1',
        }),
        logger: nullLogger,
        inbound: { settleMs: 20, maxSettleMs: 200 },
      })
      try {
        second.setEmit(async () => {})
        // The relay stays on across the restart, so the off-switch cleanup cannot be what closes the card.
        second.ctx.config.config.permission_relay = true
        second.setClientVersion(() => '2.1.312')
        second.start()
        await eventually(() => expect(second.ctx.ledger.get(card.id)?.state).toBe('expired'))
        await h.relay.expectFrame(
          'card.update',
          (f) => f.card_id === card.id && f.state === 'expired' && f.reason === 'session_ended',
          { direction: 'from_bridge' },
        )
      } finally {
        await second.stop()
      }
    } finally {
      await h.app.close()
      await stopRelay(h.relay)
    }
  })

  test('card expiry closes the id and the agent is not told', async () => {
    const h = await live()
    try {
      h.bridge.setPermissionSender(async () => {})
      const fx = permissionFixture('plain_bash').params
      await h.bridge.ctx.permission.onRequest(fx)
      const card = await waitCard(h, fx.request_id)
      await h.bridge.expiry.expire(card.id, 'expired')
      expect(h.bridge.ctx.permission.openCount).toBe(0)
      expect(h.notes.some((n) => n.meta.kind === 'card_action')).toBe(false)
      const f = await pushCardResolvePastRelay(h, card, card.payload_hash) // the relay itself answers card_expired
      expect((await h.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })).code).toBe(
        'permission_closed',
      )
    } finally {
      await h.stop()
    }
  })
})
