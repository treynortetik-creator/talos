// The hub socket's permission request from the kit's PermissionRequest hook (docs/CLAUDE-CODE.md C3.9): what an older and a
// newer hook may send, and that an unknown answer from a newer hub is one value the hook ignores, not a line it cannot read.
import { describe, expect, it } from 'vitest'
import { HubHubLine, HubWorkerLine } from '../src/index.ts'

const base = { t: 'perm', id: 'h_1', tool_name: 'Bash', tool_input: { command: 'rm -rf /home/alex/x' } }

describe('hub perm lines', () => {
  it('the smallest request (main session, no session id) parses', () => {
    expect(HubWorkerLine.safeParse(base).success).toBe(true)
    expect(HubWorkerLine.safeParse({ t: 'perm', id: 'h_1', tool_name: 'Bash' }).success).toBe(true)
  })
  it('a main-session hook may say who it is (pid, cwd); an over-long cwd is refused', () => {
    expect(HubWorkerLine.safeParse({ ...base, pid: 4242, cwd: '/srv/proj' }).success).toBe(true)
    expect(HubWorkerLine.safeParse({ ...base, cwd: 'x'.repeat(1001) }).success).toBe(false)
  })
  it('a thread session names its thread, nonce and pid', () => {
    const r = HubWorkerLine.safeParse({
      ...base,
      thread_id: 'trip',
      nonce: 'x'.repeat(16),
      pid: 4242,
      session_id: 'abc',
    })
    expect(r.success).toBe(true)
  })
  it('fields a newer hook adds are ignored, not refused', () => {
    const r = HubWorkerLine.safeParse({ ...base, permission_mode: 'bypassPermissions', future: { a: 1 } })
    expect(r.success).toBe(true)
  })
  it('a bad thread id, a short nonce, a bad pid, no id and no tool are refused', () => {
    for (const bad of [
      { ...base, thread_id: 'Not A Thread' },
      { ...base, thread_id: 'trip', nonce: 'short' },
      { ...base, thread_id: 'trip', pid: -1 },
      { ...base, thread_id: 'trip', pid: 1.5 },
      { t: 'perm', tool_name: 'Bash' },
      { t: 'perm', id: 'h_1' },
      { t: 'perm', id: 'h_1', tool_name: '' },
      { t: 'perm', id: '', tool_name: 'Bash' },
    ])
      expect(HubWorkerLine.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })
  it('the answer: allow, deny, none, and a value from a newer hub all parse (the hook acts on allow and deny only)', () => {
    for (const decision of ['allow', 'deny', 'none', 'allow_always'])
      expect(
        HubHubLine.safeParse({ t: 'perm_result', id: 'h_1', decision, reason: 'owner', extra: 1 }).success,
        decision,
      ).toBe(true)
  })
  it('an answer with no id or no decision is refused', () => {
    expect(HubHubLine.safeParse({ t: 'perm_result', decision: 'allow' }).success).toBe(false)
    expect(HubHubLine.safeParse({ t: 'perm_result', id: 'h_1' }).success).toBe(false)
  })
})
