// ci-requires: tmux
// (CI deals this file only to a machine that has tmux 3.2+: docs/CI-MACHINES.md, "Tools a test file needs".)
// `talos-app supervise`: its settings file, its lock, its unit and its tmux.conf. The running loop is main.ts's (main.test.ts).
import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadExampleConfig, tmuxTestPrefix } from '@talos-app/testkit'
import { openHistory } from '../../src/history-store.ts'
import {
  cmdSupervise,
  conversationEmpty,
  holdsLock,
  loginShellEnv,
  MAC_SUPERVISE_LINE,
  mainClaudeDir,
  markConversationSeen,
  mcpLogReason,
  parseLoginEnv,
  readSupervisorConfig,
  releaseLock,
  resolveOnPath,
  SUPERVISOR_FILES,
  saveSessionId,
  sessionSaved,
  superviseHost,
  systemdUnit,
  TMUX_CONF,
  takeLock,
} from '../../src/supervisor/cli.ts'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'talos-sup-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('supervisor.json', () => {
  it('needs only the agent folder; the rest has the defaults, and ~ is the owner’s home', () => {
    const home = tmp()
    writeFileSync(join(home, SUPERVISOR_FILES.config), JSON.stringify({ agent_dir: '~/agent' }))
    expect(readSupervisorConfig(home, '/home/alex')).toEqual({
      agentDir: '/home/alex/agent',
      claudePath: 'auto',
      args: ['--dangerously-load-development-channels', 'server:talos-app'],
      env: {},
      host: 'tmux',
      autoRestart: true,
      autoConfirmRestart: true,
      startOnLaunch: true,
      workers: true,
      session: { id: null, previousIds: [], conversationSeen: false },
    })
  })
  it('a missing file, bad JSON or no agent folder is an error, never the defaults', () => {
    const home = tmp()
    expect(readSupervisorConfig(home, '/home/alex')).toMatchObject({ error: expect.stringContaining('agent_dir') })
    writeFileSync(join(home, SUPERVISOR_FILES.config), '{nope')
    expect(readSupervisorConfig(home, '/home/alex')).toMatchObject({ error: expect.stringContaining('not valid JSON') })
    writeFileSync(join(home, SUPERVISOR_FILES.config), '{}')
    expect(readSupervisorConfig(home, '/home/alex')).toMatchObject({ error: expect.stringContaining('agent_dir') })
  })
  it('a new session id keeps every other field as the owner wrote it, and the old id joins previous_ids', () => {
    const home = tmp()
    const path = join(home, SUPERVISOR_FILES.config)
    writeFileSync(path, JSON.stringify({ agent_dir: '/a', mine: 1, session: { id: 'old' } }))
    saveSessionId(home, 'new')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      agent_dir: '/a',
      mine: 1,
      session: { id: 'new', previous_ids: ['old'], conversation_seen: false },
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('one supervisor per Talos home', () => {
  it('the lock is refused while its holder lives, and taken over from a dead one', () => {
    const home = tmp()
    const live: Record<number, string> = { [process.pid]: 'me' }
    expect(takeLock(home, (p) => live[p] ?? null)).toBe(true)
    expect(takeLock(home, (p) => live[p] ?? null)).toBe(false) // a second supervisor (here: the same pid) is refused
    writeFileSync(join(home, SUPERVISOR_FILES.lock), JSON.stringify({ pid: 999_999, start: 'gone' }))
    expect(takeLock(home, (p) => live[p] ?? null)).toBe(true)
    // a reused pid with another start time is not the holder
    writeFileSync(join(home, SUPERVISOR_FILES.lock), JSON.stringify({ pid: process.pid, start: 'an-older-process' }))
    expect(takeLock(home, (p) => live[p] ?? null)).toBe(true)
    releaseLock(home, (p) => live[p] ?? null)
    expect(() => statSync(join(home, SUPERVISOR_FILES.lock))).toThrow()
  })
  it('a lock is never taken when this process’s own start cannot be read, and a lost race steps back', () => {
    const home = tmp()
    expect(takeLock(home, () => null)).toBe(false)
    const live: Record<number, string> = { [process.pid]: 'me' }
    expect(takeLock(home, (p) => live[p] ?? null)).toBe(true)
    expect(holdsLock(home, (p) => live[p] ?? null)).toBe(true)
    // another supervisor took it over in between (its own pid and token now in the file)
    writeFileSync(join(home, SUPERVISOR_FILES.lock), JSON.stringify({ pid: 4242, start: 'other' }))
    expect(holdsLock(home, (p) => live[p] ?? null)).toBe(false)
    releaseLock(home, (p) => live[p] ?? null)
    expect(statSync(join(home, SUPERVISOR_FILES.lock)).isFile()).toBe(true) // never removes someone else's
  })
})

describe('the owner’s login environment', () => {
  it('only what follows the marker counts: a profile that prints a greeting cannot corrupt a variable', () => {
    const out = 'Welcome to the box\n__TALOS_LOGIN_ENV__\0SHELL=/bin/bash\0PATH=/home/alex/.bun/bin:/usr/bin\0'
    expect(parseLoginEnv(out)).toEqual({ SHELL: '/bin/bash', PATH: '/home/alex/.bun/bin:/usr/bin' })
    expect(parseLoginEnv('no marker here')).toBeNull()
  })
  it('a missing shell is no environment, never a crash', () => {
    expect(loginShellEnv('/nonexistent/shell')).toBeNull()
  })
  it('reads the interactive rc files too (where installers put PATH lines)', () => {
    const home = tmp()
    writeFileSync(join(home, '.bash_profile'), 'export FROM_PROFILE=1\n[ -f ~/.bashrc ] && . ~/.bashrc\n')
    writeFileSync(join(home, '.bashrc'), 'echo hello from rc\nexport FROM_RC=1\n')
    const env = loginShellEnv('/bin/bash', { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' })
    expect(env?.FROM_PROFILE).toBe('1')
    expect(env?.FROM_RC).toBe('1')
  })
})

describe('supervisor.json types', () => {
  it('a field of the wrong type, or a relative agent folder, is an error, never the default', () => {
    const home = tmp()
    const write = (o: unknown) => writeFileSync(join(home, SUPERVISOR_FILES.config), JSON.stringify(o))
    for (const bad of [
      { agent_dir: '/a', auto_restart: 'false' },
      { agent_dir: '/a', args: '--x' },
      { agent_dir: '/a', env: { A: 1 } },
      { agent_dir: 'agent' },
      [1, 2],
    ]) {
      write(bad)
      expect(readSupervisorConfig(home, '/home/alex')).toHaveProperty('error')
    }
  })
  it('previous_ids keeps the last five', () => {
    const home = tmp()
    writeFileSync(join(home, SUPERVISOR_FILES.config), JSON.stringify({ agent_dir: '/a' }))
    for (let i = 0; i < 8; i++) saveSessionId(home, `id${i}`)
    const o = JSON.parse(readFileSync(join(home, SUPERVISOR_FILES.config), 'utf8'))
    expect(o.session).toEqual({
      id: 'id7',
      previous_ids: ['id2', 'id3', 'id4', 'id5', 'id6'],
      conversation_seen: false,
    })
  })
})

describe('the rest', () => {
  it('the tmux.conf it writes is the Mac’s, byte for byte', () => {
    expect(TMUX_CONF).toBe(readFileSync(resolve(import.meta.dir, '../../../desktop/Resources/tmux.conf'), 'utf8'))
  })
  it('every key it unbinds by name is unbound with -q: a tmux that does not know the name stores no error (tmux 3.4, Titan)', () => {
    const named = TMUX_CONF.split('\n').filter((l) => /^unbind-key\b/.test(l) && !/\s-a\b/.test(l))
    expect(named.length).toBeGreaterThanOrEqual(9)
    for (const l of named) expect(l, l).toMatch(/^unbind-key -qn \S+$/)
  })
  it.skipIf(!Bun.which('tmux'))(
    'this computer’s tmux reads the whole file with no error (what a first attach would show)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'tmux-conf-'))
      const conf = join(dir, 'tmux.conf')
      writeFileSync(conf, TMUX_CONF)
      const sock = `${tmuxTestPrefix()}-conf-check-${process.pid}`
      const tmux = (...a: string[]) => Bun.spawnSync(['tmux', '-L', sock, ...a], { stdout: 'pipe', stderr: 'pipe' })
      try {
        expect(tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'x', 'sleep 30').exitCode).toBe(0)
        const r = tmux('source-file', conf)
        expect(`${r.stdout.toString()}${r.stderr.toString()}`).toBe('')
        expect(r.exitCode).toBe(0)
      } finally {
        tmux('kill-server')
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
  it('the systemd unit keeps Main alive across supervisor restarts (KillMode=process) and quotes its paths', () => {
    const u = systemdUnit(
      '/home/alex/.bun/bin/bun',
      '/home/alex/talos app/apps/bridge/src/cli.ts',
      '/home/alex/.config/talos/app',
    )
    expect(u).toContain('KillMode=process')
    expect(u).toContain('RestartPreventExitStatus=3') // a refused second supervisor is not respawned
    expect(u).toContain('ExecStart="/home/alex/.bun/bin/bun" "/home/alex/talos app/apps/bridge/src/cli.ts" supervise')
    expect(u).toContain('Environment=TALOS_APP_HOME="/home/alex/.config/talos/app"')
    expect(u).toContain('WantedBy=default.target')
    // systemd expands % and $ in these values: doubled
    expect(systemdUnit('/b', '/x/100%/$HOME/cli.ts', '/h')).toContain('"/x/100%%/$$HOME/cli.ts"')
  })
  it('finds a program on PATH, and takes an absolute path only when it is an executable file', () => {
    const d = tmp()
    mkdirSync(join(d, 'bin'))
    writeFileSync(join(d, 'bin', 'claude'), '#!/bin/sh\n')
    chmodSync(join(d, 'bin', 'claude'), 0o755)
    writeFileSync(join(d, 'bin', 'plain'), '')
    expect(resolveOnPath('auto', { PATH: `/nope:${join(d, 'bin')}` })).toBe(join(d, 'bin', 'claude'))
    expect(resolveOnPath(join(d, 'bin', 'claude'), {})).toBe(join(d, 'bin', 'claude'))
    expect(resolveOnPath(join(d, 'bin', 'plain'), {})).toBeNull()
    expect(resolveOnPath('plain', { PATH: join(d, 'bin') })).toBeNull()
    expect(resolveOnPath('auto', {})).toBeNull()
  })
})

describe('why the bridge did not start (Claude Code’s MCP log)', () => {
  it('the newest log’s newest error, else its newest debug line; nothing is null', () => {
    const cache = tmp()
    expect(mcpLogReason('/home/alex/agent', cache)).toBeNull()
    const dir = join(cache, 'claude-cli-nodejs', '-home-alex-agent', 'mcp-logs-talos-app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-11-09.jsonl'), `${JSON.stringify({ error: 'old error' })}\n`)
    writeFileSync(
      join(dir, '2026-11-10.jsonl'),
      [JSON.stringify({ debug: 'starting' }), JSON.stringify({ debug: 'spawned' }), 'not json'].join('\n'),
    )
    expect(mcpLogReason('/home/alex/agent', cache)).toBe('spawned')
    writeFileSync(
      join(dir, '2026-11-10.jsonl'),
      [JSON.stringify({ error: 'ENOENT bun' }), JSON.stringify({ debug: 'later' })].join('\n'),
    )
    expect(mcpLogReason('/home/alex/agent', cache)).toBe('ENOENT bun')
  })
  it('real names (several a day) sort newest first; a linked agent folder is found by its real path', () => {
    const cache = tmp()
    const root = tmp()
    mkdirSync(join(root, 'real-agent'))
    symlinkSync(join(root, 'real-agent'), join(root, 'agent'))
    const real = realpathSync(join(root, 'real-agent'))
    const dir = join(cache, 'claude-cli-nodejs', real.replace(/[^A-Za-z0-9]/g, '-'), 'mcp-logs-talos-app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-11-10T09-00-00-000Z.jsonl'), `${JSON.stringify({ error: 'morning' })}\n`)
    writeFileSync(join(dir, '2026-11-10T14-38-32-713Z.jsonl'), `${JSON.stringify({ error: 'afternoon' })}\n`)
    expect(mcpLogReason(join(root, 'agent'), cache)).toBe('afternoon')
  })
})

describe('has Claude Code saved this session', () => {
  const id = '36d554fe-e999-4203-93db-ebaaa3a2a2f2'
  it('finds <config>/projects/<real folder>/<id>.jsonl, and the id in any other folder (a hashed long name, a moved agent)', () => {
    const cfg = tmp()
    const agent = tmp()
    expect(sessionSaved(agent, id, cfg)).toBe(false)
    const dir = join(cfg, 'projects', `-${'x'.repeat(200)}-1abc2`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), '{}\n')
    expect(sessionSaved(agent, id, cfg)).toBe(true)
  })
  it('an id that is not a UUID is never looked up and counts as saved (it is resumed)', () => {
    expect(sessionSaved(tmp(), '../../etc/passwd', tmp())).toBe(true)
    expect(sessionSaved(tmp(), 'gone', tmp())).toBe(true)
  })
  it('a transcript with no user or assistant line has no conversation', () => {
    const cfg = tmp()
    const agent = tmp()
    const dir = join(cfg, 'projects', realpathSync(agent).replace(/[^A-Za-z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'summary' })}\n`)
    expect(conversationEmpty(agent, id, cfg)).toBe(true)
    // an /exit before anything was typed: meta and command-only user lines
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'user', isMeta: true, message: { content: 'Caveat: ...' } }),
        JSON.stringify({
          type: 'user',
          message: { content: '<command-name>/exit</command-name><command-args></command-args>' },
        }),
        JSON.stringify({ type: 'user', message: { content: '<local-command-stdout>Bye!</local-command-stdout>' } }),
      ].join('\n'),
    )
    expect(conversationEmpty(agent, id, cfg)).toBe(true)
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', message: { content: 'hello' } })}\n`)
    expect(conversationEmpty(agent, id, cfg)).toBe(false)
    expect(conversationEmpty(agent, '11111111-2222-3333-4444-555555555555', cfg)).toBe(false)
  })
  it('Main’s config folder is its own CLAUDE_CONFIG_DIR (absolute), else ~/.claude', () => {
    expect(mainClaudeDir({ CLAUDE_CONFIG_DIR: '/home/alex/.claude-work' }, '/home/alex')).toBe(
      '/home/alex/.claude-work',
    )
    expect(mainClaudeDir({}, '/home/alex')).toBe('/home/alex/.claude')
    expect(mainClaudeDir({ CLAUDE_CONFIG_DIR: 'relative' }, '/home/alex')).toBe('/home/alex/.claude')
  })
})

describe('a conversation was seen (session.conversation_seen, the Mac’s name)', () => {
  const X = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
  const Y = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'
  it('is recorded for the configured id only, replaces the old had_turn, and a new id starts without it', () => {
    const home = tmp()
    const path = join(home, SUPERVISOR_FILES.config)
    writeFileSync(path, JSON.stringify({ agent_dir: '/a', session: { id: X } }))
    markConversationSeen(home, 'other')
    expect(JSON.parse(readFileSync(path, 'utf8')).session.conversation_seen).toBeUndefined()
    markConversationSeen(home, X)
    expect(JSON.parse(readFileSync(path, 'utf8')).session).toEqual({ id: X, conversation_seen: true })
    expect(readSupervisorConfig(home, '/home/alex')).toMatchObject({ session: { id: X, conversationSeen: true } })
    saveSessionId(home, Y)
    expect(JSON.parse(readFileSync(path, 'utf8')).session).toEqual({
      id: Y,
      previous_ids: [X],
      conversation_seen: false,
    })
  })
  it('still reads had_turn, which this supervisor wrote before, and writes only conversation_seen', () => {
    const home = tmp()
    const path = join(home, SUPERVISOR_FILES.config)
    writeFileSync(path, JSON.stringify({ agent_dir: '/a', session: { id: X, had_turn: true } }))
    expect(readSupervisorConfig(home, '/home/alex')).toMatchObject({ session: { conversationSeen: true } })
    writeFileSync(path, JSON.stringify({ agent_dir: '/a', session: { id: X, had_turn: false } }))
    markConversationSeen(home, X)
    expect(JSON.parse(readFileSync(path, 'utf8')).session).toEqual({ id: X, conversation_seen: true })
    writeFileSync(path, JSON.stringify({ agent_dir: '/a', session: { id: X, conversation_seen: 'yes' } }))
    expect(readSupervisorConfig(home, '/home/alex')).toHaveProperty('error')
  })
  it('supervisor.json’s env may not name the token or its file: they are the tray’s, read by the launch (Fable)', () => {
    const home = tmp()
    const path = join(home, SUPERVISOR_FILES.config)
    for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'TALOS_APP_OAUTH_TOKEN_FILE']) {
      writeFileSync(path, JSON.stringify({ agent_dir: '/a', env: { [k]: '/home/talos/x' } }))
      expect(readSupervisorConfig(home, '/home/alex'), k).toMatchObject({ error: expect.stringContaining(k) })
    }
  })
  it('a session id that is not a UUID (a flag, a path) is refused: it would reach Claude Code’s argv (Fable R3-4)', () => {
    const home = tmp()
    const path = join(home, SUPERVISOR_FILES.config)
    for (const session of [
      { id: '--dangerously-skip-permissions' },
      { id: '--settings=/home/talos/x.json' },
      { id: 'ABCDEF01-1111-4111-8111-aaaaaaaaaaaa' },
      // a UUID with a trailing newline or space (Python's `$` takes the newline; this check never does)
      { id: `${X}\n` },
      { id: `${X}\r\n` },
      { id: ` ${X}` },
      { id: X, previous_ids: [X, '-c'] },
    ]) {
      writeFileSync(path, JSON.stringify({ agent_dir: '/a', session }))
      expect(readSupervisorConfig(home, '/home/alex'), JSON.stringify(session)).toHaveProperty('error')
    }
    writeFileSync(path, JSON.stringify({ agent_dir: '/a', session: { id: X, previous_ids: [Y] } }))
    expect(readSupervisorConfig(home, '/home/alex')).not.toHaveProperty('error')
  })
})

