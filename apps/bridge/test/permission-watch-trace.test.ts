// A probe, not a feature (Wave 1, after the failed perm-over live check): with TALOS_PERMISSION_HOOK_TRACE=<file> set, the permission hook's
// transcript watcher writes what it SEES, so the next live check can say why it did or did not arm: whether the hook input has `agent_id` and a
// transcript path, which records it read (top-level `user` and `assistant` records only, never `api-request-blob` and other kinds), when it
// armed (with the message id), when it gave up, and, for a record whose tool name matches but whose input does not, the sorted key NAMES of both
// inputs and for each shared key only "same" or "differs" with the two lengths. NEVER a value: the lines are safe to read and to send.
// Nothing is written without the variable. The real hook runs against a stand-in hub.
// (`touch probe-N` and similar are synthetic hook inputs.)
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { t } from '@talos-app/testkit'
import { eventually, sleep } from './helpers.ts'

setDefaultTimeout(t(40_000))

const HOOK = resolve(import.meta.dir, '..', '..', '..', 'kit', 'hooks', 'permission-relay.py')
const COMMON = resolve(HOOK, '..')
const SECRET = 'SECRET-VALUE-9f3a71c2'
const SECRET2 = 'OTHER-SECRET-55d0e8'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

type Line = Record<string, unknown>
async function standInHub() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pwt-')))
  mkdirSync(join(home, 'run'), { mode: 0o700 })
  writeFileSync(join(home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'x' }))
  const lines: Line[] = []
  const server: Server = createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)) as Line)
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
      }
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

function startHook(home: string, call: Line, trace?: string) {
  const p = Bun.spawn(['python3', HOOK], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: '/nonexistent',
      TALOS_APP_HOME: home,
      ...(trace ? { TALOS_PERMISSION_HOOK_TRACE: trace } : {}),
    },
    stdin: new Blob([
      JSON.stringify({
        session_id: 'abc',
        cwd: '/home/alex',
        hook_event_name: 'PermissionRequest',
        permission_mode: 'default',
        ...call,
      }),
    ]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  cleanup.push(() => {
    try {
      p.kill('SIGKILL')
    } catch {}
  })
  return p
}

const use = (id: string, name: string, input: unknown, msgId = 'msg_01AAAAAAAAAAAAAAAA') => ({
  type: 'assistant',
  isSidechain: false,
  message: { id: msgId, content: [{ type: 'tool_use', id, name, input }] },
})
const result = (id: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})
const jl = (...recs: unknown[]) => `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`

/** The trace lines of the watcher and of the hook input, without the leading time. */
const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => l.replace(/^\d+ /, ''))
    : []
const watcher = (file: string) => lines(file).filter((l) => l.startsWith('W: ') || l.startsWith('in: '))
const waitFor = (file: string, re: RegExp) =>
  eventually(() => expect(lines(file).some((l) => re.test(l))).toBe(true), t(20_000))

describe('the hook input line (agent_id, transcript, key names)', () => {
  test('a main-session call: agent_id no, a transcript, the key names of the input', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    startHook(
      hub.home,
      {
        tool_name: 'Bash',
        tool_input: { command: 'touch probe-1', description: SECRET },
        transcript_path: join(hub.home, 'none.jsonl'),
      },
      file,
    )
    await waitFor(file, /^in: /)
    expect(lines(file).find((l) => l.startsWith('in: '))).toBe(
      'in: agent_id=no transcript=yes tool_input_keys=command,description',
    )
  })

  test('a subagent call (agent_id present): agent_id yes, and no transcript when the path is missing', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    startHook(hub.home, { tool_name: 'Bash', tool_input: { command: 'x' }, agent_id: 'a1b2c3' }, file)
    await waitFor(file, /^in: /)
    expect(lines(file).find((l) => l.startsWith('in: '))).toBe('in: agent_id=yes transcript=no tool_input_keys=command')
  })

  test('without the variable no file is written at all', async () => {
    const hub = await standInHub()
    const p = startHook(hub.home, { tool_name: 'Bash', tool_input: { command: 'x' } })
    await eventually(() => expect(hub.lines.length).toBeGreaterThan(0))
    p.kill('SIGKILL')
    expect(existsSync(join(hub.home, 'trace.txt'))).toBe(false)
  })
})

