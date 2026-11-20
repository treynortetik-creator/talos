// The gate for the fields that set a thread's session up (owner ruling 2026-11-19: Main and thread sessions set up thread agents;
// the gates are opt-in and off by default). The fields: its own session turned on, its folder, model and MCP list, and a thread
// created with any of them. With "Lock Talos settings" on, a card, always. With it off, the change is made straight away when
// nothing outside reached the agent since the owner last spoke (the one strict check every agent session meets, agent-quiet.ts);
// otherwise a card. The two-hour "he asked in this thread" window does not apply to these fields. The low fields keep their rule.
import type { ConfigChange } from '@talos-app/protocol'
import { outsideRefusal } from '../agent-quiet.ts'
import type { BridgeContext } from '../context.ts'

const SETUP_KEYS = ['session', 'session_opts', 'model', 'mcp_allow']

/** Does this change turn on a session or set a folder, model or MCP list (on an existing thread, or on a new one)? */
export function isSetupChange(c: Pick<ConfigChange, 'path' | 'new'>): boolean {
  const field = /^threads\.[a-z][a-z0-9_]{0,31}\.(session|session_opts\.cwd|model|mcp_allow)$/.exec(c.path)?.[1]
  if (field) return field === 'session' ? c.new === 'dedicated' : true
  if (!/^threads\.[a-z][a-z0-9_]{0,31}$/.test(c.path)) return false
  const v = c.new
  return (
    typeof v === 'object' &&
    v !== null &&
    SETUP_KEYS.some((k) => k in v && (k !== 'session' || (v as { session?: unknown }).session === 'dedicated'))
  )
}
export const touchesSetup = (changes: readonly ConfigChange[]): boolean => changes.some(isSetupChange)

/** True when nothing outside reached any thread, no lead spoke and no peer message is pending since the owner's latest words (a thread session: in its own thread). */
export function strictlyQuiet(ctx: Pick<BridgeContext, 'store' | 'clock'>, scope?: string): boolean {
  try {
    return outsideRefusal(ctx.store, ctx.clock.now(), scope) === undefined
  } catch {
    return false // a check that cannot be read is not quiet
  }
}
