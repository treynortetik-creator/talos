// OPT-IN: a REAL Claude Code (the build named in plugins/talos-app-mod/CLAUDE_CODE_VERSION, or whatever `claude` is on PATH)
// shows its own "Dangerous rm operation on critical path" prompt, which it never sends to a channel; the kit's real
// PermissionRequest hook reaches the real bridge's hub socket, the card is minted, and the owner's signed answer decides
// whether the rm runs. Run with TALOS_REAL_CLAUDE=1 (needs `claude`, `tmux` and python3).
//
// Sandbox: a private tmux server (`-L talos-test-permhook-<random>`, never the live `talos` one), a temp HOME and
// CLAUDE_CONFIG_DIR, a throwaway agent folder, and a local stand-in for the model API that answers with one scripted
// Bash call. Nothing is sent to a real model, no real Talos home is touched, and the tmux server is stopped by name.
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type CardT, permissionCardAllowsPrimary } from '@talos-app/protocol'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

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

/** The model API stand-in: the first turn that offers Bash answers with one scripted call; after its result, plain text. */
function fakeApi() {
  const log: { toolCalls: number; results: string[] } = { toolCalls: 0, results: [] }
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
      const msgs = j.messages ?? []
      const blocks = (m?: { content: unknown }) =>
        Array.isArray(m?.content) ? (m?.content as Record<string, unknown>[]) : []
      const last = msgs[msgs.length - 1]
      const result = blocks(last).find((b) => b.type === 'tool_result')
      if (result) log.results.push(JSON.stringify(result.content).slice(0, 300))
      const used = msgs.some((m) => blocks(m).some((b) => b.type === 'tool_use'))
      const hasBash = (j.tools ?? []).some((t) => t.name === 'Bash')
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
      if (hasBash && !result && !used) {
        log.toolCalls++
        return sse([
          ['message_start', { type: 'message_start', message: base }],
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify({ command: script.command, description: 'scripted test call' }),
              },
            },
          ],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          [
            'message_delta',
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: { output_tokens: 8 },
            },
          ],
          ['message_stop', { type: 'message_stop' }],
        ])
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
  opts: { worker?: { thread: string; nonce: string } } = {},
): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phk-')))
  const home = join(root, 'home') // the dangerous rm target: Claude Code treats HOME as a critical path
  const cfg = join(root, 'cfg')
  const agent = join(root, 'agent')
  const threadDir = join(root, 'thread')
  for (const d of [home, cfg, agent, join(agent, '.claude'), join(agent, 'hooks'), threadDir])
    mkdirSync(d, { recursive: true })
  cpSync(join(KIT, 'hooks'), join(agent, 'hooks'), { recursive: true })
  const cwd = opts.worker ? threadDir : agent
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
    // what WorkerSpec writes: the same hook, the agent folder's script by absolute path, in the session's own --settings file
    const settingsFile = join(root, 'worker-settings.json')
    const script = join(agent, 'hooks', 'permission-relay.py')
    writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          PermissionRequest: [
            {
              hooks: [
                {
                  type: 'command',
                  timeout: 3600,
                  command: `f=${script}; [ -f "$f" ] || exit 0; command -v python3 >/dev/null 2>&1 || exit 0; TALOS_APP_PERM_HOOK_SOURCE=worker exec python3 "$f"`,
                },
              ],
            },
          ],
        },
      }),
    )
    args.push('--settings', settingsFile)
    env.TALOS_APP_WORKER_THREAD = opts.worker.thread
    env.TALOS_APP_WORKER_NONCE = opts.worker.nonce
    writeFileSync(join(agent, '.claude', 'settings.json'), '{}')
  } else {
    writeFileSync(
      join(agent, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PermissionRequest: template.hooks.PermissionRequest } }),
    )
  }
  const sock = `talos-test-permhook-${Math.random().toString(36).slice(2, 8)}`
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
  await sleep(1500)
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

async function bridge() {
  h = await startHarness({
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
          voice_context: 'recent',
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
    test('the main session: the card shows the exact rm, Deny leaves the folder and closes the prompt', async () => {
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
    }, 120_000)

    test('the main session: Allow with step-up runs the rm exactly once', async () => {
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
          (f) => f.direction === 'from_bridge' && f.frame.type === 'card.create' && f.frame.card.kind === 'permission',
        ),
      ).toHaveLength(1)
    }, 120_000)

    test('answered at the Mac first: the card closes by itself and the folder is untouched', async () => {
      const x = await bridge()
      const api = fakeApi()
      const sb = launch(api, x.home)
      await ready(sb)
      const card = await permCard(x, 'rm -rf')
      await waitFor(() => sb.screen().includes('Do you want to proceed?'), 20_000, "Claude Code's own prompt")
      await sleep(1500) // the dialog ignores keys for a moment after it appears
      sb.type('2') // "No" at the terminal
      await x.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired', {
        direction: 'from_bridge',
      })
      // "No" at the terminal interrupts the turn (Claude Code sends no tool result), and nothing was deleted
      await waitFor(() => sb.screen().includes('Interrupted'), 20_000, 'Claude Code to show the interrupt')
      expect(existsSync(sb.home)).toBe(true)
      expect(api.log.results).toHaveLength(0)
      expect(x.bridge.ctx.permission.openCount).toBe(0)
    }, 120_000)

    test('a thread session: the same prompt lands in the thread, proven by the nonce and the pane', async () => {
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
      await x.app.resolveCard(card, 'kill', card.payload_hash)
      await waitFor(() => api.log.results.length > 0, 30_000, 'Claude Code to report the tool result')
      expect(existsSync(sb.home)).toBe(true)
    }, 120_000)

    test('the dangerous-rm countdown runs out: Claude Code blocks the call itself, the hook sees the call result in the transcript and ends, and the card closes (hook_gone)', async () => {
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
    }, 240_000)
  },
)
