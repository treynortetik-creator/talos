import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { newUlid } from '@talos-app/protocol'
import {
  CAPTURE_TOTAL_MAX,
  normaliseToolResponse,
  pruneCaptures,
  readCapture,
  writeCapture,
} from '../../src/apps/captures.ts'
import { matcherFor, toolPrefixFor } from '../../src/apps/catalog.ts'
import { mainHook } from '../../src/apps/hook-cli.ts'
import { HOOK_MARKER, installHookSettings, mergeHookSettings, parseHookArgv, runHook } from '../../src/apps/hooks.ts'
import { claim, listClaimed, listPending, writePending } from '../../src/apps/pending.ts'
import { approvedFixture, tmp } from './helpers.ts'

const BRIDGE_DIR = resolve(import.meta.dir, '..', '..')
const NOW = Date.parse('2026-10-30T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
/** Real subprocesses read the real clock, so their fixtures must be current. */
const realTimes = () => ({ created_at: iso(Date.now()), expires_at: iso(Date.now() + 120_000) })

async function setup() {
  const home = tmp()
  const fx = await approvedFixture(home)
  const deps = (now = NOW, live = true) => ({ paths: fx.P, now: () => now, live })
  const pend = (over: Record<string, unknown> = {}) => {
    const r = {
      request_id: `ar_${newUlid()}`,
      view_id: `av_${newUlid()}`,
      server: 'probe',
      server_source: 'local',
      tool: 'set_note',
      arguments: { id: 'n1', body: 'hi' },
      state: 'authorised' as const,
      created_at: iso(NOW),
      expires_at: iso(NOW + 120_000),
      ...over,
    }
    writePending(fx.P, r as never)
    return r
  }
  const input = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      session_id: 'sess_1',
      transcript_path: join(home, 'proj', 'sess_1.jsonl'),
      tool_name: 'mcp__probe__set_note',
      tool_input: { id: 'n1', body: 'hi' },
      tool_use_id: 'toolu_01',
      mcp_server: { name: 'probe', source: 'local' },
      ...over,
    })
  return { home, fx, deps, pend, input }
}
const out = (o: unknown) => JSON.parse(JSON.stringify(o ?? null))
const decision = (o: unknown) => out(o)?.hookSpecificOutput?.permissionDecision

describe('hook argv', () => {
  it('reads the event from the argument after `hook` (gate G6)', () => {
    expect(parseHookArgv(['hook', 'pre-tool-use'])).toBe('pre-tool-use')
    expect(parseHookArgv(['src/cli.ts', 'hook', 'post-tool-use'])).toBe('post-tool-use')
    expect(parseHookArgv(['hook', 'post-tool-use-failure'])).toBe('post-tool-use-failure')
    expect(parseHookArgv(['hook'])).toBeUndefined()
    expect(parseHookArgv(['hook', 'pre-tool-use-x'])).toBeUndefined()
    expect(parseHookArgv(['pre-tool-use'])).toBeUndefined()
  })
})

describe('TALOS_APP_BRIDGE gate', () => {
  it('not live: no output from any event, even on garbage', async () => {
    const s = await setup()
    s.pend()
    for (const ev of ['pre-tool-use', 'post-tool-use', 'post-tool-use-failure'] as const) {
      expect(runHook(ev, s.input(), s.deps(NOW, false))).toBeUndefined()
      expect(runHook(ev, 'garbage', s.deps(NOW, false))).toBeUndefined()
    }
    expect(listPending(s.fx.P, NOW).requests.length).toBe(1) // nothing claimed
  })
})

