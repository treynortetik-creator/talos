// OPT-IN: a REAL Claude Code (the build named in plugins/talos-app-mod/CLAUDE_CODE_VERSION, or whatever `claude` is on PATH)
// shows its own "Dangerous rm operation on critical path" prompt, which it never sends to a channel; the kit's real
// PermissionRequest hook reaches the real bridge's hub socket, the card is minted, and the owner's signed answer decides
// whether the rm runs. Run with TALOS_REAL_CLAUDE=1 (needs `claude`, `tmux` and python3).
//
// Sandbox: a private tmux server (`-L talos-test-permhook-<random>`, never the live `talos` one), a temp HOME and
// CLAUDE_CONFIG_DIR, a throwaway agent folder, and a local stand-in for the model API that answers with one scripted
// Bash call. Nothing is sent to a real model, no real Talos home is touched, and the tmux server is stopped by name.
// gate-reads: kit/hooks/* kit/templates/dot-claude/settings.json
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type CardT, permissionCardAllowsPrimary } from '@talos-app/protocol'
import { t, tmuxTestPrefix } from '@talos-app/testkit'
import { installWorkerHook, releaseHook } from '../src/supervisor/worker-hook.ts'
import { INSTRUCTION_FILES_MODE } from '../src/supervisor/worker-policy.ts'
import { withPermissionHook } from '../src/supervisor/worker-spec.ts'
import { instructionsText } from '../src/worker/instruction-files.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'
import { cleanupReleases, sealedRelease } from './supervisor/kit-release-fixture.ts'

// the sealed kit releases this file made: writable again and removed (kit-release-fixture.ts)
afterAll(cleanupReleases)

const ENABLED = process.env.TALOS_REAL_CLAUDE === '1' && Bun.which('claude') !== null && Bun.which('tmux') !== null
const KIT = resolve(import.meta.dir, '..', '..', '..', 'kit')
const KEY = 'sk-ant-fake0000000000000000000000000000000000000000000000'

let h: Harness | undefined
const cleanups: (() => void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) c()
  await h?.stop()
  h = undefined
})

const sse = (events: [string, unknown][]) =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })

const SUBTASK = 'SUBTASK-7c1f'
const CODEWORDS = ['CW-ROOT-4d1e', 'CW-MID-9a27', 'CW-LEAF-c3b8']

/** One streamed assistant turn that is a single tool call. */
const toolCall = (base: Record<string, unknown>, id: string, name: string, input: unknown) =>
  sse([
    ['message_start', { type: 'message_start', message: base }],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    ],
    [
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
      },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])

/**
 * The model API stand-in: the first turn that offers Bash answers with one scripted call; after its result, plain text. With
 * `viaAgent` the main session's first turn starts a background sub-agent instead, and the sub-agent makes the Bash call.
 */
function fakeApi(opts: { viaAgent?: boolean } = {}) {
  const log: { toolCalls: number; results: string[]; agentCalls: number; bodies: string[] } = {
    toolCalls: 0,
    results: [],
    agentCalls: 0,
    bodies: [],
  }
  const script = { command: 'true' }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.startsWith('/v1/messages')) return Response.json({})
      const j = (await req.json().catch(() => ({}))) as {
        messages?: { content: unknown }[]
        tools?: { name: string }[]
        stream?: boolean
        model?: string
      }
      log.bodies.push(JSON.stringify(j))
      const msgs = j.messages ?? []
      const blocks = (m?: { content: unknown }) =>
        Array.isArray(m?.content) ? (m?.content as Record<string, unknown>[]) : []
      const last = msgs[msgs.length - 1]
      const result = blocks(last).find((b) => b.type === 'tool_result')
      // only the scripted Bash call's result: a sub-agent's start also comes back as a tool_result, in the main session
      if (result && result.tool_use_id === 'toolu_1') log.results.push(JSON.stringify(result.content).slice(0, 300))
      const used = msgs.some((m) => blocks(m).some((b) => b.type === 'tool_use'))
      const hasBash = (j.tools ?? []).some((t) => t.name === 'Bash')
      // the sub-agent's own requests carry its task; the main session's never do
      const inSubAgent = JSON.stringify(msgs).includes(SUBTASK)
      const base = {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: 'message',
        role: 'assistant',
        model: j.model ?? 'x',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      }
      if (j.stream === false)
        return Response.json({ ...base, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
      if (opts.viaAgent && !inSubAgent && !used && (j.tools ?? []).some((t) => t.name === 'Agent')) {
        log.agentCalls++
        return toolCall(base, 'toolu_agent', 'Agent', {
          description: 'cleanup',
          prompt: `${SUBTASK}: run the cleanup`,
          subagent_type: 'general-purpose',
          run_in_background: true,
        })
      }
      if (hasBash && !result && !used && (!opts.viaAgent || inSubAgent)) {
        log.toolCalls++
        return toolCall(base, 'toolu_1', 'Bash', { command: script.command, description: 'scripted test call' })
      }
      return sse([
        ['message_start', { type: 'message_start', message: base }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        [
          'content_block_delta',
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'finished' } },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 2 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ])
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, log, script }
}

