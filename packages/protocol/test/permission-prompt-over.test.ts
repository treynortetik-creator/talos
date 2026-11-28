// "The prompt is over" (Wave 1, after hook-wins): a PermissionRequest hook that knows its prompt has ended (Claude Code stopped it, the
// call's result is in the transcript, or Claude Code itself is gone) tells the hub with one last line before it exits. Every field is
// optional and the line is only read by a bridge that knows it: an older bridge refuses an unknown line after the hook has gone, and
// an older hook never sends it.
import { describe, expect, it } from 'vitest'
import { HubPerm, HubPermOver, HubWorkerLine } from '../src/index.ts'

describe('perm_over', () => {
  const line = { t: 'perm_over', id: 'h_abc', why: 'term' }
  it('is a hub line (so the hub reads it on the connection that carries a perm)', () => {
    const r = HubWorkerLine.safeParse(line)
    expect(r.success).toBe(true)
    if (r.success) expect((r.data as { t: string }).t).toBe('perm_over')
  })
  it('needs the request id; the reason is optional and short', () => {
    expect(HubPermOver.safeParse({ t: 'perm_over', id: 'h_abc' }).success).toBe(true)
    expect(HubPermOver.safeParse({ t: 'perm_over' }).success).toBe(false)
    expect(HubPermOver.safeParse({ t: 'perm_over', id: '' }).success).toBe(false)
    expect(HubPermOver.safeParse({ t: 'perm_over', id: 'x'.repeat(65) }).success).toBe(false)
    expect(HubPermOver.safeParse({ ...line, why: 'x'.repeat(21) }).success).toBe(false)
  })
  it('tolerates fields a newer hook adds', () => {
    expect(HubPermOver.safeParse({ ...line, more: 1 }).success).toBe(true)
  })
})

describe('perm: the call it is for (tool_use_id, agent_id, transcript_path)', () => {
  const line = { t: 'perm', id: 'h_1', tool_name: 'Bash' }
  it('an older hook sends none of them, and the line parses as before', () => {
    const r = HubPerm.safeParse(line)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.tool_use_id).toBeUndefined()
      expect(r.data.agent_id).toBeUndefined()
      expect(r.data.transcript_path).toBeUndefined()
    }
  })
  it('keeps them when they are text of a sane size', () => {
    const r = HubPerm.safeParse({
      ...line,
      tool_use_id: 'toolu_01AbC',
      agent_id: 'a0edd2143fc3f099d',
      transcript_path: '/home/alex/.claude/projects/-srv-x/9a7.jsonl',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.tool_use_id).toBe('toolu_01AbC')
      expect(r.data.agent_id).toBe('a0edd2143fc3f099d')
      expect(r.data.transcript_path).toBe('/home/alex/.claude/projects/-srv-x/9a7.jsonl')
    }
  })
  it('a value of another kind, or too long, reads as none (the line still parses)', () => {
    const r = HubPerm.safeParse({
      ...line,
      tool_use_id: 7,
      agent_id: 'x'.repeat(101),
      transcript_path: 'p'.repeat(1001),
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.tool_use_id).toBeUndefined()
      expect(r.data.agent_id).toBeUndefined()
      expect(r.data.transcript_path).toBeUndefined()
    }
  })
})
