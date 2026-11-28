// The PreToolUse companion of the permission hook (kit/hooks/permission-pre.sh). It runs before EVERY tool call, so it is a tiny POSIX sh
// script (no python start): it never blocks, never prints, always exits 0, and leaves one EMPTY file per call in a spool folder
// (<app home>/run/pretool, mode 0700, files 0600), named `<key>.<session>.<agent or ->.<tool_use id>.<epoch>`, where the key is the POSIX cksum
// of the tool name and the RAW tool_input text exactly as Claude Code wrote it (no canonicalising: nothing to disagree about). It prunes
// files older than an hour. The permission hook (python) reads the same text from its own stdin, computes the same key, and takes the
// tool_use id only when exactly ONE record of its own session (and subagent) younger than 10 minutes and not yet finished matches.
// (`touch probe-N` and similar are synthetic hook inputs.)
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { t } from '@talos-app/testkit'
import { eventually } from './helpers.ts'

setDefaultTimeout(t(30_000))

const KIT = resolve(import.meta.dir, '..', '..', '..', 'kit', 'hooks')
const PRE = join(KIT, 'permission-pre.sh')
const HOOK = join(KIT, 'permission-relay.py')
const SID = '9a7c1e52-0b3d-4f6a-8c21-5d4e3f2a1b00'
const ID = 'toolu_01AAAAAAAAAAAAAAAAAAAAAA'
const OTHER = 'toolu_01BBBBBBBBBBBBBBBBBBBBBB'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)))
  cleanup.push(() => rmSync(d, { recursive: true, force: true }))
  return d
}

const base = (extra: Record<string, unknown> = {}) => ({
  session_id: SID,
  transcript_path: `/home/alex/.claude/projects/-srv-proj/${SID}.jsonl`,
  cwd: '/srv/proj',
  prompt_id: 'f1d2d2f9-24e7-4d8a-8b3e-aaaaaaaaaaaa',
  permission_mode: 'default',
  ...extra,
})
/** What Claude Code writes for a PreToolUse: base fields, the event, the tool, its input, THEN the id (the order the sh script relies on). */
const preJson = (tool: string, input: unknown, id = ID, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...base(extra), hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id })
/** What it writes for a PermissionRequest: the same up to the input, then the suggestions (absent when there are none). */
const reqJson = (tool: string, input: unknown, extra: Record<string, unknown> = {}, suggestions?: unknown) =>
  JSON.stringify({
    ...base(extra),
    hook_event_name: 'PermissionRequest',
    tool_name: tool,
    tool_input: input,
    ...(suggestions !== undefined ? { permission_suggestions: suggestions } : {}),
  })

