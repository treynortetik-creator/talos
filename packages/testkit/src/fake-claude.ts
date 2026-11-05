// FakeClaude: an MCP client that stands in for a Claude Code session. It spawns the bridge (or any channel server)
// over stdio with @modelcontextprotocol/sdk 1.32.2, records `notifications/claude/channel`, calls tools, and in
// `autoReply` mode answers like the e2e suite expects: a `reply` with `ack: <content>`, and `card_result ok` after a
// PRIMARY card_action.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  PERMISSION_CAPABILITY,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
  PermissionRequestParams,
  type PermissionRequestT,
  PermissionVerdictParams,
} from '@talos-app/protocol'
import { z } from 'zod'
import { AgentDriver, type AgentDriverOptions } from './agent-driver.ts'
import { waitFor } from './frame-utils.ts'

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }),
})

const PermissionVerdictNote = z.object({
  method: z.literal(PERMISSION_VERDICT_METHOD),
  params: z.object({ request_id: z.unknown(), behavior: z.unknown() }).loose(),
})

/** What Claude Code did with a channel verdict (channels reference, "Relay permission prompts"). */
export type PermissionOutcome = 'applied' | 'unknown_id' | 'repeated_id' | 'closed' | 'malformed'
export type PermissionVerdictRecord = { request_id: string; behavior: string; outcome: PermissionOutcome; at: number }
export type PermissionPromptState = 'open' | 'allowed' | 'denied'

export type ChannelNote = { content: string; meta: Record<string, string>; at: number }
export type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean }

export type FakeClaudeOptions = {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  /** Reply `ack: <content>` to text notifications and approve primary card actions. Default false. */
  autoReply?: boolean
  /** Tool used for replies; default `reply`. */
  replyTool?: string
  /** The MCP `clientInfo.version` Claude Code reports; default `0.0.0` (below the permission relay's version floor). */
  clientVersion?: string
  /**
   * `agentDriver` mode (MCP-APPS-SPEC M6.1): also holds real MCP clients to connector servers and runs the real hook command
   * lines around every tool call. See `AgentDriver`. Absent: FakeClaude behaves as before.
   */
  agentDriver?: AgentDriverOptions
}

export class FakeClaude {
  readonly notifications: ChannelNote[] = []
  readonly toolCalls: Array<{ name: string; args: Record<string, unknown>; result: ToolResult }> = []
  /** Every verdict a channel sent, with what Claude Code did with it. */
  readonly permissionVerdicts: PermissionVerdictRecord[] = []
  private prompts = new Map<string, { state: PermissionPromptState; repeated: boolean }>()
  autoReply: boolean
  private client: Client
  private transport: StdioClientTransport
  private opts: FakeClaudeOptions
  private stderrText = ''
  /** Set in `agentDriver` mode. */
  readonly driver: AgentDriver | undefined

