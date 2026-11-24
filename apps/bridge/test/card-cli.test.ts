// A card can carry `talos-app peer|devices` commands (`cli`). The agent never runs them: on the owner's signed in-app PRIMARY the BRIDGE
// runs each one in process, once, in order, with his authority (card-cli.ts). Real bridge over the fake relay, the real ledger, config
// and history.sqlite, the real CLI code. Fixed fake ids only.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindingFrom,
  type CardT,
  cardNotice,
  createPhoneKeys,
  newUlid,
  payloadHash,
  shownHash,
  signNativeAct,
  signNativeGrant,
} from '@talos-app/protocol'
import { fakeClock, t } from '@talos-app/testkit'
import { agentCliRefusal } from '../src/agent-cli.ts'
import { argvHash, CARD_CLI_ALLOWED, cliOfBinding, plainSentence, runCardCli } from '../src/card-cli.ts'
import { type CliIO, runCli } from '../src/cli-main.ts'
import { loadEnv } from '../src/config.ts'
import { SETTINGS_LOCKED } from '../src/trust.ts'
import { advanceSteps, eventually, type Harness, pushCardResolvePastRelay, startHarness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

const LIST = [
  ['peer', 'list'],
  ['devices', 'list'],
]
const D2 = 'd_bbbbbbbbbbbbbbbbbbbb'
const JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as never
const args = (cli: unknown, extra: Record<string, unknown> = {}) => ({
  thread_id: 'general',
  kind: 'decision',
  title: 'Re-link the two apps',
  primary_label: 'Re-link',
  kill_label: 'Kill re-link',
  risk: 'low',
  origin: 'chat',
  cli,
  ...extra,
})
async function makeCard(cli: unknown = LIST, extra: Record<string, unknown> = {}): Promise<CardT> {
  const res = await h.bridge.callTool('card', args(cli, extra))
  expect(res.isError, res.content[0]?.text).toBeFalsy()
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26})/.exec(res.content[0]?.text ?? '')?.[1]
  return (await h.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })).card
}
const pinSecond = (name = 'Old laptop') =>
  h.bridge.ctx.devices.pin({ id: D2, name, pubkey_jwk: JWK }, '2026-03-04T05:06:07.000Z')
const state = (c: CardT) => h.bridge.ctx.ledger.get(c.id)?.state
/** What the bridge posted to a thread as messages. */
const posted = (thread = 'general') =>
  h.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.frame.type === 'reply')
    .map((r) => (r.frame as { message: { thread_id: string; text: string } }).message)
    .filter((m) => m.thread_id === thread)
    .map((m) => m.text)
const updates = (c: CardT) =>
  h.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.frame.type === 'card.update')
    .map((r) => r.frame as { card_id: string; state: string; result?: { ok: boolean; text: string } })
    .filter((u) => u.card_id === c.id)
const approve = async (c: CardT) => {
  await h.app.resolveCard(c, 'primary', c.payload_hash)
  await eventually(() => expect(['done', 'failed']).toContain(state(c) as string))
  // the summary is posted just after the card is finished
  await eventually(() => expect(posted().some((m) => m.includes(c.title))).toBe(true))
}
const ONLY = () => h.app.device.deviceId

