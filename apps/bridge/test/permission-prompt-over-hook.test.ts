// "The prompt is over" (Wave 1, after hook-wins), the hook's half. The REAL kit/hooks/permission-relay.py runs as a child process against
// a stand-in hub. After the live check on 2.1.332 the hook says "over" for ONE thing only: Claude Code itself is gone (`parent`), and only
// once its request has gone out whole. A stop (SIGTERM or SIGHUP) says NOTHING: Claude Code does not stop the hook for a terminal Yes or No
// (only for Esc), and a plain `kill` looks the same, so the card is closed by the bridge from the transcript, by the call's exact tool_use id
// (permission-result-watch.test.ts). Also nothing for SIGKILL, a crash, the hook's own wait running out, the hub closing, or the call's own
// tool_result turning up. The hook never prints a decision on any of these.
// (`touch probe-N` here is only a synthetic hook input; which commands Claude Code offers a rule for is its own choice and differs by version.)
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
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { t } from '@talos-app/testkit'
import { eventually, sleep } from './helpers.ts'

setDefaultTimeout(t(30_000))

const HOOK = resolve(import.meta.dir, '..', '..', '..', 'kit', 'hooks', 'permission-relay.py')
const CALL = { tool_name: 'Bash', tool_input: { command: 'touch probe-1' } }

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

type Line = Record<string, unknown>
/** The trace lines of a hook (what ended it), without `sent`, which the hook writes when its request has gone out whole. */
const traceOf = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => !/^\d+ (in|W):/.test(l)) // the watcher's own probe lines (permission-watch-trace.test.ts)
        .map((l) => l.split(' ').pop())
        .filter((w) => w !== 'sent')
    : []
/**
 * Waits for the real condition, not for time: the hook has written `sent` to its trace, which it does right after the send of its request
 * returned and its "request is out" flag was set. Only from then on is a stop told to the hub, so a signal before it would be a lost
 * `perm_over` on a loaded machine (the hook may not get the CPU).
 */
const waitSent = (file: string) =>
  eventually(() => expect(existsSync(file) && readFileSync(file, 'utf8').includes(' sent\n')).toBe(true), t(15_000))
/** A hub in this process (which bridge.pid names). It records every line and every close; `onPerm` may answer. */
async function standInHub(onPerm?: (line: Line, sock: Socket) => void) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ppo-')))
  mkdirSync(join(home, 'run'), { mode: 0o700 })
  writeFileSync(join(home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'x' }))
  const lines: Line[] = []
  const closed: number[] = []
  const server: Server = createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const line = JSON.parse(buf.slice(0, nl)) as Line
        buf = buf.slice(nl + 1)
        lines.push(line)
        if (line.t === 'perm') onPerm?.(line, sock)
        nl = buf.indexOf('\n')
      }
    })
    sock.on('close', () => closed.push(lines.length))
    sock.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(join(home, 'run', 'hub.sock'), r))
  cleanup.push(() => {
    server.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, lines, closed }
}