  constructor(opts: FakeClaudeOptions) {
    this.opts = opts
    this.driver = opts.agentDriver ? new AgentDriver(opts.agentDriver) : undefined
    this.client = new Client({ name: 'fake-claude', version: opts.clientVersion ?? '0.0.0' }, { capabilities: {} })
    this.autoReply = opts.autoReply ?? false
    this.transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) },
      stderr: 'pipe',
    })
    this.client.setNotificationHandler(ChannelNotification, (n) => {
      const note: ChannelNote = { content: n.params.content, meta: n.params.meta ?? {}, at: Date.now() }
      this.notifications.push(note)
      if (this.autoReply) void this.handleAuto(note)
    })
    this.client.setNotificationHandler(PermissionVerdictNote, (n) => {
      this.applyChannelVerdict(n.params)
    })
  }

  // ---- permission relay (Claude Code's side) ------------------------------------------------------------------------

  /**
   * A tool approval prompt opens. Like Claude Code, sends `permission_request` only to a server that declared
   * `claude/channel/permission: {}`; an id seen before in this session is marked repeated. Throws on fields that break
   * the documented format (a fixture bug, not a case to model).
   */
  async openPermission(req: PermissionRequestT): Promise<{ relayed: boolean }> {
    const r = PermissionRequestParams.parse(req)
    const prev = this.prompts.get(r.request_id)
    if (prev) {
      prev.state = 'open'
      prev.repeated = true
    } else this.prompts.set(r.request_id, { state: 'open', repeated: false })
    const declared = this.client.getServerCapabilities()?.experimental?.[PERMISSION_CAPABILITY]
    if (typeof declared !== 'object' || declared === null) return { relayed: false }
    await this.client.notification({ method: PERMISSION_REQUEST_METHOD, params: r })
    return { relayed: true }
  }

  /** The person at the terminal answers first; a later channel verdict for the id is then dropped. */
  answerAtTerminal(requestId: string, behavior: 'allow' | 'deny'): void {
    const p = this.prompts.get(requestId)
    if (p?.state === 'open') p.state = behavior === 'allow' ? 'allowed' : 'denied'
  }

  /** Applies a channel verdict by Claude Code's rules: open id only, never a repeated id, first answer wins. */
  applyChannelVerdict(params: { request_id: unknown; behavior: unknown }): PermissionOutcome {
    const v = PermissionVerdictParams.safeParse({ request_id: params.request_id, behavior: params.behavior })
    let outcome: PermissionOutcome
    if (!v.success) outcome = 'malformed'
    else {
      const p = this.prompts.get(v.data.request_id)
      if (!p) outcome = 'unknown_id'
      else if (p.repeated) outcome = 'repeated_id'
      else if (p.state !== 'open') outcome = 'closed'
      else {
        p.state = v.data.behavior === 'allow' ? 'allowed' : 'denied'
        outcome = 'applied'
      }
    }
    this.permissionVerdicts.push({
      request_id: String(params.request_id),
      behavior: String(params.behavior),
      outcome,
      at: Date.now(),
    })
    return outcome
  }

  permissionState(requestId: string): PermissionPromptState | undefined {
    return this.prompts.get(requestId)?.state
  }

  async waitForVerdict(requestId: string, timeoutMs = 4000): Promise<PermissionVerdictRecord> {
    let found: PermissionVerdictRecord | undefined
    await waitFor(
      () => {
        found = this.permissionVerdicts.find((v) => v.request_id === requestId)
        return Boolean(found)
      },
      timeoutMs,
      `a permission verdict for ${requestId}`,
    )
    return found as PermissionVerdictRecord
  }

  async start(): Promise<this> {
    this.transport.stderr?.on('data', (d) => {
      this.stderrText += d.toString()
    })
    await this.client.connect(this.transport)
    return this
  }

  async stop(): Promise<void> {
    await this.driver?.close()
    await this.client.close()
  }

  get stderr() {
    return this.stderrText
  }

  /** The server's declared capabilities (should include experimental['claude/channel']). */
  get serverCapabilities() {
    return this.client.getServerCapabilities()
  }
  get serverInstructions() {
    return this.client.getInstructions()
  }

  async listTools() {
    return (await this.client.listTools()).tools
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const result = (await this.client.callTool({ name, arguments: args })) as ToolResult
    this.toolCalls.push({ name, args, result })
    return result
  }

  async waitForNotification(
    predicate: (n: ChannelNote) => boolean = () => true,
    timeoutMs = 4000,
  ): Promise<ChannelNote> {
    let found: ChannelNote | undefined
    await waitFor(
      () => {
        found = this.notifications.find(predicate)
        return Boolean(found)
      },
      timeoutMs,
      `a channel notification (${this.notifications.length} seen)`,
    )
    return found as ChannelNote
  }

  private async handleAuto(note: ChannelNote) {
    try {
      const kind = note.meta.kind
      const thread = note.meta.thread_id ?? note.meta.chat_id
      if (kind === 'card_action') {
        if (note.meta.card_action === 'primary' && note.meta.card_id) {
          await this.callTool('card_result', { card_id: note.meta.card_id, ok: true, text: 'done' })
        }
        return
      }
      if (thread && (kind === 'text' || kind === 'voice_note')) {
        await this.callTool(this.opts.replyTool ?? 'reply', { thread_id: thread, text: `ack: ${note.content}` })
      }
    } catch {
      // The tests assert on what they care about; an auto-reply failure shows up as a missing reply.
    }
  }
}
