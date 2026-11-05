// Independent review of PR #91 (MCP Apps WP-AP4). Each test states something docs/APPS.md, docs/SECURITY.md or the PR's
// "only the model is scripted" says, against real shipped code. A red test here is a finding; see the review comment on the PR.
//
// The Claude Code facts below come from the pinned SDK's types (sdk.d.ts in @anthropic-ai/claude-agent-sdk 0.3.299) and agree
// with the schema inside the installed binary (read as bytes, 2.1.314; no claude was started):
//   PostToolUseFailureHookInput          { tool_name, tool_input, tool_use_id, error, is_interrupt?, duration_ms?, mcp_server? }
//   PostToolUseFailureHookSpecificOutput { hookEventName, additionalContext? }
// So a failed call hands the hook `error`, not `tool_response`, and the hook cannot replace what the model sees.
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame } from '@talos-app/protocol'
import { AgentDriver } from '@talos-app/testkit'
import { mainHook } from '../../src/apps/hook-cli.ts'
import { type Harness, startHarness } from '../helpers.ts'
import { type AppsHarness, mkApps, THREAD } from './harness.ts'
import { approvedFixture, memSecrets, PROBE, tmp } from './helpers.ts'

const live: AppsHarness[] = []
const others: Harness[] = []
afterEach(async () => {
  while (live.length) await live.pop()?.h.stop()
  while (others.length) await others.pop()?.stop()
})
const boot = async () => {
  const a = await mkApps()
  live.push(a)
  return a
}

/** An app asked for a read-only call; the agent runs it and the gate claims it. Returns the view's request. */
async function claimed(a: AppsHarness, toolUseId: string) {
  const v = await a.showView()
  const f = await a.call(v.viewId, 'read_note', { id: 'n1' })
  await a.waitFor(() => a.notesOf('app_tool_call').length === 1, 3000, 'note')
  a.hook('pre-tool-use', { tool_name: 'mcp__probe__read_note', tool_input: {}, tool_use_id: toolUseId })
  return f
}

describe('a failed app-requested call, in the shape Claude Code really sends', () => {
  it('the app is told tool_failed (docs/APPS.md Troubleshooting), not too_large', async () => {
    const a = await boot()
    const f = await claimed(a, 'toolu_real_fail')
    // PostToolUseFailureHookInput: `error`, and no `tool_response`
    a.hook('post-tool-use-failure', {
      tool_name: 'mcp__probe__read_note',
      tool_input: { id: 'n1' },
      tool_use_id: 'toolu_real_fail',
      error: 'MCP error -32000: database exploded',
    })
    await a.svc.tick()
    const r = await a.response(f.request_id)
    expect(r.state).toBe('failed')
    expect(r.error?.code).toBe('tool_failed')
  })

  it('the hook answers only with fields Claude Code reads for this event (it cannot replace what the model sees)', async () => {
    const a = await boot()
    await claimed(a, 'toolu_real_fail2')
    const post = a.hook('post-tool-use-failure', {
      tool_name: 'mcp__probe__read_note',
      tool_input: { id: 'n1' },
      tool_use_id: 'toolu_real_fail2',
      error: 'MCP error -32000: database exploded',
    })
    // A handle on this event never reaches the model, so "results never reach the agent" is not true for a failure. The fix is
    // in the docs and the residuals (the error text does reach the agent), and the hook should not pretend otherwise.
    expect(
      Object.keys(post?.hookSpecificOutput ?? {}).filter((k) => k !== 'hookEventName' && k !== 'additionalContext'),
    ).toEqual([])
  })
})

describe('the agent driver stands in for Claude Code on a failed call', () => {
  async function failedCall() {
    const dir = tmp('driver-fail-')
    const stdinFile = join(dir, 'stdin.json')
    const settingsPath = join(dir, 'settings.local.json')
    const answer = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', updatedToolOutput: 'HANDLE' },
    })
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PostToolUseFailure: [
            {
              matcher: '^mcp__probe__.*',
              hooks: [{ type: 'command', command: `cat > '${stdinFile}'; printf '%s' '${answer}'` }],
            },
          ],
        },
      }),
    )
    const driver = new AgentDriver({
      settingsPath,
      servers: [{ name: 'probe', source: 'local', command: 'node', args: [PROBE] }],
      env: {},
      cwd: dir,
      sessionDir: dir,
    })
    try {
      const call = await driver.callTool('probe', 'no_such_tool', {})
      return { call, stdin: JSON.parse(readFileSync(stdinFile, 'utf8')) as Record<string, unknown> }
    } finally {
      await driver.close()
    }
  }

  it('hands the hook `error`, not `tool_response`', async () => {
    const { stdin } = await failedCall()
    expect(stdin).toHaveProperty('error')
    expect(stdin).not.toHaveProperty('tool_response')
  }, 30_000)

  it('does not apply updatedToolOutput, which Claude Code does not read on this event', async () => {
    const { call } = await failedCall()
    expect(call.modelSees).not.toBe('HANDLE')
  }, 30_000)
})

