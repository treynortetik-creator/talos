// Claude Code integration frames, config, errors, step-up and enrollment (docs/CLAUDE-CODE.md C2.5, C3.6, C4.4, C10
// WP-C0.5). Owner frames are strict with no defaults; controls are fresh and bound to the turn the phone showed.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AgentConfig,
  bindingMac,
  CardResolveFrame,
  CONFIG_PATCH_ALLOWLIST,
  CONSUMABLE_FRAME_TYPES,
  CodexArgError,
  CodexRunSummary,
  checkConfigPatch,
  codexExecArgv,
  codexReplyText,
  DeviceEnrolledFrame,
  DIRECTION_TYPES,
  DURABLE_FRAME_TYPES,
  deriveEnrollBind,
  ErrorCode,
  FRAME_TYPES,
  newEnrollCode,
  OWNER_FRAME_TYPES,
  PERMISSION_FEATURE,
  parseFrame,
  ReadyFrame,
  routes,
  SESSION_BRIDGE_TOOLS,
  SESSION_CONSUMABLE_FRAME_TYPES,
  SESSION_DURABLE_FRAME_TYPES,
  SESSION_FEATURE,
  SESSION_OWNER_FRAME_TYPES,
  SessionControlFrame,
  SessionSpawnFrame,
  StepupAssertion,
  StepupPurpose,
  stepupChallenge,
  verifyBinding,
  verifyEnrollment,
} from '../src/index.ts'
import { loadExample, loadFixtures, loadTestKey } from './helpers.ts'

const fixtures = loadFixtures()
const AT = '2026-10-29T12:00:00.000Z'
const env = (type: string) => ({ v: 1, type, id: '01JBF3V7Q8K2M4N6P8R0S2T4C0', ts: AT })
const owner = { device_id: 'd_aaaaaaaaaaaaaaaaaaaa', osig: 'A'.repeat(86) }

describe('error codes (C0.5)', () => {
  it('adds the session and permission codes', () => {
    for (const c of [
      'control_stale',
      'command_changed',
      'command_not_allowed',
      'args_invalid',
      'capability_missing',
      'turn_mismatch',
      'stopped_at_mac',
      'model_not_allowed',
      'model_switch_denied',
      'model_switch_pending',
      'effort_change_pending',
      'permission_closed',
      'permission_hidden',
    ])
      expect(ErrorCode.safeParse(c).success, c).toBe(true)
  })
})

