// The value rules and rows of the thread fields an agent sets a session up with (folder, model, effort, MCP list, colour). Kept
// out of settings-table.ts, which holds the table; its THREAD_FIELD_RULES spreads SETUP_THREAD_FIELD_RULES in.
import { z } from 'zod'
import { ModelValue } from './config.ts'
import { ThreadId } from './ids.ts'
import { THREAD_COLORS, THREAD_TOPIC_MAX } from './models.ts'
import { DOCUMENTED_EFFORTS } from './session.ts'
import type { ThreadFieldRow } from './settings-table.ts'
import { AbsolutePath, McpAllowList } from './thread-sessions.ts'

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/
export const Plain = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (s) => !UNSAFE_TEXT.test(s) && s.trim() === s && s.trim().length >= min,
      'plain text, no control characters',
    )

export const none = (v: unknown) => (v === '' || v === null || v === undefined ? 'none' : String(v))

/**
 * The value rules of the thread fields an agent may set. One copy: the per-field paths (`threads.<id>.model`) and a new
 * thread's own fields (`threads.<new_id>`) both take these, so a value never passes in one form and fails in the other.
 * What a rule cannot see (the folder's roots, the model list, the parent's reach) is judged in config-propose.ts.
 */
export const ThreadColorValue = z.enum(THREAD_COLORS)
export const ThreadEffortValue = z.enum(DOCUMENTED_EFFORTS)
export const ThreadIdleValue = z.number().int().min(5).max(720)
export const ThreadSessionValue = z.enum(['shared', 'dedicated'])
// What Plain and a server name refuse too: C1 controls, line and paragraph separators, zero-width and direction marks, the BOM. Kept
// here, on a proposal's value, and not in `AbsolutePath`, which also reads folders already on disk and must stay as lenient as before.
const HIDDEN_TEXT = /[\u0080-\u009f\u061c\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/
/**
 * An absolute folder, written the way the checks read it: empty segments and a trailing slash gone, `..` kept so it is refused.
 * No hidden or direction-changing characters, so the text a card shows is the folder it grants.
 */
export const ThreadCwdValue = AbsolutePath.refine(
  (p) => !HIDDEN_TEXT.test(p),
  'the folder must be plain text: no control, invisible or direction-changing characters',
).transform((p) => `/${p.split('/').filter(Boolean).join('/')}`)

/**
 * A new thread: a name, and optionally the "what goes here" line, an icon, a colour, the parent, its own session and that
 * session's folder, model, effort, MCP list and idle time. Strict, so nothing else (a kind, an id) can ride along.
 */
export const NewThread = z.strictObject({
  name: Plain(1, 40),
  topic: Plain(0, THREAD_TOPIC_MAX).optional(),
  icon: Plain(0, 16).optional(),
  color: ThreadColorValue.optional(),
  parent: ThreadId.optional(),
  session: ThreadSessionValue.optional(),
  session_opts: z.strictObject({ cwd: ThreadCwdValue }).optional(),
  model: ModelValue.optional(),
  effort: ThreadEffortValue.optional(),
  mcp_allow: McpAllowList.optional(),
  idle_park_min: ThreadIdleValue.optional(),
})

type SetupField = 'color' | 'effort' | 'model' | 'mcp_allow' | 'session_opts.cwd'
export const SETUP_THREAD_FIELD_RULES: Readonly<Record<SetupField, ThreadFieldRow>> = {
  color: {
    risk: 'low',
    rule: {
      label: 'colour',
      phrase: 'thread colours',
      hint: `one of ${THREAD_COLORS.join(', ')}`,
      value: ThreadColorValue,
      show: none,
    },
    read: (t) => t.color ?? null,
    set: (v) => ({ color: v }),
  },
  effort: {
    risk: 'low',
    rule: {
      label: 'effort',
      phrase: "a thread session's effort",
      hint: `one of ${DOCUMENTED_EFFORTS.join(', ')}`,
      value: ThreadEffortValue,
      show: none,
    },
    read: (t) => t.session_opts?.effort ?? null,
    set: (v, t) => ({ session_opts: { ...(t?.session_opts ?? {}), effort: v } }),
  },
  // The model, folder and MCP list are what a session may reach: high, a card every time unless the owner asked for it.
  // A sub-thread's folder and list are held to its parent's (judged in config-propose.ts).
  model: {
    risk: 'high',
    rule: {
      label: 'model',
      phrase: "a thread session's model",
      hint: 'one of the models the app offers, or "inherit" for the main session\'s',
      value: ModelValue,
      show: none,
    },
    read: (t) => t.session_opts?.model ?? 'inherit',
    set: (v, t) => ({ session_opts: { ...(t?.session_opts ?? {}), model: v } }),
  },
  mcp_allow: {
    risk: 'high',
    rule: {
      label: 'MCP servers',
      phrase: "the MCP servers a thread's session may use",
      hint: 'a list of up to 32 server names (the session gets only these, plus talos-app); [] for none',
      value: McpAllowList,
      // no list at all is not "none": the session then gets whatever Claude Code gives it
      show: (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : 'all (no list)'),
    },
    read: (t) => t.session_opts?.mcp_allow ?? null,
    set: (v, t) => ({ session_opts: { ...(t?.session_opts ?? {}), mcp_allow: v } }),
  },
  'session_opts.cwd': {
    risk: 'high',
    rule: {
      label: 'folder',
      phrase: "the folder a thread's session works in",
      hint: "an absolute folder inside the owner's home folder, not in ~/.claude or the Talos data; a sub-thread's must be inside its parent's",
      value: ThreadCwdValue,
      show: (v) => (typeof v === 'string' && v ? v : 'the agent folder'),
    },
    read: (t) => t.session_opts?.cwd ?? null,
    set: (v, t) => ({ session_opts: { ...(t?.session_opts ?? {}), cwd: v } }),
  },
}
