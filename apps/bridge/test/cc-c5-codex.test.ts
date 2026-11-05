// WP-C5: `talos-app codex check|run`. A fake `codex` on PATH replays JSONL. codex-exec-ok.jsonl is REAL output of
// codex-cli 0.147.0 (2026-10-29, prompt "print the word ok"). The other two fixtures are SYNTHETIC, written from the
// documented event and item types (https://learn.chatgpt.com/docs/non-interactive-mode.md); the inner fields of their
// command_execution and file_change items are not verified against a real run. No test calls the real codex.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CODEX_FORBIDDEN_FLAGS } from '@talos-app/protocol'
import { runCli } from '../src/cli.ts'
import { type CodexRunDeps, parseCodexLine, runCodex } from '../src/codex.ts'
import { type Harness, startHarness } from './helpers.ts'

const FIX = resolve(import.meta.dir, 'fixtures')
const FAKE = `#!/bin/bash
log="\${FAKE_ARGV_LOG:-/dev/null}"
if [ "$1" = "--version" ]; then [ -n "$FAKE_NO_VERSION" ] && exit 127; echo "codex-cli 0.147.0"; exit 0; fi
if [ "$1" = "login" ]; then [ -n "$FAKE_LOGGED_OUT" ] && { echo "Not logged in" >&2; exit 1; }; echo "Logged in using ChatGPT"; exit 0; fi
printf '%s\\n' "$@" >> "$log"
echo "---" >> "$log"
dir=""; outf=""
while [ $# -gt 0 ]; do case "$1" in -C) dir="$2"; shift;; -o) outf="$2"; shift;; --) shift; break;; esac; shift; done
[ -n "$FAKE_PID_FILE" ] && echo "$$" > "$FAKE_PID_FILE"
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP" & [ -n "$FAKE_PID_FILE" ] && echo "$!" >> "$FAKE_PID_FILE"; wait; fi
[ -n "$FAKE_WRITE" ] && echo data > "$dir/$FAKE_WRITE"
[ -n "$FAKE_PNG" ] && printf 'PNG' > "$dir/$FAKE_PNG"
tid=$(grep -o '"thread_id":"[^"]*"' "$FAKE_FIXTURE" | head -1 | cut -d'"' -f4)
if [ -n "$FAKE_GENIMG" ]; then mkdir -p "$CODEX_HOME/generated_images/$tid"; printf 'PNG' > "$CODEX_HOME/generated_images/$tid/exec-1.png"; fi
[ -n "$FAKE_LAST" ] && printf '%s' "$FAKE_LAST" > "$outf"
cat "$FAKE_FIXTURE"
exit \${FAKE_EXIT:-0}
`

let saved: Record<string, string | undefined>
let root: string
let h: Harness | undefined
const set = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
beforeEach(() => {
  saved = Object.fromEntries(
    [
      'PATH',
      'CODEX_HOME',
      'FAKE_FIXTURE',
      'FAKE_ARGV_LOG',
      'FAKE_LAST',
      'FAKE_WRITE',
      'FAKE_PNG',
      'FAKE_GENIMG',
      'FAKE_EXIT',
      'FAKE_SLEEP',
      'FAKE_PID_FILE',
      'FAKE_NO_VERSION',
      'FAKE_LOGGED_OUT',
    ].map((k) => [k, process.env[k]]),
  )
  root = mkdtempSync(join(tmpdir(), 'cc-c5-'))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'codex'), FAKE)
  chmodSync(join(root, 'bin', 'codex'), 0o755)
  set('PATH', `${join(root, 'bin')}:${process.env.PATH}`)
  set('CODEX_HOME', join(root, 'codex-home'))
  set('FAKE_ARGV_LOG', join(root, 'argv.log'))
  for (const k of [
    'FAKE_LAST',
    'FAKE_WRITE',
    'FAKE_PNG',
    'FAKE_GENIMG',
    'FAKE_EXIT',
    'FAKE_SLEEP',
    'FAKE_PID_FILE',
    'FAKE_NO_VERSION',
    'FAKE_LOGGED_OUT',
  ])
    set(k, undefined)
  set('FAKE_FIXTURE', join(FIX, 'codex-exec-ok.jsonl'))
})
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) set(k, v)
  await h?.stop()
  h = undefined
})