describe('session frames (C2.5)', () => {
  const NEW = [
    'session.state',
    'session.inventory',
    'session.control',
    'session.control.result',
    'session.list',
    'session.spawn',
  ]
  it('are registered and have fixtures', () => {
    for (const t of NEW) {
      expect(FRAME_TYPES as readonly string[], t).toContain(t)
      expect(fixtures[t], `fixture ${t}`).toBeDefined()
    }
  })
  it('session.control and session.spawn are owner frames, app→relay→bridge', () => {
    expect([...SESSION_OWNER_FRAME_TYPES].sort()).toEqual(['session.control', 'session.spawn'])
    for (const t of SESSION_OWNER_FRAME_TYPES) {
      expect(OWNER_FRAME_TYPES as readonly string[]).toContain(t)
      expect(DIRECTION_TYPES.app_to_relay as readonly string[]).toContain(t)
      expect(DIRECTION_TYPES.relay_to_bridge as readonly string[]).toContain(t)
      expect(DIRECTION_TYPES.bridge_to_relay as readonly string[]).not.toContain(t)
    }
  })
  it('state, inventory, result and list go bridge→relay→app only', () => {
    for (const t of ['session.state', 'session.inventory', 'session.control.result', 'session.list']) {
      expect(DIRECTION_TYPES.bridge_to_relay as readonly string[], t).toContain(t)
      expect(DIRECTION_TYPES.relay_to_app as readonly string[], t).toContain(t)
      expect(DIRECTION_TYPES.app_to_relay as readonly string[], t).not.toContain(t)
    }
  })
  it('controls and spawns are consumable on their own list ("consumed" = result recorded), merged later by WP-C2/C3', () => {
    expect([...SESSION_CONSUMABLE_FRAME_TYPES].sort()).toEqual(['session.control', 'session.spawn'])
    expect([...SESSION_DURABLE_FRAME_TYPES].sort()).toEqual(
      ['session.control', 'session.control.result', 'session.spawn'].sort(),
    )
    // kept apart until the bridge implements them, so today's bridge and relay do not change behaviour
    for (const t of SESSION_CONSUMABLE_FRAME_TYPES) {
      expect(CONSUMABLE_FRAME_TYPES as readonly string[]).not.toContain(t)
      expect(DURABLE_FRAME_TYPES as readonly string[]).not.toContain(t)
    }
  })
  it('session.control: stop needs turn_id; command needs a command; others take none', () => {
    const ok = { ...env('session.control'), control_id: '01JBF3V7Q8K2M4N6P8R0S2T4C1', thread_id: 'general', ...owner }
    expect(SessionControlFrame.safeParse({ ...ok, action: 'stop', turn_id: 't1' }).success).toBe(true)
    expect(SessionControlFrame.safeParse({ ...ok, action: 'stop' }).success).toBe(false)
    expect(
      SessionControlFrame.safeParse({ ...ok, action: 'command', command: 'context', source: 'builtin' }).success,
    ).toBe(true)
    expect(SessionControlFrame.safeParse({ ...ok, action: 'command', command: 'context' }).success).toBe(false) // R3
    expect(
      SessionControlFrame.safeParse({ ...ok, action: 'command', command: 'context', source: 'user' }).success,
    ).toBe(false)
    expect(SessionControlFrame.safeParse({ ...ok, action: 'stop', turn_id: 't1', source: 'builtin' }).success).toBe(
      false,
    )
    expect(SessionControlFrame.safeParse({ ...ok, action: 'command' }).success).toBe(false)
    expect(SessionControlFrame.safeParse({ ...ok, action: 'compact', command: 'context' }).success).toBe(false)
    expect(SessionControlFrame.safeParse({ ...ok, action: 'clear', turn_id: 't1' }).success).toBe(false)
    expect(SessionControlFrame.safeParse({ ...ok, action: 'model' }).success).toBe(false) // dropped in rev 2
    expect(SessionControlFrame.safeParse({ ...ok, action: 'compact', args: 'x'.repeat(501) }).success).toBe(false)
    expect(SessionControlFrame.safeParse({ ...ok, action: 'compact', sneaky: 1 }).success).toBe(false)
  })
  it('session.spawn: kind subagent|background|cloud, prompt ≤4000', () => {
    const ok = {
      ...env('session.spawn'),
      spawn_id: '01JBF3V7Q8K2M4N6P8R0S2T4C2',
      thread_id: 'general',
      kind: 'background',
      prompt: 'Run the test suite and report',
      ...owner,
    }
    expect(SessionSpawnFrame.safeParse(ok).success).toBe(true)
    expect(SessionSpawnFrame.safeParse({ ...ok, kind: 'headless' }).success).toBe(false)
    expect(SessionSpawnFrame.safeParse({ ...ok, prompt: 'x'.repeat(4001) }).success).toBe(false)
  })
  it('session.control.result carries an optional error code and plain text ≤4000', () => {
    const r = parseFrame({
      ...env('session.control.result'),
      control_id: '01JBF3V7Q8K2M4N6P8R0S2T4C1',
      ok: false,
      code: 'model_switch_pending',
      text: 'Waiting for confirmation at the Mac.',
      at: AT,
    })
    expect(r.ok).toBe(true)
    expect(
      parseFrame({
        ...env('session.control.result'),
        control_id: '01JBF3V7Q8K2M4N6P8R0S2T4C1',
        ok: true,
        text: 'x'.repeat(4001),
        at: AT,
      }).ok,
    ).toBe(false)
  })
  it('ready carries the last session state, inventory and list', () => {
    const r = ReadyFrame.safeParse(fixtures.ready)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.session_state?.source).toBe('mod')
      expect(r.data.session_inventory?.commands.length).toBeGreaterThan(0)
      expect(r.data.session_list).toBeDefined()
    }
  })
  it('feature strings for the bridge hello', () => {
    expect(SESSION_FEATURE).toBe('session/1')
    expect(PERMISSION_FEATURE).toBe('permission/1')
  })
  it('the agent gains one bridge tool: session_report', () => {
    expect(SESSION_BRIDGE_TOOLS).toEqual(['session_report'])
  })
})

