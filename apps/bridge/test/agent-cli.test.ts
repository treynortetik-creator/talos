// `talos-app peer ...` and `talos-app devices list|revoke` for the agent (owner ruling 2026-11-19): the agent runs them itself unless
// "Lock Talos settings" is on. The real config.json, history.sqlite and devices.json in a temp home. Fixed fake ids only.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { agentCliRefusal } from '../src/agent-cli.ts'
import { loadEnv } from '../src/config.ts'
import { denyRules } from '../src/guards/rules.ts'
import { HistoryStore } from '../src/history-store.ts'
import { agentUnlessLocked, terminalOnly } from '../src/talos.ts'
import { SETTINGS_LOCKED } from '../src/trust.ts'
import { HandoffLedger } from '../src/worker/handoff.ts'
import { tempHome } from './helpers.ts'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

const D1 = 'd_aaaaaaaaaaaaaaaaaaaa'
const D2 = 'd_bbbbbbbbbbbbbbbbbbbb'
const D3 = 'd_cccccccccccccccccccc'
const JWK = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }
const MIN = 60_000

type World = ReturnType<typeof world>
function world(
  o: {
    lock?: boolean
    noConfig?: boolean
    devices?: Array<{ id: string; name: string; revoked?: boolean }>
    owner?: Array<{ thread: string; minutes: number; via?: string }>
    outside?: Record<string, number> // thread -> minutes from now
    taint?: boolean
    lastDevice?: { id: string; minutes: number }
    handoff?: { lead: string; minutes: number }
    sub?: string // a sub-thread of general with this id
    badHandoffs?: boolean // a handoffs table the query cannot read
    history?: boolean
  } = {},
) {
  const home = tempHome('talos-agentcli-')
  homes.push(home)
  const cfg = loadExampleConfig('default')
  if (!o.noConfig)
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        ...cfg,
        ...(o.sub
          ? { threads: [...cfg.threads, { ...cfg.threads[0], id: o.sub, name: 'Sub', parent_id: 'general' }] }
          : {}),
        ...(o.lock ? { settings_lock: true } : {}),
      }),
      {
        mode: 0o600,
      },
    )
  if (o.devices)
    writeFileSync(
      join(home, 'devices.json'),
      JSON.stringify({
        version: 1,
        devices: o.devices.map((d) => ({
          id: d.id,
          name: d.name,
          pubkey_jwk: JWK,
          ...(d.revoked ? { revoked_at: '2026-01-01T00:00:00.000Z' } : {}),
        })),
      }),
      { mode: 0o600 },
    )
  if (o.history !== false) {
    const store = new HistoryStore(join(home, 'history.sqlite'))
    for (const m of o.owner ?? [])
      store.addMessage({
        id: newId('m'),
        thread_id: m.thread,
        author: 'owner',
        kind: 'text',
        text: 'link my other Talos',
        format: 'plain',
        attachments: [],
        via: m.via ?? 'app',
        created_at: new Date(Date.now() + m.minutes * MIN).toISOString(),
      } as never)
    for (const [t, min] of Object.entries(o.outside ?? {}))
      store.kvSet(`outside_text_at:${t}`, String(Date.now() + min * MIN))
    if (o.taint)
      store.kvSet('peer_taint', JSON.stringify({ peers: ['work'], last_msg_id: 'pm_1', chain: 0, at: Date.now() }))
    if (o.lastDevice)
      store.kvSet(
        'last_owner_device',
        JSON.stringify({ device_id: o.lastDevice.id, at: Date.now() + o.lastDevice.minutes * MIN }),
      )
    if (o.badHandoffs) store.db.exec('CREATE TABLE handoffs (x)')
    if (o.handoff)
      new HandoffLedger(store.db).record({
        id: newId('m'),
        lead: o.handoff.lead,
        dir: 'to_main',
        type: 'TASK',
        text: 'a result',
        at: Date.now() + o.handoff.minutes * MIN,
      })
    store.close()
  }
  return { home, env: loadEnv({ TALOS_APP_HOME: home } as Record<string, string>) }
}
const plain = () => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'ac-cwd-'))
  homes.push(d)
  return d
}
const MAIN = {}
const thread = (t: string) => ({ TALOS_APP_WORKER_THREAD: t, TALOS_SESSION_ROLE: 'worker' })
function gate(w: World, argv: string[], o: { terminal?: boolean; raw?: Record<string, string> } = {}) {
  return agentCliRefusal(w.env, argv, { terminal: o.terminal ?? false, raw: o.raw ?? MAIN, cwd: plain() })
}
const ALL = [
  ['peer', 'create', 'work'],
  ['peer', 'add', 'work', '--url', 'https://example.com/hook/peer/cn_x'],
  ['peer', 'list'],
  ['peer', 'remove', 'work'],
  ['peer', 'rotate', 'work'],
  ['peer', 'secret-forget', 'work'],
  ['devices'],
  ['devices', 'list'],
  ['devices', 'revoke', D3],
]
const GATED = ['create', 'add', 'rotate'] // plus devices revoke