describe('pre-tool-use fails closed', () => {
  it('garbage or oversize stdin denies; so does a missing tool_use_id or one with ../', async () => {
    const s = await setup()
    expect(decision(runHook('pre-tool-use', 'garbage', s.deps()))).toBe('deny')
    expect(decision(runHook('pre-tool-use', '[]', s.deps()))).toBe('deny')
    expect(decision(runHook('pre-tool-use', s.input({ tool_use_id: '../../etc/passwd' }), s.deps()))).toBe('deny')
    expect(decision(runHook('pre-tool-use', s.input({ tool_use_id: undefined }), s.deps()))).toBe('deny')
    expect(decision(runHook('pre-tool-use', s.input({ tool_use_id: 'a/b' }), s.deps()))).toBe('deny')
    expect(out(runHook('pre-tool-use', 'garbage', s.deps())).hookSpecificOutput.permissionDecisionReason).toBe(
      'Talos app gate error; tool blocked. Tell the owner.',
    )
  })
  it('an unreadable or corrupt catalog denies', async () => {
    const s = await setup()
    writeFileSync(s.fx.P.catalog, '{"rev":')
    expect(decision(runHook('pre-tool-use', s.input(), s.deps()))).toBe('deny')
    writeFileSync(s.fx.P.catalog, '{"rev":1}')
    expect(decision(runHook('pre-tool-use', s.input(), s.deps()))).toBe('deny')
    s.pend()
    writeFileSync(s.fx.P.catalog, '{}')
    chmodSync(s.fx.P.catalog, 0o000)
    try {
      expect(decision(runHook('pre-tool-use', s.input(), s.deps()))).toBe('deny')
    } finally {
      chmodSync(s.fx.P.catalog, 0o600)
    }
  })
  it('an exception inside the gate (the claim directory is not a directory) denies instead of crashing or passing', async () => {
    const s = await setup()
    s.pend()
    await Bun.$`rm -rf ${s.fx.P.claimed}`
    writeFileSync(s.fx.P.claimed, 'a file where the claim directory should be')
    const o = out(runHook('pre-tool-use', s.input(), s.deps()))
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(o.hookSpecificOutput.permissionDecisionReason).toBe('Talos app gate error; tool blocked. Tell the owner.')
  })
  it('a missing catalog means nothing is catalogued: pass through', async () => {
    const s = await setup()
    await Bun.$`rm ${s.fx.P.catalog}`
    expect(runHook('pre-tool-use', s.input(), s.deps())).toBeUndefined()
  })
  it('a recent corrupt pending file denies; an old one is ignored (the bridge prunes it)', async () => {
    const s = await setup()
    const f = join(s.fx.P.pending, `ar_${newUlid()}.json`)
    writeFileSync(f, '{"request_id": 1')
    utimesSync(f, NOW / 1000, NOW / 1000)
    expect(decision(runHook('pre-tool-use', s.input(), s.deps()))).toBe('deny')
    const old = (NOW - 11 * 60_000) / 1000
    utimesSync(f, old, old)
    expect(runHook('pre-tool-use', s.input(), s.deps())).toBeUndefined()
  })
  it('a pending file with an extra field does not parse (strict) and counts as corrupt', async () => {
    const s = await setup()
    const r = s.pend()
    writeFileSync(join(s.fx.P.pending, `${r.request_id}.json`), JSON.stringify({ ...r, extra: 1 }))
    expect(decision(runHook('pre-tool-use', s.input(), s.deps()))).toBe('deny')
  })
})

