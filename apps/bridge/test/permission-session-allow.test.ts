// (`touch probe-N` here is only a synthetic hook input. Which commands Claude Code offers a rule for is its own choice and differs by version:
// on 2.1.332 `touch` and `rm -rf` got no rule, and `python3 -c "open('probe-N','w').close()"` did.)
// "Allow for this session" (Wave 1, item 1.10). Claude Code's PermissionRequest hook input can carry `permission_suggestions`, the rules
// it offers. When one is a plain rule that names what it allows, the card the hook raised offers a third choice. The owner's signed
// tap carries `session: true`; the hub answers `allow` + `session`; and the hook prints ITS OWN stored copy of Claude Code's rule with
// the destination forced to "session". Nothing between the hook and the phone can name a rule. The channel relay road has no field
// for it. Every new field is optional: an older app, relay or hook behaves exactly as before.
// Two halves: a real live bridge (hub socket, FakeRelay, FakeApp) with raw hub lines, and the REAL kit/hooks/permission-relay.py run as a
// child process against a stand-in hub that answers whatever the test says.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type CardT, permissionCardAllowsPrimary, sessionRulesHash } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import type { Explainer } from '../src/permission/explainer.ts'
import { eventually, type Harness, startHarness } from './helpers.ts'

setDefaultTimeout(t(30_000))

const HOOK = resolve(import.meta.dir, '..', '..', '..', 'kit', 'hooks', 'permission-relay.py')
const RULE = { toolName: 'Bash', ruleContent: 'touch probe-*' }
const OFFER = { type: 'addRules', rules: [RULE], behavior: 'allow', destination: 'localSettings' }
const SUGGEST = { rules: [{ tool: 'Bash', content: 'touch probe-*' }] }
/** What the owner's app signs: the hash of the rules the button showed. */
const HASH = sessionRulesHash(SUGGEST.rules)

let h: Harness | undefined
const cleanup: (() => void)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0)) c()
  await h?.stop()
  h = undefined
})

async function start(explainer?: Explainer) {
  h = await startHarness({
    config: ((c: Record<string, unknown>) => ({ ...c, permission_relay: true })) as never,
  })
  h.bridge.ctx.permission.setHookTimings({ graceMs: 150 })
  h.bridge.ctx.permission.setClientVersion(() => '2.1.312')
  if (explainer) h.bridge.ctx.permission.setExplainer(explainer)
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}

type Answer = Record<string, unknown> & { t: string; id: string; decision: string }
function rawCall(home: string, line: Record<string, unknown>) {
  const sock = createConnection(join(home, 'run', 'hub.sock'))
  cleanup.push(() => sock.destroy())
  sock.setEncoding('utf8')
  let buf = ''
  let settle: (a: Answer | null) => void = () => {}
  const result = new Promise<Answer | null>((r) => {
    settle = r
  })
  sock.on('data', (d: string) => {
    buf += d
    const nl = buf.indexOf('\n')
    if (nl >= 0) settle(JSON.parse(buf.slice(0, nl)) as Answer)
  })
  sock.on('close', () => settle(null))
  sock.on('error', () => settle(null))
  sock.on('connect', () => sock.write(`${JSON.stringify(line)}\n`))
  return { result }
}

