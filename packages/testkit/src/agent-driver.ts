// The agent driver (MCP-APPS-SPEC M6.1): stands in for Claude Code around every MCP tool call. It holds REAL MCP clients to
// the connector servers and, around each call, runs the REAL hook command lines it reads from an install-written
// settings.local.json: PreToolUse before (applying `deny`, `updatedInput`, and `onFailure: "block"` for a killed or stalled
// hook), PostToolUse(Failure) after (applying `updatedToolOutput`). The hook stdin has the shape gate G3 observed
// (`tool_response` a string; an oversize result becomes the error string plus a real tool-results file). Only the model is
// scripted: the caller decides which tool to call with which arguments.
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export type AgentServer = {
  /** `mcp_server.name` Claude Code reports (plugin servers: `plugin:<p>:<s>`). */
  name: string
  /** `mcp_server.source`. */
  source: string
} & (
  | { command: string; args: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> }
)

export type AgentDriverOptions = {
  /** The install-written `<agent-dir>/.claude/settings.local.json`. Re-read on every call, like Claude Code. */
  settingsPath: string
  servers: AgentServer[]
  /** The environment hooks run in: TALOS_APP_BRIDGE=1, TALOS_APP_HOME, and the rest (an empty HOME in tests). */
  env: Record<string, string>
  cwd: string
  /** Where the session's transcript and tool-results live (the hook input's transcript_path is inside it). */
  sessionDir: string
  sessionId?: string
  /** A result longer than this many characters becomes Claude Code's oversize error string (a token cap in reality). */
  oversizeChars?: number
  /** Wall-clock cap for a hook that overruns `timeout` seconds; tests use a small number. Default: the entry's own. */
  hookTimeoutMs?: number
}

type HookRun = {
  event: string
  command: string
  stdin: unknown
  stdout: string
  code: number | null
  timedOut: boolean
}

export type DriverCall = {
  /** What the model is shown for this call. */
  modelSees: string
  /** The server received the call. */
  ran: boolean
  /** The arguments the server actually received (after `updatedInput`). */
  sentArguments?: Record<string, unknown>
  blocked?: { by: 'deny' | 'onFailure'; reason: string }
  serverResult?: { content: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean }
  hooks: HookRun[]
  toolUseId: string
}

type HookEntry = { type?: string; command?: string; timeout?: number; onFailure?: string }
type Group = { matcher?: string; hooks?: HookEntry[] }

const norm = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')

export class AgentDriver {
  private clients = new Map<string, { client: Client; close: () => Promise<void> }>()
  private n = 0
  readonly calls: DriverCall[] = []
  readonly sessionId: string

  constructor(private readonly o: AgentDriverOptions) {
    this.sessionId = o.sessionId ?? 'sess_driver_1'
  }