describe('step-up verified by the bridge (C3.6)', () => {
  it('purposes gain session:control, permission:allow and config:session', () => {
    for (const p of ['session:control', 'permission:allow', 'config:session'])
      expect(StepupPurpose.safeParse(p).success, p).toBe(true)
  })
  it('card.resolve may carry a raw WebAuthn assertion that is signed (not stripped)', () => {
    const base = fixtures['card.resolve'] as Record<string, unknown>
    const stepup = {
      credential_id: 'Y3JlZA',
      authenticator_data: 'YXV0aA',
      client_data_json: 'Y2RqCg',
      signature: 'c2ln',
    }
    expect(CardResolveFrame.safeParse({ ...base, stepup }).success).toBe(true)
    expect(StepupAssertion.safeParse({ ...stepup, extra: 1 }).success).toBe(false)
    expect(StepupAssertion.safeParse({ ...stepup, signature: 'not base64url!' }).success).toBe(false)
  })
  it('the challenge is sha256(payload_hash + "\\n" + frame id), base64url', async () => {
    const h = `sha256:${'a'.repeat(64)}`
    const c = stepupChallenge(h, '01JBF3V7Q8K2M4N6P8R0S2T4C3')
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(stepupChallenge(h, '01JBF3V7Q8K2M4N6P8R0S2T4C4')).not.toBe(c)
    expect(stepupChallenge(`sha256:${'b'.repeat(64)}`, '01JBF3V7Q8K2M4N6P8R0S2T4C3')).not.toBe(c)
  })
})

describe('enrollment binding covers the passkey public key (C3.6)', () => {
  const key = loadTestKey()
  const COSE = 'pQECAyYgASFYIBrjb2yvbS1rZWlRqcQ'
  it('with a credential key, the binding verifies only with that key', async () => {
    const code = newEnrollCode()
    const b = bindingMac(deriveEnrollBind(code), key.deviceId, key.publicJwk, COSE)
    expect(verifyBinding(code, key.deviceId, key.publicJwk, b, COSE)).toBe(true)
    expect(verifyBinding(code, key.deviceId, key.publicJwk, b, `${COSE}x`)).toBe(false)
    expect(verifyBinding(code, key.deviceId, key.publicJwk, b)).toBe(false) // a relay that strips the key fails
    expect(await verifyEnrollment(code, key.deviceId, key.publicJwk, b, COSE)).toBe(true)
  })
  it('without one, the old binding still verifies (devices enrolled before)', () => {
    const code = newEnrollCode()
    const b = bindingMac(deriveEnrollBind(code), key.deviceId, key.publicJwk)
    expect(verifyBinding(code, key.deviceId, key.publicJwk, b)).toBe(true)
    expect(verifyBinding(code, key.deviceId, key.publicJwk, b, COSE)).toBe(false) // a relay that adds one fails
  })
  it('device.enrolled and device/verify accept an optional credential_public_key', () => {
    const f = fixtures['device.enrolled'] as Record<string, unknown>
    expect(DeviceEnrolledFrame.safeParse({ ...f, credential_public_key: COSE }).success).toBe(true)
    const req = routes.deviceVerify.req
    expect(
      req.safeParse({
        device: { id: key.deviceId, name: 'Phone', pubkey_jwk: key.publicJwk },
        binding: 'B'.repeat(43),
        code_auth: 'x',
        credential_public_key: COSE,
      }).success,
    ).toBe(true)
  })
})

