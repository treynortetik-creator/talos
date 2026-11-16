// Main's restart on request on Linux (main-request.ts RestartActor, main-restart-check.ts): the request taken once, who asked,
// the reasons, the owner's tap, the restart followed to came_back or stalled, and main-restart-check.json as the Mac writes it.
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_REQUEST_FILE,
  b64urlEncode,
  importDevicePrivateKey,
  type JwkP256T,
  jcs,
  MAIN_RESTART_CHECK_FILE,
  MainRestartCheckFile,
  type MainStatus,
  newUlid,
  signOwnerFrame,
} from '@talos-app/protocol'
import { parseRequest, plainText, RestartActor, takeRequest } from '../../src/supervisor/main-request.ts'
import { type CheckInputs, checkFileText, restartReasons } from '../../src/supervisor/main-restart-check.ts'
import type { MainStateExtras } from '../../src/supervisor/main-state.ts'

const PROTO = join(import.meta.dir, '../../../../packages/protocol/fixtures')
const KEY = JSON.parse(readFileSync(join(PROTO, 'test-device-key.json'), 'utf8')) as {
  deviceId: string
  publicJwk: JwkP256T
  privateJwk: JsonWebKey
}
const OWNER = JSON.parse(readFileSync(join(PROTO, 'agent-request', 'agent-request-owner.json'), 'utf8')) as Record<
  string,
  unknown
>
/** The fixture's proof was signed at 17:00:00Z; the request's ts is a second later. */
const WALL0 = Date.parse('2026-11-12T17:00:30.000Z')
const ID = (n: number) => `01KA00000000000000000000${String(n).padStart(2, '0')}`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const okInputs = {
  configOk: true,
  agentDirExists: true,
  devChannels: true,
  approved: true,
  launchChannels: ['server:talos-app'],
  claudeFound: true,
  autoConfirmRestart: true,
  attached: false as boolean | null,
  sessionId: '0b8f4c3e-1d2a-4f5b-9c6d-7e8f9a0b1c2d' as string | null,
}

function setup(over: { launchedAtMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'talos-restart-'))
  dirs.push(home)
  const x = {
    home,
    now: 1000,
    wall: WALL0,
    status: {
      phase: 'running',
      panePid: 1,
      sessionId: okInputs.sessionId,
      restarts: [],
      bridgeLive: true,
    } as MainStatus,
    extras: undefined as MainStateExtras | undefined,
    inputs: { ...okInputs },
    ownerStopped: false,
    calls: [] as string[],
    posts: [] as string[],
    audit: [] as Array<[string, Record<string, string> | undefined]>,
    known: new Set<string>(['trip']),
    actor: null as unknown as RestartActor,
    /** A new supervisor over the same home (a restart): a new actor, its clock going on, launched now unless told. */
    restartSupervisor: (_launchedAtMs?: number) => {},
    write(o: Record<string, unknown>) {
      writeFileSync(join(home, AGENT_REQUEST_FILE), JSON.stringify(o))
    },
    agent(n: number, over: Record<string, unknown> = {}) {
      this.write({ v: 1, control_id: ID(n), action: 'restart', ts: this.wall - 1000, ...over })
    },
    async tick(s = 1) {
      this.now += s
      this.wall += s * 1000
      // the real stop is on Main's queue: Main is down by the next tick
      if (this.status.phase === 'stopping') this.status = { ...this.status, phase: 'stopped', panePid: null }
      await this.actor.tick()
      await new Promise((r) => setTimeout(r, 0))
    },
    file() {
      return JSON.parse(readFileSync(join(home, MAIN_RESTART_CHECK_FILE), 'utf8')) as Record<string, unknown>
    },
    events(e: string) {
      return this.audit.filter(([k]) => k === e)
    },
  }
  x.restartSupervisor = (launchedAtMs = x.wall) => {
    x.actor = new RestartActor({ ...deps, launchedAtMs })
  }
  const deps: ConstructorParameters<typeof RestartActor>[0] = {
    home,
    audit: (e, f) => x.audit.push([e, f]),
    now: () => x.now,
    wallMs: () => x.wall,
    launchedAtMs: over.launchedAtMs ?? WALL0 - 60_000,
    status: () => x.status,
    extras: () => x.extras,
    inputs: async () => x.inputs,
    ownerStopped: () => x.ownerStopped,
    stop: async () => {
      x.calls.push('stop')
      x.status = { ...x.status, phase: 'stopping' }
    },
    start: async () => {
      x.calls.push('start')
      x.status = { ...x.status, phase: 'starting', panePid: 2 }
    },
    pinnedKey: (id) => (id === KEY.deviceId ? KEY.publicJwk : undefined),
    knownThread: (id) => x.known.has(id),
    post: async (t) => {
      x.posts.push(t)
    },
  }
  x.actor = new RestartActor(deps)
  return Object.assign(x, { deps })
}

