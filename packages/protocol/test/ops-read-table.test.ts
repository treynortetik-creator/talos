// `session_opts.ops_read` is a Mac-only, high-risk, per-thread option: its row sits in the one settings table, and no
// agent or phone path reaches it.
import { describe, expect, test } from 'vitest'
import {
  AGENT_CONFIG_REFUSED,
  AGENT_SETTING_PATHS,
  checkConfigPatch,
  HIGH_RISK_SETTING_PATHS,
  PHONE_PATCH_ENTRIES,
  THREAD_SESSION_OPT_ROWS,
  ThreadSessionOpts,
  ThreadSessionOptsStrict,
  threadOptsIssue,
} from '../src/index.ts'

describe('ops_read in the settings table', () => {
  test('its row is Mac-only, high risk, off by default and not an agent setting', () => {
    expect(THREAD_SESSION_OPT_ROWS.ops_read).toMatchObject({ phone: false, agent: false, risk: 'high', default: false })
    expect(AGENT_SETTING_PATHS.some((p) => p.includes('ops_read') || p === ('threads' as string))).toBe(false)
    expect(AGENT_CONFIG_REFUSED as readonly string[]).toContain('threads')
    expect(PHONE_PATCH_ENTRIES.some((p) => p.includes('ops_read'))).toBe(false)
  })
  test('the registry views list it, so a risk table built from them sees it', () => {
    expect(HIGH_RISK_SETTING_PATHS).toContain('threads.session_opts.ops_read')
  })
  test('the schema reads and checks it as an optional boolean; junk reads as absent', () => {
    expect(ThreadSessionOpts.parse({ ops_read: true }).ops_read).toBe(true)
    expect(ThreadSessionOpts.parse({}).ops_read).toBeUndefined()
    expect(ThreadSessionOpts.parse({ ops_read: 'yes' }).ops_read).toBeUndefined()
    expect(ThreadSessionOptsStrict.safeParse({ ops_read: true }).success).toBe(true)
    expect(ThreadSessionOptsStrict.safeParse({ ops_read: 'yes' }).success).toBe(false)
  })
  test('threadOptsIssue names a thread that turns it on, and nothing else', () => {
    const t = (ops_read?: unknown) => ({ id: 'a', session_opts: ops_read === undefined ? {} : { ops_read } })
    expect(threadOptsIssue({ threads: [t()] }, { threads: [t(true)] })).toMatch(/ops_read/)
    expect(threadOptsIssue({ threads: [] }, { threads: [t(true)] })).toMatch(/ops_read/)
    expect(threadOptsIssue({ threads: [t(true)] }, { threads: [t(true)] })).toBeNull()
    expect(threadOptsIssue({ threads: [t(true)] }, { threads: [t(false)] })).toBeNull()
    expect(threadOptsIssue({ threads: [t()] }, { threads: [t()] })).toBeNull()
  })
  test('junk where the threads should be is not this check’s to refuse (the schema does)', () => {
    for (const threads of [5, 'x', null, {}, [null, 7, 'a']])
      expect(threadOptsIssue({ threads: [] }, { threads })).toBeNull()
    expect(threadOptsIssue({ threads: 5 }, { threads: [{ id: 'a', session_opts: { ops_read: true } }] })).toMatch(
      /ops_read/,
    )
  })
  test('the top-level allowlist walk is unchanged: threads is still one leaf', () => {
    expect(checkConfigPatch({ threads: [] }).ok).toBe(true)
  })
})
