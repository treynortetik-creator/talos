// Thread management fields (docs/THREADS.md): icon, color and topic are optional and old configs still load.
import { describe, expect, it } from 'vitest'
import {
  AgentConfig,
  applyMergePatch,
  checkConfigPatch,
  jcs,
  parseFrame,
  resolveThreadsPatch,
  THREAD_COLORS,
  THREAD_TOPIC_MAX,
  Thread,
  threadPatchIssue,
  validateAgentConfig,
} from '../src/index.ts'
import { loadExample } from './helpers.ts'

const base = {
  id: 'trip',
  name: 'Trip planning',
  kind: 'fixed',
  order: 2,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
}

describe('Thread icon, color, topic', () => {
  it('round-trips through the schema and canonical JSON unchanged', () => {
    const t = { ...base, icon: 'rocket', color: 'orange', topic: 'Flights, hotels and the packing list' }
    const parsed = Thread.parse(JSON.parse(JSON.stringify(t)))
    expect(parsed).toEqual(t)
    expect(Thread.parse(JSON.parse(jcs(parsed)))).toEqual(parsed)
  })

  it('old threads without icon, color, topic or order still load (order defaults to 0)', () => {
    const { order: _o, ...old } = base
    const parsed = Thread.parse(old)
    expect(parsed.order).toBe(0)
    expect(parsed.color).toBeUndefined()
    expect(parsed.topic).toBeUndefined()
    expect(parsed.icon).toBeUndefined()
  })

  it('the shipped example configs (no colors, emoji icons) still parse and validate', () => {
    for (const name of ['default', 'five-threads'] as const) {
      const c = AgentConfig.parse(loadExample(name))
      expect(validateAgentConfig(c)).toEqual([])
      expect(c.threads.every((t) => t.color === undefined && t.topic === undefined)).toBe(true)
    }
  })

  it('accepts every palette key and unknown short keys, refuses junk', () => {
    for (const color of THREAD_COLORS) expect(Thread.safeParse({ ...base, color }).success).toBe(true)
    expect(Thread.safeParse({ ...base, color: 'teal' }).success).toBe(true) // a future palette key
    for (const color of ['', 'Orange', '#ff8800', 'a'.repeat(17), 'red;x']) {
      expect(Thread.safeParse({ ...base, color }).success, color).toBe(false)
    }
  })

  it('caps the topic', () => {
    expect(Thread.safeParse({ ...base, topic: 'x'.repeat(THREAD_TOPIC_MAX) }).success).toBe(true)
    expect(Thread.safeParse({ ...base, topic: 'x'.repeat(THREAD_TOPIC_MAX + 1) }).success).toBe(false)
  })

  it('a threads patch carrying the new fields is allowlisted and merges into a valid config', () => {
    const cfg = AgentConfig.parse(loadExample('default'))
    const threads = [
      { ...cfg.threads[0], name: 'Main', color: 'pink', icon: 'briefcase', topic: 'Day to day' },
      cfg.threads[1],
      { ...base, color: 'orange' },
    ]
    const patch = { threads, default_thread: 'trip' }
    expect(checkConfigPatch(patch)).toEqual({ ok: true, touchesWorkEnabled: false })
    const next = AgentConfig.parse({ ...(applyMergePatch(cfg, patch) as object), rev: cfg.rev + 1 })
    expect(validateAgentConfig(next)).toEqual([])
    expect(next.threads.map((t) => [t.id, t.color])).toEqual([
      ['general', 'pink'],
      ['inbox', undefined],
      ['trip', 'orange'],
    ])
    expect(next.threads[0]?.id).toBe('general') // a rename keeps the id
  })

  it('config.sync and thread.upsert frames carry the new fields', () => {
    const cfg = AgentConfig.parse(loadExample('default'))
    const withColor = {
      ...cfg,
      threads: [{ ...cfg.threads[0], color: 'lime', topic: 'Everything else' }, cfg.threads[1]],
    }
    const sync = parseFrame({
      v: 1,
      type: 'config.sync',
      id: '01JBF3V7Q8K2M4N6P8R0S2T417',
      ts: '2026-10-28T00:00:00.000Z',
      config: withColor,
      rev: withColor.rev,
    })
    expect(sync.ok && sync.frame.type === 'config.sync' && sync.frame.config.threads[0]?.color).toBe('lime')
    const up = parseFrame({
      v: 1,
      type: 'thread.upsert',
      id: '01JBF3V7Q8K2M4N6P8R0S2T418',
      ts: '2026-10-28T00:00:00.000Z',
      thread: { ...base, color: 'cyan', topic: 't' },
    })
    expect(up.ok && up.frame.type === 'thread.upsert' && up.frame.thread.color).toBe('cyan')
  })
})

describe('resolveThreadsPatch (per-thread patch semantics)', () => {
  const cur = [
    { ...base, id: 'a', color: 'pink', topic: 'T', icon: 'star' },
    { ...base, id: 'b' },
  ]
  it('an omitted key keeps its value, null clears it, a sent value wins; order and membership follow the patch', () => {
    const out = resolveThreadsPatch(cur, [
      { id: 'b', name: 'B2' },
      { id: 'a', name: 'A2', color: null, icon: 'rocket' },
      { ...base, id: 'c', topic: null },
    ]) as Array<Record<string, unknown>>
    expect(out.map((t) => t.id)).toEqual(['b', 'a', 'c'])
    expect(out[0]).toMatchObject({ name: 'B2', kind: 'fixed' })
    expect(out[1]).toMatchObject({ name: 'A2', topic: 'T', icon: 'rocket' })
    expect(out[1]).not.toHaveProperty('color')
    expect(out[2]).not.toHaveProperty('topic')
  })
  it('passes junk through for the schema to refuse and never copies unsafe keys', () => {
    expect(resolveThreadsPatch(cur, 'x')).toBe('x')
    const out = resolveThreadsPatch(cur, [1, JSON.parse('{"id":"a","__proto__":{"x":1}}')]) as unknown[]
    expect(out[0]).toBe(1)
    expect(Object.getPrototypeOf(out[1])).toBe(Object.prototype)
  })
  it('threadPatchIssue refuses an archived default thread', () => {
    expect(threadPatchIssue({ default_thread: 'a', threads: [{ id: 'a', archived: true }] })).toMatch(/default thread/)
    expect(threadPatchIssue({ default_thread: 'a', threads: [{ id: 'a', archived: false }] })).toBeNull()
  })
})