const tmux = (sock: string, ...a: string[]) =>
  Bun.spawnSync(['tmux', '-L', sock, ...a], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString()

type Sandbox = {
  root: string
  home: string
  agent: string
  sock: string
  screen(): string
  type(keys: string): void
  panePid(): number
}

/** A throwaway claude in a private tmux server. `worker`: the env and --settings a thread session gets. */
function launch(
  api: { url: string; script: { command: string } },
  talosHome: string,
  opts: {
    worker?: { thread: string; nonce: string }
    /** A thread folder below a repo root, with an instruction file at three depths; `inject`: launched as the supervisor does. */
    instructions?: { inject: boolean }
    /** The sandbox of an earlier launch, to resume its conversation (the same config folder and folder). */
    root?: string
    /** One conversation: its id, whether this launch resumes it, the system-prompt file's text, and the snapshot flag's value. */
    session?: { id: string; resume: boolean; prompt: string; snapshot: 'on' | 'off' }
  } = {},
): Sandbox {
  const root = opts.root ?? realpathSync(mkdtempSync(join(tmpdir(), 'phk-')))
  const home = join(root, 'home') // the dangerous rm target: Claude Code treats HOME as a critical path
  const cfg = join(root, 'cfg')
  const agent = join(root, 'agent')
  const threadDir = join(root, 'thread')
  for (const d of [home, cfg, agent, join(agent, '.claude'), join(agent, 'hooks'), threadDir])
    mkdirSync(d, { recursive: true })
  cpSync(join(KIT, 'hooks'), join(agent, 'hooks'), { recursive: true })
  // the instruction files: the repo root's AGENTS.md, a middle folder's CLAUDE.md, the thread folder's AGENTS.md
  const leaf = join(threadDir, 'a', 'b')
  if (opts.instructions) {
    mkdirSync(join(threadDir, '.git'), { recursive: true })
    mkdirSync(leaf, { recursive: true })
    writeFileSync(join(threadDir, 'AGENTS.md'), `The codeword is ${CODEWORDS[0]}.\n`)
    writeFileSync(join(threadDir, 'a', 'CLAUDE.md'), `The codeword is ${CODEWORDS[1]}.\n`)
    writeFileSync(join(leaf, 'AGENTS.md'), `The codeword is ${CODEWORDS[2]}.\n`)
  }
  const cwd = opts.instructions ? leaf : opts.worker ? threadDir : agent
  api.script.command = `rm -rf ${home}`
  writeFileSync(
    join(cfg, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      theme: 'dark',
      customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
    }),
  )
  const template = JSON.parse(readFileSync(join(KIT, 'templates', 'dot-claude', 'settings.json'), 'utf8')) as {
    hooks: Record<string, unknown>
  }
  const args = ['--dangerously-skip-permissions']
  const env: Record<string, string> = {}
  if (opts.worker) {
    // what the planner writes: the sealed kit release's hook copied into the fenced Talos home, run by the resolved python3 (worker-hook.ts)
    const settingsFile = join(root, 'worker-settings.json')
    const release = releaseHook(sealedRelease())
    if (!('source' in release)) throw new Error(release.problem)
    const hook = installWorkerHook(talosHome, release.source, { PATH: process.env.PATH ?? '' })
    if (!('script' in hook)) throw new Error(hook.problem)
    const settings = withPermissionHook({}, hook.script, hook.python, {
      talosHome,
      home: process.env.HOME ?? '/',
      thread: opts.worker.thread,
    }) as { hooks: { PermissionRequest: unknown[] } }
    // a second PermissionRequest hook that only records the shell Claude Code runs a hook's command in (it answers nothing):
    // the command is safe from what the session imports only because that shell is /bin/sh in POSIX mode (worker-spec.ts)
    const shellFile = join(root, 'hook-shell.txt')
    settings.hooks.PermissionRequest.push({
      hooks: [
        {
          type: 'command',
          command: `[ -r /proc/$$/cmdline ] && { tr '\\0' ' ' < /proc/$$/cmdline; echo; set -o | grep '^posix'; } > '${shellFile}'; exit 0`,
        },
      ],
    })
    writeFileSync(settingsFile, JSON.stringify(settings))
    args.push('--settings', settingsFile)
    if (opts.instructions) {
      // as the planner launches a thread folder's session: only the user's settings, the instruction files handed over
      args.push('--setting-sources=user')
      if (opts.instructions.inject) {
        const promptFile = join(root, 'system-prompt.md')
        writeFileSync(promptFile, instructionsText(leaf, threadDir, INSTRUCTION_FILES_MODE).text)
        args.push(`--append-system-prompt-file=${promptFile}`)
      }
    }
    if (opts.session) {
      const promptFile = join(root, 'session-prompt.md')
      writeFileSync(promptFile, opts.session.prompt)
      args.push(`--system-prompt-snapshot=${opts.session.snapshot}`, `--append-system-prompt-file=${promptFile}`)
      args.push(opts.session.resume ? '--resume' : '--session-id', opts.session.id)
    }
    env.TALOS_APP_WORKER_THREAD = opts.worker.thread
    env.TALOS_APP_WORKER_NONCE = opts.worker.nonce
    // what the planner records for the bridge's folder check at every request (worker/project-settings.ts): on Linux a session
    // with no record gets no card
    mkdirSync(join(talosHome, 'workers', opts.worker.thread), { recursive: true })
    writeFileSync(
      join(talosHome, 'workers', opts.worker.thread, 'project-check.json'),
      JSON.stringify({ v: 1, folders: [{ folder: realpathSync(threadDir), agent_folder: false }] }),
    )
    writeFileSync(join(agent, '.claude', 'settings.json'), '{}')
  } else {
    writeFileSync(
      join(agent, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PermissionRequest: template.hooks.PermissionRequest } }),
    )
  }
  const sock = `${tmuxTestPrefix()}-permhook-${Math.random().toString(36).slice(2, 8)}`
  const envWords = Object.entries({
    PATH: process.env.PATH ?? '',
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: KEY,
    TALOS_APP_HOME: talosHome,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    TERM: 'xterm-256color',
    ...env,
  }).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  tmux(
    sock,
    'new-session',
    '-d',
    '-s',
    's',
    '-x',
    '120',
    '-y',
    '40',
    '-c',
    cwd,
    `env -i ${envWords.join(' ')} ${Bun.which('claude')} ${args.join(' ')}`,
  )
  cleanups.push(() => tmux(sock, 'kill-server'))
  return {
    root,
    home,
    agent,
    sock,
    screen: () => tmux(sock, 'capture-pane', '-p', '-J', '-t', 's'),
    type: (keys) => void tmux(sock, 'send-keys', '-t', 's', keys, 'Enter'),
    panePid: () => Number(tmux(sock, 'display-message', '-p', '-t', 's', '#{pane_pid}').trim()),
  }
}

