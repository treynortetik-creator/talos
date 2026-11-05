import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bindingMac,
  createDeviceKey,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
  fingerprintWords,
  newEnrollCode,
  newUlid,
} from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { EnrollFiles } from '../src/enroll-files.ts'
import { advanceSteps, type Harness, sleep, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

type Cli = {
  out: string[]
  err: string[]
  prompts: string[]
  io: Parameters<typeof runCli>[1]
  answer: { value: string }
}
function cli(): Cli {
  const out: string[] = []
  const err: string[] = []
  const prompts: string[] = []
  const answer = { value: 'y' }
  return {
    out,
    err,
    prompts,
    answer,
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async (q) => {
        prompts.push(q)
        return answer.value
      },
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    },
  }
}

const env = (hh: Harness, extra: Record<string, string> = {}) => ({
  TALOS_APP_HOME: hh.home,
  TALOS_APP_RELAY_URL: hh.relay.httpUrl,
  ...extra,
})

/** Runs `talos-app enroll` in the background and returns once it has printed the link. */
async function startEnroll(hh: Harness, c: Cli, extra: Record<string, string> = {}) {
  const done = runCli(['enroll', '--label', 'phone'], c.io, env(hh, extra))
  await waitFor(() => c.out.some((l) => l.includes('/enroll#')), 3000, 'the enroll link')
  const link = c.out.find((l) => l.includes('/enroll#')) as string
  const code = link.split('#')[1] as string
  const codeId = enrollCodeId(enrollAuthHash(deriveEnrollAuth(code)))
  return { done, code, codeId, link }
}

async function enrolled(code: string, codeId: string, over: { badBinding?: boolean; name?: string } = {}) {
  const dev = await createDeviceKey()
  const binding = bindingMac(deriveEnrollBind(over.badBinding ? newEnrollCode() : code), dev.deviceId, dev.publicJwk)
  return {
    dev,
    frame: {
      type: 'device.enrolled',
      device: { id: dev.deviceId, name: over.name ?? 'iPhone (Home Screen)', pubkey_jwk: dev.publicJwk },
      binding,
      code_id: codeId,
      credential_id: 'cred-1',
    },
  }
}

