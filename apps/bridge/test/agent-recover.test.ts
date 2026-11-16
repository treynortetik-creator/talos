// A signed agent.recover from the phone ("Restart agent"): the bridge records the result once,
// then hands the request to the Mac app as $TALOS_APP_HOME/agent-request.json. The agent is never involved. Real inbound
// over the FakeRelay; the frames that a real relay would refuse are pushed past it.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  AgentRequestFile,
  b64urlDecode,
  fromUtf8,
  newUlid,
  ownerSignedString,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { buildGuardConfig, guardDecision } from '../src/guards/rules.ts'
import { type Harness, sleep, startHarness, tempHome } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function up() {
  h = await startHarness({ home: tempHome('ar') })
  return h
}
const requestFile = (hh: Harness) => join(hh.home, 'agent-request.json')
const results = (hh: Harness, id: unknown) =>
  hh.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.frame.type === 'agent.recover.result')
    .map((r) => r.frame as { control_id: string; ok: boolean; text: string })
    .filter((f) => f.control_id === id)

describe('agent.recover at the bridge', () => {
  test('an unsigned or altered one is refused: no file, no result', async () => {
    const hh = await up()
    const control_id = newUlid()
    const signed = await hh.app.sign({ ...mkFrame('agent.recover'), control_id, action: 'restart' })
    hh.relay.sendToBridge({ ...signed, action: 'restore_last_good' }) // changed after signing
    const { osig: _dropped, ...unsigned } = signed
    hh.relay.sendToBridge({ ...unsigned, id: newUlid() }) // never signed
    await sleep(300)
    expect(existsSync(requestFile(hh))).toBe(false)
    expect(results(hh, control_id)).toHaveLength(0)
  })

  test('a replay with the same control_id is refused and the stored result is sent again', async () => {
    const hh = await up()
    const first = await hh.app.sendAgentRecover('restart')
    const res = await hh.relay.expectFrame('agent.recover.result', (x) => x.control_id === first.control_id, {
      direction: 'from_bridge',
    })
    expect(res.ok).toBe(true)
    rmSync(requestFile(hh))
    const again = await hh.app.sign({ ...mkFrame('agent.recover'), control_id: first.control_id, action: 'restart' })
    hh.relay.sendToBridge(again)
    await sleep(400)
    expect(existsSync(requestFile(hh))).toBe(false) // not written a second time
    const sent = results(hh, first.control_id)
    expect(sent.length).toBeGreaterThanOrEqual(2)
    expect(new Set(sent.map((r) => JSON.stringify([r.ok, r.text]))).size).toBe(1)
  })

  test('a valid restart writes the request file once, with mode 0600, and nothing reaches the agent', async () => {
    const hh = await up()
    const enqueued: unknown[] = []
    const orig = hh.bridge.ctx.mod.enqueue.bind(hh.bridge.ctx.mod)
    hh.bridge.ctx.mod.enqueue = (c) => {
      enqueued.push(c)
      return orig(c)
    }
    const f = await hh.app.sendAgentRecover('restart')
    const res = await hh.relay.expectFrame('agent.recover.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(res.ok).toBe(true)
    const file = AgentRequestFile.parse(JSON.parse(readFileSync(requestFile(hh), 'utf8')))
    expect(file).toMatchObject({ v: 1, control_id: f.control_id, action: 'restart' })
    expect(Object.keys(JSON.parse(readFileSync(requestFile(hh), 'utf8')))).not.toContain('asked_by') // nothing says who asked
    expect(Math.abs(file.ts - Date.now())).toBeLessThan(60_000)
    expect(statSync(requestFile(hh)).mode & 0o777).toBe(0o600)
    await sleep(200)
    expect(hh.notes).toHaveLength(0)
    expect(enqueued).toHaveLength(0)
  })

  test('a signed restore_last_good from an old app gets a plain refusal, writes no file and is not queued', async () => {
    const hh = await up()
    const signed = await hh.app.sign({
      ...mkFrame('agent.recover'),
      control_id: newUlid(),
      action: 'restore_last_good',
    })
    hh.relay.sendToBridge(signed) // past the relay, which already refuses it
    const res = await hh.relay.expectFrame('agent.recover.result', (x) => x.control_id === signed.control_id, {
      direction: 'from_bridge',
    })
    expect(res.ok).toBe(false)
    expect(res.text).toContain('needs the Mac now')
    await sleep(200)
    expect(existsSync(requestFile(hh))).toBe(false)
    expect(results(hh, signed.control_id)).toHaveLength(1)
  })

  test("the phone's request carries the owner's proof: the exact bytes Inbound verified, checked by the same verifier", async () => {
    const hh = await up()
    // an old app's stepup_token and the relay's own stamp ride along; neither is signed, so the proof must leave both out
    const f = await hh.app.sendAgentRecover('restart', { stepup_token: 'old-app-token' })
    await hh.relay.expectFrame('agent.recover.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    const raw = JSON.parse(readFileSync(requestFile(hh), 'utf8'))
    const file = AgentRequestFile.parse(raw)
    const proof = file.proof
    if (!proof) throw new Error('no proof written')
    expect(Object.keys(raw.proof).sort()).toEqual(['device_id', 'osig', 'signed_b64url'])
    expect(proof.device_id).toBe(f.device_id)
    expect(proof.osig).toBe(f.osig)
    const signed = fromUtf8(b64urlDecode(proof.signed_b64url))
    expect(signed).toBe(ownerSignedString(f as Record<string, unknown>))
    // the frame, rebuilt from the signed bytes and the signature, passes the bridge's own owner check (inbound.ts verifyOwner)
    const back = { ...JSON.parse(signed), osig: proof.osig } as Record<string, unknown>
    expect(back).toMatchObject({ type: 'agent.recover', action: 'restart', control_id: file.control_id })
    expect(back.stepup_token).toBeUndefined()
    const jwk = hh.bridge.ctx.devices.pinnedKey(proof.device_id)
    if (!jwk) throw new Error('the test phone is not pinned')
    expect(await verifyOwnerFrame(back, jwk)).toBe(true)
    // control: one byte changed in what was signed, and the same verifier says no
    expect(await verifyOwnerFrame({ ...back, action: 'restarT' }, jwk)).toBe(false)
    // a real one is small: far under the Mac's 4 KB cap (AgentRequest.maxBytes)
    expect(readFileSync(requestFile(hh)).length).toBeLessThan(1024)
  })

  test('the K2 guard denies an agent Write, Edit and shell write to agent-request.json (the bridge write still works)', async () => {
    const hh = await up()
    const cfg = buildGuardConfig({
      home: hh.home,
      checkout: join(hh.home, 'checkout'),
      claudeHome: join(hh.home, 'claude'),
      userHome: join(hh.home, 'user'),
    })
    const target = requestFile(hh)
    for (const tool_name of ['Write', 'Edit', 'MultiEdit'])
      expect(guardDecision({ tool_name, tool_input: { file_path: target } }, cfg)?.deny).toContain('agent-request.json')
    expect(guardDecision({ tool_name: 'Bash', tool_input: { command: `echo '{}' > ${target}` } }, cfg)).toBeDefined()
    expect(
      guardDecision({ tool_name: 'Bash', tool_input: { command: `cd ${hh.home} && rm agent-request.json` } }, cfg),
    ).toBeDefined()
    // and the bridge's own write, which does not go through the guard, lands
    const f = await hh.app.sendAgentRecover('restart')
    await hh.relay.expectFrame('agent.recover.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(existsSync(target)).toBe(true)
  })

  test('a write failure sends exactly one result, ok:false, and records it', async () => {
    const hh = await up()
    mkdirSync(requestFile(hh)) // a directory where the file goes: the rename cannot succeed
    const f = await hh.app.sendAgentRecover('restart')
    await hh.relay.expectFrame('agent.recover.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    await sleep(400)
    const sent = results(hh, f.control_id)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.ok).toBe(false)
    expect(hh.bridge.ctx.store.kvGet(`arc:${f.control_id}`)).toContain('"ok":false')
  })

  // The bridge only knows the file was written. The Mac app may still refuse (the owner stopped the agent there, a phone restart in the
  // last 2 minutes) or not be running at all, and no answer comes back, so the text must not promise a restart, a time or a menu line.
  test('the success text is honest: sent to the Mac, which decides; no promise it will restart', async () => {
    const hh = await up()
    const a = await hh.app.sendAgentRecover('restart')
    const ra = await hh.relay.expectFrame('agent.recover.result', (x) => x.control_id === a.control_id, {
      direction: 'from_bridge',
    })
    expect(ra.text).toBe(
      'Sent to your Mac, where the Talos app decides. It skips the restart if you stopped the agent there, or did a phone restart in the last 2 minutes. Nothing happens if the app is not running.',
    )
    expect(ra.text.length).toBeLessThan(210)
    expect(ra.text).not.toMatch(/will restart|within|seconds|menu/i) // no time, and no line on the Mac to look for
  })
})