async function ready(sb: Sandbox) {
  await waitFor(() => sb.screen().includes('Claude Code v'), 30_000, 'claude to start')
  await sleep(t(1500)) // timing-ok: settle, can't be polled without a TUI ready marker (opt-in test, not run here)
  sb.type('do it')
}

const permCard = async (x: Harness, text: string): Promise<CardT> =>
  (
    await x.relay.expectFrame(
      'card.create',
      (f) => f.card.kind === 'permission' && (f.card.body ?? '').includes(text),
      {
        direction: 'from_bridge',
        timeoutMs: 40_000,
      } as never,
    )
  ).card

async function bridge(home?: string) {
  h = await startHarness({
    ...(home ? { home } : {}),
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      permission_relay: true,
      threads: [
        ...c.threads,
        {
          id: 'trip',
          name: 'Trip',
          kind: 'fixed',
          order: 5,
          notify: 'all',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  // what takeOver writes for a real bridge: the hook only talks to the process this file names (here, this test process)
  writeFileSync(join(h.home, 'bridge.pid'), JSON.stringify({ pid: process.pid, started_at: '', instance: 'test' }), {
    mode: 0o600,
  })
  return h
}

const writeWorkers = (home: string, pane: number) =>
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
      threads: {
        trip: {
          state: 'live',
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: pane,
          cwd: home,
          error: null,
        },
      },
    }),
  )

describe.skipIf(!ENABLED)(
  'REAL Claude Code: the dangerous-rm prompt reaches the phone and the answer is honoured',
  () => {
    test(
      'the main session: the card shows the exact rm, Deny leaves the folder and closes the prompt',
      async () => {
        const x = await bridge()
        const api = fakeApi()
        const sb = launch(api, x.home)
        await ready(sb)
        const card = await permCard(x, 'rm -rf')
        await waitFor(() => sb.screen().includes('Dangerous rm operation'), 20_000, "Claude Code's own prompt")
        expect(card.body?.replace(/\n/g, '')).toBe(`rm -rf ${sb.home}`)
        expect(card.risk).toBe('high')
        expect(card.thread_id).toBe(x.bridge.ctx.config.config.default_thread)
        expect(permissionCardAllowsPrimary(card)).toBe(true)
        await x.app.resolveCard(card, 'kill', card.payload_hash)
        await waitFor(() => api.log.results.length > 0, 30_000, 'Claude Code to report the tool result')
        expect(existsSync(sb.home)).toBe(true)
        expect(api.log.results[0]).toMatch(/den|permission|reject|block/i)
        expect(sb.screen()).not.toContain('Do you want to proceed?')
      },
      t(445_000),
    )

    test(
      'the main session: Allow with step-up runs the rm exactly once',
      async () => {
        const x = await bridge()
        const api = fakeApi()
        const sb = launch(api, x.home)
        await ready(sb)
        const card = await permCard(x, 'rm -rf')
        expect(existsSync(sb.home)).toBe(true)
        await x.app.resolveCard(card, 'primary', card.payload_hash, {
          stepup_token: x.relay.mintStepup(`card:${card.id}`),
        })
        await waitFor(() => api.log.results.length > 0, 30_000, 'Claude Code to report the tool result')
        expect(existsSync(sb.home)).toBe(false)
        expect(api.log.toolCalls).toBe(1)
        expect(
          x.relay.frames.filter(
            (f) =>
              f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
          ),
        ).toHaveLength(1)
      },
      t(385_000),
    )

    test(
      'answered at the Mac first: the card closes by itself and the folder is untouched',
      async () => {
        const x = await bridge()
        const api = fakeApi()
        const sb = launch(api, x.home)
        await ready(sb)
        const card = await permCard(x, 'rm -rf')
        await waitFor(() => sb.screen().includes('Do you want to proceed?'), 20_000, "Claude Code's own prompt")
        await sleep(t(1500)) // timing-ok: settle, can't be polled without a TUI ready marker (opt-in test, not run here): the dialog ignores keys for a moment after it appears
        sb.type('2') // "No" at the terminal
        await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired', {
          direction: 'from_bridge',
        })
        // "No" at the terminal interrupts the turn (Claude Code sends no tool result), and nothing was deleted
        await waitFor(() => sb.screen().includes('Interrupted'), 20_000, 'Claude Code to show the interrupt')
        expect(existsSync(sb.home)).toBe(true)
        expect(api.log.results).toHaveLength(0)
        expect(x.bridge.ctx.permission.openCount).toBe(0)
      },
      t(425_000),
    )

    test(
      'a thread session: the same prompt lands in the thread, proven by the nonce and the pane',
      async () => {
        const x = await bridge()
        const nonce = 'real-run-nonce-0123456789abcdef'
        mkdirSync(join(x.home, 'workers', 'trip'), { recursive: true })
        writeFileSync(join(x.home, 'workers', 'trip', 'nonce'), nonce)
        const api = fakeApi()
        const sb = launch(api, x.home, { worker: { thread: 'trip', nonce } })
        writeWorkers(x.home, sb.panePid())
        await ready(sb)
        const card = await permCard(x, 'rm -rf')
        expect(card.thread_id).toBe('trip')
        // the shell the hook's command ran in: /bin/sh -c, in POSIX mode (where /proc can say)
        if (existsSync('/proc/self/cmdline')) {
          await waitFor(() => existsSync(join(sb.root, 'hook-shell.txt')), 10_000, 'the shell recorder')
          const shell = readFileSync(join(sb.root, 'hook-shell.txt'), 'utf8')
          expect(shell.startsWith('/bin/sh -c ')).toBe(true)
          if (/^posix/m.test(shell)) expect(shell).toMatch(/^posix\s+on$/m) // bash; dash has no such option and no imported functions
        }
        await x.app.resolveCard(card, 'kill', card.payload_hash)
        await waitFor(() => api.log.results.length > 0, 30_000, 'Claude Code to report the tool result')
        expect(existsSync(sb.home)).toBe(true)
      },
      t(415_000),
    )

    test(
      'a thread folder’s session (only user settings): Claude Code loads none of its instruction files; the three handed over all reach the model',
      async () => {
        const x = await bridge()
        const nonce = 'real-run-nonce-0123456789abcdef'
        mkdirSync(join(x.home, 'workers', 'trip'), { recursive: true })
        writeFileSync(join(x.home, 'workers', 'trip', 'nonce'), nonce)
        const bodies = async (inject: boolean) => {
          const api = fakeApi()
          const sb = launch(api, x.home, { worker: { thread: 'trip', nonce }, instructions: { inject } })
          writeWorkers(x.home, sb.panePid())
          await ready(sb)
          await waitFor(() => api.log.bodies.some((b) => b.includes('do it')), 60_000, 'the first request to the model')
          return api.log.bodies.join('\n')
        }
        // control: with --setting-sources=user alone, none of the three reaches the model
        const without = await bodies(false)
        for (const w of CODEWORDS) expect(without.includes(w), w).toBe(false)
        const withFiles = await bodies(true)
        for (const w of CODEWORDS) expect(withFiles.includes(w), w).toBe(true)
      },
      t(355_000),
    )

    test(
      'a resumed thread session gets the system prompt this start wrote, not the first one (the snapshot is off)',
      async () => {
        const x = await bridge()
        const nonce = 'real-run-nonce-0123456789abcdef'
        mkdirSync(join(x.home, 'workers', 'trip'), { recursive: true })
        writeFileSync(join(x.home, 'workers', 'trip', 'nonce'), nonce)
        const id = crypto.randomUUID()
        const run = async (root: string | undefined, resume: boolean, word: string, snapshot: 'on' | 'off') => {
          const api = fakeApi()
          const sb = launch(api, x.home, {
            worker: { thread: 'trip', nonce },
            ...(root ? { root } : {}),
            session: { id, resume, prompt: `The instruction word is ${word}.`, snapshot },
          })
          writeWorkers(x.home, sb.panePid())
          await ready(sb)
          await waitFor(() => api.log.bodies.some((b) => b.includes('do it')), 60_000, 'the first request to the model')
          await sleep(t(1000)) // timing-ok: settle, can't be polled without a TUI ready marker (opt-in test, not run here)
          tmux(sb.sock, 'kill-server')
          return { root: sb.root, bodies: api.log.bodies.join('\n') }
        }
        // control: with the snapshot on (Claude Code's default), a resume replays the first prompt
        const first = await run(undefined, false, 'SNAP-ONE-71', 'on')
        const replayed = await run(first.root, true, 'SNAP-TWO-72', 'on')
        expect(replayed.bodies).toContain('SNAP-ONE-71')
        expect(replayed.bodies).not.toContain('SNAP-TWO-72')
        // as every worker starts: off, so the resume carries this start's text
        const fresh = await run(first.root, true, 'SNAP-THREE-73', 'off')
        expect(fresh.bodies).toContain('SNAP-THREE-73')
        expect(fresh.bodies).not.toContain('SNAP-ONE-71')
      },
      t(355_000),
    )

    test(
      "a thread session's background sub-agent: Claude Code's own rm check in a `bash -c` script becomes a card in the thread",
      async () => {
        // the owner's case (Delphi, 2026-11-11): a builder sub-agent ran `cd … && bash -c 'unset …; … rm …'`, Claude Code showed
        // "Bash command · from the … agent … Do you want to proceed?" in the pane, and no card reached the thread
        const x = await bridge()
        const nonce = 'real-run-nonce-0123456789abcdef'
        mkdirSync(join(x.home, 'workers', 'trip'), { recursive: true })
        writeFileSync(join(x.home, 'workers', 'trip', 'nonce'), nonce)
        const api = fakeApi({ viaAgent: true })
        const sb = launch(api, x.home, { worker: { thread: 'trip', nonce } })
        // `$D` is unset, so the script would run `rm -rf /build`: Claude Code cannot rule out a critical path and asks, in every mode
        const ran = join(sb.root, 'ran')
        api.script.command = `cd ${join(sb.root, 'thread')} && bash -c 'unset D; rm -rf "$D"/build; touch ${ran}'`
        writeWorkers(x.home, sb.panePid())
        await ready(sb)
        const card = await permCard(x, 'unset D')
        expect(api.log.agentCalls).toBe(1)
        expect(card.thread_id).toBe('trip')
        // Claude Code drops a leading `cd` into the session's own folder from the input it hands on
        expect(card.body?.replace(/\n/g, '')).toBe(`bash -c 'unset D; rm -rf "$D"/build; touch ${ran}'`)
        await x.app.resolveCard(card, 'kill', card.payload_hash)
        // a denied call ends a background sub-agent without another model turn, so the denial is seen in the pane, not the API
        await waitFor(() => sb.screen().includes('Agent "cleanup" finished'), 30_000, 'the sub-agent to end')
        expect(existsSync(ran)).toBe(false)
        expect(api.log.toolCalls).toBe(1)
        expect(x.bridge.ctx.permission.openCount).toBe(0)
      },
      t(385_000),
    )

    test(
      'the hub restarts under a running thread session: its next prompt still becomes a card in the thread',
      async () => {
        // Delphi, 2026-11-11: the thread session started on 11-10, the hub bridge restarted at 07:58, and every prompt after it stayed
        // in the pane. The proof is read from disk on each request (workers.json, the nonce file, the pane's group), so a new hub on the
        // same home must accept the session the old one launched.
        const first = await bridge()
        const home = first.home
        const nonce = 'real-run-nonce-0123456789abcdef'
        mkdirSync(join(home, 'workers', 'trip'), { recursive: true })
        writeFileSync(join(home, 'workers', 'trip', 'nonce'), nonce)
        const api = fakeApi({ viaAgent: true })
        const sb = launch(api, home, { worker: { thread: 'trip', nonce } })
        const ran = join(sb.root, 'ran')
        api.script.command = `cd ${join(sb.root, 'thread')} && bash -c 'unset D; rm -rf "$D"/build; touch ${ran}'`
        writeWorkers(home, sb.panePid())
        await waitFor(() => sb.screen().includes('Claude Code v'), 30_000, 'claude to start')
        // the hub goes and a new one takes the same home (new relay connection, a new bridge.pid)
        await first.stop()
        h = undefined
        const x = await bridge(home)
        writeWorkers(home, sb.panePid())
        await sleep(t(1500)) // timing-ok: settle, can't be polled without a TUI ready marker (opt-in test, not run here)
        sb.type('do it')
        const card = await permCard(x, 'unset D')
        expect(card.thread_id).toBe('trip')
        await x.app.resolveCard(card, 'kill', card.payload_hash)
        await waitFor(() => sb.screen().includes('Agent "cleanup" finished'), 30_000, 'the sub-agent to end')
        expect(existsSync(ran)).toBe(false)
      },
      t(465_000),
    )

    test(
      'the dangerous-rm countdown runs out: Claude Code blocks the call itself, the hook sees the call result in the transcript and ends, and the card closes (hook_gone)',
      async () => {
        const x = await bridge()
        const api = fakeApi()
        const sb = launch(api, x.home)
        await ready(sb)
        const card = await permCard(x, 'rm -rf')
        await waitFor(() => /block this request in \d:\d\d/.test(sb.screen()), 20_000, 'the countdown row')
        const gone = await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired', {
          direction: 'from_bridge',
          timeoutMs: 170_000,
        } as never)
        expect(gone.reason).toBe('hook_gone')
        expect(existsSync(sb.home)).toBe(true)
        expect(x.bridge.ctx.permission.openCount).toBe(0)
      },
      t(865_000),
    )
  },
)