describe('what a card may carry, and what it shows', () => {
  test('(a) only the peer and devices commands the agent may run are allowed: anything else is refused when the card is made', async () => {
    h = await startHarness()
    expect(CARD_CLI_ALLOWED.every((n) => n.startsWith('peer ') || n.startsWith('devices '))).toBe(true)
    for (const bad of [
      [['relay', 'update']],
      [['relay', 'auto', 'off']],
      [['enroll']],
      [['rotate']],
      [['trust', 'on']],
      [['install-guards', '--remove']],
      [['doctor']],
      [['peer', 'bogus', 'work']],
      [
        ['peer', 'list'],
        ['relay', 'update'],
      ], // one bad command spoils the card
      [['peer', 'link', 'work bob']],
      [['peer', 'link', 5]],
      [[]],
      [],
      'peer link work',
      Array.from({ length: 9 }, (_, i) => ['peer', 'link', `p${i}`]),
      [['peer', 'add', 'work', '--secret-file', 'secret.txt']],
      [['peer', 'add', 'work', '--secret-file=secret.txt']],
      [['peer', 'add', 'work', '--url', 'file:///etc/passwd']],
      [['peer', 'link', 'peer-secrets/work.secret']],
      [['peer', 'link', '..']],
    ]) {
      const r = await h.bridge.callTool('card', args(bad))
      expect(r.isError, JSON.stringify(bad)).toBe(true)
    }
  })

  test('(b) the card says what will happen in plain words, with the exact commands under Details; both and a check code are in the payload hash', async () => {
    h = await startHarness()
    const argvs = [
      ['peer', 'remove', 'work'],
      ['peer', 'list'],
    ]
    const card = await makeCard(argvs, { fields: [{ key: 'why', label: 'Why', value: 'they drifted' }] })
    expect(card.fields.map((f) => [f.key, f.label])).toEqual([
      ['talos_cli_plain', 'What will happen'],
      ['talos_cli', 'Details'],
      ['talos_cli_hash', 'Commands check'],
      ['why', 'Why'],
    ])
    expect(card.fields[0]?.value).toBe('1. Removes the link to work.\n2. Lists the agents you have linked.')
    expect(card.fields[1]?.value).toBe('talos-app peer remove work\ntalos-app peer list')
    expect(card.fields[2]?.value).toBe(argvHash(argvs))
    expect(card.fields.slice(0, 3).every((f) => f.editable === false)).toBe(true)
    expect(card.payload_hash).toBe(payloadHash(bindingFrom(card)))
    expect(cliOfBinding(bindingFrom(card))).toEqual(argvs)
    // each part moves the payload hash: other commands, so other words, other details and another check code
    const other = await makeCard([['peer', 'remove', 'work']])
    expect(other.payload_hash).not.toBe(card.payload_hash)
    for (const i of [0, 1, 2]) {
      const b = bindingFrom(card)
      b.fields = b.fields.map((f, j) => (j === i ? { ...f, value: `${f.value} ` } : f))
      expect(payloadHash(b), `field ${i}`).not.toBe(card.payload_hash)
      expect(cliOfBinding(b), `field ${i} edited`).toBeUndefined() // and the bridge would run nothing
    }
  })

  test('a devices revoke card names the device in the plain words, is high risk, and refuses unknown or revoked ids', async () => {
    h = await startHarness()
    expect((await h.bridge.callTool('card', args([['devices', 'revoke', 'd_zzzzzzzzzzzzzzzzzzzz']]))).isError).toBe(
      true,
    )
    pinSecond('Old laptop')
    const card = await makeCard([['devices', 'revoke', D2]], { risk: 'low' })
    expect(card.risk).toBe('high')
    expect(card.fields[0]?.value).toBe('1. Removes access for Old laptop (added 2026-03-04).')
    h.bridge.ctx.devices.revoke(D2, '2026-05-01T00:00:00.000Z')
    expect((await h.bridge.callTool('card', args([['devices', 'revoke', D2]]))).isError).toBe(true)
  })

  test("an agent field with the bridge's key, or its label on a card with commands, is refused", async () => {
    h = await startHarness()
    for (const f of [
      { key: 'talos_cli', label: 'Fine', value: 'talos-app peer link work' },
      { key: 'talos_cli_plain', label: 'Fine', value: 'Does nothing' },
      { key: 'talos_cli_hash', label: 'Fine', value: 'sha256:x' },
    ]) {
      expect((await h.bridge.callTool('card', args(undefined, { fields: [f] }))).isError, f.key).toBe(true)
    }
    for (const label of ['Details', 'what will happen', 'Commands check', 'Lets your agent run']) {
      const r = await h.bridge.callTool('card', args(LIST, { fields: [{ key: 'x', label, value: 'y' }] }))
      expect(r.isError, label).toBe(true)
    }
    // an ordinary card may still have a field called Details
    expect(
      (await h.bridge.callTool('card', args(undefined, { fields: [{ key: 'x', label: 'Details', value: 'y' }] })))
        .isError,
    ).toBeFalsy()
  })
})