// P3d3: the commands the thread-session notices name. restart-thread goes through the running supervisor's own path (a control
// wake); attach is the tmux command onto the thread's session.
describe('supervise restart-thread and attach', () => {
  const io = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } as never }
  }
  const world = (dedicated = true) => {
    const home = tmp()
    const agent = join(home, 'agent')
    mkdirSync(agent)
    writeFileSync(join(home, SUPERVISOR_FILES.config), JSON.stringify({ agent_dir: agent }))
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        default_thread: 'general',
        dedicated: { enabled: dedicated },
        threads: [
          { id: 'general', kind: 'fixed' },
          { id: 'inbox', kind: 'system' },
          { id: 'trip', kind: 'user', session: 'dedicated', session_opts: { cwd: agent } },
        ],
      }),
    )
    return { home, env: { home, userHome: home } as never }
  }
  const readsControl = (home: string) =>
    writeFileSync(
      join(home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true, reads_control: true },
        threads: {},
      }),
    )
  it('without the supervisor saying it reads `control`, the restart goes into `wake` as it always did', async () => {
    const w = world()
    expect(takeLock(w.home)).toBe(true)
    expect(await cmdSupervise(w.env, ['restart-thread', 'trip'], io().io)).toBe(0)
    expect(JSON.parse(readFileSync(join(w.home, 'workers', 'trip', 'wake'), 'utf8'))).toMatchObject({
      action: 'restart',
    })
    expect(existsSync(join(w.home, 'workers', 'trip', 'control'))).toBe(false)
    releaseLock(w.home)
  })
  it('asks the running supervisor to restart one thread session: a control wake, its normal park-then-start', async () => {
    const w = world()
    expect(takeLock(w.home)).toBe(true)
    readsControl(w.home)
    const c = io()
    expect(await cmdSupervise(w.env, ['restart-thread', 'trip'], c.io)).toBe(0)
    const wake = JSON.parse(readFileSync(join(w.home, 'workers', 'trip', 'control'), 'utf8'))
    expect(wake).toMatchObject({ thread_id: 'trip', action: 'restart', reason: 'control' })
    expect(existsSync(join(w.home, 'workers', 'trip', 'wake'))).toBe(false) // a control never writes a wake
    releaseLock(w.home)
  })
  it('stop and start: said as taken only when the running supervisor took the request, else said not taken (Fable R1-4)', async () => {
    const w = world()
    expect(takeLock(w.home)).toBe(true)
    const control = join(w.home, SUPERVISOR_FILES.control)
    // a supervisor that takes it: the file is gone within its next look
    let c = io()
    const took = setTimeout(() => rmSync(control, { force: true }), 600)
    expect(await cmdSupervise(w.env, ['stop'], c.io)).toBe(0)
    clearTimeout(took)
    expect(c.out.join('\n')).toContain('the supervisor took the request to stop Main')
    // one that does not: nothing is claimed, and the request is not left behind for a later supervisor
    c = io()
    expect(await cmdSupervise(w.env, ['start'], c.io)).toBe(1)
    expect(c.err.join('\n')).toContain('did not take the request')
    expect(existsSync(control)).toBe(false)
    releaseLock(w.home)
  }, 20_000)
  it("the owner's own Stop: from a session (no tty, or a tty inside Claude Code) a start needs his recent words; a real terminal starts it as before", async () => {
    const w = world()
    expect(takeLock(w.home)).toBe(true)
    writeFileSync(join(w.home, SUPERVISOR_FILES.stopped), '')
    const piped = () => {
      const c = io()
      ;(c.io as { isTerminal?: boolean }).isTerminal = false
      return c
    }
    let c = piped()
    expect(await cmdSupervise(w.env, ['start', '--anyway'], c.io)).toBe(1)
    expect(c.err.join('\n')).toContain('the owner stopped Main; he can start it from the phone')
    // a tty inside a Claude Code session (a faked terminal): not his ask, refused
    const was = process.env.CLAUDECODE
    try {
      process.env.CLAUDECODE = '1'
      c = io()
      expect(await cmdSupervise(w.env, ['start'], c.io)).toBe(1)
      expect(c.err.join('\n')).toContain('the owner stopped Main')
      // the owner at a real terminal (a tty, not inside Claude Code): goes to the supervisor as before (which, here, never takes it)
      delete process.env.CLAUDECODE
      c = io()
      expect(await cmdSupervise(w.env, ['start', '--anyway'], c.io)).toBe(1)
      expect(c.err.join('\n')).toContain('did not take the request')
    } finally {
      if (was === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = was
    }
    expect(existsSync(join(w.home, SUPERVISOR_FILES.control))).toBe(false)
    // he asked, a minute ago: the request goes to the supervisor (which, in this test, never takes it). A full config.json, as
    // a real home has: the check fails closed on one it can't read.
    writeFileSync(join(w.home, 'config.json'), JSON.stringify(loadExampleConfig('default')))
    const store = openHistory(join(w.home, 'history.sqlite'))
    store.addMessage({
      id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      thread_id: 'general',
      author: 'owner',
      kind: 'text',
      text: 'start Main again',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(Date.now() - 60_000).toISOString(),
    } as never)
    store.close()
    c = piped()
    expect(await cmdSupervise(w.env, ['start'], c.io)).toBe(1)
    expect(c.err.join('\n')).toContain('did not take the request')
    releaseLock(w.home)
  }, 20_000)
  it('refuses Main and shared threads, a thread id that is not one, and no running supervisor', async () => {
    const w = world()
    let c = io()
    expect(await cmdSupervise(w.env, ['restart-thread', 'trip'], c.io)).toBe(1) // nobody holds the lock
    expect(takeLock(w.home)).toBe(true)
    c = io()
    expect(await cmdSupervise(w.env, ['restart-thread', 'general'], c.io)).toBe(1)
    expect(c.err.join('\n')).toContain('supervise stop / start')
    expect(await cmdSupervise(w.env, ['restart-thread', '../x'], io().io)).toBe(2)
    expect(await cmdSupervise(w.env, ['restart-thread'], io().io)).toBe(2)
    expect(existsSync(join(w.home, 'workers', 'general', 'control'))).toBe(false)
    releaseLock(w.home)
  })
  it('attach --print is the tmux command onto the thread’s own session, on this supervisor’s config', async () => {
    const w = world()
    const c = io()
    expect(await cmdSupervise(w.env, ['attach', 'trip', '--print'], c.io)).toBe(0)
    expect(c.out[0]).toContain('attach-session -t =t-trip')
    expect(c.out[0]).toContain(join(w.home, SUPERVISOR_FILES.tmuxConf))
    expect(await cmdSupervise(w.env, ['attach', 'Not A Thread'], io().io)).toBe(2)
  })
  // the Windows tray's "Open a thread's session" (apps/windows/tray.ps1): the list it shows, and the window it opens
  it('threads --json: only threads with a session of their own, by their cleaned name, none running without a session', async () => {
    const w = world()
    const cfg = JSON.parse(readFileSync(join(w.home, 'config.json'), 'utf8'))
    cfg.threads[2].name = 'Trip\u0007 to\u001b[31m Rome' // control characters never reach the tray's menu
    cfg.threads.push({ id: 'plain', kind: 'user', session: 'dedicated' }) // no name: its id
    writeFileSync(join(w.home, 'config.json'), JSON.stringify(cfg))
    const c = io()
    const before = process.env.TALOS_SUPERVISOR_TMUX_SOCKET
    process.env.TALOS_SUPERVISOR_TMUX_SOCKET = `${tmuxTestPrefix()}-none-${process.pid}` // a socket with no server: nothing is running
    try {
      expect(await cmdSupervise(w.env, ['threads', '--json'], c.io)).toBe(0)
    } finally {
      if (before === undefined) delete process.env.TALOS_SUPERVISOR_TMUX_SOCKET
      else process.env.TALOS_SUPERVISOR_TMUX_SOCKET = before
    }
    expect(JSON.parse(c.out[0] as string)).toEqual({
      threads: [
        { id: 'trip', name: 'Trip to[31m Rome', running: false },
        { id: 'plain', name: 'plain', running: false },
      ],
    })
    expect(await cmdSupervise(w.env, ['threads'], io().io)).toBe(2) // --json is its only form
    writeFileSync(join(w.home, 'config.json'), '{not json')
    const bad = io()
    expect(await cmdSupervise(w.env, ['threads', '--json'], bad.io)).toBe(1)
    expect(bad.err.join('\n')).toContain('the thread list cannot be read')
  })
  it.skipIf(!Bun.which('tmux'))('threads --json says running for a thread whose tmux session is there', async () => {
    const w = world()
    const socket = `${tmuxTestPrefix()}-thr-${process.pid}`
    const tmux = Bun.which('tmux') as string
    const before = process.env.TALOS_SUPERVISOR_TMUX_SOCKET
    process.env.TALOS_SUPERVISOR_TMUX_SOCKET = socket
    Bun.spawnSync([tmux, '-L', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 't-trip', 'sleep 30'])
    try {
      const c = io()
      expect(await cmdSupervise(w.env, ['threads', '--json'], c.io)).toBe(0)
      expect(JSON.parse(c.out[0] as string).threads).toEqual([{ id: 'trip', name: 'trip', running: true }])
    } finally {
      Bun.spawnSync([tmux, '-L', socket, 'kill-server'])
      if (before === undefined) delete process.env.TALOS_SUPERVISOR_TMUX_SOCKET
      else process.env.TALOS_SUPERVISOR_TMUX_SOCKET = before
    }
  })
  // the "not running" line needs tmux there to ask; a Mac without tmux says so instead (the case above skips the same way)
  it.skipIf(!Bun.which('tmux'))(
    'attach --window: the name and how to leave first, and a thread with no session, or none running, says so',
    async () => {
      const w = world()
      const before = process.env.TALOS_SUPERVISOR_TMUX_SOCKET
      process.env.TALOS_SUPERVISOR_TMUX_SOCKET = `${tmuxTestPrefix()}-none-${process.pid}`
      try {
        let c = io()
        expect(await cmdSupervise(w.env, ['attach', 'trip', '--window'], c.io)).toBe(1)
        expect(c.out).toEqual([
          'Talos — trip. To leave, close this window: the thread keeps running.',
          "This thread's session is not running now.",
        ])
        c = io()
        expect(await cmdSupervise(w.env, ['attach', 'general', '--window'], c.io)).toBe(1) // shared: no session of its own
        expect(c.out).toEqual(['This thread has no session of its own, so there is nothing to open.'])
        expect(await cmdSupervise(w.env, ['attach', 'trip', '--window', '--print'], io().io)).toBe(2)
        expect(await cmdSupervise(w.env, ['attach', '../x', '--window'], io().io)).toBe(2)
      } finally {
        if (before === undefined) delete process.env.TALOS_SUPERVISOR_TMUX_SOCKET
        else process.env.TALOS_SUPERVISOR_TMUX_SOCKET = before
      }
    },
  )
})