/** A fresh owner's request, signed with the test key at the wall clock (+ `aheadMs`), as the bridge writes one from the phone. */
async function signedOwnerAt(x: ReturnType<typeof setup>, controlId: string, aheadMs = 0) {
  const priv = await importDevicePrivateKey(KEY.privateJwk)
  const signed = await signOwnerFrame(
    {
      v: 1,
      type: 'agent.recover',
      id: newUlid(),
      ts: new Date(x.wall + aheadMs).toISOString(),
      control_id: controlId,
      action: 'restart',
      device_id: KEY.deviceId,
    },
    priv,
  )
  const { osig, ...rest } = signed
  const file = {
    v: 1,
    control_id: controlId,
    action: 'restart',
    ts: x.wall,
    proof: { device_id: KEY.deviceId, osig, signed_b64url: b64urlEncode(new TextEncoder().encode(jcs(rest))) },
  }
  writeFileSync(join(x.home, AGENT_REQUEST_FILE), JSON.stringify(file))
  return file
}
/** Ticks until a restart the actor began has Main running again. */
async function cameBack(x: ReturnType<typeof setup>) {
  await x.tick()
  x.status = { ...x.status, phase: 'running' }
  await x.tick()
}

describe('the request file (main-request.ts)', () => {
  it('taken once: renamed aside, read, and deleted before anything is decided; nothing left behind', () => {
    const x = setup()
    x.agent(1)
    const t = takeRequest(x.home)
    expect(t.kind).toBe('request')
    expect(existsSync(join(x.home, AGENT_REQUEST_FILE))).toBe(false)
    expect(existsSync(join(x.home, `${AGENT_REQUEST_FILE}.taken`))).toBe(false)
    expect(takeRequest(x.home).kind).toBe('absent')
  })
  it('a link, a folder or a big file is never read (and is still taken away)', () => {
    const x = setup()
    const target = join(x.home, 'elsewhere.json')
    writeFileSync(target, JSON.stringify({ v: 1, control_id: ID(1), action: 'restart', ts: WALL0 }))
    symlinkSync(target, join(x.home, AGENT_REQUEST_FILE))
    expect(takeRequest(x.home)).toMatchObject({ kind: 'invalid' })
    expect(existsSync(target)).toBe(true) // the link's target is untouched
    mkdirSync(join(x.home, AGENT_REQUEST_FILE))
    expect(takeRequest(x.home)).toMatchObject({ kind: 'invalid' })
    writeFileSync(join(x.home, AGENT_REQUEST_FILE), `{"v":1,"pad":"${'x'.repeat(5000)}"}`)
    expect(takeRequest(x.home)).toMatchObject({ kind: 'invalid' })
  })
  it('read as the Mac reads it: extra fields kept out, a bad by_thread dropped, why made plain, a bad proof shape malformed', () => {
    const r = parseRequest(
      JSON.stringify({
        v: 1,
        control_id: 'abc_DEF-1',
        action: 'restart',
        ts: 5.5,
        by_thread: '../x',
        why: 'a‮b\n<c>',
        extra: 1,
      }),
    )
    expect(r).toMatchObject({ controlId: 'abc_DEF-1', ts: 5.5, byThread: null, why: 'a b c', proof: { kind: 'none' } })
    for (const bad of [
      { v: 2, control_id: 'a', action: 'restart', ts: 1 },
      { v: 1, control_id: 'a b', action: 'restart', ts: 1 },
      { v: 1, control_id: 'a', action: 'stop', ts: 1 },
      { v: 1, control_id: 'a', action: 'restart', ts: '1' },
      { v: true, control_id: 'a', action: 'restart', ts: 1 },
    ])
      expect(parseRequest(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull()
    const proof = parseRequest(
      JSON.stringify({ v: 1, control_id: 'a', action: 'restart', ts: 1, proof: { device_id: 'x' } }),
    )
    expect(proof?.proof).toEqual({ kind: 'malformed' })
    expect(plainText('x'.repeat(200))).toHaveLength(80)
  })
})

describe('a session’s request (no proof)', () => {
  it('a thread this computer does not know is never named (a forged by_thread is "a session")', async () => {
    const x = setup()
    x.agent(1, { by_thread: 'owner' })
    await x.tick()
    expect(x.posts).toEqual(['Main is restarting, asked by a session (thread not known).'])
  })
  it('started, and nothing Talos knows on screen after the start wait: stalled', async () => {
    const x = setup()
    x.agent(1)
    await x.tick()
    await x.tick()
    x.status = { ...x.status, needsYou: { kind: 'start_stalled' } }
    await x.tick()
    expect(x.file().last).toMatchObject({ outcome: 'stalled', detail: 'no screen Talos knows' })
  })
  it('everything holds: a quiet stop, a cold start, followed to came_back; one line naming a known thread, never its why', async () => {
    const x = setup()
    x.agent(1, { by_thread: 'trip', why: 'stuck on a tool' })
    await x.tick()
    expect(x.calls).toEqual(['stop'])
    await x.tick()
    expect(x.calls).toEqual(['stop', 'start'])
    x.status = { ...x.status, phase: 'running' }
    await x.tick()
    expect(x.file().last).toMatchObject({ control_id: ID(1), outcome: 'came_back' })
    expect(x.posts).toEqual(['Main is restarting, asked by a session in thread “trip”.'])
    expect(x.posts.join(' ')).not.toContain('stuck')
  })
  it('each reason refuses it: nothing stopped, last says refused with the reason, one line', async () => {
    const cases: Array<[string, (x: ReturnType<typeof setup>) => void]> = [
      ['launch_changed', (x) => (x.inputs.approved = false)],
      ['claude_path_changed', (x) => (x.inputs.claudeFound = false)],
      ['auto_confirm_off', (x) => (x.inputs.autoConfirmRestart = false)],
      ['someone_typing', (x) => (x.inputs.attached = true)],
      ['someone_typing', (x) => (x.inputs.attached = null)],
      ['takeover_held', (x) => (x.status = { ...x.status, phase: 'blocked' })],
      ['session_id_invalid', (x) => (x.inputs.sessionId = 'not-a-uuid')],
      ['unknown', (x) => (x.inputs.agentDirExists = false)],
    ]
    for (const [reason, set] of cases) {
      const x = setup()
      set(x)
      x.agent(1)
      await x.tick()
      expect(x.calls, reason).toEqual([])
      expect(x.file().last, reason).toMatchObject({ control_id: ID(1), outcome: 'refused', detail: reason })
      expect(x.file().reasons, reason).toContain(reason)
      expect(x.posts, reason).toHaveLength(1)
      expect(x.posts[0], reason).toStartWith('Main was not restarted: ')
    }
  })
  it('refused while Main waits on the owner at any screen (a dialog, a first-start screen, the usage-limit menu)', async () => {
    const waits: Array<[string, (x: ReturnType<typeof setup>) => void]> = [
      ['folder trust', (x) => (x.status = { ...x.status, needsYou: { kind: 'dialog', dialog: 'trust' } })],
      ['dev-channel warning', (x) => (x.status = { ...x.status, needsYou: { kind: 'confirm_cold_start' } })],
      ['login expired', (x) => (x.extras = { signin: true })],
      ['MCP server consent', (x) => (x.extras = { waiting: 'mcp_consent' })],
      [
        'usage limit',
        (x) =>
          (x.status = {
            ...x.status,
            needsYou: {
              kind: 'usage_limit',
              model: 'Fable',
              limit: 'weekly',
              resets: '4pm',
              resets_at: '2026-11-12T23:00:00.000Z',
            },
          }),
      ],
    ]
    for (const [label, set] of waits) {
      const x = setup()
      set(x)
      x.agent(1)
      await x.tick()
      expect(x.calls, label).toEqual([])
      expect(x.file().last, label).toMatchObject({ outcome: 'refused', detail: label })
      expect(x.file().needs_you, label).toMatchObject({ kind: label })
    }
  })
  it('the gap: a second within 2 minutes is too_soon (neither stamp moves on a refusal); 3 an hour, then restart_limit', async () => {
    const x = setup()
    x.agent(1)
    await x.tick()
    await x.tick()
    x.status = { ...x.status, phase: 'running' }
    await x.tick()
    x.agent(2)
    await x.tick(30)
    expect(x.file().last).toMatchObject({ control_id: ID(2), outcome: 'refused', detail: 'too_soon' })
    for (const n of [3, 4]) {
      x.agent(n)
      await x.tick(130)
      await x.tick()
      x.status = { ...x.status, phase: 'running' }
      await x.tick()
      expect(x.file().last, String(n)).toMatchObject({ control_id: ID(n), outcome: 'came_back' })
    }
    x.agent(5)
    await x.tick(130)
    expect(x.file().last).toMatchObject({ control_id: ID(5), outcome: 'refused', detail: 'restart_limit' })
    expect(x.calls.filter((c) => c === 'stop')).toHaveLength(3)
  })
  it('stale, from the future, from before this start, or the same control_id again: discarded, nothing recorded', async () => {
    const x = setup()
    // (built once: each is read one tick later than the one before)
    for (const ts of [x.wall - 300_001, x.wall + 65_000, WALL0 - 60_001]) {
      x.write({ v: 1, control_id: ID(1), action: 'restart', ts })
      await x.tick()
    }
    expect(x.calls).toEqual([])
    expect(x.file().last).toBeUndefined()
    x.agent(7)
    await x.tick()
    await x.tick()
    x.status = { ...x.status, phase: 'running' }
    await x.tick()
    x.agent(7)
    await x.tick(200)
    expect(x.calls.filter((c) => c === 'stop')).toHaveLength(1)
  })
  it('the owner’s Stop refuses it, and wins over a restart already on its way down', async () => {
    const x = setup()
    x.ownerStopped = true
    x.agent(1)
    await x.tick()
    expect(x.file().last).toMatchObject({ outcome: 'refused', detail: 'owner_stopped' })
    const y = setup()
    y.agent(1)
    await y.tick()
    y.ownerStopped = true
    await y.tick()
    expect(y.calls).toEqual(['stop'])
  })
  it('a request left half-taken by a stop mid-request is discarded unread at the next start', async () => {
    const x = setup()
    writeFileSync(
      join(x.home, `${AGENT_REQUEST_FILE}.taken`),
      JSON.stringify({ v: 1, control_id: ID(1), action: 'restart', ts: x.wall }),
    )
    const y = new RestartActor({ ...(x.actor as unknown as { d: ConstructorParameters<typeof RestartActor>[0] }).d })
    expect(existsSync(join(x.home, `${AGENT_REQUEST_FILE}.taken`))).toBe(false)
    await y.tick()
    expect(x.calls).toEqual([])
  })
})

describe('the owner’s own tap (a proof that verifies)', () => {
  const ownerRequest = (x: ReturnType<typeof setup>) =>
    writeFileSync(join(x.home, AGENT_REQUEST_FILE), JSON.stringify(OWNER))
  /** A fresh owner's request, signed now with the test key, as the bridge writes one from the phone. */
  async function signedOwner(x: ReturnType<typeof setup>, controlId: string) {
    const priv = await importDevicePrivateKey(KEY.privateJwk)
    const signed = await signOwnerFrame(
      {
        v: 1,
        type: 'agent.recover',
        id: newUlid(),
        ts: new Date(x.wall).toISOString(),
        control_id: controlId,
        action: 'restart',
        device_id: KEY.deviceId,
      },
      priv,
    )
    const { osig, ...rest } = signed
    writeFileSync(
      join(x.home, AGENT_REQUEST_FILE),
      JSON.stringify({
        v: 1,
        control_id: controlId,
        action: 'restart',
        ts: x.wall,
        proof: { device_id: KEY.deviceId, osig, signed_b64url: b64urlEncode(new TextEncoder().encode(jcs(rest))) },
      }),
    )
  }
  it('his own gap: a second tap within 2 minutes is too_soon; a session’s restart just before does not hold him', async () => {
    const x = setup()
    await signedOwner(x, ID(20))
    await x.tick()
    await x.tick()
    x.status = { ...x.status, phase: 'running' }
    await x.tick()
    await signedOwner(x, ID(21))
    await x.tick(30)
    expect(x.file().last).toMatchObject({ control_id: ID(21), outcome: 'refused', detail: 'too_soon' })
    const y = setup()
    y.agent(1)
    await y.tick()
    await y.tick()
    y.status = { ...y.status, phase: 'running' }
    await y.tick()
    await signedOwner(y, ID(22))
    await y.tick(10)
    expect(y.calls.filter((c) => c === 'stop')).toHaveLength(2)
  })
  it('skips the restart check: restarted with someone attached, auto-confirm off, a dialog up; no "asked by" line', async () => {
    const x = setup()
    x.inputs.attached = true
    x.inputs.autoConfirmRestart = false
    x.status = { ...x.status, needsYou: { kind: 'dialog', dialog: 'trust' } }
    ownerRequest(x)
    await x.tick()
    expect(x.calls).toEqual(['stop'])
    expect(x.events('agent_request')[0]?.[1]).toMatchObject({ proof: 'owner' })
    expect(x.posts).toEqual([])
    // the proof is spent on disk, 0600
    expect(statSync(join(x.home, 'restart-proofs-used.json')).mode & 0o777).toBe(0o600)
  })
  it('landing on a screen that needs someone at the keyboard: said at once, last = stalled with its label', async () => {
    const x = setup()
    ownerRequest(x)
    await x.tick()
    await x.tick()
    x.status = { ...x.status, needsYou: { kind: 'confirm_cold_start' } }
    await x.tick()
    expect(x.file().last).toMatchObject({ outcome: 'stalled', detail: 'dev-channel warning' })
    expect(x.posts).toEqual([
      'Main restarted on request and is waiting at the dev-channel warning on this computer; someone has to answer it at the keyboard (Talos does not).',
    ])
    // still waiting past the lines' 2-minute spacing: said once per restart, not again
    await x.tick(130)
    await x.tick()
    expect(x.posts).toHaveLength(1)
    // answered later: came_back
    x.status = { ...x.status, phase: 'running', needsYou: undefined }
    await x.tick()
    expect(x.file().last).toMatchObject({ outcome: 'came_back' })
  })
  it('refused on the usage-limit menu only (a restart lands on it again), in its own words', async () => {
    const x = setup()
    x.status = { ...x.status, needsYou: { kind: 'usage_limit', model: null, limit: 'session', resets: null } }
    ownerRequest(x)
    await x.tick()
    expect(x.calls).toEqual([])
    expect(x.file().last).toMatchObject({ outcome: 'refused', detail: 'usage limit' })
    expect(x.posts[0]).toContain('a restart would land on the same menu')
  })
  it('the same proof again (a replay under a new control id) is no proof: refused, never a restart', async () => {
    const x = setup()
    ownerRequest(x)
    await x.tick()
    await x.tick()
    x.status = { ...x.status, phase: 'running' }
    await x.tick()
    writeFileSync(join(x.home, AGENT_REQUEST_FILE), JSON.stringify({ ...OWNER, control_id: ID(9) }))
    await x.tick(200)
    expect(x.calls.filter((c) => c === 'stop')).toHaveLength(1)
    expect(x.file().last).toMatchObject({ control_id: ID(9), outcome: 'refused' })
    expect(x.events('restart_proof_bad')[0]?.[1]).toEqual({ step: 'control_id' })
  })
  it('a proof claiming the owner that does not verify: refused whatever the check says, one fixed line', async () => {
    const x = setup()
    const p = OWNER.proof as Record<string, string>
    writeFileSync(
      join(x.home, AGENT_REQUEST_FILE),
      JSON.stringify({ ...OWNER, proof: { ...p, osig: `${(p.osig as string).slice(0, -2)}AA` } }),
    )
    await x.tick()
    expect(x.calls).toEqual([])
    expect(x.file().last).toMatchObject({ outcome: 'refused' })
    expect(x.file().last).not.toHaveProperty('detail')
    expect(x.posts).toEqual(['Main was not restarted: a restart request that claimed to be yours did not verify.'])
  })
})

describe('main-restart-check.json (main-restart-check.ts)', () => {
  it('the protocol’s shape, sorted keys, 0600; rewritten every 5 s, not every tick', async () => {
    const x = setup()
    await x.tick()
    const text = readFileSync(join(x.home, MAIN_RESTART_CHECK_FILE), 'utf8')
    expect(MainRestartCheckFile.safeParse(JSON.parse(text)).success).toBe(true)
    expect(Object.keys(JSON.parse(text))).toEqual(['at', 'reasons', 'v', 'will_return'])
    expect(JSON.parse(text)).toMatchObject({ v: 1, will_return: true, reasons: [] })
    expect(statSync(join(x.home, MAIN_RESTART_CHECK_FILE)).mode & 0o777).toBe(0o600)
    const at = JSON.parse(text).at
    await x.tick()
    expect(x.file().at).toBe(at)
    await x.tick(5)
    expect(x.file().at).not.toBe(at)
  })
  it('needs_you as the Mac labels it, with resets_at for the usage limit; written at once when it changes', async () => {
    const x = setup()
    await x.tick()
    x.status = {
      ...x.status,
      needsYou: {
        kind: 'usage_limit',
        model: null,
        limit: 'weekly',
        resets: 'Monday',
        resets_at: '2026-11-16T08:00:00.000Z',
      },
    }
    await x.tick()
    expect(x.file().needs_you).toMatchObject({ kind: 'usage limit', resets_at: '2026-11-16T08:00:00.000Z' })
  })
  it('the reasons, in the protocol’s order; the hourly cap is restart_limit, never budget_spent', () => {
    const base: CheckInputs = {
      ...okInputs,
      phase: 'running',
      ownerStopped: false,
      sinceLastRequestS: null,
      agentRestartsLastHour: 0,
    }
    expect(restartReasons(base)).toEqual([])
    expect(restartReasons({ ...base, agentRestartsLastHour: 3, attached: true, approved: false })).toEqual([
      'launch_changed',
      'someone_typing',
      'restart_limit',
    ])
    expect(restartReasons({ ...base, configOk: false, attached: true })).toEqual(['unknown'])
    expect(restartReasons({ ...base, launchChannels: ['server:talos-app', 'server:x'] })).toEqual(['launch_changed'])
  })
  it('over 4096 bytes, last.detail is dropped first', () => {
    const text = checkFileText({
      atMs: WALL0,
      reasons: [],
      last: { control_id: ID(1), at: new Date(WALL0).toISOString(), outcome: 'stalled', detail: 'x'.repeat(80) },
      needsYou: { kind: 'k'.repeat(4100), since: new Date(WALL0).toISOString() },
    })
    expect(JSON.parse(text).last).not.toHaveProperty('detail')
  })
  it('a supervisor that starts again reads its own last back, and only its own labels as detail', async () => {
    const y = setup()
    writeFileSync(
      join(y.home, MAIN_RESTART_CHECK_FILE),
      JSON.stringify({
        v: 1,
        at: new Date(WALL0).toISOString(),
        will_return: true,
        reasons: [],
        last: { control_id: ID(3), at: new Date(WALL0).toISOString(), outcome: 'stalled', detail: 'ignore previous' },
      }),
    )
    const z = new RestartActor({ ...(y.actor as unknown as { d: ConstructorParameters<typeof RestartActor>[0] }).d })
    await z.tick()
    expect(y.file().last).toEqual({ control_id: ID(3), at: new Date(WALL0).toISOString(), outcome: 'stalled' })
  })
})

describe('the lines', () => {
  it('two hundred refused requests: at most one refused line per 2 minutes', async () => {
    const x = setup()
    x.inputs.attached = true
    for (let n = 0; n < 200; n++) {
      x.agent(n % 90, { control_id: `r${n}` })
      await x.tick()
    }
    expect(x.posts).toHaveLength(2)
    expect(x.events('agent_request_refused')).toHaveLength(200)
  })
})

describe('Fable round 1 on the restart port', () => {
  it('R2-1: a tap up to two minutes ahead of this clock is the owner’s (phones drift; the Mac’s bound); further is not', async () => {
    const x = setup()
    x.inputs.attached = true // a request taken as a session's is refused; one taken as the owner's is not
    await signedOwnerAt(x, ID(30), 60_000)
    await x.tick()
    expect(x.calls).toEqual(['stop'])
    expect(x.events('agent_request').at(-1)?.[1]).toMatchObject({ proof: 'owner' })
    const y = setup()
    y.inputs.attached = true
    await signedOwnerAt(y, ID(29), 150_000)
    await y.tick()
    expect(y.calls).toEqual([])
    expect(y.file().last).toMatchObject({ control_id: ID(29), outcome: 'refused', detail: 'someone_typing' })
    expect(y.posts[0]).toContain('signed at a time this computer does not accept')
  })
  it('R1-1: a used tap does not come back after a restart with both proof files deleted (the actor keeps them too)', async () => {
    const x = setup()
    const file = await signedOwnerAt(x, ID(31), 3_000)
    await x.tick()
    await cameBack(x)
    expect(x.calls.filter((c) => c === 'stop')).toHaveLength(1)
    x.agent(32) // another request handled since, so the replay is not merely "the last id again"
    await x.tick()
    rmSync(join(x.home, 'restart-proofs-used.json'))
    rmSync(join(x.home, 'restart-proof-mark.json'))
    x.restartSupervisor(x.wall - 2_000) // started before the tap's signed time
    writeFileSync(join(x.home, AGENT_REQUEST_FILE), JSON.stringify({ ...file, ts: x.wall }))
    await x.tick(130)
    expect(x.calls.filter((c) => c === 'stop')).toHaveLength(1)
    expect(x.events('restart_proof_bad').at(-1)?.[1]).toEqual({ step: 'used' })
  })
  it('R1-3: the gap, the hourly cap, the handled id and the line spacing outlive a restart', async () => {
    const x = setup()
    x.agent(1)
    await x.tick()
    await cameBack(x)
    // six fresh supervisors within 12 s: none acts again
    for (let n = 2; n <= 7; n++) {
      x.restartSupervisor(x.wall - 5_000)
      x.agent(n)
      await x.tick(2)
    }
    expect(x.calls.filter((c) => c === 'stop')).toHaveLength(1)
    expect(x.file().last).toMatchObject({ outcome: 'refused', detail: 'too_soon' })
    expect(x.posts.filter((p) => p.startsWith('Main was not restarted'))).toHaveLength(1)
    // the last control id handled, to a fresh one: discarded (as on the Mac, the last one is what is kept)
    x.restartSupervisor(x.wall - 5_000)
    x.agent(7)
    await x.tick(200)
    expect(x.calls.filter((c) => c === 'stop')).toHaveLength(1)
    // the hourly cap across restarts: two more acted on, then the fourth is restart_limit
    for (const n of [8, 9]) {
      x.restartSupervisor(x.wall - 5_000)
      x.agent(n)
      await x.tick(130)
      await cameBack(x)
    }
    x.restartSupervisor(x.wall - 5_000)
    x.agent(10)
    await x.tick(130)
    expect(x.file().last).toMatchObject({ control_id: ID(10), outcome: 'refused', detail: 'restart_limit' })
    expect(statSync(join(x.home, 'restart-actor.json')).mode & 0o777).toBe(0o600)
  })
  it('R1-7: a folder at the old taken name blocks nothing; one left behind goes at a start; the ignored log is spaced', async () => {
    const x = setup()
    mkdirSync(join(x.home, `${AGENT_REQUEST_FILE}.taken`))
    writeFileSync(join(x.home, `${AGENT_REQUEST_FILE}.taken`, 'x'), '')
    x.agent(1)
    await x.tick()
    expect(x.calls).toEqual(['stop'])
    x.restartSupervisor()
    expect(existsSync(join(x.home, `${AGENT_REQUEST_FILE}.taken`))).toBe(false)
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(x.home, AGENT_REQUEST_FILE), 'not json')
      await x.tick()
    }
    expect(x.events('agent_request_ignored').length).toBeLessThanOrEqual(3)
  })
  it('R1-6: bad proofs are spaced like every refused line', async () => {
    const x = setup()
    const p = OWNER.proof as Record<string, string>
    for (let n = 0; n < 5; n++) {
      writeFileSync(
        join(x.home, AGENT_REQUEST_FILE),
        JSON.stringify({
          ...OWNER,
          control_id: `bad${n}`,
          ts: x.wall,
          proof: { ...p, osig: `${(p.osig as string).slice(0, -2)}AA` },
        }),
      )
      await x.tick()
    }
    expect(x.posts).toHaveLength(1)
    expect(x.events('restart_proof_bad')).toHaveLength(5)
  })
  it('R1-6: a proof another supervisor used is refused here, read from the file (not only this one’s memory)', async () => {
    const x = setup()
    await signedOwnerAt(x, ID(40))
    await x.tick() // this actor seeds its used list now
    await cameBack(x)
    const other = new RestartActor({ ...x.deps })
    const file = await signedOwnerAt(x, ID(41))
    await other.tick() // the other one uses ID(41)'s proof
    writeFileSync(join(x.home, AGENT_REQUEST_FILE), JSON.stringify({ ...file, ts: x.wall }))
    await x.tick(200)
    expect(x.events('restart_proof_bad').at(-1)?.[1]).toEqual({ step: 'used' })
  })
  it('R1-6: a mark dated far ahead in the file is capped at this start (it cannot shut the owner out)', async () => {
    const x = setup()
    writeFileSync(join(x.home, 'restart-proof-mark.json'), JSON.stringify({ v: 1, signed_ms: x.wall + 86_400_000 }))
    await signedOwnerAt(x, ID(42))
    await x.tick()
    expect(x.calls).toEqual(['stop'])
    expect(x.events('agent_request').at(-1)?.[1]).toMatchObject({ proof: 'owner' })
  })
  it('R1-6: a proof whose use could not be written down is not the owner’s word (checked like a session’s)', async () => {
    const x = setup()
    mkdirSync(join(x.home, 'restart-proofs-used.json')) // the write fails
    x.inputs.attached = true
    await signedOwnerAt(x, ID(43))
    await x.tick()
    expect(x.calls).toEqual([])
    expect(x.file().last).toMatchObject({ outcome: 'refused', detail: 'someone_typing' })
    expect(x.events('restart_proof_unrecorded')).toHaveLength(1)
  })
  it('R1-6: a request more than five minutes old is discarded (the stale check on its own)', async () => {
    const x = setup({ launchedAtMs: WALL0 - 3_600_000 })
    x.write({ v: 1, control_id: ID(50), action: 'restart', ts: x.wall - 302_000 })
    await x.tick()
    expect(x.calls).toEqual([])
    x.write({ v: 1, control_id: ID(51), action: 'restart', ts: x.wall - 290_000 })
    await x.tick()
    expect(x.calls).toEqual(['stop'])
  })
})