const perm = (id: string, extra: Record<string, unknown> = {}) => ({
  t: 'perm',
  id,
  tool_name: 'Bash',
  tool_input: { command: 'touch probe-1', description: 'make a probe file' },
  ...extra,
})
const permissionCards = (x: Harness) =>
  x.relay.frames.filter(
    (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
  )
const hookCard = async (x: Harness): Promise<CardT> => {
  let found: CardT | undefined
  await eventually(() => {
    found = permissionCards(x)
      .map((f) => (f.frame as { card: CardT }).card)
      .find((c) => (c.payload as { request_id?: string }).request_id !== 'abcde')
    expect(found).toBeDefined()
  })
  return found as CardT
}

describe('the bridge: a hook request with a rule offer raises a card with the third choice', () => {
  test('a good offer: the card carries session_allow, the same hash as without it, and still allows Allow', async () => {
    const x = await start()
    rawCall(x.home, perm('p1', { suggest: SUGGEST }))
    const card = await hookCard(x)
    expect(card.session_allow).toEqual(SUGGEST)
    expect(permissionCardAllowsPrimary(card)).toBe(true)
    rawCall(x.home, perm('p2'))
    await eventually(() => expect(permissionCards(x)).toHaveLength(2))
    const plain = permissionCards(x)
      .map((f) => (f.frame as { card: CardT }).card)
      .find((c) => c.id !== card.id) as CardT
    expect('session_allow' in plain).toBe(false)
    // the binding is the call (its request id aside): the offer is beside it, never in it
    const { request_id: _a, ...mine } = card.payload as Record<string, unknown>
    const { request_id: _b, ...theirs } = plain.payload as Record<string, unknown>
    expect(mine).toEqual(theirs)
    expect(Object.keys(card.payload as object).sort()).toEqual([
      'description',
      'input_preview',
      'request_id',
      'tool_name',
    ])
  })

  test.each([
    ['a whole-tool rule (no content)', { rules: [{ tool: 'Bash' }] }],
    ...['*', '**', ':*', '* *', '*:*', '//**'].map(
      (c) => [`wildcards only (${c})`, { rules: [{ tool: 'Bash', content: c }] }] as const,
    ),
    ['a rule for another tool than the call', { rules: [{ tool: 'Write', content: '*' }] }],
    ['a hidden character', { rules: [{ tool: 'Bash', content: 'touch a‮b' }] }],
    ['a line break', { rules: [{ tool: 'Bash', content: 'touch a\nrm b' }] }],
    ['too many rules', { rules: [1, 2, 3, 4].map((i) => ({ tool: 'Bash', content: `touch p${i}` })) }],
    ['a rule over the length limit', { rules: [{ tool: 'Bash', content: 'a'.repeat(161) }] }],
    ['no rules', { rules: [] }],
    ['not the shape', 'allow everything'],
  ])('%s: the card has no third choice', async (_why, suggest) => {
    const x = await start()
    rawCall(x.home, perm('p1', { suggest }))
    const card = await hookCard(x)
    expect('session_allow' in card).toBe(false)
  })

  test('the owner taps "for this session": the hub answers allow with session true', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('p1', { suggest: SUGGEST }))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash, { session: true, session_hash: HASH })
    expect(await call.result).toEqual({
      t: 'perm_result',
      id: 'p1',
      decision: 'allow',
      reason: 'owner',
      session: true,
      session_hash: HASH,
    })
  })

  test('a tap with no session_hash (an older app) is a plain allow', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('p1', { suggest: SUGGEST }))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash, { session: true })
    expect(await call.result).toEqual({ t: 'perm_result', id: 'p1', decision: 'allow', reason: 'owner' })
  })

  test('a relay rewrote the button: the owner signed the hash of the words they SAW, so the answer is a plain allow', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('p1', { suggest: SUGGEST }))
    const card = await hookCard(x)
    const shown = [{ tool: 'Bash', content: 'rm probe-1' }] // what a taken-over relay put on the phone
    await x.app.resolveCard(card, 'primary', card.payload_hash, {
      session: true,
      session_hash: sessionRulesHash(shown),
    })
    expect(await call.result).toEqual({ t: 'perm_result', id: 'p1', decision: 'allow', reason: 'owner' })
  })

  test('a hash that matches nothing is a plain allow', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('p1', { suggest: SUGGEST }))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash, {
      session: true,
      session_hash: `sha256:${'0'.repeat(64)}`,
    })
    expect(await call.result).toEqual({ t: 'perm_result', id: 'p1', decision: 'allow', reason: 'owner' })
  })

  const explained = (x: Harness) =>
    eventually(() =>
      expect(
        x.relay.frames.some(
          (f) =>
            f.direction === 'from_bridge' &&
            f.frame.type === 'card.update' &&
            (f.frame as { explain?: { status?: string } }).explain?.status === 'ready',
        ),
      ).toBe(true),
    )

  test('the explainer called the call a mismatch: a session tap is a plain allow', async () => {
    const x = await start({
      explain: async () => ({ ok: true, tag: 'Deletes', mismatch: true, sentence: 'It deletes more than it says.' }),
    })
    const call = rawCall(x.home, perm('p1', { suggest: SUGGEST }))
    const card = await hookCard(x)
    await explained(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash, { session: true, session_hash: HASH })
    expect(await call.result).toEqual({ t: 'perm_result', id: 'p1', decision: 'allow', reason: 'owner' })
  })

  test('an explainer that found no mismatch changes nothing: the session tap counts', async () => {
    const x = await start({
      explain: async () => ({ ok: true, tag: 'Changes files', mismatch: false, sentence: 'Makes a probe file.' }),
    })
    const call = rawCall(x.home, perm('p1', { suggest: SUGGEST }))
    const card = await hookCard(x)
    await explained(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash, { session: true, session_hash: HASH })
    expect(await call.result).toEqual({
      t: 'perm_result',
      id: 'p1',
      decision: 'allow',
      reason: 'owner',
      session: true,
      session_hash: HASH,
    })
  })

  test('a plain Allow on the same card: the answer is exactly what it was before (no session key)', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('p1', { suggest: SUGGEST }))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    expect(await call.result).toEqual({ t: 'perm_result', id: 'p1', decision: 'allow', reason: 'owner' })
  })

  test('session on a card that offered nothing is a plain allow', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('p1'))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'primary', card.payload_hash, { session: true, session_hash: HASH })
    expect(await call.result).toEqual({ t: 'perm_result', id: 'p1', decision: 'allow', reason: 'owner' })
  })

  test('session with Deny is a plain deny', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('p1', { suggest: SUGGEST }))
    const card = await hookCard(x)
    await x.app.resolveCard(card, 'kill', card.payload_hash, { session: true, session_hash: HASH })
    expect(await call.result).toEqual({ t: 'perm_result', id: 'p1', decision: 'deny', reason: 'owner' })
  })

  test('the channel relay road has no third choice, and a session tap there sends the old verdict', async () => {
    const x = await start()
    const sent: unknown[] = []
    x.bridge.ctx.permission.setSender(async (v) => {
      sent.push(v)
    })
    await x.bridge.ctx.permission.onRequest({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run it',
      input_preview: '{"command": "ls"}',
    })
    const card = (permissionCards(x)[0] as unknown as { frame: { card: CardT } }).frame.card
    expect('session_allow' in card).toBe(false)
    await x.app.resolveCard(card, 'primary', card.payload_hash, { session: true, session_hash: HASH })
    await eventually(() => expect(sent).toEqual([{ request_id: 'abcde', behavior: 'allow' }]))
  })

  test('an older hook (no suggest at all) gets the card and the answers it always got', async () => {
    const x = await start()
    const call = rawCall(x.home, perm('p1'))
    const card = await hookCard(x)
    expect('session_allow' in card).toBe(false)
    await x.app.resolveCard(card, 'primary', card.payload_hash)
    expect(await call.result).toMatchObject({ decision: 'allow' })
  })
})

