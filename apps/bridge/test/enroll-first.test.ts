// device.pinned `first`: the agent's first device ever, on an agent never set up, is the one pin after which the app
// starts the setup interview by itself. Never for a set-up agent (a reinstalled bridge over it), never after a revoke-all
// (the device history is kept), never for a second device.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindingMac,
  createDeviceKey,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
} from '@talos-app/protocol'
import { agentNeverSetUp, DEFAULT_PERSONA } from '../src/agent-setup-state.ts'
import { runCli } from '../src/cli.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

function agentFolder(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-'))
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}
/** What install.sh leaves: the default CLAUDE.md render, and the hook's `later` from its first offer. */
const freshInstall = () =>
  agentFolder({
    'CLAUDE.md': `# Talos\n\n${DEFAULT_PERSONA}\n`,
    '.agent-state/onboarding.json': JSON.stringify({ state: 'later', wave: 1 }),
  })
const progressDone = (n: number) =>
  Array.from({ length: 8 }, (_, i) => `| ${i + 1} | wave | ${i < n ? 'done' : 'todo'} | |`).join('\n')

async function pinOne(name = 'iPhone') {
  const out: string[] = []
  let skew = 0
  const io = {
    out: (l: string) => out.push(l),
    err: () => {},
    prompt: async () => {
      skew += 600
      return 'y'
    },
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))),
    now: () => Date.now() + skew,
  }
  const done = runCli(['enroll', '--no-qr'], io, { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl })
  await waitFor(() => out.some((l) => l.includes('/enroll#')), 3000, 'the link')
  const code = (out.find((l) => l.includes('/enroll#')) as string).split('#')[1] as string
  const dev = await createDeviceKey()
  h.relay.sendToBridge({
    type: 'device.enrolled',
    device: { id: dev.deviceId, name, pubkey_jwk: dev.publicJwk },
    binding: bindingMac(deriveEnrollBind(code), dev.deviceId, dev.publicJwk),
    code_id: enrollCodeId(enrollAuthHash(deriveEnrollAuth(code))),
    credential_id: 'cred-1',
  })
  await done
  await h.bridge.enrollment.poll()
  return h.relay.expectFrame('device.pinned', (f) => f.device_id === dev.deviceId, { direction: 'from_bridge' })
}

describe('device.pinned first', () => {
  test('the first device on a fresh agent: first, and only that one', async () => {
    h = await startHarness({ pinApp: false, bridge: { undo: { agentDir: freshInstall() } } })
    const one = await pinOne()
    expect(one.ok).toBe(true)
    expect(one.first).toBe(true)
    const two = await pinOne('second phone')
    expect(two.ok).toBe(true)
    expect(two.first).toBeUndefined()
  })

  test('a reinstalled bridge (no devices) over a set-up agent: never first', async () => {
    const dir = agentFolder({
      'CLAUDE.md': '# My agent\n\nYou are Ada, my research partner.\n', // tuned, and no onboarding.json (an older kit)
    })
    h = await startHarness({ pinApp: false, bridge: { undo: { agentDir: dir } } })
    expect((await pinOne()).first).toBeUndefined()
  })

  test("after a revoke-all on the owner's agent: the revoked devices still count, never first", async () => {
    h = await startHarness({ pinApp: false, bridge: { undo: { agentDir: freshInstall() } } })
    const one = await pinOne()
    h.bridge.ctx.devices.revoke(one.device_id, new Date().toISOString())
    expect(h.bridge.ctx.devices.list().every((d) => d.revoked_at)).toBe(true)
    expect((await pinOne('new phone')).first).toBeUndefined()
  })

  test('no agent folder known: never first', async () => {
    h = await startHarness({ pinApp: false })
    expect((await pinOne()).first).toBeUndefined()
  })
})