describe('the claim (M5.2)', () => {
  it('claims on JCS-equal input and substitutes the exact approved arguments', async () => {
    const s = await setup()
    const r = s.pend({ arguments: { n: 1, id: 'a' } })
    const o = runHook('pre-tool-use', s.input({ tool_input: { id: 'a', n: 1.0 } }), s.deps())
    expect(out(o)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { n: 1, id: 'a' } },
    })
    const c = listClaimed(s.fx.P)
    expect(c.length).toBe(1)
    expect(c[0]?.linked).toBe(true)
    expect((c[0]?.req as { tool_use_id?: string } | undefined)?.tool_use_id).toBe('toolu_01')
    expect(listPending(s.fx.P, NOW).requests.length).toBe(0)
    expect(r.request_id).toBe(c[0]?.req.request_id as string)
  })
  it('claims on an empty input too, and puts the approved arguments in', async () => {
    const s = await setup()
    s.pend()
    const o = runHook('pre-tool-use', s.input({ tool_input: {} }), s.deps())
    expect(out(o).hookSpecificOutput.updatedInput).toEqual({ id: 'n1', body: 'hi' })
  })
  it("a different value passes through untouched: an app can't hijack or block the owner's own call", async () => {
    const s = await setup()
    s.pend()
    expect(runHook('pre-tool-use', s.input({ tool_input: { id: 'n1', body: 'OTHER' } }), s.deps())).toBeUndefined()
    expect(listPending(s.fx.P, NOW).requests.length).toBe(1) // still waiting
    expect(
      runHook(
        'pre-tool-use',
        s.input({ tool_name: 'mcp__probe__read_note', tool_input: { id: 'n1', body: 'hi' } }),
        s.deps(),
      ),
    ).toBeUndefined()
  })
  it('an awaiting_card request denies a call with its arguments, naming the request', async () => {
    const s = await setup()
    const r = s.pend({ state: 'awaiting_card', expires_at: iso(NOW + 700_000) })
    const o = out(runHook('pre-tool-use', s.input(), s.deps()))
    expect(o.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(o.hookSpecificOutput.permissionDecisionReason).toBe(
      `Waiting for the owner to approve app request ${r.request_id}; don't call set_note with these arguments until a card_action arrives.`,
    )
    // and not with other arguments
    expect(runHook('pre-tool-use', s.input({ tool_input: { id: 'zzz' } }), s.deps())).toBeUndefined()
  })
  it('the expired tombstone denies for 10 minutes, then the call passes', async () => {
    const s = await setup()
    const r = s.pend({ state: 'expired', expires_at: iso(NOW + 10 * 60_000) })
    expect(
      out(runHook('pre-tool-use', s.input(), s.deps(NOW + 9 * 60_000))).hookSpecificOutput.permissionDecisionReason,
    ).toBe(`App request ${r.request_id} expired; nothing was approved. Ask the owner.`)
    expect(runHook('pre-tool-use', s.input(), s.deps(NOW + 10 * 60_000 + 1))).toBeUndefined()
  })
  it('an authorised request past its deadline that the bridge has not swept yet is a tombstone, never claimable', async () => {
    const s = await setup()
    s.pend({ expires_at: iso(NOW + 120_000) })
    const late = NOW + 121_000
    expect(decision(runHook('pre-tool-use', s.input(), s.deps(late)))).toBe('deny')
    expect(listClaimed(s.fx.P).length).toBe(0)
    expect(runHook('pre-tool-use', s.input(), s.deps(NOW + 120_000 + 10 * 60_000 + 1))).toBeUndefined()
  })
  it('two requests for the same call: the oldest is claimed first', async () => {
    const s = await setup()
    const older = s.pend({ created_at: iso(NOW - 5000) })
    s.pend({ created_at: iso(NOW) })
    runHook('pre-tool-use', s.input(), s.deps())
    expect(listClaimed(s.fx.P)[0]?.req.request_id).toBe(older.request_id)
  })
  it('the claim is single-winner when several processes race for one request (real concurrent hook processes)', async () => {
    const s = await setup()
    s.pend(realTimes())
    const cmds = Array.from({ length: 6 }, (_, i) =>
      Bun.spawn(['bun', 'run', '--cwd', BRIDGE_DIR, '--silent', 'cli', 'hook', 'pre-tool-use'], {
        stdin: new Blob([s.input({ tool_use_id: `toolu_race_${i}` })]),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { PATH: process.env.PATH ?? '', HOME: tmp('empty-home-'), TALOS_APP_BRIDGE: '1', TALOS_APP_HOME: s.home },
      }),
    )
    const outs = await Promise.all(
      cmds.map(async (c) => ({ text: await new Response(c.stdout as ReadableStream).text(), code: await c.exited })),
    )
    expect(outs.every((o) => o.code === 0)).toBe(true)
    const winners = outs.filter((o) => o.text.includes('"allow"'))
    expect(winners.length).toBe(1)
    expect(listClaimed(s.fx.P).length).toBe(1)
  })
  it('claim() itself loses cleanly when the file is already gone', async () => {
    const s = await setup()
    const r = s.pend()
    expect(claim(s.fx.P, r as never, 'toolu_a', iso(NOW))).toBe(true)
    expect(claim(s.fx.P, r as never, 'toolu_b', iso(NOW))).toBe(false)
  })
})

