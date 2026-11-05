// Phone recovery frames: a signed agent.recover and its result, and the request file the Mac app reads. An older relay
// (the parser from the commit before this one, via git archive) must refuse the frame, so a new app against it fails closed.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentRequestFile, isFrameFor, parseFrame } from '../src/index.ts'

const BEFORE_AGENT_RECOVER = '201be736c2658efb64040d11b3446d7650341b1b'
const here = join(import.meta.dirname, '..')
const fx = (n: string) => JSON.parse(readFileSync(join(here, 'fixtures', 'frames', `${n}.json`), 'utf8'))

function oldProtocolDir(): string | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'ar-compat-'))
    const tar = execFileSync(
      'git',
      ['-C', join(here, '..', '..'), 'archive', BEFORE_AGENT_RECOVER, 'packages/protocol', 'tsconfig.base.json'],
      { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    )
    execFileSync('tar', ['-x', '-C', dir], { input: tar })
    symlinkSync(join(here, 'node_modules'), join(dir, 'packages', 'protocol', 'node_modules'))
    return join(dir, 'packages', 'protocol')
  } catch {
    return undefined
  }
}
const oldDir = oldProtocolDir()

describe('agent.recover frames', () => {
  it('a signed restart parses; an unknown or retired action still parses (the receiver refuses it in words), junk does not', () => {
    const f = fx('agent.recover')
    expect(parseFrame(f, { direction: 'app_to_relay' }).ok).toBe(true)
    expect(parseFrame({ ...f, action: 'restore_last_good' }).ok).toBe(true) // an old cached app
    expect(parseFrame({ ...f, action: 'wipe' }).ok).toBe(true)
    expect(parseFrame({ ...f, action: '' }).ok).toBe(false)
    expect(parseFrame({ ...f, action: 'x'.repeat(500) }).ok).toBe(false)
    expect(parseFrame({ ...f, action: 7 }).ok).toBe(false)
  })

  it('an unsigned one does not parse', () => {
    const { osig: _o, ...unsigned } = fx('agent.recover')
    expect(parseFrame(unsigned).ok).toBe(false)
    const { device_id: _d, ...noDevice } = fx('agent.recover')
    expect(parseFrame(noDevice).ok).toBe(false)
  })

  it('the request goes app to bridge and the result comes back; neither goes the other way', () => {
    expect(isFrameFor('app_to_relay', { type: 'agent.recover' })).toBe(true)
    expect(isFrameFor('relay_to_bridge', { type: 'agent.recover' })).toBe(true)
    expect(isFrameFor('bridge_to_relay', { type: 'agent.recover' })).toBe(false)
    expect(isFrameFor('bridge_to_relay', { type: 'agent.recover.result' })).toBe(true)
    expect(isFrameFor('relay_to_app', { type: 'agent.recover.result' })).toBe(true)
    expect(isFrameFor('app_to_relay', { type: 'agent.recover.result' })).toBe(false)
  })

  it('the request file is exactly v, control_id, action and ts, and its only action is restart', () => {
    const ok = { v: 1, control_id: fx('agent.recover').control_id, action: 'restart', ts: 1_788_000_000_000 }
    expect(AgentRequestFile.safeParse(ok).success).toBe(true)
    expect(AgentRequestFile.safeParse({ ...ok, action: 'restore_last_good' }).success).toBe(false)
    expect(AgentRequestFile.safeParse({ ...ok, extra: 1 }).success).toBe(false)
    expect(AgentRequestFile.safeParse({ ...ok, action: 'stop' }).success).toBe(false)
  })

  it.skipIf(!oldDir)('an older relay refuses the frame, so nothing is queued (fails closed)', async () => {
    const old = await import(join(oldDir as string, 'src', 'index.ts'))
    expect(old.parseFrame(fx('agent.recover'), { direction: 'app_to_relay' }).ok).toBe(false)
    expect(old.parseFrame(fx('agent.recover.result'), { direction: 'relay_to_app' }).ok).toBe(false)
  })
})