describe('agentNeverSetUp', () => {
  const fresh = `# Talos\n\n${DEFAULT_PERSONA}\n`
  test('a fresh install: an untuned CLAUDE.md, before or after the hook first offered', () => {
    expect(agentNeverSetUp(freshInstall())).toBe(true)
    expect(agentNeverSetUp(agentFolder({ 'CLAUDE.md': fresh }))).toBe(true)
    expect(agentNeverSetUp(agentFolder({ 'CLAUDE.md': '<!-- talos:placeholder -->' }))).toBe(true)
    expect(
      agentNeverSetUp(agentFolder({ 'CLAUDE.md': fresh, '.agent-state/onboarding.json': '{"state":"not_offered"}' })),
    ).toBe(true)
  })
  test('set up, started, or chosen: not fresh', () => {
    for (const state of ['in_progress', 'declined', 'done'])
      expect(
        agentNeverSetUp(agentFolder({ 'CLAUDE.md': fresh, '.agent-state/onboarding.json': JSON.stringify({ state }) })),
      ).toBe(false)
    // `later` past wave 1, with or without the progress file: someone answered
    expect(
      agentNeverSetUp(
        agentFolder({ 'CLAUDE.md': fresh, '.agent-state/onboarding.json': '{"state":"later","wave":4}' }),
      ),
    ).toBe(false)
    expect(agentNeverSetUp(agentFolder({ 'CLAUDE.md': fresh, 'wiki/_onboarding-progress.md': progressDone(1) }))).toBe(
      false,
    )
    expect(agentNeverSetUp(agentFolder({ 'CLAUDE.md': fresh, 'wiki/_onboarding-progress.md': progressDone(8) }))).toBe(
      false,
    )
  })
  test('a tuned CLAUDE.md is a set-up agent, even when the hook wrote `later` (an owner who ignored the offer)', () => {
    expect(
      agentNeverSetUp(
        agentFolder({
          'CLAUDE.md': 'You are Ada, my research partner.',
          '.agent-state/onboarding.json': '{"state":"later","wave":1}',
        }),
      ),
    ).toBe(false)
    expect(agentNeverSetUp(agentFolder({ 'CLAUDE.md': 'You are my agent.' }))).toBe(false)
  })
  test('anything it cannot vouch for is not fresh', () => {
    expect(agentNeverSetUp(undefined)).toBe(false)
    expect(agentNeverSetUp('/nonexistent/agent/folder')).toBe(false)
    expect(agentNeverSetUp(agentFolder({ '.agent-state/onboarding.json': '{"state":"not_offered"}' }))).toBe(false) // no CLAUDE.md
    expect(agentNeverSetUp(agentFolder({ 'CLAUDE.md': fresh, '.agent-state/onboarding.json': 'not json' }))).toBe(false)
    expect(
      agentNeverSetUp(agentFolder({ 'CLAUDE.md': fresh, '.agent-state/onboarding.json': '{"state":"weird"}' })),
    ).toBe(false)
    const linked = agentFolder({ 'CLAUDE.md': fresh, 'elsewhere.json': '{"state":"not_offered"}' })
    mkdirSync(join(linked, '.agent-state'))
    symlinkSync(join(linked, 'elsewhere.json'), join(linked, '.agent-state', 'onboarding.json'))
    expect(agentNeverSetUp(linked)).toBe(false)
  })
})

describe('host feature', () => {
  test('is first in the list, so an app that reads only the first 20 still gets it, with every feature on', async () => {
    const { bridgeFeatures, hostFeature } = await import('../src/handshake.ts')
    const on = { available: true }
    const all = bridgeFeatures({
      search: on,
      memory: on,
      health: on,
      speak: on,
      folders: on,
      files: on,
      agentsMd: on,
      filesPut: on,
      problems: {},
      config: { subthreadsSupported: () => true },
    })
    expect(all[0]).toBe(hostFeature())
    expect(all.slice(0, 20)).toContain(hostFeature())
    expect(hostFeature('mac')).toBe('host/mac')
    expect(hostFeature('windows')).toBe('host/windows')
    expect(hostFeature('linux')).toBe('host/linux')
  })
})