describe('matching servers by name AND source', () => {
  it('a same-named server from another source does not match; the right one does', async () => {
    const s = await setup()
    s.pend()
    expect(
      runHook('pre-tool-use', s.input({ mcp_server: { name: 'probe', source: 'user' } }), s.deps()),
    ).toBeUndefined()
    expect(decision(runHook('pre-tool-use', s.input(), s.deps()))).toBe('allow')
  })
  it('a server block with a name but no source still finds the one catalogued server that fits (and claims)', async () => {
    const s = await setup()
    s.pend()
    expect(decision(runHook('pre-tool-use', s.input({ mcp_server: { name: 'probe' } }), s.deps()))).toBe('allow')
  })
  it('plugin server names resolve through the Claude Code tool prefix', async () => {
    const home = tmp()
    const fx = await approvedFixture(home, { server: 'plugin:pl:plugsrv', source: 'plugin' })
    writePending(fx.P, {
      request_id: `ar_${newUlid()}`,
      view_id: `av_${newUlid()}`,
      server: 'plugin:pl:plugsrv',
      server_source: 'plugin',
      tool: 'set_note',
      arguments: { id: 'n1' },
      state: 'authorised',
      created_at: iso(NOW),
      expires_at: iso(NOW + 120_000),
    })
    const stdin = JSON.stringify({
      session_id: 's',
      transcript_path: '/x/s.jsonl',
      tool_name: 'mcp__plugin_pl_plugsrv__set_note',
      tool_input: { id: 'n1' },
      tool_use_id: 'toolu_p',
      mcp_server: { name: 'plugin:pl:plugsrv', source: 'plugin' },
    })
    expect(decision(runHook('pre-tool-use', stdin, { paths: fx.P, now: () => NOW, live: true }))).toBe('allow')
    expect(matcherFor(toolPrefixFor('plugin:pl:plugsrv'))).toBe('^mcp__plugin_pl_plugsrv__.*')
  })
  it('without a server block the prefix identifies the server only when exactly one fits', async () => {
    const s = await setup()
    s.pend()
    expect(decision(runHook('pre-tool-use', s.input({ mcp_server: undefined }), s.deps()))).toBe('allow')
  })
})

describe('uncertain state never allows (the gate)', () => {
  it('two catalogued servers with one tool prefix: refused with or without a server block; post hooks stay silent', async () => {
    const s = await setup()
    const cat = JSON.parse(readFileSync(s.fx.P.catalog, 'utf8'))
    const twin = structuredClone(cat.servers[0])
    twin.server = 'pro.be' // maps to a different prefix, so make it collide by hand
    twin.tool_prefix = cat.servers[0].tool_prefix
    cat.servers.push(twin)
    writeFileSync(s.fx.P.catalog, JSON.stringify(cat))
    s.pend()
    expect(decision(runHook('pre-tool-use', s.input({ mcp_server: undefined }), s.deps()))).toBe('deny')
    expect(decision(runHook('pre-tool-use', s.input({ mcp_server: { name: 'probe' } }), s.deps()))).toBe('allow') // the name narrows it to one
    expect(runHook('post-tool-use', s.input({ mcp_server: undefined, tool_response: '{}' }), s.deps())).toBeUndefined()
  })
})