function runPre(home: string, stdin: string, shell: string[] = ['sh'], pathFirst = '') {
  const r = Bun.spawnSync([...shell, PRE], {
    env: {
      PATH: `${pathFirst ? `${pathFirst}:` : ''}${process.env.PATH ?? ''}`,
      HOME: '/nonexistent',
      TALOS_APP_HOME: home,
    },
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const spool = (home: string) => join(home, 'run', 'pretool')
const records = (home: string) =>
  existsSync(spool(home)) ? readdirSync(spool(home)).filter((n) => !n.startsWith('.')) : []
const newHome = () => {
  const home = tmp('pre-')
  mkdirSync(join(home, 'run'), { mode: 0o700 })
  return home
}
const hasShell = (...cmd: string[]) => Bun.spawnSync([...cmd, '-c', 'exit 0']).exitCode === 0

describe('permission-pre.sh: a record per call, and nothing else', () => {
  test('writes one empty 0600 file in a 0700 folder, prints nothing, exits 0', () => {
    const home = newHome()
    const r = runPre(home, preJson('Bash', { command: 'touch probe-1' }))
    expect(r).toEqual({ code: 0, out: '', err: '' })
    const names = records(home)
    expect(names).toHaveLength(1)
    const parts = (names[0] as string).split('.')
    expect(parts).toHaveLength(5)
    expect(parts[0]).toMatch(/^\d+-\d+$/) // cksum: crc-length
    expect(parts.slice(1, 4)).toEqual([SID, '-', ID])
    expect(Math.abs(Number(parts[4]) - Date.now() / 1000)).toBeLessThan(30)
    expect(statSync(join(spool(home), names[0] as string)).size).toBe(0) // no tool input is ever stored
    expect(statSync(join(spool(home), names[0] as string)).mode & 0o777).toBe(0o600)
    expect(statSync(spool(home)).mode & 0o777).toBe(0o700)
  })

  test('a subagent call carries its agent id in the name', () => {
    const home = newHome()
    runPre(
      home,
      preJson('Bash', { command: 'x' }, ID, { agent_id: 'a0edd2143fc3f099d', agent_type: 'general-purpose' }),
    )
    expect((records(home)[0] as string).split('.')[2]).toBe('a0edd2143fc3f099d')
  })

  test.each([
    ['empty input', ''],
    ['not JSON', 'hello'],
    ['an empty object', '{}'],
    [
      'another event',
      JSON.stringify({
        ...base(),
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: {},
        tool_use_id: ID,
      }),
    ],
    ['no tool_use_id', JSON.stringify({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })],
    ['a session id that is a path', preJson('Bash', {}).replace(SID, '../../etc')],
    ['a session id with a space', preJson('Bash', {}).replace(SID, 'a b')],
    ['a tool_use id with a slash', preJson('Bash', {}, 'toolu/../x')],
    ['an id with a dot (it would break the file name)', preJson('Bash', {}, 'toolu.01')],
    ['an agent id with a dot', preJson('Bash', {}, ID, { agent_id: 'a.b' })],
    ['JSON over several lines', JSON.stringify(JSON.parse(preJson('Bash', {})), null, 2)],
    ['a truncated line', preJson('Bash', { command: 'x' }).slice(0, 80)],
  ])('%s: exits 0, prints nothing, writes nothing', (_why, stdin) => {
    const home = newHome()
    const r = runPre(home, stdin)
    expect(r).toEqual({ code: 0, out: '', err: '' })
    expect(records(home)).toEqual([])
  })

  test('the spool cannot be made: still exits 0 and prints nothing (it never blocks a tool call)', () => {
    const home = tmp('pre-')
    writeFileSync(join(home, 'run'), 'a file where the folder should be')
    expect(runPre(home, preJson('Bash', {}))).toEqual({ code: 0, out: '', err: '' })
    const noHome = Bun.spawnSync(['sh', PRE], {
      env: { PATH: process.env.PATH ?? '' },
      stdin: new Blob([preJson('Bash', {})]),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(noHome.exitCode).toBe(0)
    expect(noHome.stdout.toString()).toBe('')
  })

  test.each([['sh'], ['bash', '--posix']].filter((s) => hasShell(...s)))(
    'runs under %s (POSIX mode: macOS ships bash as /bin/sh)',
    (...shell) => {
      const home = newHome()
      expect(runPre(home, preJson('Bash', { command: 'x' }), shell)).toEqual({ code: 0, out: '', err: '' })
      expect(records(home)).toHaveLength(1)
    },
  )

  test('uses nothing outside POSIX sh and the usual tools (no bash-only syntax, no GNU-only options)', () => {
    const body = readFileSync(PRE, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(body).not.toMatch(/\[\[|\(\(\s|\bfunction\b|<<<|\$'|\blocal\b|\bsource\b|=~|\bdeclare\b|\barray\b/)
    expect(body).not.toMatch(/\b(sed|awk|grep|sha256sum|shasum|head -c|tail -c|stat|readlink|find|xargs)\b/) // one fork for cksum and one for date, no more
  })
})

describe('the key: the same bytes in the sh script and in the python hook', () => {
  const cases: [string, unknown][] = [
    ['plain', { command: 'touch probe-1' }],
    ['key order is kept', { b: 1, a: 2, command: 'x' }],
    ['non-ASCII text', { command: "echo 'café 日本語 \u{1F600}'" }],
    ['escapes and quotes', { command: 'printf "%s\\n" \'a"b\'', note: 'tab\there\nnewline \\ back' }],
    ['numbers', { n: 1, f: 1.5, big: 123456789012345, e: 1e21, neg: -0.25, z: 0 }],
    ['nested objects and arrays', { a: { b: { c: [1, 2, { d: null, e: true }] } }, list: [[], {}, [[]]] }],
    ['an empty input', {}],
    ['a key named like the envelope', { tool_use_id: 'x', tool_name: 'y', hook_event_name: 'z', session_id: 'w' }],
    ['text that looks like the envelope', { command: 'echo ,"tool_use_id":"toolu_fake" and ","tool_input":{' }],
    ['a lone surrogate (JSON escapes it)', { s: '\ud800 bad' }],
    ['a long value', { content: 'x'.repeat(200_000) }],
    ['a control character', { c: '\u0001\u001f' }],
    ['spaces around', { 'a b': 'c  d', ' lead': ' trail ' }],
  ]
  test.each(cases)('%s', (_name, input) => {
    const home = newHome()
    runPre(home, preJson('Bash', input))
    const fileKey = (records(home)[0] as string).split('.')[0]
    const raw = reqJson('Bash', input, {}, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    const rawNoSuggestions = reqJson('Bash', input, { agent_id: 'a1' })
    const py = (text: string) => {
      const r = Bun.spawnSync(
        [
          'python3',
          '-c',
          'import sys; sys.path.insert(0, sys.argv[1]); import _talos_common as C; print(C.pre_key(sys.stdin.read()))',
          KIT,
        ],
        {
          stdin: new Blob([text]),
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      expect(r.stderr.toString()).toBe('')
      return r.stdout.toString().trim()
    }
    expect(py(raw)).toBe(fileKey) // with permission_suggestions after the input
    expect(py(rawNoSuggestions)).toBe(fileKey) // without it (and an agent id before)
  })

  test('raw spellings JSON.stringify never writes (1.0, 1E3, -0.0, \\u escapes, extra spaces): the text is hashed as it is', () => {
    const rawInput = '{"n":1.0,"e":1E3,"neg":-0.0,"u":"\\u00e9\\ud83d\\ude00","sp": [ 1 , 2 ]}'
    const home = newHome()
    const pre = `{"session_id":"${SID}","cwd":"/x","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":${rawInput},"tool_use_id":"${ID}"}`
    const req = `{"session_id":"${SID}","cwd":"/x","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":${rawInput},"permission_suggestions":[]}`
    runPre(home, pre)
    const fileKey = (records(home)[0] as string).split('.')[0]
    const r = Bun.spawnSync(
      [
        'python3',
        '-c',
        'import sys; sys.path.insert(0, sys.argv[1]); import _talos_common as C; print(C.pre_key(sys.stdin.read()))',
        KIT,
      ],
      {
        stdin: new Blob([req]),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(r.stdout.toString().trim()).toBe(fileKey)
  })

  test('another tool name or another input is another key', () => {
    const home = newHome()
    runPre(home, preJson('Bash', { command: 'a' }))
    runPre(home, preJson('Write', { command: 'a' }, OTHER))
    runPre(home, preJson('Bash', { command: 'b' }, 'toolu_01CCCCCCCCCCCCCCCCCCCCCC'))
    expect(new Set(records(home).map((n) => n.split('.')[0])).size).toBe(3)
  })
})

describe('the spool expires: files older than an hour are pruned', () => {
  const nameAt = (epoch: number, id = ID) => `1-1.${SID}.-.${id}.${epoch}`
  const now = () => Math.floor(Date.now() / 1000)

  test('a write prunes old records, keeps young ones, and notes when it pruned', () => {
    const home = newHome()
    mkdirSync(spool(home), { mode: 0o700 })
    writeFileSync(join(spool(home), nameAt(now() - 3601, 'toolu_old1')), '')
    writeFileSync(join(spool(home), nameAt(now() - 7200, 'toolu_old2')), '')
    writeFileSync(join(spool(home), nameAt(now() - 3000, 'toolu_young')), '')
    writeFileSync(join(spool(home), '.pruned'), `${now() - 700}\n`) // last pruned more than 10 minutes ago
    runPre(home, preJson('Bash', { command: 'x' }))
    const names = records(home)
    expect(names.some((n) => n.includes('toolu_old1') || n.includes('toolu_old2'))).toBe(false)
    expect(names.some((n) => n.includes('toolu_young'))).toBe(true)
    expect(names.some((n) => n.includes(ID))).toBe(true)
    expect(Number(readFileSync(join(spool(home), '.pruned'), 'utf8').trim())).toBeGreaterThan(now() - 30)
  })

  test('a big backlog is pruned in a few removals, all of it (more than one batch), and fast enough for a hook that runs before a tool call', () => {
    const home = newHome()
    mkdirSync(spool(home), { mode: 0o700 })
    for (let i = 0; i < 1300; i++) writeFileSync(join(spool(home), nameAt(now() - 7200, `toolu_o${i}`)), '')
    for (let i = 0; i < 30; i++) writeFileSync(join(spool(home), nameAt(now() - 100, `toolu_y${i}`)), '')
    // what "fast enough" means is how many removals it makes: a shim `rm` first on PATH logs each call, then runs the real one
    const shim = tmp('rmshim-')
    const log = join(shim, 'calls')
    const real = Bun.spawnSync(['sh', '-c', 'command -v rm']).stdout.toString().trim()
    writeFileSync(join(shim, 'rm'), `#!/bin/sh\necho call >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 })
    const started = Date.now()
    runPre(home, preJson('Bash', { command: 'x' }), ['sh'], shim)
    const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
    // one rm per 400 files, not one per file (3000 single removals took over 3 s): 1300 old records are at most ceil(1300 / 400) calls
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBeLessThanOrEqual(Math.ceil(1300 / 400))
    expect(Date.now() - started).toBeLessThan(t(10_000)) // only a sanity bound: the count above is the test
    expect(records(home).filter((n) => n.includes('toolu_o'))).toEqual([])
    expect(records(home).filter((n) => n.includes('toolu_y'))).toHaveLength(30)
  })

  test('with a fresh marker (pruned lately) it does not look again', () => {
    const home = newHome()
    mkdirSync(spool(home), { mode: 0o700 })
    writeFileSync(join(spool(home), nameAt(now() - 7200, 'toolu_old')), '')
    writeFileSync(join(spool(home), '.pruned'), `${now() - 30}\n`)
    runPre(home, preJson('Bash', { command: 'x' }))
    expect(records(home).some((n) => n.includes('toolu_old'))).toBe(true)
  })

  test('with no marker at all it prunes at once; a name that is not a record is left alone', () => {
    const home = newHome()
    mkdirSync(spool(home), { mode: 0o700 })
    writeFileSync(join(spool(home), nameAt(now() - 7200, 'toolu_old')), '')
    writeFileSync(join(spool(home), 'stray.txt'), '')
    runPre(home, preJson('Bash', { command: 'x' }))
    expect(records(home).some((n) => n.includes('toolu_old'))).toBe(false)
    expect(existsSync(join(spool(home), 'stray.txt'))).toBe(true)
  })

  test('a marker that holds rubbish is read as "never pruned", not a crash', () => {
    const home = newHome()
    mkdirSync(spool(home), { mode: 0o700 })
    writeFileSync(join(spool(home), nameAt(now() - 7200, 'toolu_old')), '')
    writeFileSync(join(spool(home), '.pruned'), '09; echo hi\n')
    expect(runPre(home, preJson('Bash', { command: 'x' }))).toEqual({ code: 0, out: '', err: '' })
    expect(records(home).some((n) => n.includes('toolu_old'))).toBe(false)
  })
})

// ---- the permission hook looks its call up ------------------------------------------------------------------------------

type Line = Record<string, unknown>
async function standInHub() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pre-hub-')))
  mkdirSync(join(home, 'run'), { mode: 0o700 })
  writeFileSync(join(home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'x' }))
  const lines: Line[] = []
  const server: Server = createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      lines.push(JSON.parse(buf.slice(0, nl)) as Line)
      sock.destroy() // an answerless end: the hook just exits
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
/** Runs the real permission hook with `stdin` against the hub whose home also holds the spool; returns the perm line it sent. */
async function perm(home: string, hubLines: Line[], stdin: string, trace?: string) {
  const p = Bun.spawn(['python3', HOOK], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: '/nonexistent',
      TALOS_APP_HOME: home,
      ...(trace ? { TALOS_PERMISSION_HOOK_TRACE: trace } : {}),
    },
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await p.exited
  await eventually(() => expect(hubLines.length).toBeGreaterThan(0))
  return hubLines[hubLines.length - 1] as Line
}
const touch = { command: 'touch probe-1' }
const TX = (root: string) => {
  const dir = join(root, 'projects', '-srv-proj')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${SID}.jsonl`)
}

describe('the permission hook takes its call id only when exactly one record fits', () => {
  test('exactly one record: the perm line carries the id, the session, and the transcript path', async () => {
    const hub = await standInHub()
    const tx = TX(hub.home)
    runPre(hub.home, preJson('Bash', touch))
    const line = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: tx }))
    expect(line).toMatchObject({ tool_use_id: ID, session_id: SID, transcript_path: tx })
    expect('agent_id' in line).toBe(false)
  })

  test('two records (identical parallel calls, or a repeat not yet finished): no id', async () => {
    const hub = await standInHub()
    runPre(hub.home, preJson('Bash', touch, ID))
    runPre(hub.home, preJson('Bash', touch, OTHER))
    const line = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: TX(hub.home) }))
    expect('tool_use_id' in line).toBe(false)
  })

  test('no record: no id', async () => {
    const hub = await standInHub()
    const line = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: TX(hub.home) }))
    expect('tool_use_id' in line).toBe(false)
  })

  test('a record of another session, of another tool, of another input: ignored', async () => {
    const hub = await standInHub()
    runPre(hub.home, preJson('Bash', touch).replace(SID, 'another-session'))
    runPre(hub.home, preJson('Write', touch, OTHER))
    runPre(hub.home, preJson('Bash', { command: 'something else' }, 'toolu_01DDDDDDDDDDDDDDDDDDDDDD'))
    const line = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: TX(hub.home) }))
    expect('tool_use_id' in line).toBe(false)
  })

  test('a main call ignores a subagent record, and a subagent call takes only its own', async () => {
    const hub = await standInHub()
    const tx = TX(hub.home)
    runPre(hub.home, preJson('Bash', touch, OTHER, { agent_id: 'agentA1' }))
    const main = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: tx }))
    expect('tool_use_id' in main).toBe(false)
    hub.lines.length = 0
    const sub = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: tx, agent_id: 'agentA1' }))
    expect(sub).toMatchObject({ tool_use_id: OTHER, agent_id: 'agentA1' })
    hub.lines.length = 0
    const wrong = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: tx, agent_id: 'agentB2' }))
    expect('tool_use_id' in wrong).toBe(false)
  })

  test('a record older than two minutes is ignored, one a minute old still counts', async () => {
    const hub = await standInHub()
    mkdirSync(spool(hub.home), { mode: 0o700 })
    runPre(hub.home, preJson('Bash', touch))
    const name = records(hub.home)[0] as string
    const old = name.replace(/\.\d+$/, `.${Math.floor(Date.now() / 1000) - 121}`)
    rmSync(join(spool(hub.home), name))
    writeFileSync(join(spool(hub.home), old), '')
    const line = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: TX(hub.home) }))
    expect('tool_use_id' in line).toBe(false)
  })

  test('a call that already has its result in the transcript is finished: it does not count, so a repeat gets its own id', async () => {
    const hub = await standInHub()
    const tx = TX(hub.home)
    runPre(hub.home, preJson('Bash', touch, OTHER)) // the earlier identical call
    writeFileSync(
      tx,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: OTHER, content: 'ok' }] } })}\n`,
    )
    runPre(hub.home, preJson('Bash', touch, ID)) // this one
    const line = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: tx }))
    expect(line).toMatchObject({ tool_use_id: ID })
  })

  test('a result that is only a copy inside another record kind does not finish a call', async () => {
    const hub = await standInHub()
    const tx = TX(hub.home)
    runPre(hub.home, preJson('Bash', touch, OTHER))
    writeFileSync(
      tx,
      `${JSON.stringify({ type: 'api-request-blob', message: { content: [{ type: 'tool_result', tool_use_id: OTHER }] } })}\n`,
    )
    runPre(hub.home, preJson('Bash', touch, ID))
    const line = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: tx }))
    expect('tool_use_id' in line).toBe(false) // both still open: ambiguous
  })

  test('a subagent call is judged by its own file for finished calls', async () => {
    const hub = await standInHub()
    const tx = TX(hub.home)
    const sub = join(tx.replace(/\.jsonl$/, ''), 'subagents', 'agent-agentA1.jsonl')
    mkdirSync(join(tx.replace(/\.jsonl$/, ''), 'subagents'), { recursive: true })
    runPre(hub.home, preJson('Bash', touch, OTHER, { agent_id: 'agentA1' }))
    writeFileSync(
      sub,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: OTHER, content: 'ok' }] } })}\n`,
    )
    runPre(hub.home, preJson('Bash', touch, ID, { agent_id: 'agentA1' }))
    const line = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: tx, agent_id: 'agentA1' }))
    expect(line).toMatchObject({ tool_use_id: ID })
  })

  test('a missing or unreadable transcript: the records alone decide', async () => {
    const hub = await standInHub()
    runPre(hub.home, preJson('Bash', touch))
    const line = await perm(
      hub.home,
      hub.lines,
      reqJson('Bash', touch, { transcript_path: join(hub.home, 'nowhere', `${SID}.jsonl`) }),
    )
    expect(line).toMatchObject({ tool_use_id: ID })
  })

  test('no spool folder at all, or a spool that is a file: no id, and the hook still sends its request', async () => {
    const hub = await standInHub()
    writeFileSync(join(hub.home, 'run', 'pretool'), 'not a folder')
    const line = await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: TX(hub.home) }))
    expect(line.t).toBe('perm')
    expect('tool_use_id' in line).toBe(false)
  })

  test('the trace says what it found, without values', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    runPre(hub.home, preJson('Bash', touch))
    await perm(hub.home, hub.lines, reqJson('Bash', touch, { transcript_path: TX(hub.home) }), file)
    const text = readFileSync(file, 'utf8')
    expect(text).toMatch(/ pre: id=AAAAAA matches=1 open=1 other=0\n/)
    expect(text).not.toContain('touch probe')
  })
})