describe('enrollment (Mac side)', () => {
  test('enroll writes the pending file, sends ONLY the hash to the relay, and prints the link', async () => {
    h = await startHarness({ startBridge: false })
    const c = cli()
    const { done, code, codeId, link } = await startEnroll(h, c)
    expect(link).toBe(`${h.relay.httpUrl}/enroll#${code}`)
    const files = new EnrollFiles(paths(h.home).enrollPending)
    const pending = files.readPending(codeId)
    expect(pending?.code).toBe(code)
    expect(pending?.label).toBe('phone')
    const req = h.relay.http.find((r) => r.path === '/bridge/enroll')
    const sent = JSON.parse(req?.body.toString() ?? '{}')
    expect(sent.code_auth_hash).toBe(enrollAuthHash(deriveEnrollAuth(code)))
    expect(sent.code_id).toBe(codeId)
    expect(JSON.stringify(sent)).not.toContain(code)
    expect(JSON.stringify(sent)).not.toContain(deriveEnrollAuth(code)) // not even code_auth itself
    expect(req?.status).toBe(200)
    c.io.now = () => Date.now() + 11 * 60_000 // make the foreground wait give up
    await done
  })

  test('device.enrolled with a valid binding writes the confirm file; y pins, sends device.pinned{ok:true} and posts a system message', async () => {
    h = await startHarness()
    const c = cli()
    const e = await startEnroll(h, c)
    const { dev, frame } = await enrolled(e.code, e.codeId)
    h.relay.sendToBridge(frame)
    await e.done // the CLI saw the confirm file and prompted
    expect(c.prompts).toEqual([`Pin "iPhone (Home Screen)" [${fingerprintWords(dev.deviceId).join(' ')}]? [y/N] `])
    expect(h.bridge.ctx.devices.pinnedKey(dev.deviceId)).toBeUndefined() // not pinned until the live bridge acts on the answer
    await h.bridge.enrollment.poll()
    expect(h.bridge.ctx.devices.pinnedKey(dev.deviceId)).toEqual(dev.publicJwk)
    const pinned = await h.relay.expectFrame('device.pinned', (f) => f.device_id === dev.deviceId, {
      direction: 'from_bridge',
    })
    expect(pinned.ok).toBe(true)
    const sys = await h.relay.expectFrame('reply', (f) => f.message.author === 'system', { direction: 'from_bridge' })
    // the four words are the device's real fingerprint (they can be capitalized: "Athens"), not just [a-z]+
    expect(sys.message.text).toMatch(
      new RegExp(
        `^New device pinned \\(${fingerprintWords(dev.deviceId).join(' ')}\\), device-supplied name \\(untrusted text\\): "iPhone \\(Home Screen\\)", \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC\\.$`,
      ),
    )
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.kind).toBe('system')
    // the pending files are gone, and the stored entry carries the fingerprint
    expect(readdirSync(paths(h.home).enrollPending)).toEqual([])
    const stored = JSON.parse(readFileSync(paths(h.home).devicesJson, 'utf8')).devices.find(
      (d: { id: string }) => d.id === dev.deviceId,
    )
    expect(stored.fingerprint).toEqual([...fingerprintWords(dev.deviceId)])
    // and the newly pinned device can now talk to the agent
    const { FakeApp } = await import('@talos-app/testkit')
    const app2 = new FakeApp({ relayWs: h.relay.wsBase, deviceKey: dev })
    await app2.connect()
    await app2.sendMessage('general', 'hello from the new device')
    await waitFor(() => h.notes.some((n) => n.content === 'hello from the new device'))
    await app2.close()
  })

  test('after y the live bridge pins from the file watch, without a manual poll and before its 10 s fallback poll', async () => {
    // The bridge has two ways to notice the owner's answer: a file watch on enroll-pending/ (200 ms debounce) and a 10 s
    // fallback poll. Both run on the bridge's clock. This clock is only ever moved by the debounce's 200 ms steps, one per
    // watcher event, so the fallback poll cannot come due and only the watcher can pin.
    const clock = fakeClock(new Date().toISOString())
    // The folder exists before the bridge starts, so its creation is not an event on the home-folder watch: on a Mac that
    // late event could otherwise stand in for the answer's event and let a missing enroll-pending watch pass.
    const home = tempHome()
    mkdirSync(paths(home).enrollPending, { recursive: true })
    h = await startHarness({ clock, home })
    let pokes = 0
    const b = h.bridge as unknown as { pokePoll(): void }
    const realPoke = b.pokePoll
    b.pokePoll = function (this: unknown) {
      pokes++
      return realPoke.call(this)
    }
    const c = cli()
    const e = await startEnroll(h, c)
    const { dev, frame } = await enrolled(e.code, e.codeId)
    h.relay.sendToBridge(frame)
    await e.done
    // Each watcher event arms the debounce on the fake clock; moving the clock 200 ms is what lets that one poll run.
    // Nothing here calls enrollment.poll(). The wait is a cap on a hang (a watcher that never fires), not a speed claim.
    let stepped = 0
    let advanced = 0
    await waitFor(
      () => {
        if (pokes > stepped) {
          stepped = pokes
          clock.advance(200)
          advanced += 200
        }
        return h.bridge.ctx.devices.pinnedKey(dev.deviceId) !== undefined
      },
      8000,
      'the pin from the file watch',
    )
    expect(pokes).toBeGreaterThan(0)
    // The owner's answer lands in enroll-pending/, which a watch on the home folder does not see on every platform (and
    // on a Mac, late home-folder events for other files can stand in for it). Only that folder's own watch is the proof.
    expect(h.bridge.watchHits[paths(h.home).enrollPending] ?? 0).toBeGreaterThan(0)
    expect(advanced).toBeLessThan(10_000) // never reached POLL_MS: the pin did not come from the fallback poll
  }, 30_000)

  test('N does not pin: device.pinned{ok:false, reason:declined}', async () => {
    h = await startHarness()
    const c = cli()
    c.answer.value = 'N'
    const e = await startEnroll(h, c)
    const { dev, frame } = await enrolled(e.code, e.codeId)
    h.relay.sendToBridge(frame)
    await e.done
    await h.bridge.enrollment.poll()
    expect(h.bridge.ctx.devices.pinnedKey(dev.deviceId)).toBeUndefined()
    const pinned = await h.relay.expectFrame('device.pinned', (f) => f.device_id === dev.deviceId, {
      direction: 'from_bridge',
    })
    expect(pinned.ok).toBe(false)
    expect(pinned.reason).toBe('declined')
    expect(readdirSync(paths(h.home).enrollPending)).toEqual([])
    expect(h.notes).toHaveLength(0)
  })

  test('an empty answer, "no" and garbage all count as N', async () => {
    for (const a of ['', 'no', 'maybe', 'yes please?']) {
      h = await startHarness()
      const c = cli()
      c.answer.value = a
      const e = await startEnroll(h, c)
      const { dev, frame } = await enrolled(e.code, e.codeId)
      h.relay.sendToBridge(frame)
      await e.done
      await h.bridge.enrollment.poll()
      expect(h.bridge.ctx.devices.pinnedKey(dev.deviceId), `answer ${JSON.stringify(a)}`).toBeUndefined()
      await h.stop()
    }
    h = await startHarness({ startBridge: false })
  })

  test('a bad binding is device.pinned{ok:false, reason:bad_binding} and no confirm file is written', async () => {
    h = await startHarness()
    const c = cli()
    const e = await startEnroll(h, c)
    const { dev, frame } = await enrolled(e.code, e.codeId, { badBinding: true })
    h.relay.sendToBridge(frame)
    const pinned = await h.relay.expectFrame('device.pinned', (f) => f.device_id === dev.deviceId, {
      direction: 'from_bridge',
    })
    expect(pinned.ok).toBe(false)
    expect(pinned.reason).toBe('bad_binding')
    expect(new EnrollFiles(paths(h.home).enrollPending).readConfirm(e.codeId)).toBeUndefined()
    // a binding with a device id that is not the id of the key is refused too
    const other = await createDeviceKey()
    const swapped = { ...frame, device: { ...frame.device, id: other.deviceId } }
    h.relay.sendToBridge(swapped)
    const p2 = await h.relay.expectFrame('device.pinned', (f) => f.device_id === other.deviceId, {
      direction: 'from_bridge',
    })
    expect(p2.reason).toBe('bad_binding')
    c.io.now = () => Date.now() + 11 * 60_000
    await e.done
  })

  test('an unknown code id is code_unknown', async () => {
    h = await startHarness()
    const { dev, frame } = await enrolled(newEnrollCode(), '0123456789abcdef')
    h.relay.sendToBridge(frame)
    const pinned = await h.relay.expectFrame('device.pinned', (f) => f.device_id === dev.deviceId, {
      direction: 'from_bridge',
    })
    expect(pinned.reason).toBe('code_unknown')
  })

  test('a revoked device id is never re-pinned', async () => {
    h = await startHarness()
    const c = cli()
    const e = await startEnroll(h, c)
    const { dev, frame } = await enrolled(e.code, e.codeId)
    h.bridge.ctx.devices.revoke(dev.deviceId, new Date().toISOString())
    h.relay.sendToBridge(frame)
    const pinned = await h.relay.expectFrame('device.pinned', (f) => f.device_id === dev.deviceId, {
      direction: 'from_bridge',
    })
    expect(pinned.reason).toBe('revoked')
    expect(h.bridge.ctx.devices.pinnedKey(dev.deviceId)).toBeUndefined()
    // even a y answered later (e.g. a stale confirm file) does not pin it
    new EnrollFiles(paths(h.home).enrollPending).writeConfirm(e.codeId, {
      device_id: dev.deviceId,
      name: 'x',
      fingerprint: [],
      pubkey_jwk: dev.publicJwk,
      created_at: new Date().toISOString(),
    })
    new EnrollFiles(paths(h.home).enrollPending).writeAnswer(e.codeId, { yes: true, device_id: dev.deviceId })
    await h.bridge.enrollment.poll()
    expect(h.bridge.ctx.devices.pinnedKey(dev.deviceId)).toBeUndefined()
    c.io.now = () => Date.now() + 11 * 60_000
    await e.done
  })

  test('a pending code survives a bridge restart', async () => {
    h = await startHarness({ startBridge: false })
    const c = cli()
    const e = await startEnroll(h, c)
    await h.bridge.stop()
    const { Bridge } = await import('../src/bridge.ts')
    const { nullLogger } = await import('../src/log.ts')
    const b2 = await Bridge.create({ env: h.bridge.ctx.env, logger: nullLogger, inbound: { settleMs: 10 } })
    b2.setEmit(async () => {})
    b2.start()
    await h.relay.expectFrame('ready', () => true, { direction: 'to_bridge' })
    const { dev, frame } = await enrolled(e.code, e.codeId)
    h.relay.sendToBridge(frame)
    await waitFor(() => Boolean(new EnrollFiles(paths(h.home).enrollPending).readConfirm(e.codeId)))
    await e.done
    await b2.enrollment.poll()
    expect(b2.ctx.devices.pinnedKey(dev.deviceId)).toEqual(dev.publicJwk)
    await b2.stop()
  })

  test('an unanswered prompt times out after 10 minutes as declined, and old pending codes are removed after 24 h', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock })
    const files = new EnrollFiles(paths(h.home).enrollPending)
    const code = newEnrollCode()
    const codeId = enrollCodeId(enrollAuthHash(deriveEnrollAuth(code)))
    files.writePending(codeId, { code, created_at: clock.iso(), expires_at: clock.iso() })
    const { dev, frame } = await enrolled(code, codeId)
    h.relay.sendToBridge(frame)
    await waitFor(() => Boolean(files.readConfirm(codeId)))
    await advanceSteps(clock, 9 * 60_000)
    await h.bridge.enrollment.poll()
    expect(files.readConfirm(codeId)).toBeDefined()
    await advanceSteps(clock, 2 * 60_000)
    await h.bridge.enrollment.poll()
    expect(files.readConfirm(codeId)).toBeUndefined()
    const pinned = await h.relay.expectFrame('device.pinned', (f) => f.device_id === dev.deviceId, {
      direction: 'from_bridge',
    })
    expect(pinned.reason).toBe('declined')
    const code2 = newEnrollCode()
    const id2 = enrollCodeId(enrollAuthHash(deriveEnrollAuth(code2)))
    files.writePending(id2, { code: code2, created_at: clock.iso(), expires_at: clock.iso() })
    clock.set(clock.now() + 25 * 3600_000)
    await h.bridge.enrollment.poll()
    expect(existsSync(join(paths(h.home).enrollPending, `${id2}.json`))).toBe(false)
    expect(newUlid()).toBeTruthy()
    await sleep(10)
  })

  test('device.revoked from the app marks devices.json and the revoked device can no longer talk to the agent', async () => {
    h = await startHarness()
    h.relay.sendToBridge({ type: 'device.revoked', device_id: h.app.device.deviceId })
    await waitFor(() => h.bridge.ctx.devices.isRevoked(h.app.device.deviceId))
    await h.app.sendMessage('general', 'still me?')
    await h.waitNotes(2)
    expect(h.notes.map((n) => n.meta.kind)).toEqual(['system', 'system'])
    expect(h.notes.some((n) => n.content === 'still me?')).toBe(false)
  })

  test('devices lists pinned devices and `devices revoke` marks devices.json and calls POST /bridge/devices/<id>/revoke', async () => {
    h = await startHarness({ startBridge: false })
    const c = cli()
    expect(await runCli(['devices'], c.io, env(h))).toBe(0)
    expect(c.out.join('\n')).toContain(h.app.device.deviceId)
    expect(c.out.join('\n')).toContain('pinned')
    const c2 = cli()
    expect(await runCli(['devices', 'revoke', h.app.device.deviceId], c2.io, env(h))).toBe(0)
    const req = h.relay.http.find((r) => r.path === `/bridge/devices/${h.app.device.deviceId}/revoke`)
    expect(req?.method).toBe('POST')
    expect(req?.status).toBe(200)
    expect(h.bridge.ctx.devices.isRevoked(h.app.device.deviceId)).toBe(true)
    const c3 = cli()
    expect(await runCli(['devices', 'revoke', 'nonsense'], c3.io, env(h))).toBe(1)
  })

  test('`devices revoke` warns when the relay says the passkey stays valid', async () => {
    h = await startHarness({ startBridge: false, relay: { revokeSharedPasskey: true } })
    const c = cli()
    expect(await runCli(['devices', 'revoke', h.app.device.deviceId], c.io, env(h))).toBe(0)
    const text = c.out.join('\n')
    expect(text).toContain("the relay ended that device's sessions")
    expect(text).toContain('shares its passkey')
    expect(text).toContain('NOT revoked')
  })

  test('`devices revoke` stays quiet about the passkey when it is not shared, and when the relay is older and says nothing', async () => {
    for (const relay of [{ revokeSharedPasskey: false }, {}]) {
      h = await startHarness({ startBridge: false, relay })
      const c = cli()
      expect(await runCli(['devices', 'revoke', h.app.device.deviceId], c.io, env(h))).toBe(0)
      expect(c.out.join('\n')).not.toContain('passkey')
      await h.stop()
    }
  })
})