describe('post hooks', () => {
  const claimed = async (s: Awaited<ReturnType<typeof setup>>, toolUseId = 'toolu_01') => {
    const r = s.pend()
    claim(s.fx.P, r as never, toolUseId, iso(NOW))
    return r
  }
  it('a claimed request: capture written and the model sees only the handle (exact text)', async () => {
    const s = await setup()
    await claimed(s)
    const o = out(
      runHook('post-tool-use', s.input({ tool_response: '{"ok":true,"secret":"result-body-xyz"}' }), s.deps()),
    )
    const text = o.hookSpecificOutput.updatedToolOutput as string
    expect(o.hookSpecificOutput.hookEventName).toBe('PostToolUse')
    expect(text).toBe(
      'Result handed to app "Probe view" (142 bytes, capture toolu_01). Nothing else to do. If you made this call for the owner, make it again.',
    )
    expect(text).not.toContain('result-body-xyz')
    const cap = readCapture(s.fx.P, 'toolu_01', NOW)
    expect(cap?.ok).toBe(true)
    expect(cap?.result?.structuredContent).toEqual({ ok: true, secret: 'result-body-xyz' })
    expect(cap?.tool_input).toEqual({ id: 'n1', body: 'hi' })
  })
  it('the failure event also hands off, with ok:false', async () => {
    const s = await setup()
    await claimed(s)
    const o = out(runHook('post-tool-use-failure', s.input({ error: 'Error: boom' }), s.deps()))
    expect(o.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure')
    expect(readCapture(s.fx.P, 'toolu_01', NOW)?.ok).toBe(false)
  })
  it('a UI tool the agent called for the owner: capture plus the app_show nudge', async () => {
    const s = await setup()
    const o = out(
      runHook(
        'post-tool-use',
        s.input({
          tool_name: 'mcp__probe__show_widget',
          tool_input: {},
          tool_use_id: 'toolu_ui',
          tool_response: '{"tool":"show_widget","ok":true}',
        }),
        s.deps(),
      ),
    )
    expect(o.hookSpecificOutput.additionalContext).toBe(
      'Talos: this result has an app view ("Probe view"). To show it in the thread, call app_show with capture_id "toolu_ui".',
    )
    expect(readCapture(s.fx.P, 'toolu_ui', NOW)?.result?.content[0]?.text).toBe('{"tool":"show_widget","ok":true}')
  })
  it('a failed UI call nobody claimed writes nothing and says nothing', async () => {
    const s = await setup()
    expect(
      runHook(
        'post-tool-use-failure',
        s.input({ tool_name: 'mcp__probe__show_widget', tool_use_id: 'toolu_f', error: 'Error' }),
        s.deps(),
      ),
    ).toBeUndefined()
    expect(readCapture(s.fx.P, 'toolu_f', NOW)).toBeUndefined()
  })
  it('a tool with no view and no claim: no output, nothing written', async () => {
    const s = await setup()
    expect(
      runHook(
        'post-tool-use',
        s.input({ tool_name: 'mcp__probe__model_only', tool_use_id: 'toolu_m', tool_response: 'x' }),
        s.deps(),
      ),
    ).toBeUndefined()
    expect(existsSync(join(s.fx.P.captures, 'toolu_m.json'))).toBe(false)
  })
  it('garbage stdin: the post hooks exit 0 with no output (they fail open)', async () => {
    const s = await setup()
    for (const ev of ['post-tool-use', 'post-tool-use-failure'] as const) {
      expect(runHook(ev, 'garbage', s.deps())).toBeUndefined()
      expect(runHook(ev, s.input({ tool_use_id: '../x' }), s.deps())).toBeUndefined()
    }
    writeFileSync(s.fx.P.catalog, '{')
    expect(runHook('post-tool-use', s.input(), s.deps())).toBeUndefined()
  })
})

describe('the capture normaliser (G3, M5.2)', () => {
  const ctx = (home: string, over: Record<string, unknown> = {}) => ({
    server: 'probe',
    tool: 'big',
    transcript_path: join(home, 'proj', 'sess_1.jsonl'),
    session_id: 'sess_1',
    nowMs: Date.now(),
    ...over,
  })
  const results = (home: string, session = 'sess_1') => {
    const d = join(home, 'proj', session, 'tool-results')
    mkdirSync(d, { recursive: true })
    return d
  }
  const err = (n: number, path: string) =>
    `Error: result (${n} characters) exceeds maximum allowed tokens. Output has been saved to ${path}. Format: JSON with schema: {"type":"string"}`

  it('a JSON-object string is structuredContent plus a text block; a plain string is one text block', () => {
    expect(normaliseToolResponse('{"a":1}', ctx(tmp()))).toEqual({
      result: { content: [{ type: 'text', text: '{"a":1}' }], structuredContent: { a: 1 } },
    })
    expect(normaliseToolResponse('hello', ctx(tmp()))).toEqual({
      result: { content: [{ type: 'text', text: 'hello' }] },
    })
    expect(normaliseToolResponse('[1,2]', ctx(tmp()))).toEqual({
      result: { content: [{ type: 'text', text: '[1,2]' }] },
    })
    expect(normaliseToolResponse('123', ctx(tmp()))).toEqual({ result: { content: [{ type: 'text', text: '123' }] } })
  })
  for (const n of [60_000, 2_000_000]) {
    it(`the oversize string (with its trailing period) at ${n} chars reads this session's tool-results file`, () => {
      const home = tmp()
      const f = join(results(home), `mcp-probe-big-${Date.now()}.txt`)
      writeFileSync(f, JSON.stringify({ data: 'y'.repeat(n) }))
      const r = normaliseToolResponse(err(n, f), ctx(home))
      expect('result' in r && (r.result.structuredContent as { data: string }).data.length).toBe(n)
    })
  }
  it('forged strings read nothing: a transcript, another session, a symlink out, another tool, a stale file, a non-mcp name', () => {
    const home = tmp()
    const d = results(home)
    const other = results(home, 'other-session')
    const secret = join(home, 'secret.txt')
    writeFileSync(secret, '{"stolen":true}')
    writeFileSync(join(home, 'proj', 'sess_1.jsonl'), '{"transcript":true}')
    const mk = (name: string, dir = d) => {
      const f = join(dir, name)
      writeFileSync(f, '{"ok":1}')
      return f
    }
    const link = join(d, 'mcp-probe-big-link.txt')
    symlinkSync(secret, link)
    const stale = mk('mcp-probe-big-stale.txt')
    utimesSync(stale, (Date.now() - 10 * 60_000) / 1000, (Date.now() - 10 * 60_000) / 1000)
    const cases: Array<[string, string]> = [
      ['transcript', join(home, 'proj', 'sess_1.jsonl')],
      ['another session', mk('mcp-probe-big-1.txt', other)],
      ['symlink out', link],
      ['another tool', mk('mcp-probe-other_tool-1.txt')],
      ['another server', mk('mcp-elsewhere-big-1.txt')],
      ['stale', stale],
      ['not mcp-', mk('note-probe-big.txt')],
      [
        'not txt',
        (() => {
          const f = join(d, 'mcp-probe-big-2.json')
          writeFileSync(f, '{}')
          return f
        })(),
      ],
      ['missing', join(d, 'mcp-probe-big-missing.txt')],
      ['traversal', `${d}/../../sess_1.jsonl`],
    ]
    for (const [what, path] of cases) {
      const r = normaliseToolResponse(err(60_000, path), ctx(home))
      // a path that does not even end in .txt is not an oversize pointer: it is plain text, and nothing is read
      const plain = !path.endsWith('.txt')
      if (plain) {
        expect({ what, read: JSON.stringify(r).includes('transcript":true') }).toEqual({ what, read: false })
        expect('result' in r).toBe(true)
      } else expect({ what, r }).toEqual({ what, r: { too_large: true } })
    }
    // a .txt path that climbs out of tool-results/ reads nothing either
    writeFileSync(join(home, 'proj', 'sess_1.txt'), '{"transcript":true}')
    expect(normaliseToolResponse(err(1, `${d}/../../sess_1.txt`), ctx(home))).toEqual({ too_large: true })
    // and a file over 8 MiB
    const huge = join(d, 'mcp-probe-big-huge.txt')
    writeFileSync(huge, 'z'.repeat(8 * 1024 * 1024 + 1))
    expect(normaliseToolResponse(err(9_000_000, huge), ctx(home))).toEqual({ too_large: true })
  })
  it('a different session id or missing transcript path in the hook input reads nothing', () => {
    const home = tmp()
    const f = join(results(home), 'mcp-probe-big-1.txt')
    writeFileSync(f, '{"a":1}')
    expect(normaliseToolResponse(err(1, f), ctx(home, { session_id: 'sess_other' }))).toEqual({ too_large: true })
    expect(normaliseToolResponse(err(1, f), ctx(home, { transcript_path: undefined }))).toEqual({ too_large: true })
    expect(normaliseToolResponse(err(1, f), ctx(home, { session_id: '../x' }))).toEqual({ too_large: true })
  })
  it('an almost-matching message is plain text, not an oversize read', () => {
    const r = normaliseToolResponse(
      'note: Error: result (5 characters) exceeds maximum allowed tokens. Output has been saved to /etc/passwd.txt.',
      ctx(tmp()),
    )
    expect('result' in r).toBe(true)
  })
  it('the defensive branches: {content, structuredContent} as is, a block array as content, _meta host keys stripped', () => {
    expect(
      normaliseToolResponse(
        {
          content: [{ type: 'text', text: 'x' }],
          structuredContent: { a: 1 },
          _meta: { 'com.anthropic/x': 1, keep: 2 },
        },
        ctx(tmp()),
      ),
    ).toEqual({
      result: { content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 }, _meta: { keep: 2 } },
    })
    expect(normaliseToolResponse([{ type: 'text', text: 'y' }], ctx(tmp()))).toEqual({
      result: { content: [{ type: 'text', text: 'y' }] },
    })
    expect(normaliseToolResponse(42, ctx(tmp()))).toEqual({ too_large: true })
    expect(normaliseToolResponse(null, ctx(tmp()))).toEqual({ too_large: true })
  })
})