describe("what the owner's signed PRIMARY runs", () => {
  test("1/6: it runs exactly the shown commands, once, in order, and the output lands in the card's thread and the ledger", async () => {
    h = await startHarness()
    const card = await makeCard()
    await approve(card)
    expect(state(card)).toBe('done')
    const text = posted().find((m) => m.includes('Re-link the two apps')) ?? ''
    expect(text).toContain('Ran 2 commands.')
    // the thread gets the summary only: what the commands printed is on the card, for the owner
    expect(text).not.toContain('talos-app peer list')
    expect(text).not.toContain(ONLY())
    const shown = updates(card).find((u) => u.state === 'done')?.result?.text ?? ''
    const iPeer = shown.indexOf('talos-app peer list')
    const iDev = shown.indexOf('talos-app devices list')
    expect(iPeer).toBeGreaterThan(-1)
    expect(iDev).toBeGreaterThan(iPeer)
    expect(shown).toContain(ONLY()) // the real `devices list` output
    const done = updates(card).find((u) => u.state === 'done')
    expect(done?.result?.ok).toBe(true)
    expect(h.notes).toHaveLength(0) // the agent is not told to run anything
    // a replay of the signed frame, or a second tap, runs nothing more
    const again = await pushCardResolvePastRelay(h, card, card.payload_hash)
    const err = await h.relay.expectFrame('error', (f) => f.ref === again.id, { direction: 'from_bridge' })
    expect(err.code).toBe('card_not_pending')
    expect(posted().filter((m) => m.includes('Re-link the two apps'))).toHaveLength(1)
  })

  test('it stops at the first command that fails and says which', async () => {
    h = await startHarness()
    // the only approved device cannot be revoked: that command fails, and the one after it never runs
    const card = await makeCard([
      ['peer', 'list'],
      ['devices', 'revoke', ONLY()],
      ['devices', 'list'],
    ])
    await approve(card)
    expect(state(card)).toBe('failed')
    const text = posted().find((m) => m.includes('Re-link the two apps')) ?? ''
    expect(text).toContain('Stopped at talos-app devices revoke')
    expect(text).toContain('last approved device')
    expect(updates(card).find((u) => u.state === 'failed')?.result?.ok).toBe(false)
    expect(updates(card).find((u) => u.state === 'failed')?.result?.text).not.toContain('talos-app devices list')
  })

  test('2: Kill runs nothing (the agent hears it as for any card)', async () => {
    h = await startHarness()
    const card = await makeCard()
    await h.app.resolveCard(card, 'kill', card.payload_hash)
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.card_action).toBe('kill')
    expect(posted().filter((m) => m.includes('Re-link the two apps'))).toHaveLength(0)
  })

  test('2: a notification tap is refused, the card stays pending and nothing runs', async () => {
    h = await startHarness()
    const card = await makeCard()
    const dev = h.app.device
    const keys = await createPhoneKeys()
    const grant = await signNativeGrant({
      deviceId: dev.deviceId,
      devicePrivateKey: dev.privateKey,
      encPub: keys.encPub,
      actPub: keys.actPub,
      nowMs: Date.now(),
    })
    const id = newUlid()
    const now = Date.now()
    const frame = await signNativeAct({
      deviceId: dev.deviceId,
      id,
      ts: new Date(now).toISOString(),
      grant,
      body: {
        a: 'approve',
        shown_v: '3',
        card_id: card.id,
        payload_hash: card.payload_hash,
        shown: shownHash(cardNotice(card).text, 'General'),
      },
      actPrivateKey: keys.act.privateKey,
    })
    h.relay.sendToBridge({ ...frame, relay: { seq: 1, received_at: new Date(now).toISOString() } }, { durable: true })
    const err = await h.relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })
    expect(err.code).toBe('open_in_app')
    expect(state(card)).toBe('pending')
    expect(posted().filter((m) => m.includes('Re-link the two apps'))).toHaveLength(0)
  })

  test('3: with the lock on nothing runs, and the card says so', async () => {
    h = await startHarness({ config: ((c: Record<string, unknown>) => ({ ...c, settings_lock: true })) as never })
    const card = await makeCard()
    await approve(card)
    expect(state(card)).toBe('failed')
    const text = posted().find((m) => m.includes('Re-link the two apps')) ?? ''
    expect(text).toContain(SETTINGS_LOCKED)
    expect(text).not.toContain(ONLY())
  })

  test('4: revoking the only approved device is refused with the last-device words', async () => {
    h = await startHarness()
    expect(h.bridge.ctx.devices.list().filter((d) => !d.revoked_at)).toHaveLength(1)
    const card = await makeCard([['devices', 'revoke', ONLY()]])
    await approve(card)
    expect(state(card)).toBe('failed')
    expect(posted().join('\n')).toContain('last approved device')
    expect(h.bridge.ctx.devices.isRevoked(ONLY())).toBe(false)
  })

  test('4: revoking the device his latest message came from is refused', async () => {
    h = await startHarness()
    pinSecond()
    h.bridge.ctx.store.kvSet('last_owner_device', JSON.stringify({ device_id: D2, at: Date.now() }))
    const card = await makeCard([['devices', 'revoke', D2]])
    await approve(card)
    expect(state(card)).toBe('failed')
    expect(posted().join('\n')).toContain('latest message came from')
    expect(h.bridge.ctx.devices.isRevoked(D2)).toBe(false)
  })

  test('4: another device that is neither the last nor his latest is revoked', async () => {
    h = await startHarness()
    pinSecond()
    h.bridge.ctx.store.kvSet('last_owner_device', JSON.stringify({ device_id: ONLY(), at: Date.now() }))
    const card = await makeCard([['devices', 'revoke', D2]])
    await approve(card)
    expect(h.bridge.ctx.devices.isRevoked(D2)).toBe(true)
  })

  test(
    '5: a tap older than ten minutes runs nothing and the card expires',
    async () => {
      const clock = fakeClock(new Date().toISOString())
      h = await startHarness({ clock })
      const card = await makeCard()
      const tap = clock.now() + 1_000
      await advanceSteps(clock, 11 * 60_000, 20_000, h.bridge.client)
      const f = await pushCardResolvePastRelay(h, card, card.payload_hash, 'primary', {
        ts: new Date(tap).toISOString(),
      })
      const err = await h.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })
      expect(err.code).toBe('card_expired')
      expect(posted().filter((m) => m.includes('Re-link the two apps'))).toHaveLength(0)
      expect(state(card)).toBe('expired')
    },
    t(30_000),
  )

  test('5: the bridge also checks the tap age itself, right before running', async () => {
    h = await startHarness()
    const card = await makeCard()
    await approve(card)
    const row = h.bridge.ctx.ledger.get(card.id) as NonNullable<ReturnType<typeof h.bridge.ctx.ledger.get>>
    const old = {
      ...row,
      resolution: { ...(row.resolution as object), at: new Date(Date.now() - 11 * 60_000).toISOString() },
    }
    const r = await runCardCli(h.bridge.ctx, old as never, async () => {
      throw new Error('must not run')
    })
    expect(r.ok).toBe(false)
    expect(r.ran).toBe(0)
    expect(r.text).toContain('more than 10 minutes old')
  })

  test('(c) an edit to the commands in the signed resolve is refused and nothing runs', async () => {
    h = await startHarness()
    const card = await makeCard()
    const f = await pushCardResolvePastRelay(h, card, card.payload_hash, 'primary', {
      edited: { fields: [{ key: 'talos_cli', value: 'talos-app peer remove work' }] },
      edited_hash: 'sha256:' + '0'.repeat(64),
    })
    const err = await h.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })
    expect(err.code).toBe('card_edit_forbidden')
    expect(state(card)).toBe('pending')
    expect(posted().filter((m) => m.includes('Re-link the two apps'))).toHaveLength(0)
  })

  test('(c) a card changed in the ledger after it was shown runs nothing: the stored card no longer hashes to what was approved', async () => {
    h = await startHarness()
    const card = await makeCard([['peer', 'list']])
    const row = h.bridge.ctx.ledger.get(card.id) as NonNullable<ReturnType<typeof h.bridge.ctx.ledger.get>>
    const forged = {
      ...row.binding,
      fields: row.binding.fields.map((f) =>
        f.key === 'talos_cli' ? { ...f, value: 'talos-app peer remove work' } : f,
      ),
    }
    h.bridge.ctx.store.db.query('UPDATE cards SET binding_json = ? WHERE id = ?').run(JSON.stringify(forged), card.id)
    await approve(card)
    expect(state(card)).toBe('failed')
    expect(posted().join('\n')).toContain('no longer matches what you approved')
  })

  test("(c) a card changed in the ledger AND re-hashed does not match the owner's signed hash: refused before anything runs", async () => {
    h = await startHarness()
    const card = await makeCard([['peer', 'list']])
    const row = h.bridge.ctx.ledger.get(card.id) as NonNullable<ReturnType<typeof h.bridge.ctx.ledger.get>>
    const forged = {
      ...row.binding,
      fields: row.binding.fields.map((f) =>
        f.key === 'talos_cli' ? { ...f, value: 'talos-app peer remove work' } : f,
      ),
    }
    h.bridge.ctx.store.db
      .query('UPDATE cards SET binding_json = ?, payload_hash = ? WHERE id = ?')
      .run(JSON.stringify(forged), payloadHash(forged), card.id)
    const f = await pushCardResolvePastRelay(h, card, card.payload_hash)
    const err = await h.relay.expectFrame('error', (e) => e.ref === f.id, { direction: 'from_bridge' })
    expect(err.code).toBe('card_hash_mismatch')
    expect(posted().filter((m) => m.includes('Re-link the two apps'))).toHaveLength(0)
  })

  test(
    '(c) a forged card whose commands, plain words and check code disagree runs nothing even if its hash is right',
    async () => {
      h = await startHarness()
      const card = await makeCard([['peer', 'list']])
      const row = h.bridge.ctx.ledger.get(card.id) as NonNullable<ReturnType<typeof h.bridge.ctx.ledger.get>>
      const forged = {
        ...row.binding,
        fields: row.binding.fields.map((f) =>
          f.key === 'talos_cli' ? { ...f, value: 'talos-app peer remove work' } : f,
        ),
      }
      h.bridge.ctx.store.db
        .query('UPDATE cards SET binding_json = ?, payload_hash = ? WHERE id = ?')
        .run(JSON.stringify(forged), payloadHash(forged), card.id)
      await pushCardResolvePastRelay(h, card, payloadHash(forged))
      await eventually(() => expect(state(card)).toBe('failed'))
      // the card is marked failed just before its thread line goes out: wait for the line itself
      await eventually(() => expect(posted().join('\n')).toContain('could not be checked'))
      expect(posted().join('\n')).not.toContain('talos-app peer remove work\n')
    },
    t(20_000),
  )
})