describe('Fable round 2 on the restart port', () => {
  const state = (x: ReturnType<typeof setup>, text: string) => writeFileSync(join(x.home, 'restart-actor.json'), text)
  it('an unreadable restart-actor.json holds a session’s request as if a restart had just happened at the cap; the owner’s tap is not held', async () => {
    for (const bad of ['dir', '{"v":1,', '{"v":1,"owner_acted_ms":"x"}', '[1]', '{"v":2}']) {
      const x = setup()
      if (bad === 'dir') mkdirSync(join(x.home, 'restart-actor.json'))
      else state(x, bad)
      x.restartSupervisor(x.wall - 5_000)
      expect(x.events('restart_state_unreadable'), bad).toHaveLength(1)
      x.agent(1)
      await x.tick()
      expect(x.calls, bad).toEqual([])
      expect(x.file().last, bad).toMatchObject({ outcome: 'refused', detail: 'too_soon' })
      // after the gap, the cap: still refused within the hour
      x.agent(2)
      await x.tick(130)
      expect(x.file().last, bad).toMatchObject({ outcome: 'refused', detail: 'restart_limit' })
      // the owner's tap goes
      await signedOwnerAt(x, ID(3))
      await x.tick()
      expect(x.calls, bad).toEqual(['stop'])
    }
    // no file at all is a first run, not unreadable
    const y = setup()
    expect(y.events('restart_state_unreadable')).toHaveLength(0)
    y.agent(1)
    await y.tick()
    expect(y.calls).toEqual(['stop'])
  })
  it('R2-2: a stamp dated far ahead is clamped to now: the owner is held one gap, never indefinitely', async () => {
    const x = setup()
    state(x, JSON.stringify({ v: 1, owner_acted_ms: x.wall + 86_400_000 }))
    x.restartSupervisor()
    await signedOwnerAt(x, ID(60))
    await x.tick()
    expect(x.file().last).toMatchObject({ control_id: ID(60), outcome: 'refused', detail: 'too_soon' })
    await x.tick(125)
    await signedOwnerAt(x, ID(61))
    await x.tick()
    expect(x.calls).toEqual(['stop'])
  })
  it('R2-2: the owner’s own gap holds across a supervisor restart (owner_acted_ms read back)', async () => {
    const x = setup()
    await signedOwnerAt(x, ID(62))
    await x.tick()
    await cameBack(x)
    x.restartSupervisor(x.wall - 5_000)
    await signedOwnerAt(x, ID(63))
    await x.tick(30)
    expect(x.file().last).toMatchObject({ control_id: ID(63), outcome: 'refused', detail: 'too_soon' })
  })
  it('R2-2: mark_ms is read from the actor’s state (a tap at or before it is not taken as the owner’s word)', async () => {
    const x = setup()
    rmSync(join(x.home, 'restart-proof-mark.json'), { force: true })
    state(x, JSON.stringify({ v: 1, mark_ms: x.wall + 10 * 86_400_000 }))
    x.restartSupervisor(x.wall) // the mark is capped at this start: a tap signed exactly then is at the mark
    await signedOwnerAt(x, ID(64))
    await x.tick()
    expect(x.posts[0]).toContain('earlier than one this computer already accepted')
  })
  it('a wall clock stepped back an hour in-run: requests are still taken (the start is placed by the monotonic clock)', async () => {
    const x = setup()
    x.wall -= 3_600_000
    x.agent(1)
    await x.tick()
    expect(x.calls).toEqual(['stop'])
  })
})