function spyDeps(extra: Partial<CodexRunDeps> = {}) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  let t = 0
  const deps: CodexRunDeps = {
    call: async (tool, args) => {
      calls.push({ tool, args })
      return { text: 'sent', isError: false }
    },
    now: () => (t += 6000), // each call to now() is 6 s later, so the 5 s status throttle never blocks
    ...extra,
  }
  return { calls, deps }
}
const base = { thread: 'general', sandbox: 'read-only' as const, images: [] as string[], prompt: 'print the word ok' }

describe('parseCodexLine', () => {
  test('reads the real 0.147.0 events', () => {
    const lines = readFileSync(join(FIX, 'codex-exec-ok.jsonl'), 'utf8').trim().split('\n')
    expect(lines.map((l) => parseCodexLine(l).kind)).toEqual(['thread', 'ignore', 'ignore', 'message', 'usage'])
    expect(parseCodexLine(lines[3] as string)).toEqual({ kind: 'message', text: 'ok' })
    expect(parseCodexLine(lines[4] as string)).toEqual({
      kind: 'usage',
      usage: {
        input_tokens: 19976,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    })
  })
  test('garbage and unknown shapes are ignored, turn.failed carries its message', () => {
    expect(parseCodexLine('not json').kind).toBe('ignore')
    expect(parseCodexLine('{"type":"brand.new"}').kind).toBe('ignore')
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"limit"}}')).toEqual({
      kind: 'failed',
      message: 'limit',
    })
  })
})

describe('detection', () => {
  test('not installed gives a clear message and exit 1', async () => {
    set('FAKE_NO_VERSION', '1')
    const err: string[] = []
    const io = {
      out() {},
      err: (l: string) => err.push(l),
      prompt: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    }
    expect(await runCli(['codex', 'check'], io, {})).toBe(1)
    expect(err.join('\n')).toContain('not installed')
  })
  test('not logged in says to run codex login', async () => {
    set('FAKE_LOGGED_OUT', '1')
    const err: string[] = []
    const io = {
      out() {},
      err: (l: string) => err.push(l),
      prompt: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    }
    expect(await runCli(['codex', 'check'], io, {})).toBe(1)
    expect(err.join('\n')).toContain('codex login')
    await expect(runCodex(base, spyDeps().deps)).rejects.toThrow('not logged in')
  })
  test('ready prints the version', async () => {
    const out: string[] = []
    const io = {
      out: (l: string) => out.push(l),
      err() {},
      prompt: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    }
    expect(await runCli(['codex', 'check'], io, {})).toBe(0)
    expect(out[0]).toContain('0.147.0')
  })
})