const CODE = 'talos-link:relay.example.com/cn_abcdefghijklmnopqrstuv/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

describe('nothing that makes a code or a secret runs from a card', () => {
  test('peer link, create, rotate and add are refused when the card is made, with a plain reason', async () => {
    h = await startHarness()
    const why: [string[], string][] = [
      [
        ['peer', 'link', 'work'],
        "talos-app peer link makes a one-time code, so it can't run from a card yet. Run it in Terminal.",
      ],
      [
        ['peer', 'link', 'work', '--cap', '20'],
        "talos-app peer link makes a one-time code, so it can't run from a card yet. Run it in Terminal.",
      ],
      [
        ['peer', 'create', 'work'],
        "talos-app peer create makes a secret, so it can't run from a card yet. Run it in Terminal.",
      ],
      [
        ['peer', 'rotate', 'work'],
        "talos-app peer rotate makes a secret, so it can't run from a card yet. Run it in Terminal.",
      ],
      [
        ['peer', 'add', 'work', '--url', 'https://other.example.com/hook/peer/cn_x'],
        "talos-app peer add needs a secret file, so it can't run from a card yet. Run it in Terminal.",
      ],
    ]
    for (const [argv, text] of why) {
      const r = await h.bridge.callTool('card', args([argv]))
      expect(r.isError, argv.join(' ')).toBe(true)
      expect(r.content[0]?.text ?? '', argv.join(' ')).toContain(text)
    }
    // one of them among allowed ones spoils the whole card
    expect(
      (
        await h.bridge.callTool(
          'card',
          args([
            ['peer', 'list'],
            ['peer', 'link', 'work'],
          ]),
        )
      ).isError,
    ).toBe(true)
    expect(CARD_CLI_ALLOWED).toEqual([
      'peer accept',
      'peer list',
      'peer remove',
      'peer secret-forget',
      'devices list',
      'devices revoke',
    ])
  })

  test('the commands that remain work from a card: accept (fails here, no network), list, remove, secret-forget, devices list', async () => {
    h = await startHarness()
    const card = await makeCard([
      ['peer', 'list'],
      ['peer', 'remove', 'work'],
      ['peer', 'secret-forget', 'work'],
      ['devices', 'list'],
    ])
    await approve(card)
    expect(state(card)).toBe('done')
    const shown = updates(card).find((u) => u.state === 'done')?.result?.text ?? ''
    for (const w of [
      'talos-app peer list',
      'talos-app peer remove work',
      'talos-app peer secret-forget work',
      'talos-app devices list',
    ])
      expect(shown).toContain(w)
    expect(posted().find((m) => m.includes('Re-link the two apps'))).toContain('Ran 4 commands.')
  })

  test(
    'a failure summary never carries a code or secret, even when the command line does',
    async () => {
      h = await startHarness()
      const card = await makeCard([['peer', 'accept', CODE, '--name', 'home']])
      // the card is approved but not run here (no network): the run is done by hand with a command that fails
      await h.app.resolveCard(card, 'primary', card.payload_hash)
      await eventually(() => expect(h.bridge.ctx.ledger.get(card.id)?.resolution?.action).toBe('primary'))
      const row = h.bridge.ctx.ledger.get(card.id) as NonNullable<ReturnType<typeof h.bridge.ctx.ledger.get>>
      const r = await runCardCli(h.bridge.ctx, row, async (_a, io) => {
        io.err(`talos-app: could not redeem ${CODE}`)
        return 1
      })
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).not.toContain('talos-link:')
      expect(JSON.stringify(r)).not.toContain('AAAAAAAAAAAA')
      expect(r.text).toContain('Stopped at talos-app peer accept')
    },
    t(20_000),
  )

  test('a line with a code or secret in what a command printed is redacted in the thread and on the card', async () => {
    h = await startHarness()
    const card = await makeCard([
      ['peer', 'list'],
      ['devices', 'list'],
    ])
    await approve(card)
    const row = h.bridge.ctx.ledger.get(card.id) as NonNullable<ReturnType<typeof h.bridge.ctx.ledger.get>>
    const r = await runCardCli(h.bridge.ctx, row, async (_a, io) => {
      io.out('talos-link:relay.example.com/cn_abcdefghijklmnopqrstuv/SECRETTOKEN')
      io.out('secret: whsec_ABCDEF')
      return 0
    })
    expect(JSON.stringify(r)).not.toContain('SECRETTOKEN')
    expect(JSON.stringify(r)).not.toContain('whsec_')
    expect(r.owner).toContain('(hidden)')
  })
})