describe('the watcher says what it sees, keys only', () => {
  test('armed: with the message id, from a user/assistant record, and the records it read', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    const tx = join(hub.home, 'session.jsonl')
    writeFileSync(tx, jl(use('toolu_1', 'Bash', { command: 'touch probe-1' }, 'msg_01XYZ123456789')))
    startHook(hub.home, { tool_name: 'Bash', tool_input: { command: 'touch probe-1' }, transcript_path: tx }, file)
    await waitFor(file, /^W: armed /)
    expect(lines(file)).toContain('W: read user=0 assistant=1 skipped=none')
    expect(lines(file).find((l) => l.startsWith('W: armed '))).toBe(
      'W: armed msg=Z123456789 uses=1 from=assistant.message.content',
    )
  })

  test('the input differs: key names of both, same or differs per shared key with the lengths, never a value', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    const tx = join(hub.home, 'session.jsonl')
    writeFileSync(
      tx,
      jl(
        use('toolu_1', 'Bash', { command: `echo ${SECRET2}`, description: 'x', 'my secret key': SECRET2, timeout: 5 }),
      ),
    )
    startHook(
      hub.home,
      {
        tool_name: 'Bash',
        tool_input: { command: `echo ${SECRET}`, description: 'x', timeout: 5 },
        transcript_path: tx,
      },
      file,
    )
    await waitFor(file, /^W: input-differs /)
    const line = lines(file).find((l) => l.startsWith('W: input-differs ')) as string
    expect(line).toBe(
      `W: input-differs keys_hook=command,description,timeout keys_tx=?,command,description,timeout shared: command=differs(${JSON.stringify(`echo ${SECRET}`).length}/${JSON.stringify(`echo ${SECRET2}`).length}) description=same timeout=same`,
    )
    const all = readFileSync(file, 'utf8')
    expect(all).not.toContain(SECRET)
    expect(all).not.toContain(SECRET2)
    expect(all).not.toContain('my secret key') // an odd key name is shown as ?
  })

  test('only top-level user and assistant records count: an api-request-blob copy neither arms nor ends the watcher', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    const tx = join(hub.home, 'session.jsonl')
    const input = { command: 'touch probe-1' }
    const blob = (id: string) => ({
      type: 'api-request-blob',
      hash: 'h',
      message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] },
    })
    // a blob holds an identical call under another id: the old scan saw two open calls and gave up for good
    writeFileSync(tx, jl(use('toolu_1', 'Bash', input), blob('toolu_blob')))
    const p = startHook(hub.home, { tool_name: 'Bash', tool_input: input, transcript_path: tx }, file)
    await waitFor(file, /^W: armed /)
    expect(lines(file)).toContain('W: read user=0 assistant=1 skipped=api-request-blob:1')
    // a blob that holds a result for the armed call must not end it
    appendFileSync(
      tx,
      jl({
        type: 'api-request-blob',
        hash: 'h2',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      }),
    )
    await sleep(t(2500))
    expect(p.exitCode).toBeNull()
    appendFileSync(tx, jl(result('toolu_1'))) // the real result ends it
    expect(await p.exited).toBe(0)
  })

  test('two open identical calls: off, ambiguous, with the count', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    const tx = join(hub.home, 'session.jsonl')
    const input = { command: 'touch probe-1' }
    writeFileSync(tx, jl(use('toolu_1', 'Bash', input), use('toolu_2', 'Bash', input)))
    startHook(hub.home, { tool_name: 'Bash', tool_input: input, transcript_path: tx }, file)
    await waitFor(file, /^W: off ambiguous /)
    expect(lines(file)).toContain('W: off ambiguous n=2')
    expect(lines(file).some((l) => l.startsWith('W: armed'))).toBe(false)
  })
})

describe('the watcher gives up (the real code, looked at 15 times in one process)', () => {
  const script = [
    'import json,os,sys',
    'sys.path.insert(0, sys.argv[1])',
    'import _talos_common as C',
    'w = C.Watcher({"transcript_path": sys.argv[2], "tool_name": "Bash", "tool_input": json.loads(sys.argv[3])})',
    'for _ in range(17): w.done()',
    'print(w.off, w.started)',
  ].join('\n')
  const run = (tx: string, input: unknown, trace: string) => {
    const r = Bun.spawnSync(['python3', '-c', script, COMMON, tx, JSON.stringify(input)], {
      env: { PATH: process.env.PATH ?? '', TALOS_PERMISSION_HOOK_TRACE: trace },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.stderr.toString()).toBe('')
    return r.stdout.toString().trim()
  }

  test('the call is never in the transcript: off, not found in 15 looks', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    const tx = join(hub.home, 'session.jsonl')
    writeFileSync(tx, jl(use('toolu_9', 'Read', { file_path: '/x' })))
    expect(run(tx, { command: 'touch probe-1' }, file)).toBe('True False')
    expect(lines(file)).toContain('W: off not-found-in-15-looks near=0')
  })

  test('only the input differs: the same, with the number of records whose name matched', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    const tx = join(hub.home, 'session.jsonl')
    writeFileSync(tx, jl(use('toolu_1', 'Bash', { command: `echo ${SECRET2}` })))
    expect(run(tx, { command: `echo ${SECRET}` }, file)).toBe('True False')
    expect(lines(file)).toContain('W: off not-found-in-15-looks near=1')
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET)
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET2)
  })
})

describe('the hook is still small', () => {
  test('kit/hooks/permission-relay.py is at most 1000 lines', () => {
    expect(readFileSync(HOOK, 'utf8').split('\n').length - 1).toBeLessThanOrEqual(1000)
  })
})