describe('it stays small', () => {
  test('permission-relay.py is at most 1000 lines, permission-pre.sh is a page or so', () => {
    expect(readFileSync(HOOK, 'utf8').split('\n').length - 1).toBeLessThanOrEqual(1000)
    expect(readFileSync(PRE, 'utf8').split('\n').length).toBeLessThan(100)
  })
})

// ---- review fixes: it must never block a tool call (a PreToolUse exit code 2 BLOCKS it) ----------------------------------

describe('permission-pre.sh never blocks: rc 0 with empty stdout and stderr, whatever goes wrong', () => {
  const quietRun = (home: string, stdin: string, shell: string[] = ['sh']) => {
    const r = runPre(home, stdin, shell)
    expect(r).toEqual({ code: 0, out: '', err: '' })
    return r
  }
  const shells = [['sh'], ['bash', '--posix']].filter((sh) => hasShell(...sh))
  const mkSpool = (home: string, mode = 0o700) => {
    mkdirSync(spool(home), { recursive: true })
    chmodSync(spool(home), mode)
  }

  test.each(shells)('a read-only spool (%s): rc 0, nothing written, nothing said', (...shell) => {
    const home = newHome()
    mkSpool(home, 0o500)
    quietRun(home, preJson('Bash', { command: 'x' }), shell)
    chmodSync(spool(home), 0o700)
    expect(records(home)).toEqual([])
  })

  test.each(shells)('a spool that is not mode 0700 is not used (%s), and is left as it is', (...shell) => {
    const home = newHome()
    mkSpool(home, 0o755)
    quietRun(home, preJson('Bash', { command: 'x' }), shell)
    expect(records(home)).toEqual([])
    expect(statSync(spool(home)).mode & 0o777).toBe(0o755)
  })

  test.each(shells)('a spool that is a link is not followed (%s)', (...shell) => {
    const home = newHome()
    const elsewhere = tmp('pre-else-')
    symlinkSync(elsewhere, spool(home))
    quietRun(home, preJson('Bash', { command: 'x' }), shell)
    expect(readdirSync(elsewhere)).toEqual([])
  })

  test.each(shells)('a session id of 300 characters (a file name too long) (%s)', (...shell) => {
    const home = newHome()
    quietRun(home, preJson('Bash', { command: 'x' }).replace(SID, 'a'.repeat(300)), shell)
    expect(records(home)).toEqual([])
  })

  test.each(shells)('three 100-character ids make a name over the limit (%s): nothing written, rc 0', (...shell) => {
    const home = newHome()
    const long = (c: string) => c.repeat(100)
    quietRun(home, preJson('Bash', { command: 'x' }, long('u'), { agent_id: long('g') }).replace(SID, long('s')), shell)
    expect(records(home)).toEqual([])
  })

  test('an id of 101 characters is refused, one of 100 is taken', () => {
    const home = newHome()
    quietRun(home, preJson('Bash', { command: 'x' }, 'u'.repeat(101)))
    expect(records(home)).toEqual([])
    quietRun(home, preJson('Bash', { command: 'x' }, 'u'.repeat(100)))
    expect(records(home)).toHaveLength(1)
  })

  test.each(shells)(
    'a .pruned marker with 23 digits, or other rubbish (%s): rc 0, read as never pruned',
    (...shell) => {
      for (const junk of ['12345678901234567890123', '99999999999', '-5', '1e9', '0x10', '']) {
        const home = newHome()
        mkdirSync(spool(home), { mode: 0o700 })
        writeFileSync(join(spool(home), '.pruned'), `${junk}\n`)
        quietRun(home, preJson('Bash', { command: 'x' }), shell)
        expect(records(home)).toHaveLength(1)
      }
    },
  )

  test('a record name with a 23-digit time is left alone and does not stop the prune', () => {
    const home = newHome()
    mkdirSync(spool(home), { mode: 0o700 })
    const now = Math.floor(Date.now() / 1000)
    writeFileSync(join(spool(home), `1-1.${SID}.-.toolu_big.12345678901234567890123`), '')
    writeFileSync(join(spool(home), `1-1.${SID}.-.toolu_old.${now - 7200}`), '')
    quietRun(home, preJson('Bash', { command: 'x' }))
    expect(records(home).some((n) => n.includes('toolu_big'))).toBe(true)
    expect(records(home).some((n) => n.includes('toolu_old'))).toBe(false)
  })

  test('the prune deletes only names of the full five-field record shape', () => {
    const home = newHome()
    mkdirSync(spool(home), { mode: 0o700 })
    const old = Math.floor(Date.now() / 1000) - 7200
    for (const keep of [
      'notes.1',
      'a.b.c.d.1',
      'x.y.z.w.v.1',
      `abc-1.${SID}.-.toolu_k.${old}`,
      `1-1.${SID}.-.toolu_k.${old}.bak`,
      'readme.txt',
    ])
      writeFileSync(join(spool(home), keep), '')
    writeFileSync(join(spool(home), `1-1.${SID}.-.toolu_gone.${old}`), '')
    quietRun(home, preJson('Bash', { command: 'x' }))
    const names = records(home)
    expect(names.some((n) => n.includes('toolu_gone'))).toBe(false)
    for (const keep of [
      'notes.1',
      'a.b.c.d.1',
      'x.y.z.w.v.1',
      `abc-1.${SID}.-.toolu_k.${old}`,
      `1-1.${SID}.-.toolu_k.${old}.bak`,
      'readme.txt',
    ])
      expect(names).toContain(keep)
  })

  test('the prune counts the fields: a name with fewer or more than five is left alone, only a five-field old record goes', () => {
    const home = newHome()
    mkdirSync(spool(home), { mode: 0o700 })
    const old = Math.floor(Date.now() / 1000) - 7200
    const keep = [
      '1-1.5',
      'a.b',
      '1-1.2.3',
      `1-1.${SID}.-.${old}`,
      `1-1.${SID}.-.toolu_k.${old}.${old}`,
      `1-1.${SID}.-.toolu_k.x.${old}.${old}`,
    ]
    for (const k of keep) writeFileSync(join(spool(home), k), '')
    writeFileSync(join(spool(home), `1-1.${SID}.-.toolu_gone.${old}`), '')
    expect(runPre(home, preJson('Bash', { command: 'x' }))).toEqual({ code: 0, out: '', err: '' })
    const names = records(home)
    expect(names.some((n) => n.includes('toolu_gone'))).toBe(false)
    for (const k of keep) expect(names).toContain(k)
  })

  test('every exit of the script is `exit 0`', () => {
    const body = readFileSync(PRE, 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    expect(body).not.toMatch(/exit [1-9]/)
    expect(body.trim().endsWith('exit 0')).toBe(true)
    expect(body).toMatch(/^exec 2>\/dev\/null$/m)
    expect(body).not.toMatch(/^\s*: >/m) // `:` is a special builtin: a failed redirect would end the script with rc 2
  })
})

describe('agent_id and session_id are read from any position, the same way in sh and in python', () => {
  const ti = '{"command":"touch probe-1"}'
  const A = (a: string) => `"agent_id":"${a}"`
  const BASE = `"session_id":"${SID}","cwd":"/x","permission_mode":"default"`
  const PRE_TAIL = `"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":${ti},"tool_use_id":"${ID}"`
  const positions: [string, string, string][] = [
    ['agent first', `{${A('A1')},${BASE},${PRE_TAIL}}`, 'A1'],
    ['agent in the middle of the base fields', `{"session_id":"${SID}",${A('A1')},"cwd":"/x",${PRE_TAIL}}`, 'A1'],
    ['agent last of the base fields', `{${BASE},${A('A1')},${PRE_TAIL}}`, 'A1'],
    ['agent after tool_use_id', `{${BASE},${PRE_TAIL},${A('A1')}}`, 'A1'],
    ['no agent', `{${BASE},${PRE_TAIL}}`, '-'],
    ['session_id not first', `{"cwd":"/x",${A('A1')},"session_id":"${SID}",${PRE_TAIL}}`, 'A1'],
    ['session_id after tool_use_id', `{"cwd":"/x",${PRE_TAIL},"session_id":"${SID}",${A('A1')}}`, 'A1'],
    [
      'an agent_id inside the input is not the call’s',
      `{${BASE},"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"agent_id":"EVIL","a":1},"tool_use_id":"${ID}"}`,
      '-',
    ],
  ]
  test.each(positions)('sh: %s', (_name, stdin, agent) => {
    const home = newHome()
    expect(runPre(home, stdin)).toEqual({ code: 0, out: '', err: '' })
    const names = records(home)
    expect(names).toHaveLength(1)
    const parts = (names[0] as string).split('.')
    expect(parts[1]).toBe(SID)
    expect(parts[2]).toBe(agent)
    expect(parts[3]).toBe(ID)
  })

  const reqAt = (agent: string | null, where: 'first' | 'last' | 'after-input') => {
    const a = agent ? `${A(agent)},` : ''
    const tail = `"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":${ti}`
    if (where === 'first') return `{${a}${BASE},${tail},"permission_suggestions":[]}`
    if (where === 'last') return `{${BASE},${tail}${agent ? `,${A(agent)}` : ''}}`
    return `{${BASE},${tail},"permission_suggestions":[]${agent ? `,${A(agent)}` : ''}}`
  }
  test.each(['first', 'last', 'after-input'] as const)(
    'python: a subagent call with its agent id %s finds the record the sh hook left for it',
    async (where) => {
      const hub = await standInHub()
      const tx = TX(hub.home)
      runPre(hub.home, `{${BASE},${A('A1')},${PRE_TAIL}}`)
      const line = await perm(
        hub.home,
        hub.lines,
        reqAt('A1', where).replace('"cwd":"/x"', `"cwd":"/x","transcript_path":${JSON.stringify(tx)}`),
      )
      expect(line).toMatchObject({ tool_use_id: ID, agent_id: 'A1' })
    },
  )
  test('python: a main call (no agent id) finds a record left with no agent', async () => {
    const hub = await standInHub()
    runPre(hub.home, `{${BASE},${PRE_TAIL}}`)
    const line = await perm(hub.home, hub.lines, reqAt(null, 'first'))
    expect(line).toMatchObject({ tool_use_id: ID })
  })

  test('a fresh record of the same session and call under a DIFFERENT agent label refuses the id (a main call and a subagent doing the same thing at once)', async () => {
    const hub = await standInHub()
    runPre(hub.home, `{${BASE},${PRE_TAIL}}`) // the main call's own record
    runPre(
      hub.home,
      `{${BASE},${A('A1')},"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":${ti},"tool_use_id":"${OTHER}"}`,
    ) // a subagent's identical call
    const file = join(hub.home, 'trace.txt')
    const line = await perm(hub.home, hub.lines, reqAt(null, 'first'), file)
    expect('tool_use_id' in line).toBe(false)
    expect(readFileSync(file, 'utf8')).toMatch(/ pre: id=none matches=1 open=1 other=1\n/)
  })
  test('the same the other way round: a subagent call refuses an id when the main call has a record too', async () => {
    const hub = await standInHub()
    runPre(hub.home, `{${BASE},${A('A1')},${PRE_TAIL}}`)
    runPre(
      hub.home,
      `{${BASE},"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":${ti},"tool_use_id":"${OTHER}"}`,
    )
    const line = await perm(hub.home, hub.lines, reqAt('A1', 'first'))
    expect('tool_use_id' in line).toBe(false)
  })
  test('an old record under another agent label does not count against it (only fresh ones)', async () => {
    const hub = await standInHub()
    runPre(hub.home, `{${BASE},${PRE_TAIL}}`)
    runPre(
      hub.home,
      `{${BASE},${A('A1')},"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":${ti},"tool_use_id":"${OTHER}"}`,
    )
    const other = records(hub.home).find((n) => n.includes(`.A1.${OTHER}.`)) as string
    rmSync(join(spool(hub.home), other))
    writeFileSync(join(spool(hub.home), other.replace(/\.\d+$/, `.${Math.floor(Date.now() / 1000) - 500}`)), '')
    const line = await perm(hub.home, hub.lines, reqAt(null, 'first'))
    expect(line).toMatchObject({ tool_use_id: ID })
  })
})