describe('the plain words come from what the command really does', () => {
  const cap = (n: number) => `, up to ${n} messages a day`
  test('each sentence against its argv', () => {
    const rows: [string[], string][] = [
      [['peer', 'accept', CODE, '--name', 'home'], 'Connects to the agent at relay.example.com and calls it home.'],
      [
        ['peer', 'accept', CODE, '--name', 'home', '--cap', '5'],
        `Connects to the agent at relay.example.com and calls it home${cap(5)}.`,
      ],
      [['peer', 'list'], 'Lists the agents you have linked.'],
      [['peer', 'remove', 'work'], 'Removes the link to work.'],
      [['peer', 'secret-forget', 'work'], 'Forgets the stored secret for work.'],
      [['devices', 'list'], 'Lists your approved devices.'],
    ]
    for (const [argv, want] of rows) expect(plainSentence(argv), argv.join(' ')).toBe(want)
  })

  test('a flag the sentence writer does not know, a bad cap, a missing part or a stray word is refused when the card is made', async () => {
    h = await startHarness()
    for (const bad of [
      ['peer', 'accept', CODE, '--name', 'home', '--force'],
      ['peer', 'accept', CODE, '--name', 'home', '--url', 'https://x.example.com/hook'],
      ['peer', 'accept', CODE, '--name', 'home', '--cap', '0'],
      ['peer', 'accept', CODE, '--name', 'home', '--cap', 'lots'],
      ['peer', 'accept', CODE, '--name', 'home', '--cap', '99999999'],
      ['peer', 'accept', CODE, '--name', 'home', 'extra'],
      ['peer', 'accept', CODE],
      ['peer', 'accept', 'not-a-code', '--name', 'home'],
      ['peer', 'accept', CODE, '--name', 'Bad Name'],
      ['peer', 'list', '--cap', '3'],
      ['peer', 'remove', 'work', '--cap', '3'],
      ['peer', 'remove', 'work', 'extra'],
      ['peer', 'remove'],
      ['devices', 'list', 'extra'],
    ]) {
      const r = await h.bridge.callTool('card', args([bad]))
      expect(r.isError, bad.join(' ')).toBe(true)
    }
  })

  test('peer accept and devices revoke cards are high risk; list and remove keep what was asked', async () => {
    h = await startHarness()
    expect((await makeCard([['peer', 'accept', CODE, '--name', 'home']], { risk: 'low' })).risk).toBe('high')
    expect((await makeCard([['peer', 'list']], { risk: 'low' })).risk).toBe('low')
    expect((await makeCard([['peer', 'remove', 'work']], { risk: 'low' })).risk).toBe('low')
  })

  test('the card carries the sentence written from the parsed options, and a changed option changes the words and the hash', async () => {
    h = await startHarness()
    const a = await makeCard([['peer', 'accept', CODE, '--name', 'home', '--cap', '20']])
    const b = await makeCard([['peer', 'accept', CODE, '--name', 'home', '--cap', '30']])
    expect(a.fields[0]?.value).toContain('up to 20 messages a day')
    expect(b.fields[0]?.value).toContain('up to 30 messages a day')
    expect(a.payload_hash).not.toBe(b.payload_hash)
    // words that no longer describe the command: nothing runs
    const bind = bindingFrom(a)
    bind.fields = bind.fields.map((f) =>
      f.key === 'talos_cli_plain' ? { ...f, value: '1. Lists the agents you have linked.' } : f,
    )
    expect(cliOfBinding(bind)).toBeUndefined()
  })
})

