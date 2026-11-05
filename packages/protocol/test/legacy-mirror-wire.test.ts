// R1-1: the frames this branch sends must still parse in the last build that required a top-level `mirror` (origin/main
// before the Telegram removal), run through that build's real parser from git, not a simulation. Skips without git or the commit.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentConfig, parseFrame, withLegacyMirror } from '../src/index.ts'

const BEFORE_REMOVAL = '12bf6345ba11e8455e89bf8294806b298fc17098'
const here = join(import.meta.dirname, '..')
function oldProtocolDir(): string | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'mirror-compat-'))
    const tar = execFileSync(
      'git',
      ['-C', join(here, '..', '..'), 'archive', BEFORE_REMOVAL, 'packages/protocol', 'tsconfig.base.json'],
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
const fx = (n: string) => JSON.parse(readFileSync(join(here, 'fixtures', 'frames', `${n}.json`), 'utf8'))

const without = (cfg: Record<string, unknown>) => {
  const { mirror: _m, ...rest } = cfg
  return rest
}

describe('withLegacyMirror', () => {
  it('adds mirror {telegram:off} without changing anything else, and the current parser drops it again', () => {
    const cfg = without(fx('ready').agent_config)
    const wire = withLegacyMirror(cfg)
    expect(wire.mirror).toEqual({ telegram: 'off' })
    expect(AgentConfig.parse(wire)).toEqual(AgentConfig.parse(cfg))
    expect('mirror' in AgentConfig.parse(wire)).toBe(false)
  })
  it('does not mutate its input', () => {
    const cfg = without(fx('ready').agent_config)
    withLegacyMirror(cfg)
    expect('mirror' in cfg).toBe(false)
  })
})

describe.skipIf(!oldDir)('the previous release parser (requires top-level mirror)', async () => {
  const old = oldDir ? await import(join(oldDir, 'src', 'index.ts')) : undefined
  it('rejects a ready whose config has no mirror (why the field must stay on the wire)', () => {
    const r = fx('ready')
    expect(old.parseFrame({ ...r, agent_config: without(r.agent_config) }, { direction: 'relay_to_app' }).ok).toBe(
      false,
    )
  })
  it('accepts the branch ready fixture, which carries the wire mirror, and so does the current parser', () => {
    expect(old.parseFrame(fx('ready'), { direction: 'relay_to_app' }).ok).toBe(true)
    expect(parseFrame(fx('ready'), { direction: 'relay_to_app' }).ok).toBe(true)
  })
  it('accepts the branch config.sync fixture, and rejects it without the mirror', () => {
    const c = fx('config.sync')
    expect(old.parseFrame(c, { direction: 'bridge_to_relay' }).ok).toBe(true)
    expect(old.parseFrame({ ...c, config: without(c.config) }, { direction: 'bridge_to_relay' }).ok).toBe(false)
  })
})
