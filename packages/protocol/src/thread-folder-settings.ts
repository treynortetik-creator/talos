// The one table of what a thread session's project settings may carry (tables/thread-folder-settings.json): read by the Linux
// supervisor and bridge (apps/bridge/src/worker/project-settings.ts), and held equal (swift-parity.test.ts) to the Mac's
// (WorkerHookFolder.swift) and the hook's (kit/hooks/permission-relay.py), so the three
// cannot drift. Allow-lists, never deny-lists: what can run code before a hook's clean environment has no short list.
import table from '../tables/thread-folder-settings.json' with { type: 'json' }

export const THREAD_FOLDER_SETTINGS_VERSION: number = table.version
/** The env keys a project's settings may set, in every folder: Claude Code's own limits and switches. */
export const THREAD_FOLDER_ALLOWED_ENV: ReadonlySet<string> = new Set(table.allowedEnv)
/** The top-level keys a folder other than the agent's may have. */
export const THREAD_FOLDER_ALLOWED_KEYS: ReadonlySet<string> = new Set(table.allowedKeys)
/** `permissions` keys outside the agent folder: rules that only take away. */
export const THREAD_FOLDER_ALLOWED_PERMISSION_KEYS: ReadonlySet<string> = new Set(table.allowedPermissionKeys)
/** The frontmatter keys a skill, command or agent file in those folders may not carry (compared without case, `-` or `_`). */
export const THREAD_FOLDER_REFUSED_FRONTMATTER_KEYS: readonly string[] = table.refusedFrontmatterKeys
/** The instruction files a thread-folder session is handed, per folder, in order (`mode`: which instructionFiles mode reads it). */
export const THREAD_INSTRUCTION_FILES: ReadonlyArray<{ path: string; mode: 'claude' | 'agents' }> = table
  .instructionFiles.perFolder as Array<{ path: string; mode: 'claude' | 'agents' }>
export const THREAD_INSTRUCTION_FILE_CAP: number = table.instructionFiles.fileCap
export const THREAD_INSTRUCTION_TOTAL_CAP: number = table.instructionFiles.totalCap

/**
 * Why a permission rule a thread folder's settings carry may not go into a session's `--settings`, or null when it may. Claude
 * Code 2.1.322 skips a malformed rule but stops the session at start on a "Settings Warning" dialog (Continue / Fix with Claude /
 * Exit), which no one answers in a thread session: so a carried rule is held to its grammar first, a little stricter than Claude
 * Code, and one that fails it refuses the start (never dropped: that would widen what the session may do) (vectors in packages/protocol/fixtures/permission-rule-grammar.json, what 2.1.322 said of each beside it). A tool name
 * is an uppercase-first word (`Bash`, `WebFetch`, `My_Tool`) or an MCP name (`mcp__server`, `mcp__server__tool`); then
 * optionally `(content)` with content not empty, the rule ending at its closing `)` (parentheses inside are literal); no
 * control characters, at most 1000 characters.
 */
export function permissionRuleProblem(rule: string): string | null {
  if (rule.length === 0 || rule.length > 1000) return 'empty or longer than 1000 characters'
  if ([...rule].some(controlOrBreak)) return 'a control character or line break'
  const open = rule.indexOf('(')
  const tool = open < 0 ? rule : rule.slice(0, open)
  if (!/^(?:[A-Z][A-Za-z0-9_]*|mcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_*-]+)?)$/.test(tool))
    return 'not a tool name (uppercase first, or mcp__…)'
  if (open < 0) return rule.includes(')') ? 'a ")" with no "("' : null
  if (!rule.endsWith(')')) return 'does not end at its closing ")"'
  if (rule.length - open - 2 === 0) return 'empty parentheses'
  return null
}

/** A control character, DEL, or the line and paragraph separators (U+2028, U+2029). */
const controlOrBreak = (c: string): boolean => {
  const n = c.codePointAt(0) ?? 0
  return n < 0x20 || n === 0x7f || n === 0x2028 || n === 0x2029
}