describe('R3-4 and R3-5', () => {
  test('R3-4: a card with commands cannot allow edits or carry an editable field, and is made with editing off', async () => {
    h = await startHarness()
    expect((await h.bridge.callTool('card', args(LIST, { allow_edit: true }))).isError).toBe(true)
    expect(
      (await h.bridge.callTool('card', args(LIST, { fields: [{ key: 'x', label: 'X', value: 'y', editable: true }] })))
        .isError,
    ).toBe(true)
    const card = await makeCard()
    expect(card.allow_edit).toBe(false)
    expect(card.fields.every((f) => f.editable === false)).toBe(true)
    // a card without commands is as before
    expect((await h.bridge.callTool('card', args(undefined, { allow_edit: true }))).isError).toBeFalsy()
  })

  test('R3-5: commands run in a fresh 0700 folder that is gone afterwards, even when a command throws', async () => {
    h = await startHarness()
    const card = await makeCard([
      ['peer', 'list'],
      ['devices', 'list'],
    ])
    await approve(card)
    const row = h.bridge.ctx.ledger.get(card.id) as NonNullable<ReturnType<typeof h.bridge.ctx.ledger.get>>
    const seen: string[] = []
    let n = 0
    const r = await runCardCli(h.bridge.ctx, row, async (_a, io, _e, deps) => {
      const cwd = deps.cwd as string
      seen.push(cwd)
      expect(statSync(cwd).mode & 0o777).toBe(0o700)
      expect(cwd.split('/').pop()).toStartWith('talos-')
      io.out('ok')
      if (++n === 2) throw new Error('boom')
      return 0
    })
    expect(r.ok).toBe(false)
    expect(seen).toHaveLength(2)
    expect(new Set(seen).size).toBe(1) // one folder for the run
    for (const d of seen) expect(existsSync(d)).toBe(false)
  })
})

