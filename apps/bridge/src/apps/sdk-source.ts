// The real McpStatusSource: an Agent SDK session in the agent folder, driving the INSTALLED `claude`, with hooks off and
// no model turn (M5.1 steps 1-3, gates G1-G2). The prompt stream never yields, so nothing is ever billed and no tool can
// run; only control requests are used: initializationResult, mcpServerStatus, reconnectMcpServer, readMcpResource.
import { type Options, type SDKUserMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { McpStatusSource, RawServer } from './scan.ts'
import { ScanStop } from './scan.ts'

export { resolveClaude } from '../claude-path.ts'

export type ScanOptionInput = {
  agentDir: string
  claudePath: string
  env: Record<string, string | undefined>
  excludePlugins: string[]
}

/**
 * `settings.disableAllHooks` is required, not optional: without it the scan fired the folder's SessionStart hook (G2).
 * `strictMcpConfig` stays false so plugin servers load (P11). The env drops TALOS_APP_BRIDGE (this is not the live bridge)
 * and sets legacy negotiation as the live launch does (SPEC 4.1).
 */
export function buildScanOptions(i: ScanOptionInput): Options {
  const env: Record<string, string | undefined> = { ...i.env }
  delete env.TALOS_APP_BRIDGE
  env.MCP_PROTOCOL_NEGOTIATION = 'legacy'
  return {
    cwd: i.agentDir,
    pathToClaudeCodeExecutable: i.claudePath,
    settings: {
      disableAllHooks: true,
      ...(i.excludePlugins.length
        ? { enabledPlugins: Object.fromEntries(i.excludePlugins.map((n) => [n, false])) }
        : {}),
    },
    strictMcpConfig: false,
    env,
  } as Options
}

/** An async iterable that never yields and ends only when `end()` is called. */
export function neverYielding(): { iterable: AsyncIterable<SDKUserMessage>; end: () => void; yielded: () => number } {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const n = 0
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            await gate
            return { done: true, value: undefined } as IteratorResult<SDKUserMessage>
          },
          async return() {
            release()
            return { done: true, value: undefined } as IteratorResult<SDKUserMessage>
          },
        }
      },
    },
    end: () => release(),
    yielded: () => n,
  }
}

type QueryFn = typeof sdkQuery

export function sdkStatusSource(i: ScanOptionInput, queryFn: QueryFn = sdkQuery): McpStatusSource {
  const prompt = neverYielding()
  let q: ReturnType<QueryFn> | undefined
  const need = () => {
    if (!q) throw new ScanStop('The scan session is not started.')
    return q
  }
  return {
    async start() {
      q = queryFn({ prompt: prompt.iterable, options: buildScanOptions(i) })
      const init = await q.initializationResult()
      return { claudeCodeVersion: (init as { claude_code_version?: string }).claude_code_version }
    },
    async status() {
      const list = await need().mcpServerStatus()
      return list.map(
        (s): RawServer => ({
          name: s.name,
          status: s.status,
          error: s.error,
          config: s.config,
          source: s.source,
          scope: s.scope,
          tools: s.tools?.map((t) => ({ name: t.name, annotations: t.annotations, _meta: t._meta })),
        }),
      )
    },
    async reconnect(name) {
      await need().reconnectMcpServer(name)
    },
    async readResource(server, uri) {
      const r = await need().readMcpResource(server, uri)
      return { contents: r.contents }
    },
    close() {
      prompt.end()
      try {
        q?.close()
      } catch {
        // already closed
      }
    },
  }
}