function startHook(home: string, call: Line = {}, env: Record<string, string> = {}) {
  const p = Bun.spawn(['python3', HOOK], {
    env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', TALOS_APP_HOME: home, ...env },
    stdin: new Blob([
      JSON.stringify({
        session_id: 'abc',
        cwd: '/home/alex',
        permission_mode: 'default',
        hook_event_name: 'PermissionRequest',
        ...CALL,
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
  const done = (async () => ({
    stdout: await new Response(p.stdout).text(),
    stderr: await new Response(p.stderr).text(),
    code: await p.exited,
  }))()
  return { p, done }
}

const waitForPerm = (hub: { lines: Line[] }) =>
  eventually(() => expect(hub.lines.filter((l) => l.t === 'perm')).toHaveLength(1))
const overs = (hub: { lines: Line[] }) => hub.lines.filter((l) => l.t === 'perm_over')
const reqId = (hub: { lines: Line[] }) => hub.lines.find((l) => l.t === 'perm')?.id

describe('the hook says the prompt is over, only when Claude Code itself is gone', () => {
  test('SIGTERM while it waits: NOTHING is said (a plain kill looks the same as Claude Code stopping it); quiet exit 0, the trace says term', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    const h = startHook(hub.home, {}, { TALOS_PERMISSION_HOOK_TRACE: file })
    await waitForPerm(hub)
    await waitSent(file)
    h.p.kill('SIGTERM')
    const r = await h.done
    expect(r).toMatchObject({ stdout: '', code: 0 })
    expect(overs(hub)).toEqual([])
    expect(traceOf(file)).toEqual(['term'])
    await eventually(() => expect(hub.closed).toHaveLength(1))
    expect(hub.closed[0]).toBe(1) // only the request line came before the close
  })

  test('SIGHUP: nothing is said either', async () => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    const h = startHook(hub.home, {}, { TALOS_PERMISSION_HOOK_TRACE: file })
    await waitForPerm(hub)
    await waitSent(file)
    h.p.kill('SIGHUP')
    expect(await h.done).toMatchObject({ stdout: '', code: 0 })
    expect(overs(hub)).toEqual([])
    expect(traceOf(file)).toEqual(['hup'])
  })

  test('the call’s own tool_result appears in the transcript: the hook ends quietly and says NOTHING (a subagent’s hook can lock onto Main’s identical call, so a result proves nothing about its own prompt)', async () => {
    const hub = await standInHub()
    const transcript = join(hub.home, 'session.jsonl')
    const file = join(hub.home, 'trace.txt')
    const use = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: CALL.tool_input }] },
    }
    writeFileSync(transcript, `${JSON.stringify(use)}\n`)
    const h = startHook(hub.home, { transcript_path: transcript }, { TALOS_PERMISSION_HOOK_TRACE: file })
    await waitForPerm(hub)
    await sleep(t(1500)) // the watcher has seen the open call
    const result = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    }
    appendFileSync(transcript, `${JSON.stringify(result)}\n`)
    expect(await h.done).toMatchObject({ stdout: '', code: 0 })
    expect(overs(hub)).toEqual([])
    expect(existsSync(file) ? readFileSync(file, 'utf8') : '').toMatch(/ result\n$/) // the trace still says why it ended
    await eventually(() => expect(hub.closed).toHaveLength(1)) // the socket closes: the bridge sees a plain close
  })

  test('a denied or interrupted call is a tool_result too: the same, nothing said', async () => {
    const hub = await standInHub()
    const transcript = join(hub.home, 'session.jsonl')
    const use = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: CALL.tool_input }] },
    }
    writeFileSync(transcript, `${JSON.stringify(use)}\n`)
    const h = startHook(hub.home, { transcript_path: transcript })
    await waitForPerm(hub)
    await sleep(t(1500))
    const result = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            is_error: true,
            content: '[Request interrupted by user for tool use]',
          },
        ],
      },
    }
    appendFileSync(transcript, `${JSON.stringify(result)}\n`)
    await h.done
    expect(overs(hub)).toEqual([])
  })

  test('two identical calls open in the transcript: the watcher stays off, so nothing is said by it', async () => {
    const hub = await standInHub()
    const transcript = join(hub.home, 'session.jsonl')
    const blocks = ['toolu_a', 'toolu_b'].map((id) => ({ type: 'tool_use', id, name: 'Bash', input: CALL.tool_input }))
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { content: blocks } })}\n`)
    const h = startHook(hub.home, { transcript_path: transcript })
    await waitForPerm(hub)
    await sleep(t(1500))
    appendFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'ok' }] } })}\n`,
    )
    await sleep(t(1500))
    expect(overs(hub)).toEqual([])
    h.p.kill('SIGKILL')
    await h.done
  })

  test('Claude Code is gone (the process that started the hook ended): perm_over (parent)', async () => {
    const hub = await standInHub()
    const input = join(hub.home, 'input.json')
    writeFileSync(
      input,
      JSON.stringify({ session_id: 'abc', cwd: '/home/alex', hook_event_name: 'PermissionRequest', ...CALL }),
    )
    // a shell starts the hook, waits a moment and exits: the hook is left with another parent
    const sh = Bun.spawn(['sh', '-c', `python3 "${HOOK}" < "${input}" > /dev/null 2>&1 & sleep 2`], {
      env: { PATH: process.env.PATH ?? '', HOME: '/nonexistent', TALOS_APP_HOME: hub.home },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    cleanup.push(() => {
      try {
        sh.kill('SIGKILL')
      } catch {}
    })
    await waitForPerm(hub)
    await eventually(() => expect(overs(hub)).toHaveLength(1), t(10_000))
    expect(overs(hub)[0]).toEqual({ t: 'perm_over', id: reqId(hub), why: 'parent' })
  })
})