/**
 * A thread folder's own configuration, one marker of each kind, and what a real Claude Code session in it did with them:
 * codewords in the API requests (skills top-level and nested, commands, agents), marker files (hooks, the settings env reaching
 * a hook, an MCP server started), and whether an allow rule spared the Bash call its prompt. `user`: launched as a thread
 * session outside the agent folder is (--setting-sources=user); otherwise with every source, the control that proves each
 * marker can be seen.
 */
async function folderConfigLoads(user: boolean) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phk-load-')))
  const home = join(root, 'home')
  const cfg = join(root, 'cfg')
  const dir = join(root, 'thread')
  const sub = join(dir, 'sub')
  const M = (n: string) => join(dir, `marker-${n}`)
  for (const d of [
    home,
    cfg,
    join(dir, '.claude', 'skills', 'topskill'),
    join(dir, '.claude', 'commands'),
    join(dir, '.claude', 'agents'),
    join(sub, '.claude', 'skills', 'nestedskill'),
  ])
    mkdirSync(d, { recursive: true })
  writeFileSync(
    join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      // Skill(topskill): invoking a skill asks in the default mode; allowed here, it runs when (and only when) the folder loads
      permissions: { allow: ['Bash(touch:*)', `Bash(touch ${M('allow')})`, 'Skill(topskill)'] },
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `touch ${M('hook-sessionstart')}; [ -n "$PROBE_SETTINGS_ENV" ] && touch ${M('env')}; exit 0`,
              },
            ],
          },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${M('hook-prompt')}` }] }],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `touch ${M('hook-pretool')}` }] }],
      },
      env: { PROBE_SETTINGS_ENV: 'set' },
    }),
  )
  const skill = (name: string, cw: string) =>
    `---\nname: ${name}\ndescription: Use this for the probe task ${cw}.\nallowed-tools: Bash(touch:*)\nhooks:\n  PreToolUse:\n    - matcher: "*"\n      hooks:\n        - type: command\n          command: touch ${M(`skill-${name}`)}\n---\nThe probe skill ${cw}.\n`
  writeFileSync(join(dir, '.claude', 'skills', 'topskill', 'SKILL.md'), skill('topskill', 'CW-SKILL-TOP-1b2c'))
  writeFileSync(join(sub, '.claude', 'skills', 'nestedskill', 'SKILL.md'), skill('nestedskill', 'CW-SKILL-NESTED-3d4e'))
  writeFileSync(
    join(dir, '.claude', 'commands', 'probecmd.md'),
    '---\ndescription: The probe command CW-CMD-5f6a\n---\nGo.\n',
  )
  writeFileSync(
    join(dir, '.claude', 'agents', 'probeagent.md'),
    '---\nname: probeagent\ndescription: The probe agent CW-AGENT-7b8c\n---\nYou are the probe agent.\n',
  )
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'probe-mcp': { command: 'sh', args: ['-c', `touch ${M('mcp')}; sleep 30`] } } }),
  )
  writeFileSync(join(sub, 'notes.txt'), 'notes\n')
  // the model: read a file in the nested folder (nested skills load on that), then run the Bash call the allow rule names
  const bodies: string[] = []
  const toolNames = new Set<string>()
  let turn = 0
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (!new URL(req.url).pathname.startsWith('/v1/messages')) return Response.json({})
      const j = (await req.json().catch(() => ({}))) as { tools?: { name: string }[]; stream?: boolean; model?: string }
      bodies.push(JSON.stringify(j))
      const base = {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: 'message',
        role: 'assistant',
        model: j.model ?? 'x',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      }
      if (j.stream === false)
        return Response.json({ ...base, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
      for (const t of j.tools ?? []) toolNames.add(t.name)
      if ((j.tools ?? []).some((t) => t.name === 'Bash')) {
        turn++
        if (turn === 1) return toolCall(base, 'toolu_r', 'Read', { file_path: join(sub, 'notes.txt') })
        // the execution oracle: invoke the folder's skill by name; loaded, its own PreToolUse hook marks the next tool call
        if (turn === 2) return toolCall(base, 'toolu_s', 'Skill', { skill: 'topskill' })
        if (turn === 3)
          return toolCall(base, 'toolu_b', 'Bash', { command: `touch ${M('allow')}`, description: 'probe' })
      }
      return sse([
        ['message_start', { type: 'message_start', message: base }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
          'message_delta',
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 2 },
          },
        ],
        ['message_stop', { type: 'message_stop' }],
      ])
    },
  })
  cleanups.push(() => server.stop(true))
  writeFileSync(
    join(cfg, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
      // the MCP server pre-approved: under --setting-sources=user it must still not start
      projects: {
        [dir]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
          allowedTools: [],
          enabledMcpjsonServers: ['probe-mcp'],
        },
      },
    }),
  )
  const sock = `${tmuxTestPrefix()}-permhook-${Math.random().toString(36).slice(2, 8)}`
  const envWords = Object.entries({
    PATH: '/usr/bin:/bin',
    HOME: home,
    CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    ANTHROPIC_API_KEY: KEY,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    TERM: 'xterm-256color',
  }).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  const args = ['--permission-mode', 'default', ...(user ? ['--setting-sources=user'] : [])]
  tmux(
    sock,
    'new-session',
    '-d',
    '-s',
    's',
    '-x',
    '150',
    '-y',
    '50',
    '-c',
    dir,
    `env -i ${envWords.join(' ')} ${Bun.which('claude')} ${args.join(' ')}`,
  )
  cleanups.push(() => tmux(sock, 'kill-server'))
  const screen = () => tmux(sock, 'capture-pane', '-p', '-J', '-t', 's')
  await waitFor(() => screen().includes('Claude Code v'), 30_000, 'claude to start')
  await sleep(t(3000)) // timing-ok: settle, can't be polled without a TUI ready marker (opt-in test, not run here)
  tmux(sock, 'send-keys', '-t', 's', '-l', 'do the probe')
  tmux(sock, 'send-keys', '-t', 's', 'Enter')
  await waitFor(() => turn >= 3 || bodies.length >= 4, 40_000, 'the scripted turns')
  await sleep(t(4000)) // timing-ok: settle, can't be polled without a TUI ready marker (opt-in test, not run here)
  const all = bodies.join('\n')
  const seen = (cw: string) => all.includes(cw)
  return {
    skillTop: seen('CW-SKILL-TOP-1b2c'),
    // executed, not only listed: the skill's own hook ran on the tool call after it was invoked
    skillRan: existsSync(M('skill-topskill')),
    skillToolOffered: toolNames.has('Skill'),
    skillNested: seen('CW-SKILL-NESTED-3d4e'),
    command: seen('CW-CMD-5f6a'),
    agent: seen('CW-AGENT-7b8c'),
    hookSessionStart: existsSync(M('hook-sessionstart')),
    hookPrompt: existsSync(M('hook-prompt')),
    hookPreTool: existsSync(M('hook-pretool')),
    settingsEnv: existsSync(M('env')),
    mcpStarted: existsSync(M('mcp')),
    allowRule: existsSync(M('allow')) && !/Do you want to proceed/.test(screen()),
  }
}

describe.skipIf(!ENABLED)(
  'REAL Claude Code: a thread folder’s own configuration under --setting-sources=user (Fable R1-5)',
  () => {
    test(
      'control (every source): each marker is seen; --setting-sources=user: none of them',
      async () => {
        const control = await folderConfigLoads(false)
        for (const [k, v] of Object.entries(control)) expect(v, `control: ${k}`).toBe(true)
        const { skillToolOffered, ...thread } = await folderConfigLoads(true)
        // the Skill tool itself is Claude Code's own (it is there either way); what matters is that no folder skill ran
        void skillToolOffered
        for (const [k, v] of Object.entries(thread)) expect(v, `--setting-sources=user: ${k}`).toBe(false)
      },
      t(440_000),
    )
  },
)