describe('captures on disk', () => {
  it('written 0600 in a 0700 dir; expire after 15 minutes; pruned by TTL and by the 64 MiB cap', async () => {
    const s = await setup()
    writeCapture(s.fx.P, {
      capture_id: 'c1',
      server: 'probe',
      source: 'local',
      tool: 't',
      tool_input: {},
      ok: true,
      at: iso(NOW),
    })
    expect(statSync(join(s.fx.P.captures, 'c1.json')).mode & 0o777).toBe(0o600)
    expect(statSync(s.fx.P.captures).mode & 0o777).toBe(0o700)
    expect(readCapture(s.fx.P, 'c1', NOW + 14 * 60_000)?.capture_id).toBe('c1')
    expect(readCapture(s.fx.P, 'c1', NOW + 15 * 60_000 + 1)).toBeUndefined()
    // TTL prune
    const old = (Date.now() - 20 * 60_000) / 1000
    utimesSync(join(s.fx.P.captures, 'c1.json'), old, old)
    expect(pruneCaptures(s.fx.P, Date.now())).toBe(1)
    // size cap: three ~30 MiB files, oldest goes first
    for (let i = 0; i < 3; i++) {
      const f = join(s.fx.P.captures, `big${i}.json`)
      writeFileSync(f, 'x'.repeat(30 * 1024 * 1024))
      utimesSync(f, Date.now() / 1000 - 10 + i, Date.now() / 1000 - 10 + i)
    }
    pruneCaptures(s.fx.P, Date.now())
    expect(existsSync(join(s.fx.P.captures, 'big0.json'))).toBe(false)
    expect(existsSync(join(s.fx.P.captures, 'big2.json'))).toBe(true)
    expect(CAPTURE_TOTAL_MAX).toBe(64 * 1024 * 1024)
  })
  it('an id that is not a plain id never reaches the file system', async () => {
    const s = await setup()
    writeFileSync(
      join(s.fx.P.dir, 'escape.json'),
      JSON.stringify({
        capture_id: 'escape',
        server: 'probe',
        source: 'local',
        tool: 't',
        tool_input: {},
        ok: true,
        at: iso(NOW),
      }),
    )
    expect(readCapture(s.fx.P, '../escape', NOW)).toBeUndefined() // a well-formed capture one level up is still not read
    expect(readCapture(s.fx.P, 'escape', NOW)).toBeUndefined()
    expect(readCapture(s.fx.P, '../catalog', NOW)).toBeUndefined()
    expect(() =>
      writeCapture(s.fx.P, {
        capture_id: '../x',
        server: 'p',
        source: 'l',
        tool: 't',
        tool_input: {},
        ok: true,
        at: iso(NOW),
      }),
    ).toThrow()
  })
})