describe('the command class', () => {
  test('peer create|add|list|remove|rotate|secret-forget and devices list|revoke are agent-unless-locked', () => {
    for (const a of ALL) expect(agentUnlessLocked(a), a.join(' ')).toBeDefined()
  })
  test('enroll, rotate, trust on, install-guards --remove and unknown subcommands are not', () => {
    for (const a of [
      ['enroll'],
      ['rotate'],
      ['trust', 'on'],
      ['install-guards', '--remove'],
      ['peer'],
      ['peer', 'bogus'],
      ['devices', 'bogus'],
    ])
      expect(agentUnlessLocked(a), a.join(' ')).toBeUndefined()
  })
  test('the guards keep denying peer and devices: both stay terminal-only for them', () => {
    expect(terminalOnly(['peer', 'create', 'work'])).toBe('peer')
    expect(terminalOnly(['devices', 'revoke', D1])).toBe('devices')
    const rules = denyRules({ home: '/h', writeDenied: [] } as never)
    expect(rules).toContain('Bash(talos-app peer:*)')
    expect(rules).toContain('Bash(talos-app devices:*)')
  })
})

describe('the lock and the terminal', () => {
  test('lock on: the one sentence for every agent run; a terminal runs exactly as today, lock on or off', () => {
    const w = world({ lock: true })
    for (const a of ALL) {
      expect(gate(w, a), a.join(' ')).toBe(SETTINGS_LOCKED)
      expect(gate(w, a, { terminal: true }), a.join(' ')).toBeUndefined()
    }
  })
  test('lock off, from an agent session with nothing against it: every command runs (main and a thread session)', () => {
    const w = world({
      devices: [
        { id: D1, name: 'Phone' },
        { id: D2, name: 'Laptop browser' },
        { id: D3, name: 'Old', revoked: true },
      ],
      lastDevice: { id: D1, minutes: -1 },
    })
    for (const a of ALL) {
      expect(gate(w, a), a.join(' ')).toBeUndefined()
      expect(gate(w, a, { raw: thread('trip') }), a.join(' ')).toBeUndefined()
    }
  })
  test('a terminal runs them as today', () => {
    const w = world({ outside: { general: 1 }, owner: [{ thread: 'general', minutes: -5 }], taint: true })
    for (const a of ALL) expect(gate(w, a, { terminal: true }), a.join(' ')).toBeUndefined()
  })
  test('a config that cannot be read: refused from an agent, the terminal goes on', () => {
    const w = world({ noConfig: true })
    for (const a of ALL) {
      expect(gate(w, a), a.join(' ')).toMatch(/config\.json/)
      expect(gate(w, a, { terminal: true }), a.join(' ')).toBeUndefined()
    }
  })
  test('anything else is none of this gate', () => {
    expect(gate(world(), ['enroll'])).toBeUndefined()
  })
})