// P3d3: the owner's switch for thread sessions, in supervisor.json
describe('supervisor.json workers', () => {
  it('absent is on; false is off; anything else is a settings error, never a guess', () => {
    const h = tmp()
    const agent = join(h, 'agent')
    mkdirSync(agent)
    const read = (extra: Record<string, unknown>) => {
      writeFileSync(join(h, SUPERVISOR_FILES.config), JSON.stringify({ agent_dir: agent, ...extra }))
      return readSupervisorConfig(h, h)
    }
    expect(read({})).toMatchObject({ workers: true })
    expect(read({ workers: false })).toMatchObject({ workers: false })
    expect(read({ workers: 'no' })).toHaveProperty('error')
  })
})

describe('supervise on a Mac', () => {
  const MAC_LINE = MAC_SUPERVISE_LINE
  const run = async (platform: string) => {
    const home = tmp()
    const err: string[] = []
    const out: string[] = []
    const was = superviseHost.platform
    superviseHost.platform = platform
    try {
      const code = await cmdSupervise({ home, userHome: home } as never, [], {
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
      } as never)
      return { code, err, out }
    } finally {
      superviseHost.platform = was
    }
  }
  it('warns once at startup and carries on to the supervisor (here: the missing-config message)', async () => {
    const r = await run('darwin')
    expect(r.err.filter((l) => l === MAC_LINE)).toHaveLength(1)
    expect(r.err[0]).toBe(MAC_LINE)
    expect(r.err.join('\n')).toContain('supervisor.json')
    expect(r.code).toBe(1)
  })
  it('linux prints no such line', async () => {
    const r = await run('linux')
    expect(r.err.join('\n')).not.toContain('On a Mac')
    expect(r.err.join('\n')).toContain('supervisor.json')
  })
})