describe('R3-5: the bridge is not a thread session, whatever folder it is in', () => {
  test('a .talos-lead marker in the PARENT of the run folder does not stop an approved card', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'talos-sbx-'))
    const was = process.env.TMPDIR
    try {
      writeFileSync(join(sandbox, '.talos-lead'), JSON.stringify({ thread: 'other' }))
      process.env.TMPDIR = sandbox // the run folder is made inside it, so the marker is its parent's
      h = await startHarness()
      const card = await makeCard([['peer', 'list']])
      await approve(card)
      expect(state(card)).toBe('done')
      expect(posted().join('\n')).not.toContain('not available in')
    } finally {
      if (was === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = was
      rmSync(sandbox, { recursive: true, force: true }) // the folder this test made itself, and only that
    }
  })
})

describe('R3-5: the thread-session fence', () => {
  test('a folder under a .talos-lead marker fences a command (the control), and the bridge as the caller is not fenced', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'talos-sbx-'))
    try {
      writeFileSync(join(sandbox, '.talos-lead'), JSON.stringify({ thread: 'other' }))
      const cwd = join(sandbox, 'run')
      mkdirSync(cwd)
      const errs: string[] = []
      const io: CliIO = {
        isTerminal: true,
        out: () => {},
        err: (l) => errs.push(l),
        prompt: async () => '',
        sleep: async () => {},
        now: () => Date.now(),
      }
      const env = { TALOS_APP_HOME: sandbox } as Record<string, string>
      expect(await runCli(['trust', 'show'], io, env, { cwd })).toBe(1)
      expect(errs.join('\n')).toContain('is not available in')
      errs.length = 0
      await runCli(['trust', 'show'], io, env, { cwd, bridgeCaller: true })
      expect(errs.join('\n')).not.toContain('is not available in')
    } finally {
      rmSync(sandbox, { recursive: true, force: true }) // the folder this test made itself, and only that
    }
  })
})

