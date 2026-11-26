// Why did this permission card ask? Claude Code does not say. Its channel request and its PermissionRequest hook input carry no
// reason, so the only thing the bridge can PROVE is one case: the agent's settings files (the owner's own, and the agent folder's) hold an ask rule that matches the call, and
// Claude Code asks for such a call in every mode, Bypass included (docs/CLAUDE-CODE.md C1.6). That is `your_rule`.
//
// "Claude Code's own safety check" is not here: it cannot be told apart from the other reasons Claude Code asks in Bypass (an
// organisation's ask rule, a tool that needs the owner, the critical-path rm, ...), and "no rule matched" proves none of them.
// Anything unknown is no line on the card.
//
// So matching only ever says yes when it is certain. It reads the shapes the kit's own rules use (a bare tool name, an MCP server,
// `Bash(<glob>)` with the older `:*` suffix) and says no to everything else, including rules it cannot read.
import { legacyRuleSuffix } from './ask-rules.ts'

/**
 * The command parts a Bash rule is tested against: the whole command, and, for a plain chain, each part. A leading `VAR=value` is
 * NOT stripped (nobody has shown Claude Code does; a miss only hides the line). Only a command with none of the following is
 * split: a quote, backtick, backslash or substitution, a here-document or here-string (`<<`), a `#` comment, or a bare `&`
 * (background). In those, where a command really starts is Claude Code's parse, and text in a heredoc body or after a `#` is
 * not a command, so only the whole command is matched.
 */
function commandParts(command: string): string[] {
  const whole = command.trim()
  const parts = new Set([whole])
  if (!/["'`#\\]|\$[({]|<<|(?<!&)&(?!&)/.test(whole))
    for (const p of whole.split(/&&|\|\||;|\|/)) {
      const t = p.trim()
      if (t) parts.add(t)
    }
  parts.delete('')
  return [...parts]
}

/** A rule glob: `*` is any text, every other character is itself (never a regex). Matches the whole text. */
function globMatches(glob: string, text: string): boolean {
  const re = glob
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*')
  return new RegExp(`^${re}$`, 'u').test(text)
}

/** True only when some rule certainly matches this call; false for no match and for anything it cannot read. */
export function askRuleMatches(rules: readonly string[], tool: string, input: unknown): boolean {
  for (const raw of rules) {
    if (typeof raw !== 'string') continue
    const rule = legacyRuleSuffix(raw.trim()) // whitespace is matched as written
    const m = /^([^()\s]+)(?:\(([\s\S]*)\))?$/.exec(rule)
    if (!m) continue
    const name = m[1] as string
    const spec = m[2]
    if (spec === undefined) {
      // a bare tool name; `mcp__server` covers every tool of that server
      if (name === tool) return true
      if (/^mcp__[^_].*$/.test(name) && !name.slice(5).includes('__') && tool.startsWith(`${name}__`)) return true
      continue
    }
    if (name !== 'Bash' || tool !== 'Bash' || spec === '') continue
    const command = (input as { command?: unknown } | null)?.command
    if (typeof command !== 'string') continue
    // A here-document, a `#` comment or a line break: what follows may be text, not a command (a heredoc body, a comment), and a
    // rule that starts with `*` (the kit's defaults do) would match straight through it. No line at all; a miss only hides it.
    if (/<<|#|[\r\n]/.test(command)) continue
    if (commandParts(command).some((p) => globMatches(spec, p))) return true
  }
  return false
}

/** The one mode in which the owner wonders why anything asked, as Claude Code names it in a hook's input. Nothing else counts. */
export const BYPASS_MODE = 'bypassPermissions'
