// The agent driver against the committed probe server and tiny hook scripts: each branch of how Claude Code runs hooks
// around an MCP tool call (deny, updatedInput, updatedToolOutput, onFailure "block" for a failed or stalled gate, the
// oversize string and its tool-results file, no hook entry for an unmatched tool).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentDriver } from '../src/agent-driver.ts'

const here = dirname(fileURLToPath(import.meta.url))
const PROBE = join(here, '..', 'fixtures', 'apps-probe-server', 'server.mjs')
const drivers: AgentDriver[] = []
afterEach(async () => {
  for (const d of drivers.splice(0)) await d.close()
})

function rig(hooks: Record<string, unknown>, o: { hookTimeoutMs?: number; oversizeChars?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'driver-'))
  const log = join(dir, 'probe.jsonl')
  const settingsPath = join(dir, 'settings.local.json')
  writeFileSync(settingsPath, JSON.stringify({ hooks }))
  const driver = new AgentDriver({
    settingsPath,
    servers: [{ name: 'probe', source: 'local', command: process.execPath, args: [PROBE], env: { PROBE_LOG: log } }],
    env: { MARK: 'x' },
    cwd: dir,
    sessionDir: join(dir, 'session'),
    ...o,
  })
  drivers.push(driver)
  const calls = () => {
    try {
      return readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((l) => l.event === 'tools/call')
    } catch {
      return []
    }
  }
  return { dir, driver, calls, settingsPath }
}
const hook = (matcher: string, command: string, extra: Record<string, unknown> = {}) => [
  { matcher, hooks: [{ type: 'command', command, ...extra }] },
]
const echo = (obj: unknown) => `cat >/dev/null; printf '%s' '${JSON.stringify(obj)}'`

describe('AgentDriver', () => {
  it("no matching hook: the call just runs and the model sees the tool's own output", async () => {
    const r = rig({})
    const c = await r.driver.callTool('probe', 'read_note', { id: 'n1' })
    expect(c.ran).toBe(true)
    expect(c.hooks).toEqual([])
    expect(c.modelSees).toBe('{"id":"n1","body":"buy milk"}') // structuredContent JSON is what the model sees (P5)
  })
  it('the hook gets the shape gate G3 observed on stdin', async () => {
    const r = rig({ PostToolUse: hook('^mcp__probe__.*', 'cat > "$MARKFILE_UNUSED" 2>/dev/null; cat >/dev/null') })
    const c = await r.driver.callTool('probe', 'read_note', { id: 'n1' })
    const stdin = c.hooks[0]?.stdin as Record<string, unknown>
    expect(stdin).toMatchObject({
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__probe__read_note',
      tool_input: { id: 'n1' },
      tool_response: '{"id":"n1","body":"buy milk"}',
      mcp_server: { name: 'probe', source: 'local' },
      permission_mode: 'bypassPermissions',
    })
    expect(String(stdin.tool_use_id)).toMatch(/^toolu_/)
    expect(typeof stdin.transcript_path).toBe('string')
  })
  it('deny blocks the call before the server hears of it; updatedInput replaces the arguments', async () => {
    const deny = rig({
      PreToolUse: hook(
        '^mcp__probe__set_note$',
        echo({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'gate says no',
          },
        }),
      ),
    })
    const d = await deny.driver.callTool('probe', 'set_note', { id: 'n1' })
    expect(d.blocked).toEqual({ by: 'deny', reason: 'gate says no' })
    expect(d.modelSees).toContain('gate says no')
    expect(deny.calls()).toEqual([])
    const rewrite = rig({
      PreToolUse: hook(
        '^mcp__probe__.*',
        echo({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { id: 'REWRITTEN' },
          },
        }),
      ),
    })
    const w = await rewrite.driver.callTool('probe', 'read_note', { id: 'ORIGINAL' })
    expect(w.sentArguments).toEqual({ id: 'REWRITTEN' })
    expect(rewrite.calls()[0]?.arguments).toEqual({ id: 'REWRITTEN' })
  })
  it('updatedToolOutput replaces what the model sees (PostToolUse and PostToolUseFailure)', async () => {
    const r = rig({
      PostToolUse: hook(
        '.*',
        echo({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'HANDLE_ONLY' } }),
      ),
    })
    expect((await r.driver.callTool('probe', 'read_note', {})).modelSees).toBe('HANDLE_ONLY')
  })
  it('onFailure "block": a hook that is killed or stalls blocks the call; without the flag the same failure lets it run (G5)', async () => {
    for (const command of ['kill -9 $$', 'sleep 30']) {
      const blocked = rig({ PreToolUse: hook('.*', command, { onFailure: 'block' }) }, { hookTimeoutMs: 300 })
      const b = await blocked.driver.callTool('probe', 'read_note', {})
      expect(b.blocked?.by).toBe('onFailure')
      expect(blocked.calls()).toEqual([])
      const open = rig({ PreToolUse: hook('.*', command) }, { hookTimeoutMs: 300 })
      const o = await open.driver.callTool('probe', 'read_note', {})
      expect(o.ran).toBe(true)
      expect(open.calls().length).toBe(1)
    }
  })
  it("an oversize result becomes the error string and a real file under the session's tool-results/", async () => {
    const r = rig({}, { oversizeChars: 1000 })
    const c = await r.driver.callTool('probe', 'big', { chars: 5000 })
    const m =
      /^Error: result \(5000 characters\) exceeds maximum allowed tokens\. Output has been saved to (\S+\.txt)\./.exec(
        c.modelSees,
      )
    expect(m).not.toBeNull()
    expect(m?.[1]).toContain(join('session', 'sess_driver_1', 'tool-results', 'mcp-probe-big-'))
    expect(readFileSync(m?.[1] as string, 'utf8').length).toBe(5000)
  })
  it('the tool call carries claudecode/toolUseId and the hooks see the same id', async () => {
    const r = rig({ PreToolUse: hook('.*', 'cat >/dev/null') })
    const c = await r.driver.callTool('probe', 'read_note', {}, { toolUseId: 'toolu_fixed' })
    expect(r.calls()[0]?.meta).toMatchObject({ 'claudecode/toolUseId': 'toolu_fixed' })
    const stdin = c.hooks[0]?.stdin as { tool_use_id?: string } | undefined
    expect(stdin?.tool_use_id).toBe('toolu_fixed')
  })
  it('an unknown server is an error, not a silent no-op; settings are re-read on every call', async () => {
    const r = rig({})
    await expect(r.driver.callTool('nope', 'x', {})).rejects.toThrow('unknown server')
    expect((await r.driver.callTool('probe', 'read_note', {})).hooks).toEqual([])
    writeFileSync(r.settingsPath, JSON.stringify({ hooks: { PostToolUse: hook('.*', 'cat >/dev/null') } }))
    expect((await r.driver.callTool('probe', 'read_note', {})).hooks.length).toBe(1)
    mkdirSync(join(r.dir, 'x'), { recursive: true })
  })
})