describe('7: a session has no way to start a run', () => {
  const env = () => loadEnv({ TALOS_APP_HOME: h.home } as Record<string, string>)
  test(
    'an approved card gives a session nothing: its own run of the same command is judged exactly as before',
    async () => {
      h = await startHarness()
      h.bridge.ctx.store.kvSet(
        'peer_taint',
        JSON.stringify({ peers: ['work'], last_msg_id: 'pm_1', chain: 0, at: Date.now() }),
      )
      const card = await makeCard([['peer', 'accept', CODE, '--name', 'home']])
      expect(
        agentCliRefusal(env(), ['peer', 'accept', CODE, '--name', 'home'], { terminal: false, raw: {}, cwd: h.home }),
      ).toMatch(/not run for the agent/)
      await h.app.resolveCard(card, 'primary', card.payload_hash)
      await eventually(() => expect(['done', 'failed']).toContain(state(card) as string))
      expect(
        agentCliRefusal(env(), ['peer', 'accept', CODE, '--name', 'home'], { terminal: false, raw: {}, cwd: h.home }),
      ).toMatch(/not run for the agent/)
      expect(h.bridge.ctx.store.kvKeys('cli_grant:')).toEqual([])
    },
    t(20_000),
  )
  test('there is no command, tool or card_result that runs a card: they are refused or unknown', async () => {
    h = await startHarness()
    const card = await makeCard()
    const errs: string[] = []
    const io: CliIO = {
      isTerminal: false,
      out: () => {},
      err: (l) => errs.push(l),
      prompt: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    }
    for (const argv of [
      ['card', 'run', card.id],
      ['cards', 'run', card.id],
      ['run-card', card.id],
    ])
      expect(await runCli(argv, io, { TALOS_APP_HOME: h.home } as Record<string, string>), argv.join(' ')).not.toBe(0)
    const r = await h.bridge.callTool('card_result', { card_id: card.id, ok: true, text: 'did it' })
    expect(r.isError).toBe(true)
    expect(state(card)).toBe('pending')
    expect(posted().filter((m) => m.includes('Re-link the two apps'))).toHaveLength(0)
  })
})

describe('a clear refusal for a word that is not a command', () => {
  const io = (errs: string[]): CliIO => ({
    isTerminal: false,
    out: () => {},
    err: (l) => errs.push(l),
    prompt: async () => '',
    sleep: async () => {},
    now: () => Date.now(),
  })
  const run = async (argv: string[]) => {
    const errs: string[] = []
    const code = await runCli(argv, io(errs), { TALOS_APP_HOME: h.home } as Record<string, string>)
    return { code, text: errs.join('\n') }
  }
  test('peer unlink names the real cause and suggests peer remove, not "only runs in Terminal"', async () => {
    h = await startHarness()
    const r = await run(['peer', 'unlink', 'work'])
    expect(r.code).toBe(1)
    expect(r.text).toContain("`peer unlink` isn't a talos-app command")
    expect(r.text).toContain('Did you mean `peer remove`?')
    expect(r.text).not.toMatch(/only runs in/)
  })
  test('a near typo gets the nearest one; nothing near lists the real ones; devices too', async () => {
    h = await startHarness()
    expect((await run(['peer', 'lnk', 'work'])).text).toContain('Did you mean `peer link`?')
    expect((await run(['devices', 'remove', 'x'])).text).toContain('Did you mean `devices revoke`?')
    const far = (await run(['peer', 'zzzzzzzz'])).text
    expect(far).toContain("`peer zzzzzzzz` isn't a talos-app command")
    expect(far).toContain('peer link')
    expect(far).not.toContain('Did you mean')
  })
  test('a terminal-only command that IS real keeps its Terminal message', async () => {
    h = await startHarness()
    expect((await run(['enroll'])).text).toMatch(/only runs in/)
  })
})