describe('the hook says nothing when it cannot know', () => {
  test('SIGKILL: the hub sees the socket close and no perm_over', async () => {
    const hub = await standInHub()
    const h = startHook(hub.home)
    await waitForPerm(hub)
    h.p.kill('SIGKILL')
    await h.done
    await eventually(() => expect(hub.closed).toHaveLength(1))
    expect(overs(hub)).toEqual([])
  })

  test('the hub closes the connection (eof): quiet exit 0, no perm_over', async () => {
    const hub = await standInHub((_l, sock) => sock.destroy())
    const h = startHook(hub.home)
    expect(await h.done).toMatchObject({ stdout: '', code: 0 })
    expect(overs(hub)).toEqual([])
  })

  test('the hook’s own wait runs out: quiet exit 0, no perm_over', async () => {
    const hub = await standInHub()
    const h = startHook(hub.home, {}, { TALOS_PERMISSION_HOOK_WAIT_S: '0.4' })
    expect(await h.done).toMatchObject({ stdout: '', code: 0 })
    expect(overs(hub)).toEqual([])
  })

  test('the hub answers first: the answer is printed as before and nothing is sent after it', async () => {
    const hub = await standInHub((l, sock) =>
      sock.write(`${JSON.stringify({ t: 'perm_result', id: l.id, decision: 'allow', reason: 'owner' })}\n`),
    )
    const r = await startHook(hub.home).done
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    expect(hub.lines.map((l) => l.t)).toEqual(['perm'])
  })

  test('a deny answer: printed as before, nothing sent after it', async () => {
    const hub = await standInHub((l, sock) =>
      sock.write(`${JSON.stringify({ t: 'perm_result', id: l.id, decision: 'deny', reason: 'owner' })}\n`),
    )
    const r = await startHook(hub.home).done
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior).toBe('deny')
    expect(hub.lines.map((l) => l.t)).toEqual(['perm'])
  })

  test('no hub (nothing listening): quiet exit 0', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ppo-none-')))
    cleanup.push(() => rmSync(home, { recursive: true, force: true }))
    expect(await startHook(home).done).toMatchObject({ stdout: '', code: 0 })
  })

  test('a SIGTERM never makes the hook print a decision or a session rule', async () => {
    const hub = await standInHub()
    const suggestion = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'touch probe-*' }],
      behavior: 'allow',
      destination: 'localSettings',
    }
    const h = startHook(hub.home, { permission_suggestions: [suggestion] })
    await waitForPerm(hub)
    h.p.kill('SIGTERM')
    const r = await h.done
    expect(r.stdout).toBe('')
    expect(r.stdout).not.toContain('updatedPermissions')
  })
})

describe('the trace (off unless asked for)', () => {
  test.each([
    ['term', 'SIGTERM'],
    ['hup', 'SIGHUP'],
  ] as const)('%s is written to the file named by TALOS_PERMISSION_HOOK_TRACE', async (why, sig) => {
    const hub = await standInHub()
    const file = join(hub.home, 'trace.txt')
    const h = startHook(hub.home, {}, { TALOS_PERMISSION_HOOK_TRACE: file })
    await waitForPerm(hub)
    await waitSent(file)
    h.p.kill(sig)
    await h.done
    expect(traceOf(file)).toEqual([why])
  })

  test('eof and timeout are traced too, though nothing is sent', async () => {
    const hub = await standInHub((_l, sock) => sock.destroy())
    const file = join(hub.home, 'trace.txt')
    await startHook(hub.home, {}, { TALOS_PERMISSION_HOOK_TRACE: file }).done
    expect(traceOf(file)).toEqual(['eof'])
    const hub2 = await standInHub()
    const file2 = join(hub2.home, 'trace.txt')
    await startHook(hub2.home, {}, { TALOS_PERMISSION_HOOK_TRACE: file2, TALOS_PERMISSION_HOOK_WAIT_S: '0.4' }).done
    expect(traceOf(file2)).toEqual(['timeout'])
  })

  test('with the variable unset no trace file is written anywhere in the hub folder', async () => {
    const hub = await standInHub()
    const h = startHook(hub.home)
    await waitForPerm(hub)
    h.p.kill('SIGTERM')
    await h.done
    expect(existsSync(join(hub.home, 'trace.txt'))).toBe(false)
  })
})

describe('the stop handler itself (the real code, flag and clock set by hand)', () => {
  const COMMON = resolve(HOOK, '..')
  // Installs the handler on one end of a socket pair, optionally ages the hook and sets the flag, sends this process the signal, and
  // prints what arrived on the other end.
  const script = [
    'import os,signal,socket,sys,time',
    'sys.path.insert(0, sys.argv[1])',
    'import _talos_common as C',
    'a, b = socket.socketpair()',
    'req = {"id": "h_x"}',
    'if sys.argv[2] == "1": req["_out"] = True',
    'C.on_over(a, req)',
    'if float(sys.argv[3]) > 0: C._T0 = time.monotonic() - float(sys.argv[3])',
    'try:',
    '    os.kill(os.getpid(), getattr(signal, sys.argv[4])); time.sleep(2)',
    'except SystemExit:',
    '    pass',
    'b.settimeout(0.3)',
    'try:',
    '    data = b.recv(4096)',
    'except Exception:',
    '    data = b""',
    'print(data.decode(), end="")',
  ].join('\n')
  const handler = (out: boolean, age: number, sig = 'SIGTERM') => {
    const r = Bun.spawnSync(['python3', '-c', script, COMMON, out ? '1' : '0', String(age), sig], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(r.stderr.toString()).toBe('')
    return r.stdout.toString()
  }

  test('a stop says nothing, however young the hook and whether or not its request is out (SIGTERM and SIGHUP)', () => {
    for (const out of [true, false]) for (const sig of ['SIGTERM', 'SIGHUP']) expect(handler(out, 0, sig)).toBe('')
    expect(handler(true, 4000)).toBe('') // nor an old one
  })
})

describe('the hook stays inside its size limit', () => {
  test('kit/hooks/permission-relay.py is at most 1000 lines', () => {
    expect(readFileSync(HOOK, 'utf8').split('\n').length - 1).toBeLessThanOrEqual(1000)
  })
})