describe('(A) one rule for every agent session: nothing outside reached any thread since the owner last spoke', () => {
  const FOUR: string[][] = [
    ['peer', 'create', 'work'],
    ['peer', 'add', 'work', '--url', 'https://example.com/x'],
    ['peer', 'rotate', 'work'],
    ['devices', 'revoke', D3],
  ]
  const OTHERS: string[][] = [
    ['peer', 'list'],
    ['peer', 'remove', 'work'],
    ['peer', 'secret-forget', 'work'],
    ['devices'],
  ]
  const devs = [
    { id: D1, name: 'A' },
    { id: D2, name: 'B' },
    { id: D3, name: 'C' },
  ]
  const refused = (w: World, raw: Record<string, string>) => FOUR.map((a) => gate(w, a, { raw }))
  const runs = (w: World, raw: Record<string, string>) => {
    for (const a of FOUR) expect(gate(w, a, { raw }), a.join(' ')).toBeUndefined()
  }
  const REFUSES = /outside text.*ask again in his own words.*terminal/s
  const sessions: Array<[string, Record<string, string>]> = [
    ['main', MAIN],
    ['a thread session', thread('trip')],
  ]

  for (const [who, raw] of sessions) {
    test(`${who}: outside text in the thread he spoke in refuses the four; the others run`, () => {
      const w = world({
        owner: [{ thread: 'general', minutes: -10 }],
        outside: { general: -5 },
        devices: devs,
        lastDevice: { id: D1, minutes: -10 },
      })
      for (const r of refused(w, raw)) expect(r).toMatch(REFUSES)
      for (const a of OTHERS) expect(gate(w, a, { raw }), a.join(' ')).toBeUndefined()
    })
    test(`${who}: outside text in ANOTHER thread refuses too`, () => {
      const w = world({
        owner: [{ thread: 'general', minutes: -10 }],
        outside: { inbox: -5 },
        devices: devs,
        lastDevice: { id: D1, minutes: -10 },
      })
      for (const r of refused(w, raw)) expect(r).toMatch(REFUSES)
    })
    test(`${who}: outside text in a sub-thread refuses, whichever session asks`, () => {
      const w = world({
        sub: 'planning',
        owner: [{ thread: 'general', minutes: -10 }],
        outside: { planning: -5 },
        devices: devs,
        lastDevice: { id: D1, minutes: -10 },
      })
      for (const r of refused(w, raw)) expect(r).toMatch(REFUSES)
    })
    test(`${who}: a lead's hand-off to main since his words refuses (it is trust agent, so it never sets outside text)`, () => {
      const w = world({
        owner: [{ thread: 'general', minutes: -10 }],
        handoff: { lead: 'trip', minutes: -5 },
        devices: devs,
        lastDevice: { id: D1, minutes: -10 },
      })
      for (const r of refused(w, raw)) expect(r).toMatch(REFUSES)
    })
    test(`${who}: his words after the outside text, or after the hand-off, free them`, () => {
      const w = world({
        owner: [
          { thread: 'general', minutes: -20 },
          { thread: 'general', minutes: -1 },
        ],
        outside: { inbox: -10, general: -8 },
        handoff: { lead: 'trip', minutes: -6 },
        devices: devs,
        lastDevice: { id: D1, minutes: -1 },
      })
      runs(w, raw)
    })
    test(`${who}: the peer taint refuses the four`, () => {
      const w = world({
        owner: [{ thread: 'general', minutes: -2 }],
        taint: true,
        devices: devs,
        lastDevice: { id: D1, minutes: -1 },
      })
      for (const r of refused(w, raw)) expect(r).toMatch(/linked agent|peer/i)
      for (const a of OTHERS) expect(gate(w, a, { raw }), a.join(' ')).toBeUndefined()
    })
  }
  test('the owner spoke more than two hours ago and nothing outside came since: runs (no two-hour ask)', () => {
    runs(
      world({ owner: [{ thread: 'general', minutes: -300 }], devices: devs, lastDevice: { id: D1, minutes: -300 } }),
      MAIN,
    )
  })
  test('no record of him speaking: nothing outside ever runs; any outside text or hand-off refuses', () => {
    runs(world({ devices: devs, lastDevice: { id: D1, minutes: -1 } }), MAIN)
    expect(gate(world({ outside: { general: -5 } }), ['peer', 'create', 'work'])).toMatch(REFUSES)
    expect(gate(world({ handoff: { lead: 'trip', minutes: -5 } }), ['peer', 'create', 'work'])).toMatch(REFUSES)
  })
  test('a share is not him speaking', () => {
    const w = world({ owner: [{ thread: 'general', minutes: -1, via: 'share' }], outside: { general: -5 } })
    expect(gate(w, FOUR[1] as string[])).toMatch(REFUSES)
  })
  test('the session label is for the audit only: spoofing TALOS_APP_WORKER_THREAD (a clean thread, or none) gains nothing', () => {
    const w = world({ owner: [{ thread: 'general', minutes: -10 }], outside: { general: -5 } })
    for (const raw of [thread('clean-thread'), { TALOS_APP_WORKER_THREAD: 'clean-thread' }, MAIN, {}])
      expect(gate(w, ['peer', 'create', 'work'], { raw }), JSON.stringify(raw)).toMatch(REFUSES)
  })
  test('a session whose thread cannot be told is judged the same way: refused with outside text, run without', () => {
    const cwd = plain()
    writeFileSync(join(cwd, '.talos-lead'), JSON.stringify({ thread: 'other' }))
    const dirty = world({ outside: { general: -5 } })
    expect(
      agentCliRefusal(dirty.env, ['peer', 'create', 'work'], { terminal: false, raw: thread('trip'), cwd }),
    ).toMatch(REFUSES)
    const clean = world()
    expect(
      agentCliRefusal(clean.env, ['peer', 'create', 'work'], { terminal: false, raw: thread('trip'), cwd }),
    ).toBeUndefined()
  })
  test('outside text on a thread that has since left config still refuses (the keys are read, not the config)', () => {
    const w = world({ owner: [{ thread: 'general', minutes: -10 }], outside: { 'long-gone-thread': -5 } })
    expect(gate(w, ['peer', 'create', 'work'])).toMatch(REFUSES)
    expect(gate(w, ['peer', 'list'])).toBeUndefined()
  })
  test('a hand-off query that errors refuses (fails closed); no handoffs table at all is no hand-off', () => {
    const w = world({ owner: [{ thread: 'general', minutes: -10 }], badHandoffs: true })
    expect(gate(w, ['peer', 'create', 'work'])).toMatch(/hand-off|history/)
    expect(gate(world({ owner: [{ thread: 'general', minutes: -10 }] }), ['peer', 'create', 'work'])).toBeUndefined()
  })
  test('a phone clock 10 minutes fast: his words count from when the bridge received them, so outside text after them refuses', () => {
    // his message was received 5 minutes ago (the bridge's own clock, kv last_owner_device) but carries a phone time 5 minutes ahead;
    // the outside text arrived 2 minutes ago. By the row's time his words would look newer than the text.
    const w = world({
      owner: [{ thread: 'general', minutes: 5 }],
      lastDevice: { id: D1, minutes: -5 },
      outside: { general: -2 },
    })
    expect(gate(w, ['peer', 'create', 'work'])).toMatch(REFUSES)
  })
  test('with no receive time kept (before this build) the newest row time counts, never later than now: a future phone time is clamped', () => {
    const fast = world({ owner: [{ thread: 'general', minutes: 30 }], outside: { general: -2 } })
    expect(gate(fast, ['peer', 'create', 'work'])).toBeUndefined() // clamped to now: after the text (the limit of what a row can tell)
    const plain = world({ owner: [{ thread: 'general', minutes: -10 }], outside: { general: -2 } })
    expect(gate(plain, ['peer', 'create', 'work'])).toMatch(REFUSES)
  })
  test('history.sqlite missing or unreadable: the four are refused (fails closed); the others run', () => {
    const missing = world({ history: false })
    for (const a of FOUR.slice(0, 3)) expect(gate(missing, a), a.join(' ')).toMatch(/history/)
    expect(gate(missing, ['peer', 'list'])).toBeUndefined()
    const junk = world({ history: false })
    writeFileSync(join(junk.home, 'history.sqlite'), 'not a database')
    expect(gate(junk, ['peer', 'create', 'work'])).toMatch(/history/)
  })
})