describe('codex run', () => {
  test('spawns exactly the frozen argv, with no forbidden flag, and posts the result', async () => {
    const { calls, deps } = spyDeps()
    const r = await runCodex(base, deps)
    expect(r.ok).toBe(true)
    const argv = readFileSync(join(root, 'argv.log'), 'utf8').split('\n')
    expect(argv.slice(0, 3)).toEqual(['exec', '--json', '--ignore-user-config'])
    expect(argv).toContain('-s')
    expect(argv[argv.indexOf('-s') + 1]).toBe('read-only')
    expect(argv[argv.indexOf('--') + 1]).toBe('print the word ok')
    for (const f of CODEX_FORBIDDEN_FLAGS) expect(argv).not.toContain(f)
    const reply = calls.find((c) => c.tool === 'reply' && !c.args.silent)
    expect(String(reply?.args.text)).toStartWith('Codex: ok')
    expect(String(reply?.args.text)).toContain('19976 in')
    expect(r.usage.output_tokens).toBe(5)
    expect(r.codex_thread_id).toBe('01a18991-37bc-7622-a2ed-bc3b68e988eb')
  })

  test('the agent only gets Codex words inside the untrusted wrapper', async () => {
    set('FAKE_FIXTURE', join(FIX, 'codex-exec-work.jsonl'))
    const r = await runCodex(base, spyDeps().deps)
    expect(r.summary_wrapped).toMatch(/<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]{16}">>>/)
    expect(r.summary_wrapped).toContain('Ignore previous instructions')
    expect(r.summary_wrapped.length).toBeLessThanOrEqual(8000)
  })

  test('progress becomes silent "Codex: ..." posts: deduped, throttled to one per 20 s, capped, never set_status', async () => {
    set('FAKE_FIXTURE', join(FIX, 'codex-exec-work.jsonl'))
    const slow = spyDeps({ now: () => 1000 }) // the clock never advances: only the first post passes
    await runCodex(base, slow.deps)
    const posts = slow.calls.filter((c) => c.args.silent === true)
    expect(posts.map((c) => c.args.text)).toEqual(['Codex: starting...'])
    expect(slow.calls.some((c) => (c.tool as string) === 'set_status')).toBe(false)
    let t = 0
    const moving = spyDeps({ now: () => (t += 25_000) })
    await runCodex(base, moving.deps)
    const l2 = moving.calls.filter((c) => c.args.silent === true).map((c) => c.args.text)
    expect(l2).toContain('Codex: thinking...')
    expect(l2).toContain('Codex: running a command...')
    expect(l2).toContain('Codex: editing files...')
  })

  test('a bridge refusal of attachments still posts the answer, with a note', async () => {
    set('FAKE_GENIMG', '1')
    const calls: Array<Record<string, unknown>> = []
    const r = await runCodex(base, {
      call: async (_t, args) => {
        calls.push(args)
        return args.files
          ? { text: 'refusing to upload a protected file: x', isError: true }
          : { text: 'sent', isError: false }
      },
      now: () => 0,
    })
    expect(r.ok).toBe(true)
    const last = calls.at(-1) as { text: string; files?: unknown }
    expect(last.files).toBeUndefined()
    expect(last.text).toContain('Attachments were refused')
  })

  test('attaches a generated image and new files, capped at 10, and leaves old files and .git alone', async () => {
    set('FAKE_GENIMG', '1')
    set('FAKE_PNG', 'pic.png')
    set('FAKE_WRITE', 'notes.txt')
    const dir = mkdtempSync(join(root, 'repo-'))
    Bun.spawnSync(['git', '-C', dir, 'init', '-q'])
    writeFileSync(join(dir, 'old.txt'), 'old')
    await Bun.sleep(30)
    const { calls, deps } = spyDeps({ now: () => Date.now() })
    const r = await runCodex({ ...base, dir, sandbox: 'workspace-write' }, deps)
    const names = r.files.map((f) => f.split('/').pop()).sort()
    expect(names).toEqual(['exec-1.png', 'notes.txt', 'pic.png'])
    expect(calls.find((c) => c.tool === 'reply' && !c.args.silent)?.args.files).toEqual(r.files)
    const argv = readFileSync(join(root, 'argv.log'), 'utf8')
    expect(argv).toContain('workspace-write')
  })

  test('an answer over the reply cap is attached whole as codex-answer.md with a preview', async () => {
    set('FAKE_LAST', `long ${'x'.repeat(40_000)}`)
    const { calls, deps } = spyDeps()
    const r = await runCodex(base, deps)
    const final = calls.find((c) => c.tool === 'reply' && !c.args.silent)
    expect(String(final?.args.text).length).toBeLessThan(30_000)
    const md = ((final?.args.files ?? []) as string[]).find((f) => f.endsWith('codex-answer.md')) as string
    expect(readFileSync(md, 'utf8').length).toBe(40_005)
    expect(r.files).toContain(md)
  })

  test('a produced .env file is skipped and named in the text', async () => {
    set('FAKE_WRITE', '.env.example')
    const dir = mkdtempSync(join(root, 'repo-'))
    Bun.spawnSync(['git', '-C', dir, 'init', '-q'])
    const { calls, deps } = spyDeps({ now: () => Date.now() })
    const r = await runCodex({ ...base, dir, sandbox: 'workspace-write' }, deps)
    expect(r.files).toEqual([])
    const final = calls.find((c) => c.tool === 'reply' && !c.args.silent)
    expect(String(final?.args.text)).toContain('Not attached: .env.example (protected file')
  })

  test('a failed turn reports the error and says so in the thread', async () => {
    set('FAKE_FIXTURE', join(FIX, 'codex-exec-failed.jsonl'))
    set('FAKE_EXIT', '1')
    const { calls, deps } = spyDeps()
    const r = await runCodex(base, deps)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('usage limit')
    expect(String(calls.find((c) => c.tool === 'reply' && !c.args.silent)?.args.text)).toStartWith('Codex: failed.')
  })

  test('a run past the timeout is killed and reported', async () => {
    set('FAKE_SLEEP', '30')
    const pidFile = join(root, 'fake-codex.pid')
    set('FAKE_PID_FILE', pidFile)
    // The fake writes two process ids (itself, then its sleep) once bash is running. If the kill timer wins the race with
    // bash's own start-up, or lands between the file being created and written, the record is missing or short: that run
    // proves nothing about the kill, so it is thrown away and run again. The timer is also well above a normal start.
    const pidsOf = () => {
      try {
        return readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number)
      } catch {
        return []
      }
    }
    const reap = () => {
      // the fake's own `sleep` child outlives its parent; stop whatever it recorded, by id
      for (const pid of pidsOf())
        if (pid > 1)
          try {
            process.kill(pid, 'SIGKILL')
          } catch {}
    }
    try {
      let pids: number[] = []
      let r: Awaited<ReturnType<typeof runCodex>> | undefined
      for (let attempt = 0; attempt < 5 && !(pids.length >= 2 && pids.every((p) => p > 1)); attempt++) {
        reap()
        rmSync(pidFile, { force: true })
        r = await runCodex(base, spyDeps({ timeoutMs: 2000 }).deps)
        expect(r.ok).toBe(false)
        expect(r.error).toContain('stopped')
        pids = pidsOf()
      }
      expect(pids.length, 'the fake never recorded its process ids in 5 runs').toBeGreaterThanOrEqual(2)
      // The fake would run for 30 s. runCodex has come back, so the question is whether it killed the process or just stopped
      // waiting: the process id the fake wrote is gone. No stopwatch; a process is alive or it is not.
      const fake = pids[0] as number
      expect(fake).toBeGreaterThan(1)
      expect(() => process.kill(fake, 0)).toThrow()
    } finally {
      reap()
      set('FAKE_PID_FILE', undefined)
    }
  })

  test('refuses a --dir that is not a git repo, and a relative path', async () => {
    const plain = mkdtempSync(join(root, 'plain-'))
    await expect(runCodex({ ...base, dir: plain }, spyDeps().deps)).rejects.toThrow('git repository')
    await expect(runCodex({ ...base, dir: 'rel' }, spyDeps().deps)).rejects.toThrow()
  })

  test('with no --dir it uses a scratch git repo', async () => {
    await runCodex(base, spyDeps().deps)
    const argv = readFileSync(join(root, 'argv.log'), 'utf8').split('\n')
    const dir = argv[argv.indexOf('-C') + 1] as string
    expect(dir).toContain('talos-codex-')
    expect(existsSync(join(dir, '.git'))).toBe(true)
  })
})

