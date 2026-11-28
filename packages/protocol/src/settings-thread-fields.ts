// The per-thread settings the agent may change (`threads.<id>.<field>`): which fields there are, each one's risk, its words and
// how it is read and written. Moved out of settings-table.ts unchanged, so that file stays under the size limit; settings-table.ts
// re-exports everything here, so every import of these names still works.

import { z } from 'zod'
import type { AgentConfigT } from './config.ts'
import { ThreadId } from './ids.ts'
import { THREAD_TOPIC_MAX, type ThreadT } from './models.ts'
import type { AgentRule } from './settings-table.ts'
import { canBeDedicated, DEFAULT_IDLE_PARK_MIN } from './thread-sessions.ts'
import { none, Plain, SETUP_THREAD_FIELD_RULES, ThreadIdleValue, ThreadSessionValue } from './thread-setup-fields.ts'

/** The thread fields whose change is a `setting.changed` event; name and archived have events of their own. */
export const THREAD_SETTING_EVENT_FIELDS = ['topic', 'icon', 'notify', 'session'] as const

/** The fields of one thread the agent may change, and what the thread-scoped paths `threads.<id>.<field>` mean. */
export const THREAD_FIELDS = [
  'name',
  'topic',
  'icon',
  'notify',
  'session',
  'archived',
  'parent',
  'idle_park_min',
  'color',
  'effort',
  'compact_window',
  'model',
  'mcp_allow',
  'session_opts.cwd',
] as const
export type ThreadField = (typeof THREAD_FIELDS)[number]

export type ThreadFieldRow = {
  /** `high`: how much it matters (marked on its card); asked for, it is made at once like a low one. */
  readonly risk: 'low' | 'high'
  /** `label` is the field's name in "Thread trip name: Trip → Travel"; the value rules, words and hint are the same kind as a row's. */
  readonly rule: AgentRule
  /**
   * A value or a thread that makes a `low` field high: a change for which `when` is true is high. `phrase`
   * is how the agent is told ("turning a thread's alerts off").
   */
  readonly alsoHigh?: {
    readonly phrase: string
    readonly when: (value: unknown, config: AgentConfigT, threadId: string) => boolean
  }
  /** The value now on the thread, raw (null when it has none); what the card shows as old, and what is compared and hashed. */
  readonly read: (t: ThreadT) => unknown
  /**
   * The keys to put on the thread for a new value (`null` clears a key; a threads patch drops it). `t` is the thread as it is now,
   * for a field inside an object of the thread (`session_opts`), whose other keys must stay.
   */
  readonly set: (v: unknown, t?: ThreadT) => Record<string, unknown>
}

/**
 * Per-thread operations, with their risk. Name, topic, icon, colour, effort and alerts are low; a thread's own session, archiving it and putting
 * it under another thread are high (a session uses the owner's plan; archiving keeps the thread's inbox copies; a sub-thread takes
 * its parent's folder, model and MCP list). A session's folder, model and MCP list are high too: they are what it can reach.
 */
export const THREAD_FIELD_RULES: Readonly<Record<ThreadField, ThreadFieldRow>> = {
  name: {
    risk: 'low',
    rule: { label: 'name', phrase: 'thread names', hint: '1-40 chars', value: Plain(1, 40) },
    read: (t) => t.name,
    set: (v) => ({ name: v }),
  },
  topic: {
    risk: 'low',
    rule: {
      label: 'topic',
      phrase: 'thread topics',
      hint: `the "what goes here" line, up to ${THREAD_TOPIC_MAX} chars, "" to clear it`,
      value: Plain(0, THREAD_TOPIC_MAX),
      show: none,
    },
    read: (t) => t.topic ?? '',
    set: (v) => ({ topic: v === '' ? null : v }),
  },
  icon: {
    risk: 'low',
    rule: {
      label: 'icon',
      phrase: 'thread icons',
      hint: 'an icon key or one emoji, up to 16 chars, "" to clear it',
      value: Plain(0, 16),
      show: none,
    },
    read: (t) => t.icon ?? '',
    set: (v) => ({ icon: v === '' ? null : v }),
  },
  notify: {
    risk: 'low',
    rule: {
      label: 'alerts',
      phrase: 'thread alerts',
      hint: '"all", "needs_you" or "off"',
      value: z.enum(['all', 'needs_you', 'off']),
    },
    // A thread on 'off' gets no push at all, approval-card pushes included (relay push.ts `thread_off`; security notices and health
    // alarms are system templates and still arrive). So 'off' is high, and so is any change to the default thread's alerts, where
    // the approval cards land.
    alsoHigh: {
      phrase: "turning a thread's alerts off or changing the default thread's alerts",
      when: (v, c, id) => v === 'off' || id === c.default_thread,
    },
    read: (t) => t.notify,
    set: (v) => ({ notify: v }),
  },
  session: {
    risk: 'high',
    rule: {
      label: 'own session',
      phrase: 'thread sessions',
      hint: '"dedicated" (its own Claude Code session) or "shared" (the main session answers)',
      value: ThreadSessionValue,
    },
    read: (t) => t.session ?? 'shared',
    set: (v) => ({ session: v }),
  },
  archived: {
    risk: 'high',
    rule: {
      label: 'archived',
      phrase: 'archiving threads',
      hint: 'true to archive an agent-made thread (never the default thread), false to bring it back',
      value: z.boolean(),
      show: (v) => (v === true ? 'yes' : v === false ? 'no' : String(v)),
    },
    read: (t) => t.archived,
    set: (v) => ({ archived: v }),
  },
  parent: {
    risk: 'high',
    rule: {
      label: 'under',
      phrase: 'putting a thread under another thread or taking it out',
      hint: 'the id of a top-level thread to put it under (sub-threads go one level deep), or null to take it out',
      value: ThreadId.nullable(),
      show: (v) => (v === null ? 'no thread (top level)' : String(v)),
    },
    read: (t) => t.parent_id ?? null,
    set: (v) => ({ parent_id: v }),
  },
  // How long a thread's own session may sit idle before it is parked (Pantheon 2026-11-15, with the dev panel). Only this key of
  // session_opts is written; the folder, model and MCP list stay as they are.
  idle_park_min: {
    risk: 'low',
    rule: {
      label: 'idle minutes before parking',
      phrase: "how long a thread's own session idles before it is parked",
      hint: `5-720 minutes (default ${DEFAULT_IDLE_PARK_MIN})`,
      value: ThreadIdleValue,
      show: (v) => `${String(v)} min`,
    },
    read: (t) => t.session_opts?.idle_park_min ?? DEFAULT_IDLE_PARK_MIN,
    set: (v, t) => ({ session_opts: { ...(t?.session_opts ?? {}), idle_park_min: v } }),
  },
  ...SETUP_THREAD_FIELD_RULES,
}

/** Whether a thread may have its own session, in the words a refusal uses; null when it may. */
export function sessionRefusal(config: AgentConfigT, threadId: string): string | null {
  return canBeDedicated(config, threadId)
    ? null
    : `thread ${threadId} can't have its own session: the default thread, general, inbox and archived threads are always shared`
}