  private async client(s: AgentServer): Promise<Client> {
    const have = this.clients.get(s.name)
    if (have) return have.client
    const client = new Client({ name: 'claude-code', version: '2.1.312' }, { capabilities: {} })
    if ('url' in s) {
      const t = new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: s.headers ?? {} } })
      await client.connect(t)
    } else {
      const t = new StdioClientTransport({
        command: s.command,
        args: s.args,
        env: { PATH: process.env.PATH ?? '', ...(s.env ?? {}) },
        stderr: 'pipe',
      })
      await client.connect(t)
    }
    this.clients.set(s.name, { client, close: () => client.close() })
    return client
  }

  /** Hook entries for an event whose matcher (a regex over the tool name) matches. */
  private entries(event: string, toolName: string): HookEntry[] {
    let settings: { hooks?: Record<string, Group[]> }
    try {
      settings = JSON.parse(readFileSync(this.o.settingsPath, 'utf8'))
    } catch {
      return []
    }
    const out: HookEntry[] = []
    for (const g of settings.hooks?.[event] ?? []) {
      if (g.matcher !== undefined && !new RegExp(g.matcher).test(toolName)) continue
      for (const h of g.hooks ?? []) if (h.type === 'command' && h.command) out.push(h)
    }
    return out
  }

  private runHook(event: string, h: HookEntry, stdin: unknown): Promise<HookRun> {
    const timeoutMs = this.o.hookTimeoutMs ?? (h.timeout ?? 60) * 1000
    return new Promise((resolve) => {
      let child: ChildProcess
      let stdout = ''
      let timedOut = false
      try {
        child = spawn('sh', ['-c', h.command as string], {
          cwd: this.o.cwd,
          env: { PATH: process.env.PATH ?? '', ...this.o.env },
          stdio: ['pipe', 'pipe', 'ignore'],
          detached: true, // own process group, so the timeout kills a forked child (dash forks `sleep`) too
        })
      } catch {
        return resolve({ event, command: h.command as string, stdin, stdout: '', code: null, timedOut: false })
      }
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, timeoutMs)
      child.stdout?.on('data', (d) => {
        stdout += String(d)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        // wait for the output to drain, but not for a grandchild that kept the pipe open
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve({ event, command: h.command as string, stdin, stdout, code, timedOut })
        }
        child.stdout?.once('end', finish)
        setTimeout(finish, 200)
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify(stdin))
    })
  }

  private base(toolName: string, server: AgentServer, input: unknown, id: string) {
    return {
      session_id: this.sessionId,
      transcript_path: join(this.o.sessionDir, `${this.sessionId}.jsonl`),
      cwd: this.o.cwd,
      permission_mode: 'bypassPermissions',
      tool_name: toolName,
      tool_input: input,
      tool_use_id: id,
      mcp_server: { name: server.name, source: server.source },
    }
  }

  /** One agent tool call, hooks and all. `server` is the name given in `servers`. */
  async callTool(
    serverName: string,
    tool: string,
    args: Record<string, unknown>,
    opts: { toolUseId?: string } = {},
  ): Promise<DriverCall> {
    const server = this.o.servers.find((s) => s.name === serverName)
    if (!server) throw new Error(`driver: unknown server ${serverName}`)
    const toolName = `mcp__${norm(server.name)}__${tool}`
    const id = opts.toolUseId ?? `toolu_${String(++this.n).padStart(4, '0')}`
    const call: DriverCall = { modelSees: '', ran: false, hooks: [], toolUseId: id }
    this.calls.push(call)
    let sent = args
    // PreToolUse: deny, updatedInput, and a failed or stalled hook that blocks when `onFailure` is "block"
    for (const h of this.entries('PreToolUse', toolName)) {
      const run = await this.runHook('PreToolUse', h, {
        ...this.base(toolName, server, sent, id),
        hook_event_name: 'PreToolUse',
      })
      call.hooks.push(run)
      if (run.timedOut || run.code !== 0) {
        if (h.onFailure === 'block') {
          call.blocked = { by: 'onFailure', reason: run.timedOut ? 'hook timed out' : 'hook failed' }
          call.modelSees = `PreToolUse hook ${run.timedOut ? 'timed out' : 'failed'}; blocking because onFailure is "block"`
          return call
        }
        continue
      }
      let out: {
        hookSpecificOutput?: {
          permissionDecision?: string
          permissionDecisionReason?: string
          updatedInput?: Record<string, unknown>
        }
      } = {}
      try {
        out = run.stdout.trim() ? JSON.parse(run.stdout) : {}
      } catch {
        continue
      }
      const hso = out.hookSpecificOutput
      if (hso?.permissionDecision === 'deny') {
        call.blocked = { by: 'deny', reason: hso.permissionDecisionReason ?? '' }
        call.modelSees = `PreToolUse hook error: ${hso.permissionDecisionReason ?? ''}`
        return call
      }
      if (hso?.updatedInput) sent = hso.updatedInput
    }
    const client = await this.client(server)
    let ok = true
    let toolResponse: string
    try {
      const res = (await client.callTool({
        name: tool,
        arguments: sent,
        _meta: { 'claudecode/toolUseId': id },
      })) as NonNullable<DriverCall['serverResult']>
      call.ran = true
      call.sentArguments = sent
      call.serverResult = res
      ok = res.isError !== true
      const text = res.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n')
      // when structuredContent is present the model and the hook see only its JSON (P5, G3)
      toolResponse = res.structuredContent !== undefined ? JSON.stringify(res.structuredContent) : text
    } catch (e) {
      call.ran = true
      ok = false
      toolResponse = `Error: ${(e as Error).message}`
    }
    const cap = this.o.oversizeChars ?? 50_000
    if (toolResponse.length > cap) {
      const dir = join(this.o.sessionDir, this.sessionId, 'tool-results')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `mcp-${norm(server.name)}-${norm(tool)}-${Date.now()}.txt`)
      writeFileSync(file, toolResponse)
      toolResponse = `Error: result (${toolResponse.length} characters) exceeds maximum allowed tokens. Output has been saved to ${file}. Format: JSON with schema: {"type":"string"}`
    }
    call.modelSees = toolResponse
    const event = ok ? 'PostToolUse' : 'PostToolUseFailure'
    for (const h of this.entries(event, toolName)) {
      // Claude Code's schemas (agent SDK 0.3.299 types, checked against the installed binary's schema): PostToolUse input has
      // `tool_response`; PostToolUseFailure input has `error` and NO `tool_response`. The failure hook's output accepts only
      // `additionalContext`, so it cannot replace what the model sees; PostToolUse also takes `updatedToolOutput`.
      const stdin = ok
        ? { ...this.base(toolName, server, sent, id), hook_event_name: event, tool_response: toolResponse }
        : { ...this.base(toolName, server, sent, id), hook_event_name: event, error: toolResponse, is_interrupt: false }
      const run = await this.runHook(event, h, stdin)
      call.hooks.push(run)
      if (run.timedOut || run.code !== 0) continue // post hooks fail open
      try {
        const out = run.stdout.trim() ? JSON.parse(run.stdout) : {}
        const hso = out.hookSpecificOutput as { updatedToolOutput?: string; additionalContext?: string } | undefined
        if (ok && typeof hso?.updatedToolOutput === 'string') call.modelSees = hso.updatedToolOutput
        else if (typeof hso?.additionalContext === 'string')
          call.modelSees = `${call.modelSees}\n${hso.additionalContext}`
      } catch {
        // an unparseable hook answer changes nothing
      }
    }
    return call
  }

  async close(): Promise<void> {
    for (const c of this.clients.values()) await c.close().catch(() => {})
    this.clients.clear()
  }
}
