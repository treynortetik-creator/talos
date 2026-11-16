// Protocol audit O2: one element an older app cannot read inside `ready` (a thread kind or notify mode it does not know, a
// status state, a key a newer Mac added to the strict session state) must cost that element, never the whole frame. A
// `ready` that does not parse never arrives, and the app sits on "connecting" for good.
import { describe, expect, it } from 'vitest'
import { ReadyFrame } from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const ready = loadFixtures().ready as Record<string, any>

const parse = (over: Record<string, unknown>) => {
  const r = ReadyFrame.safeParse({ ...ready, ...over })
  expect(r.success, r.success ? '' : JSON.stringify(r.error.issues.slice(0, 2))).toBe(true)
  return r.success ? r.data : undefined
}

describe('a ready with one element this build cannot read', () => {
  it('a thread of a newer kind is left out; the other threads and the frame stay', () => {
    const newer = { ...ready.threads[0], id: 'later', kind: 'a_kind_from_the_future' }
    const d = parse({ threads: [...ready.threads, newer] })
    expect(d?.threads?.map((t) => t.id)).toEqual(['general', 'inbox'])
  })

  it('a thread with a newer notify mode is left out, not the frame', () => {
    const d = parse({ threads: [{ ...ready.threads[0], notify: 'only_on_tuesdays' }, ready.threads[1]] })
    expect(d?.threads?.map((t) => t.id)).toEqual(['inbox'])
  })

  it('a status with a newer state is left out; the other statuses stay', () => {
    const d = parse({
      statuses: [...ready.statuses, { thread_id: 'inbox', state: 'daydreaming', since: ready.statuses[0].since }],
    })
    expect(d?.statuses?.map((s) => s.thread_id)).toEqual(['general'])
  })

  it('a session state with a key a newer Mac added drops that field only', () => {
    const d = parse({ session_state: { ...ready.session_state, a_newer_key: 1 } })
    expect(d?.session_state).toBeUndefined()
    expect(d?.threads?.length).toBe(2)
  })

  it('an unreadable session inventory, session list or agents snapshot drops that field only', () => {
    expect(
      parse({ session_inventory: { ...ready.session_inventory, commands: 'not a list' } })?.session_inventory,
    ).toBeUndefined()
    const list = [{ ...ready.session_list[0], kind: 'a_kind_from_the_future' }, ready.session_list[1]]
    expect(parse({ session_list: list })?.session_list?.map((x) => x.id)).toEqual(['cloud_example_1'])
    expect(parse({ session_agents: { ...ready.session_agents, rows: 'not a list' } })?.session_agents).toBeUndefined()
  })

  it('the fixture itself still parses whole, with nothing dropped', () => {
    const d = parse({})
    expect(d?.threads?.length).toBe(2)
    expect(d?.statuses?.length).toBe(1)
    expect(d?.session_state?.session_id).toBe('sess_cc_example')
    expect(d?.session_list?.length).toBe(2)
  })
})
