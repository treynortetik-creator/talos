// The guard for the bridge's mod-only tools (docs/CLAUDE-CODE.md C2.3). Three hooks use it, all fail closed:
// `tool.check` and `tool.call` deny EVERY caller (the mod never reaches these tools that way), and `mcp.call` (the op a
// plugin uses to talk to a server, which raises neither of the other two) denies every plugin but this one. The key is
// hygiene, not a boundary (the bridge verifies osig on every control), and the bridge refuses these tools on its own
// when the mod is not loaded.

/** Same shape as the protocol's isModToolName: any server name, any `talos_mod_*` tool. */
export const MOD_TOOL_RE = /^mcp__.+__talos_mod_[A-Za-z0-9_]*$/
export const MOD_TOOL_DESCRIPTION = 'Internal to the Talos mod. Never call.'
export const GUARD_REASON = 'Internal to the Talos mod. Never call.'

export function isModTool(tool: unknown): boolean {
  return typeof tool === 'string' && MOD_TOOL_RE.test(tool)
}

/** `tool.check` / `tool.call`: true = deny. A non-string name denies too (it cannot be read, so it cannot be cleared). */
export function shouldDenyModTool(tool: unknown): boolean {
  return typeof tool !== 'string' || MOD_TOOL_RE.test(tool)
}

/** The bare tool name `mcp.call` carries (no `mcp__server__` prefix). */
export const MOD_BARE_TOOL_RE = /^talos_mod_[A-Za-z0-9_]*$/

/**
 * `mcp.call`: true = deny. Only this plugin's own call to a bridge mod tool goes through; `originPlugin` is set by the
 * host from where the call came from, never by a plugin. An unreadable name or origin denies.
 */
export function shouldDenyModCall(tool: unknown, originPlugin: unknown, selfName: string): boolean {
  if (typeof tool !== 'string') return true
  if (!MOD_BARE_TOOL_RE.test(tool)) return false
  return originPlugin !== selfName
}