describe('the real hook process, from an install-written settings file (G6)', () => {
  it('installs the exact line, onFailure:block on the gate with timeout 10, and the command runs', async () => {
    const s = await setup()
    const agent = tmp('agent-')
    const file = join(agent, '.claude', 'settings.local.json')
    installHookSettings(
      file,
      { bridgeDir: BRIDGE_DIR, prefixes: [toolPrefixFor('probe')], keychainDeny: true },
      matcherFor,
    )
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    const pre = cfg.hooks.PreToolUse[0]
    expect(pre.matcher).toBe('^mcp__probe__.*')
    expect(pre.hooks[0]).toMatchObject({ type: 'command', timeout: 10, onFailure: 'block' })
    expect(pre.hooks[0].command).toBe(`bun run --cwd ${BRIDGE_DIR} ${HOOK_MARKER} pre-tool-use`)
    expect(cfg.hooks.PostToolUse[0].hooks[0]).toMatchObject({ timeout: 10 })
    expect(cfg.hooks.PostToolUse[0].hooks[0].onFailure).toBeUndefined()
    expect(cfg.hooks.PostToolUseFailure[0].hooks[0].timeout).toBe(5)
    expect(cfg.permissions.deny).toEqual(['Bash(security find-generic-password:*)', 'Bash(security dump-keychain:*)'])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // run the exact command line through a shell, as Claude Code does
    s.pend(realTimes())
    const p = Bun.spawn(['sh', '-c', pre.hooks[0].command], {
      stdin: new Blob([s.input()]),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: tmp('empty-home-'), TALOS_APP_BRIDGE: '1', TALOS_APP_HOME: s.home },
    })
    const text = await new Response(p.stdout as ReadableStream).text()
    expect(await p.exited).toBe(0)
    expect(JSON.parse(text).hookSpecificOutput.permissionDecision).toBe('allow')
    // the same line with TALOS_APP_BRIDGE unset prints nothing
    const q = Bun.spawn(['sh', '-c', pre.hooks[0].command], {
      stdin: new Blob([s.input()]),
      stdout: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: tmp('empty-home-'), TALOS_APP_HOME: s.home },
    })
    expect(await new Response(q.stdout as ReadableStream).text()).toBe('')
    expect(await q.exited).toBe(0)
  })
  it('a hook process that cannot read its input still exits 0 and the gate says deny', async () => {
    const s = await setup()
    const io = {
      readStdin: async () => {
        throw new Error('closed')
      },
      write: (x: string) => lines.push(x),
      env: { TALOS_APP_BRIDGE: '1', TALOS_APP_HOME: s.home },
      now: () => NOW,
    }
    const lines: string[] = []
    expect(await mainHook(['pre-tool-use'], io)).toBe(0)
    expect(JSON.parse(lines.join('')).hookSpecificOutput.permissionDecision).toBe('deny')
    const l2: string[] = []
    expect(await mainHook(['post-tool-use'], { ...io, write: (x) => l2.push(x) })).toBe(0)
    expect(l2).toEqual([])
    expect(await mainHook(['nonsense'], io)).toBe(0)
  })
})