describe('(B) device lock-out', () => {
  const two = [
    { id: D1, name: 'Phone' },
    { id: D2, name: 'Laptop browser' },
  ]
  test('the last approved device is refused', () => {
    const w = world({
      devices: [
        { id: D1, name: 'Phone' },
        { id: D2, name: 'Old', revoked: true },
      ],
      lastDevice: { id: D2, minutes: -1 },
    })
    expect(gate(w, ['devices', 'revoke', D1])).toMatch(/last approved device/)
  })
  test('the device his latest message came from is refused; another runs', () => {
    const w = world({ devices: [...two, { id: D3, name: 'Tablet' }], lastDevice: { id: D1, minutes: -1 } })
    expect(gate(w, ['devices', 'revoke', D1])).toMatch(/message came from/)
    expect(gate(w, ['devices', 'revoke', D2])).toBeUndefined()
  })
  test('no record of his latest device: only a device that was never approved may be revoked', () => {
    const w = world({ devices: [...two, { id: D3, name: 'Old', revoked: true }] })
    expect(gate(w, ['devices', 'revoke', D2])).toMatch(/can't tell which device/)
    expect(gate(w, ['devices', 'revoke', D3])).toBeUndefined() // already revoked
    expect(gate(w, ['devices', 'revoke', 'd_zzzzzzzzzzzzzzzzzzzz'])).toBeUndefined() // never approved
  })
  test('a devices.json that cannot be read: refused', () => {
    const w = world()
    writeFileSync(join(w.home, 'devices.json'), '{nope')
    expect(gate(w, ['devices', 'revoke', D1])).toMatch(/devices\.json/)
  })
  test('a terminal is unchanged', () => {
    const w = world({ devices: [{ id: D1, name: 'Phone' }], lastDevice: { id: D1, minutes: -1 } })
    expect(gate(w, ['devices', 'revoke', D1], { terminal: true })).toBeUndefined()
  })
})

describe('the audit line', () => {
  const lines = (w: World) =>
    readFileSync(join(w.home, 'bridge.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((l) => l.msg === 'agent cli')
  test('an allowed and a refused agent run each write one line naming the session, command, target and outcome; a terminal run writes none', () => {
    const w = world({ outside: { general: -5 } })
    gate(w, ['peer', 'list'])
    gate(w, ['peer', 'create', 'work'], { raw: thread('trip') })
    gate(w, ['peer', 'create', 'work'])
    gate(w, ['peer', 'create', 'work'], { terminal: true })
    const l = lines(w)
    expect(l.map((x) => [x.session, x.command, x.target, x.outcome])).toEqual([
      ['main', 'peer list', undefined, 'allowed'],
      ['trip', 'peer create', 'work', 'refused'],
      ['main', 'peer create', 'work', 'refused'],
    ])
  })
  test('no secret, url or conn id reaches it', () => {
    const w = world()
    gate(w, [
      'peer',
      'add',
      'work',
      '--url',
      'https://example.com/hook/peer/cn_abc123',
      '--secret-file',
      '/x/work.secret',
    ])
    const raw = readFileSync(join(w.home, 'bridge.log'), 'utf8')
    expect(raw).not.toMatch(/cn_|https?:|whsec_|example\.com|secret-file/)
  })
})