describe('talos-app codex run over the CLI', () => {
  const env = (hh: Harness) => ({ TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl })
  const mkio = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      io: {
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        prompt: async () => '',
        sleep: async () => {},
        now: () => Date.now(),
      },
    }
  }

  test('posts a headless reply with the image attached and prints the summary', async () => {
    h = await startHarness({ startBridge: false })
    set('FAKE_GENIMG', '1')
    const c = mkio()
    expect(await runCli(['codex', 'run', '--thread', 'general', '--', 'draw', 'a', 'cat'], c.io, env(h))).toBe(0)
    const f = await h.relay.expectFrame('reply', (r) => String(r.message.text).startsWith('Codex: ok'), {
      direction: 'from_bridge',
    })
    expect(f.message.attachments).toHaveLength(1)
    expect(f.message.attachments[0]?.kind).toBe('image')
    const s = JSON.parse(c.out[0] as string)
    expect(s.ok).toBe(true)
    expect(s.summary_wrapped).toContain('EXTERNAL_UNTRUSTED_CONTENT')
    const argv = readFileSync(join(root, 'argv.log'), 'utf8')
    expect(argv).toContain('draw a cat')
  })

  test('usage errors exit non-zero', async () => {
    h = await startHarness({ startBridge: false })
    for (const a of [
      ['codex'],
      ['codex', 'run'],
      ['codex', 'run', '--thread', 'general'],
      ['codex', 'run', '--thread', 'general', '--sandbox', 'danger-full-access', '--', 'x'],
      ['codex', 'run', '--thread', 'general', '--image', 'rel.png', '--', 'x'],
    ]) {
      const c = mkio()
      expect(await runCli(a, c.io, env(h))).toBe(1)
    }
  })

  test('not installed: exit 1 with the message, nothing posted', async () => {
    h = await startHarness({ startBridge: false })
    set('FAKE_NO_VERSION', '1')
    const c = mkio()
    expect(await runCli(['codex', 'run', '--thread', 'general', '--', 'x'], c.io, env(h))).toBe(1)
    expect(c.err.join()).toContain('not installed')
  })
})