describe('settings merge', () => {
  const foreign = {
    permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] },
    model: 'x',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign-pre' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo foreign-stop' }] }],
    },
  }
  const opts = { bridgeDir: BRIDGE_DIR, prefixes: ['mcp__probe__', 'mcp__other__'], keychainDeny: true }
  it('keeps foreign hooks and settings, adds one matcher per server, and is idempotent', () => {
    const once = mergeHookSettings(foreign, opts, matcherFor)
    const twice = mergeHookSettings(once, opts, matcherFor)
    expect(twice).toEqual(once)
    const pre = (once.hooks as Record<string, Array<{ matcher: string }>>).PreToolUse as Array<{ matcher: string }>
    expect(pre.map((g) => g.matcher)).toEqual(['Bash', '^mcp__probe__.*', '^mcp__other__.*'])
    expect((once.hooks as Record<string, unknown>).Stop).toEqual(foreign.hooks.Stop)
    expect((once as { model: string }).model).toBe('x')
    expect((once.permissions as { allow: string[]; deny: string[] }).allow).toEqual(['Bash(ls:*)'])
    expect((once.permissions as { deny: string[] }).deny).toEqual([
      'Bash(rm:*)',
      'Bash(security find-generic-password:*)',
      'Bash(security dump-keychain:*)',
    ])
  })
  it('drops only our entries when a server is gone, and a hook our group shares with a foreign one survives', () => {
    const mixed = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'x',
            hooks: [
              { type: 'command', command: 'echo mine' },
              { type: 'command', command: `bun run --cwd /old ${HOOK_MARKER} pre-tool-use` },
            ],
          },
        ],
      },
    }
    const r = mergeHookSettings(mixed, { ...opts, prefixes: [], keychainDeny: false }, matcherFor)
    expect(r.hooks).toEqual({ PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo mine' }] }] })
    expect(
      mergeHookSettings(
        {
          hooks: {
            PostToolUse: [
              { matcher: 'y', hooks: [{ type: 'command', command: `bun run ${HOOK_MARKER} post-tool-use` }] },
            ],
          },
        },
        { ...opts, prefixes: [], keychainDeny: false },
        matcherFor,
      ),
    ).toEqual({})
  })
  it('writes only settings.local.json, rejects invalid JSON loudly, leaves the user scope file alone', () => {
    const agent = tmp('agent-')
    const emptyHome = tmp('empty-home-')
    expect(() => installHookSettings(join(agent, '.claude', 'settings.json'), opts, matcherFor)).toThrow(
      'settings.local.json only',
    )
    expect(() => installHookSettings(join(emptyHome, '.claude', 'settings.json'), opts, matcherFor)).toThrow()
    expect(existsSync(join(emptyHome, '.claude'))).toBe(false)
    mkdirSync(join(agent, '.claude'), { recursive: true })
    writeFileSync(join(agent, '.claude', 'settings.local.json'), '{broken')
    expect(() => installHookSettings(join(agent, '.claude', 'settings.local.json'), opts, matcherFor)).toThrow(
      'not valid JSON',
    )
    expect(readFileSync(join(agent, '.claude', 'settings.local.json'), 'utf8')).toBe('{broken')
  })
  it('no servers and no file: nothing is created', () => {
    const agent = tmp('agent-')
    const r = installHookSettings(
      join(agent, '.claude', 'settings.local.json'),
      { ...opts, prefixes: [], keychainDeny: false },
      matcherFor,
    )
    expect(r.changed).toBe(false)
    expect(existsSync(join(agent, '.claude'))).toBe(false)
  })
  it('running the install twice on disk leaves the file byte-identical', () => {
    const agent = tmp('agent-')
    const f = join(agent, '.claude', 'settings.local.json')
    expect(installHookSettings(f, opts, matcherFor).changed).toBe(true)
    const a = readFileSync(f, 'utf8')
    expect(installHookSettings(f, opts, matcherFor).changed).toBe(false)
    expect(readFileSync(f, 'utf8')).toBe(a)
  })
})