describe('the off switch (docs/APPS.md "Status and scope")', () => {
  it('bridge.env set to 0 turns off a bridge started with `export TALOS_APP_APPS=1`, the way "Turning it on" and smoke S1 start it', async () => {
    const was = process.env.TALOS_APP_APPS
    process.env.TALOS_APP_APPS = '1' // what a bridge launched from that shell has, for the life of the process
    try {
      const h = await startHarness({
        env: { TALOS_APP_APPS: '1' },
        bridge: { apps: { secrets: memSecrets().secrets, watch: false, tickMs: 3600_000 } },
      })
      others.push(h)
      const svc = h.bridge.ctx.apps
      expect(svc?.enabled()).toBe(true)
      // a running process's environment cannot be changed, so this file is the only switch the doc's "without a restart" can mean
      writeFileSync(join(h.home, 'bridge.env'), 'TALOS_APP_APPS=0\n')
      await new Promise((r) => setTimeout(r, 2100))
      expect(svc?.enabled()).toBe(false)
    } finally {
      if (was === undefined) delete process.env.TALOS_APP_APPS
      else process.env.TALOS_APP_APPS = was
    }
  }, 15_000)

  it('with the switch off the hooks do nothing: no capture on disk and no note telling the agent to call a tool it does not have', async () => {
    const home = tmp()
    const fx = await approvedFixture(home)
    const written: string[] = []
    const code = await mainHook(['post-tool-use'], {
      readStdin: async () =>
        JSON.stringify({
          session_id: 'sess_1',
          transcript_path: join(home, 'proj', 'sess_1.jsonl'),
          mcp_server: { name: 'probe', source: 'local' },
          tool_name: 'mcp__probe__show_widget',
          tool_input: {},
          tool_use_id: 'toolu_off_1',
          tool_response: '{"secret":"result held on disk while apps are off"}',
        }),
      write: (s) => void written.push(s),
      // a live session with apps never switched on: no TALOS_APP_APPS, no bridge.env
      env: { TALOS_APP_BRIDGE: '1', TALOS_APP_HOME: home },
      now: () => Date.now(),
    })
    expect(code).toBe(0)
    expect(written).toEqual([])
    expect(existsSync(fx.P.captures) ? readdirSync(fx.P.captures) : []).toEqual([])
  })
})

describe('the echo row of a ui/message (docs/APPS.md "What an app can see and do")', () => {
  it('has no push: "That row is drawn by Talos and has no sound or push."', async () => {
    const a = await boot()
    const v = await a.showView()
    await a.message(v.viewId, 'hello from the app')
    const echo = (await a.h.relay.expectFrame('reply', (r) => r.message.author === 'app' && r.message.kind === 'text', {
      direction: 'from_bridge',
    })) as Extract<Frame, { type: 'reply' }>
    // the relay pushes every `reply` that is not `silent` (apps/relay/src/core/hub.ts), and counts it unread
    expect(echo.silent).toBe(true)
  })
})

describe('the abuse rule (docs/APPS.md "Limits and budgets")', () => {
  it('three limit hits by ui/message close the view AND post a note, as they do for tools/call', async () => {
    const a = await boot()
    const v = await a.showView()
    let last = ''
    for (let i = 0; i < 9; i++) last = (await a.message(v.viewId, `m${i}`)).request_id
    expect((await a.response(last)).error?.code).toBe('rate_limited')
    await a.waitFor(() => a.updates(v.viewId).some((u) => u.state === 'closed'), 3000, 'the view to close')
    await a.h.relay.expectFrame(
      'reply',
      (f) => f.message.thread_id === THREAD && f.message.author === 'system' && /too many/.test(f.message.text ?? ''),
      { direction: 'from_bridge', timeoutMs: 1500 },
    )
  })
})