// ---- the real hook, against a stand-in hub ---------------------------------------------------------------------------------

/** A hub that records the one `perm` line it gets and answers with `reply(line)`. It lives in this process, which bridge.pid names. */
async function standInHub(reply: (line: Record<string, unknown>) => Record<string, unknown>) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'psa-')))
  mkdirSync(join(home, 'run'), { mode: 0o700 })
  writeFileSync(join(home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'x' }))
  const lines: Record<string, unknown>[] = []
  const server: Server = createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
      lines.push(line)
      sock.write(`${JSON.stringify({ t: 'perm_result', id: line.id, ...reply(line) })}\n`)
    })
    sock.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(join(home, 'run', 'hub.sock'), r))
  cleanup.push(() => {
    server.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, lines }
}

async function runHook(home: string, call: Record<string, unknown>) {
  const p = Bun.spawn(['python3', HOOK], {
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', TALOS_APP_HOME: home },
    stdin: new Blob([
      JSON.stringify({
        session_id: 'abc',
        cwd: '/home/alex',
        permission_mode: 'default',
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'touch probe-1' },
        ...call,
      }),
    ]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(p.stdout).text()
  const code = await p.exited
  return { stdout, code, decision: stdout ? JSON.parse(stdout).hookSpecificOutput.decision : null }
}

const SESSION_UPDATE = { type: 'addRules', rules: [RULE], behavior: 'allow', destination: 'session' }

describe('the real hook: what it sends and what it prints', () => {
  test('a good offer: the line carries suggest; the owner chose session; the hook prints its own rule with destination session', async () => {
    const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner', session: true, session_hash: HASH }))
    const r = await runHook(hub.home, { permission_suggestions: [OFFER] })
    expect(hub.lines[0]?.suggest).toEqual(SUGGEST)
    expect(r.decision).toEqual({ behavior: 'allow', updatedPermissions: [SESSION_UPDATE] })
    expect(r.code).toBe(0)
  })

  test.each(['userSettings', 'projectSettings', 'localSettings', 'session', undefined])(
    'the destination Claude Code offered (%s) never survives: it is "session"',
    async (destination) => {
      const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner', session: true, session_hash: HASH }))
      const offer = { ...OFFER, ...(destination ? { destination } : {}) }
      if (!destination) delete (offer as { destination?: string }).destination
      const r = await runHook(hub.home, { permission_suggestions: [offer] })
      expect(r.decision.updatedPermissions).toEqual([SESSION_UPDATE])
    },
  )

  test('the answer has no session: a plain allow, exactly as before', async () => {
    const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner' }))
    const r = await runHook(hub.home, { permission_suggestions: [OFFER] })
    expect(r.decision).toEqual({ behavior: 'allow' })
  })

  test('no suggestions: no suggest on the line, a plain allow even if the hub says session', async () => {
    const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner', session: true, session_hash: HASH }))
    const r = await runHook(hub.home, {})
    expect('suggest' in (hub.lines[0] ?? {})).toBe(false)
    expect(r.decision).toEqual({ behavior: 'allow' })
  })

  test.each([
    ['a setMode suggestion', [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]],
    ['an addDirectories suggestion', [{ type: 'addDirectories', directories: ['/etc'], destination: 'session' }]],
    ['a whole-tool rule (no ruleContent)', [{ ...OFFER, rules: [{ toolName: 'Bash' }] }]],
    ...['*', '**', ':*', '* *', '*:*', '//**', ' * '].map(
      (c) => [`wildcards only (${c})`, [{ ...OFFER, rules: [{ toolName: 'Bash', ruleContent: c }] }]] as const,
    ),
    ['an empty ruleContent', [{ ...OFFER, rules: [{ toolName: 'Bash', ruleContent: '' }] }]],
    ['a deny rule', [{ ...OFFER, behavior: 'deny' }]],
    ['an ask rule', [{ ...OFFER, behavior: 'ask' }]],
    ['a rule for another tool', [{ ...OFFER, rules: [{ toolName: 'Write', ruleContent: '*' }] }]],
    ['a rule over the length limit', [{ ...OFFER, rules: [{ toolName: 'Bash', ruleContent: 'a'.repeat(161) }] }]],
    ['a rule with a bidi character', [{ ...OFFER, rules: [{ toolName: 'Bash', ruleContent: 'ls ‮*' }] }]],
    ['a rule with a line break', [{ ...OFFER, rules: [{ toolName: 'Bash', ruleContent: 'ls\nrm *' }] }]],
    ['a rule with a non-breaking space', [{ ...OFFER, rules: [{ toolName: 'Bash', ruleContent: 'ls *' }] }]],
    [
      'more than 3 rules',
      [{ ...OFFER, rules: [1, 2, 3, 4].map((i) => ({ toolName: 'Bash', ruleContent: `ls ${i}*` })) }],
    ],
    ['an unknown key on a rule', [{ ...OFFER, rules: [{ ...RULE, extra: 'x' }] }]],
    ['one good and one bad rule in the same offer', [{ ...OFFER, rules: [RULE, { toolName: 'Bash' }] }]],
    ['not a list', 'allow'],
    ['junk entries', [null, 7, 'x', []]],
  ])('%s: nothing is offered, and a hub that says session still gets a plain allow', async (_why, suggestions) => {
    const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner', session: true, session_hash: HASH }))
    const r = await runHook(hub.home, { permission_suggestions: suggestions })
    expect('suggest' in (hub.lines[0] ?? {})).toBe(false)
    expect(r.decision).toEqual({ behavior: 'allow' })
  })

  test('only the rules Claude Code offered are echoed: a setMode beside a good rule is dropped, not sent', async () => {
    const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner', session: true, session_hash: HASH }))
    const r = await runHook(hub.home, {
      permission_suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }, OFFER],
    })
    expect(hub.lines[0]?.suggest).toEqual(SUGGEST)
    expect(r.decision.updatedPermissions).toEqual([SESSION_UPDATE])
  })

  test('the hub cannot name a rule: made-up fields in its answer are ignored', async () => {
    const hub = await standInHub(() => ({
      decision: 'allow',
      reason: 'owner',
      session: true,
      session_hash: HASH,
      suggest: { rules: [{ tool: 'Bash', content: '*' }] },
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' },
      ],
      rules: [{ toolName: 'Bash' }],
      destination: 'userSettings',
    }))
    const r = await runHook(hub.home, { permission_suggestions: [OFFER] })
    expect(r.decision).toEqual({ behavior: 'allow', updatedPermissions: [SESSION_UPDATE] })
  })

  test('the owner signed no hash (an older answer): a plain allow', async () => {
    const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner', session: true }))
    const r = await runHook(hub.home, { permission_suggestions: [OFFER] })
    expect(r.decision).toEqual({ behavior: 'allow' })
  })

  test("the signed hash is not the hash of the hook's own rules: a plain allow, never a rule", async () => {
    const other = sessionRulesHash([{ tool: 'Bash', content: 'rm probe-1' }])
    for (const bad of [other, 'sha256:', 7, null, HASH.toUpperCase()]) {
      const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner', session: true, session_hash: bad }))
      const r = await runHook(hub.home, { permission_suggestions: [OFFER] })
      expect(r.decision).toEqual({ behavior: 'allow' })
    }
  })

  test('a wildcard-only rule for WebFetch (domain:*) is not offered either', async () => {
    const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner', session: true, session_hash: HASH }))
    const offer = { ...OFFER, rules: [{ toolName: 'WebFetch', ruleContent: 'domain:*' }] }
    const r = await runHook(hub.home, {
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
      permission_suggestions: [offer],
    })
    expect('suggest' in (hub.lines[0] ?? {})).toBe(false)
    expect(r.decision).toEqual({ behavior: 'allow' })
  })

  test('the Python hash twin agrees with the protocol package, byte for byte', () => {
    const cases = [
      [{ tool: 'Bash', content: 'touch probe-*' }],
      [
        { tool: 'Bash', content: 'ls *' },
        { tool: 'Bash', content: 'cat *' },
      ],
      [{ tool: 'Bash', content: 'echo "a\\b" é 日本 \u{1F600}*' }],
      [{ tool: 'WebFetch', content: 'domain:example.com' }],
    ]
    const script =
      'import json,sys\nsys.path.insert(0, sys.argv[1])\nimport _talos_common as C\n' +
      'print(json.dumps([C.session_rules_hash(rules) for rules in json.load(sys.stdin)]))'
    const py = Bun.spawnSync(['python3', '-c', script, resolve(HOOK, '..')], {
      stdin: new Blob([JSON.stringify(cases)]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(py.stderr.toString()).toBe('')
    expect(JSON.parse(py.stdout.toString())).toEqual(cases.map((c) => sessionRulesHash(c)))
  })

  test.each(['yes', 1, 'true', null])('a session value that is not exactly true (%p) is a plain allow', async (v) => {
    const hub = await standInHub(() => ({ decision: 'allow', reason: 'owner', session: v }))
    const r = await runHook(hub.home, { permission_suggestions: [OFFER] })
    expect(r.decision).toEqual({ behavior: 'allow' })
  })

  test('a deny never carries a rule, even when the hub says session', async () => {
    const hub = await standInHub(() => ({ decision: 'deny', reason: 'owner', session: true, session_hash: HASH }))
    const r = await runHook(hub.home, { permission_suggestions: [OFFER] })
    expect(r.decision.behavior).toBe('deny')
    expect('updatedPermissions' in r.decision).toBe(false)
  })

  test('no decision (none): no output at all', async () => {
    const hub = await standInHub(() => ({ decision: 'none', reason: 'timeout', session: true, session_hash: HASH }))
    const r = await runHook(hub.home, { permission_suggestions: [OFFER] })
    expect(r).toMatchObject({ stdout: '', code: 0 })
  })

  test('end to end with the real bridge: the owner taps "for this session" and the hook prints the session rule', async () => {
    const x = await start()
    const p = Bun.spawn(['python3', HOOK], {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', TALOS_APP_HOME: x.home },
      stdin: new Blob([
        JSON.stringify({
          session_id: 'abc',
          cwd: '/home/alex',
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'touch probe-1', description: 'make a probe file' },
          permission_suggestions: [OFFER],
        }),
      ]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const card = await hookCard(x)
    expect(card.session_allow).toEqual(SUGGEST)
    await x.app.resolveCard(card, 'primary', card.payload_hash, { session: true, session_hash: HASH })
    const out = JSON.parse(await new Response(p.stdout).text())
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: [SESSION_UPDATE] },
      },
    })
    expect(await p.exited).toBe(0)
  })
})
