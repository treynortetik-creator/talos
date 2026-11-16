// The fixed parts of a thread session's MCP allow list (docs/OPTION-C.md "Leads and the fence", `session_opts.mcp_allow`), one
// source for both supervisors and the bridge's lead settings. The Mac app's WorkerMcp.swift says the same; a parity test reads it.

/** The server every thread session keeps, list or no list. */
export const WORKER_MCP_APP = 'talos-app'
/** Servers no allow list can open: they drive the owner's browser and screen. */
export const MCP_NEVER_OPEN = ['claude-in-chrome', 'computer-use'] as const
/**
 * Denied to every Talos session, list or no list: Claude Code's own screen control. Talos's screen tools replace it
 * (`screen_*`, through the Mac app's screen helper), so its terminal permission dialog can never park a session.
 */
export const MCP_ALWAYS_DENIED = ['computer-use'] as const
/** A claude.ai account connector, as Claude Code names it (`claude.ai Gmail`); compared lower-cased. */
export const MCP_CONNECTOR_PREFIX = 'claude.ai '
/** The deny rule that keeps every claude.ai connector's tools out. */
export const MCP_CONNECTOR_DENY = 'mcp__claude_ai_*'
/** Channel plugins: a thread session is never a channel, so their servers are never on a list. */
export const MCP_CHANNEL_PLUGINS = ['telegram', 'imessage'] as const

export const isMcpConnector = (name: string): boolean => name.toLowerCase().startsWith(MCP_CONNECTOR_PREFIX)

/**
 * The prefix Claude Code gives a server's tools (`mcp__<prefix>__<tool>`), as its own function has it (read from the 2.1.322
 * binary): every UTF-16 code unit outside ASCII letters, digits, `_` and `-` becomes `_` (so a character outside the BMP is
 * two), and a name that starts with `claude.ai ` has its runs of `_` made one and its leading and trailing `_` dropped. A
 * plugin's server `plugin:<plugin>:<server>` comes out as `plugin_<plugin>_<server>` by the same rule.
 */
export function mcpToolPrefix(name: string): string {
  const r = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return name.startsWith('claude.ai ') ? r.replace(/_+/g, '_').replace(/^_|_$/g, '') : r
}

/** Where the supervisor writes a thread session's generated MCP config (0600 in a 0700 folder). */
export const workerMcpConfigPath = (talosHome: string, threadId: string): string =>
  `${talosHome}/workers/${threadId}/mcp/mcp.json`
