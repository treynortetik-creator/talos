// The Linux launch spec for restart-on-update (supervisor/launch-spec.ts), on the procedure in packages/protocol spec-hash.ts.
import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { jcs, specHash } from '@talos-app/protocol'
import { ALWAYS_DROP, INHERITED_CLAUDE_PREFIX, SESSION_MARKERS } from '../../src/claude-env.ts'
import { CHANNEL_SWITCH_ALWAYS, TERMINAL_ONLY } from '../../src/supervisor/launch-env.ts'
import {
  argvWithoutSession,
  LAUNCH_SPEC_EXCLUDED_ENV,
  launchSpec,
  launchSpecHash,
  STRIP_RULES_ENTRY,
} from '../../src/supervisor/launch-spec.ts'
import {
  SHELL_STEERING_ENV,
  STRIPPED_ENV,
  STRIPPED_PREFIXES,
  WORKER_ENV_STRIP_RULES,
  workerEnvStripRulesText,
} from '../../src/supervisor/worker-spec.ts'
import { specHashOf } from '../../src/supervisor/workers-wiring.ts'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('the launch spec (launch-spec.ts)', () => {
  it('argv keeps every flag in order and drops only the session flag with its id, in both forms', () => {
    const tail = ['--settings', '/x/settings.json', '--model=sonnet']
    expect(argvWithoutSession(['claude', ...tail, '--session-id', 'abc'])).toEqual(['claude', ...tail])
    expect(argvWithoutSession(['claude', '--resume', 'abc', ...tail])).toEqual(['claude', ...tail])
    expect(argvWithoutSession(['claude', '-r', 'abc', ...tail])).toEqual(['claude', ...tail])
    expect(argvWithoutSession(['claude', '--session-id=abc', '--resume=def', ...tail])).toEqual(['claude', ...tail])
    // a value that only looks like a session flag inside another argument stays
    expect(argvWithoutSession(['claude', '--append-system-prompt=--resume x'])).toEqual([
      'claude',
      '--append-system-prompt=--resume x',
    ])
  })
  it('env is only what the start sets or changes over the login environment; never the nonce, never what it strips', () => {
    const s = launchSpec({
      argv: ['claude'],
      baseEnv: { PATH: '/usr/bin', HOME: '/home/alex', LANG: 'C', TALOS_APP_BRIDGE: '1' },
      env: {
        PATH: '/usr/bin',
        HOME: '/home/alex',
        LANG: 'C.UTF-8',
        TALOS_APP_HOME: '/t',
        TALOS_APP_WORKER_NONCE: 'ab'.repeat(16),
      },
      files: {},
    })
    expect(s.env).toEqual({ LANG: 'C.UTF-8', TALOS_APP_HOME: '/t' })
    expect(LAUNCH_SPEC_EXCLUDED_ENV).toContain('TALOS_APP_WORKER_NONCE')
  })
  it('each file the start writes is the sha256 of its exact bytes; one not written is left out', () => {
    const s = launchSpec({
      argv: ['claude'],
      env: {},
      baseEnv: {},
      files: { 'settings.json': '{"a":1}\n', 'mcp.json': new TextEncoder().encode('{}'), 'system-prompt.md': null },
    })
    expect(s.files).toEqual({
      'settings.json': sha('{"a":1}\n'),
      'mcp.json': sha('{}'),
      [STRIP_RULES_ENTRY]: sha(workerEnvStripRulesText()),
    })
  })
  it('the hash is the protocol procedure over that object', () => {
    const i = { argv: ['claude', '--session-id', 'x'], env: { A: '1' }, baseEnv: {}, files: { 'settings.json': '{}' } }
    expect(launchSpecHash(i)).toBe(specHash(launchSpec(i)))
    expect(launchSpecHash(i)).toBe(launchSpecHash({ ...i, argv: ['claude', '--resume', 'y'] }))
    expect(launchSpecHash(i)).not.toBe(launchSpecHash({ ...i, env: { A: '2' } }))
  })
})

describe('the plan’s spec hash (workers-wiring.ts specHashOf)', () => {
  it('a launch whose spec cannot be made gives no hash (an older entry), never a refused start', () => {
    expect(
      specHashOf(() => {
        throw new Error('the talos-only mcp.json is gone')
      }),
    ).toEqual({})
    const ok = specHashOf(() => ({ argv: ['claude'], env: {}, baseEnv: {}, files: {} }))
    expect(ok.specHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('the strip rule in the spec (worker-spec.ts WORKER_ENV_STRIP_RULES)', () => {
  it('is the lists strippedKey and the marker strip use, so a new name stripped is a new spec', () => {
    const r = WORKER_ENV_STRIP_RULES
    for (const k of STRIPPED_ENV) expect(r.names).toContain(k)
    for (const p of STRIPPED_PREFIXES) expect(r.prefixes).toContain(p)
    for (const k of SHELL_STEERING_ENV) expect(r.shell_steering).toContain(k)
    for (const k of ALWAYS_DROP) expect(r.claude_markers.always_drop).toContain(k)
    for (const k of SESSION_MARKERS) expect(r.claude_markers.session_markers).toContain(k)
    for (const k of TERMINAL_ONLY) expect(r.launch_env.terminal_only).toContain(k)
    expect(r.launch_env.channel_switch_always).toEqual([...CHANNEL_SWITCH_ALWAYS])
    expect(r.claude_markers.prefix).toBe(INHERITED_CLAUDE_PREFIX)
    expect(workerEnvStripRulesText()).toBe(jcs(r))
    const spec = (stripRules?: string) =>
      launchSpecHash({ argv: ['claude'], env: {}, baseEnv: {}, files: {}, stripRules })
    const now = spec()
    expect(spec(workerEnvStripRulesText())).toBe(now) // every spec carries this build's rule
    expect(spec(jcs({ ...r, names: [...r.names, 'A_NEW_SECRET'] }))).not.toBe(now) // a release stripping a new name
  })
})

describe('the resume-turn variables never reach the hash (0.26)', () => {
  const TURN = { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1', CLAUDE_CODE_RESUME_REASON: 'user_resume' }
  const base = { argv: ['claude', '--resume', 'abc'], baseEnv: { PATH: '/usr/bin' }, files: {} }
  it('a launch with them hashes the same as one without: no restart loop', () => {
    const plain = { ...base, env: { PATH: '/usr/bin', TALOS_APP_HOME: '/t' } }
    const again = { ...base, env: { ...plain.env, ...TURN } }
    expect(launchSpec(again).env).toEqual({ TALOS_APP_HOME: '/t' })
    expect(launchSpecHash(again)).toBe(launchSpecHash(plain))
  })
  it('other CLAUDE_CODE_ variables still count', () => {
    const plain = { ...base, env: { PATH: '/usr/bin' } }
    const other = { ...base, env: { PATH: '/usr/bin', CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: '1' } }
    expect(launchSpecHash(other)).not.toBe(launchSpecHash(plain))
  })
  it('the list the Mac shares (and swift-parity checks) is still the nonce alone', () => {
    expect([...LAUNCH_SPEC_EXCLUDED_ENV]).toEqual(['TALOS_APP_WORKER_NONCE'])
  })
})
