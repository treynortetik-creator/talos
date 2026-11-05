// The slice of the engine interface `$` the mod uses, spelled structurally so the pure logic in hooks/lib type-checks
// (and runs under bun test) without the engine-written `claude-code` declaration file. `$` itself may never be bound or
// passed (the engine's static check, `claude plugin validate`), so register.ts builds this adapter, each member a lambda
// spelled `$.noun.method()` at its call site, and the lib only ever sees the adapter.

export type McpContentBlock = { type?: string; text?: string }
export type McpResultLike = { content?: McpContentBlock[]; isError?: boolean }

export type ToolInfoLike = { name: string; description?: string; mcp?: boolean }
export type CommandInfoLike = { name: string; description?: string; source?: string; plugin?: string }
export type ConfigRowLike = {
  key: string
  value?: unknown
  options?: readonly string[]
  provider?: { plugin?: string }
}
export type UsageLike = {
  context?: { tokens?: number; window?: number; percent?: number }
  rateLimits?: Array<{ kind?: string; percentUsed?: number; resetsAt?: string }>
  cost?: { usd?: number }
}

export interface EngineLike {
  plugin: { name: string }
  /** The bridge's 0600 key file, read with `$.fs`. The key never leaves the mod: calls carry HMACs made with it. */
  secret: { read(): Promise<string> }
  clock: {
    now(): Promise<number>
    every(ms: number, fn: () => void): unknown
    /** One-shot timer (`$.clock.after`): the 15 s waits of WP-C3 run on it. */
    after(ms: number, fn: () => void): unknown
  }
  mcp: { call(server: string, tool: string, args?: Record<string, unknown>): Promise<McpResultLike> }
  tool: { list(): Promise<ToolInfoLike[]> }
  command: {
    list(): Promise<CommandInfoLike[]>
    /** WP-C3. Queued by the engine until idle; rejects an unknown name, or inside a hook the turn waits on. */
    run(input: { command: string; args?: string }): Promise<{ text?: string } | undefined>
  }
  /** WP-C3. Rejects, naming both ids, when `turnId` is not the running turn. */
  turn: { abort(input: { turnId: string }): Promise<unknown> }
  config: { list(): Promise<ConfigRowLike[]> }
  session: {
    id(): Promise<string>
    model(): Promise<string>
    version(): Promise<{ version?: string; base?: string }>
    usage(): Promise<UsageLike>
    surfaces(): Promise<readonly string[]>
    /** WP-C3. Rejects while a turn runs; resolves `{ skip }` when another plugin vetoed it. */
    compact(input: { instructions?: string }): Promise<{ skip?: boolean | string } | undefined>
  }
  /** docs/SUBAGENTS.md: `$.agent.list()`. Absent on an adapter that predates the agents panel. */
  agent?: { list(): Promise<unknown> }
  /** docs/SUBAGENTS.md: the session's tee file under $TALOS_APP_HOME, read with `$.fs` (and blanked at session end). */
  tee?: { read(sessionId: string): Promise<string>; clear(sessionId: string): Promise<void> }
  /** docs/SUBAGENTS.md: `$.tool.call({ tool: 'TaskStop', task_id })`. Resolves with the tool's result or `{ deny }`. */
  tasks?: { stop(taskId: string): Promise<TaskStopResultLike> }
}

/** What `$.tool.call` resolves to (ToolCallResult): `{ deny }`, or `{ result, text, isError? }` from core. */
export type TaskStopResultLike = { deny?: string; text?: string; isError?: boolean; result?: unknown } | undefined