describe('config fields (C3.6, C4.4)', () => {
  it('the seed example has tool prompts as approval cards on, and the four default models', () => {
    const c = AgentConfig.parse(loadExample('default'))
    expect(c.permission_relay).toBe(true)
    expect(c.session_models).toEqual(['default', 'opus', 'sonnet', 'haiku'])
  })
  it('a saved false stays false; a config with no permission_relay key stays off (existing installs never flip)', () => {
    const base = loadExample('default') as Record<string, unknown>
    expect(AgentConfig.parse({ ...base, permission_relay: false }).permission_relay).toBe(false)
    const { permission_relay: _drop, ...noKey } = base
    expect(AgentConfig.parse(noKey).permission_relay).toBe(false)
  })
  it('session_models refuses an empty or oversized list and odd values', () => {
    const base = loadExample('default')
    expect(AgentConfig.safeParse({ ...base, session_models: [] }).success).toBe(false)
    expect(AgentConfig.safeParse({ ...base, session_models: ['opus; rm -rf'] }).success).toBe(false)
    expect(AgentConfig.safeParse({ ...base, session_models: Array(13).fill('opus') }).success).toBe(false)
    expect(AgentConfig.safeParse({ ...base, session_models: ['opus[1m]', 'claude-sonnet-5-5'] }).success).toBe(true)
  })
  it('both fields are on the config.patch allowlist; a relay change needs step-up config:session', () => {
    for (const f of ['permission_relay', 'session_models'])
      expect(CONFIG_PATCH_ALLOWLIST as readonly string[], f).toContain(f)
    expect(checkConfigPatch({ permission_relay: true })).toMatchObject({ ok: true, stepupPurpose: 'config:session' })
    expect(checkConfigPatch({ session_models: ['opus'] })).not.toHaveProperty('stepupPurpose')
  })
  it('permission_stepup and sessions_view are gone: a patch naming them is refused (config_field_forbidden path)', () => {
    for (const f of ['permission_stepup', 'sessions_view']) {
      expect(CONFIG_PATCH_ALLOWLIST as readonly string[], f).not.toContain(f)
      expect(checkConfigPatch({ [f]: 'high' })).toEqual({ ok: false, path: f })
    }
  })
  it('an old config.json that still carries the removed keys loads, and the keys are dropped', () => {
    const current = JSON.parse(
      readFileSync(new URL('../fixtures/frames/config.sync.json', import.meta.url), 'utf8'),
    ).config
    const old = { ...current, permission_stepup: 'off', sessions_view: false }
    const c = AgentConfig.parse(old)
    expect(c).not.toHaveProperty('permission_stepup')
    expect(c).not.toHaveProperty('sessions_view')
  })
})

describe('Codex hand-off (C6.2)', () => {
  const base = {
    dir: '/tmp/work',
    sandbox: 'read-only' as const,
    prompt: 'Review this diff',
    lastMessagePath: '/tmp/run/last.md',
  }
  it('builds the documented argv, with the prompt after --', () => {
    expect(codexExecArgv(base)).toEqual([
      'exec',
      '--json',
      '--ignore-user-config',
      '-C',
      '/tmp/work',
      '-s',
      'read-only',
      '-o',
      '/tmp/run/last.md',
      '--',
      'Review this diff',
    ])
  })
  it('a prompt that looks like a flag stays a prompt', () => {
    expect(codexExecArgv({ ...base, prompt: '--dangerously-bypass-approvals-and-sandbox' }).at(-1)).toBe(
      '--dangerously-bypass-approvals-and-sandbox',
    )
  })
  it('images go before --, one -i each', () => {
    const a = codexExecArgv({ ...base, images: ['/tmp/a.png', '/tmp/b.png'] })
    expect(a.slice(a.indexOf('--') - 4, a.indexOf('--'))).toEqual(['-i', '/tmp/a.png', '-i', '/tmp/b.png'])
  })
  it('refuses relative paths, danger-full-access and empty prompts', () => {
    expect(() => codexExecArgv({ ...base, dir: 'work' })).toThrow(CodexArgError)
    expect(() => codexExecArgv({ ...base, sandbox: 'danger-full-access' as never })).toThrow(CodexArgError)
    expect(() => codexExecArgv({ ...base, images: ['rel.png'] })).toThrow(CodexArgError)
    expect(() => codexExecArgv({ ...base, prompt: '  ' })).toThrow(CodexArgError)
    expect(() => codexExecArgv({ ...base, dir: '/tmp/a\nb' })).toThrow(CodexArgError)
  })
  it('the summary carries only wrapped text; replies are prefixed Codex:', () => {
    expect(
      CodexRunSummary.safeParse({ ok: true, summary_wrapped: 'x', files: [], usage: {}, thread_id: 'general' }).success,
    ).toBe(true)
    expect(
      CodexRunSummary.safeParse({
        ok: true,
        summary_wrapped: 'x',
        last_message_path: '/tmp/x',
        files: [],
        usage: {},
        thread_id: 'general',
      }).success,
    ).toBe(false)
    expect(codexReplyText('Looks fine.')).toBe('Codex: Looks fine.')
  })
})
