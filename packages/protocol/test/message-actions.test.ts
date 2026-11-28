// A chat message may carry client-side actions (today only "open this thread's terminal"). The field is optional and read with a catch,
// so a peer that does not know it (or a value it cannot read) shows the plain text, and nothing here can carry authority: an action
// only moves the app to a screen.
import { describe, expect, it as test } from 'vitest'
import { newId } from '../src/ids.ts'
import { Message, MessageAction } from '../src/models.ts'

const base = {
  id: newId('m'),
  thread_id: 'trip',
  author: 'system',
  kind: 'text',
  text: 'Trip has been quiet.',
  created_at: '2026-11-26T15:00:00.000Z',
}

describe('Message.actions', () => {
  test('an open_terminal action is kept, with its thread', () => {
    const m = Message.parse({ ...base, actions: [{ kind: 'open_terminal', thread: 'trip' }] })
    expect(m.actions).toEqual([{ kind: 'open_terminal', thread: 'trip' }])
  })

  test('no actions: the field is absent, as for every older message', () => {
    expect(Message.parse(base).actions).toBeUndefined()
  })

  test('a kind this build does not know, a bad thread, too many, or a non-list: the field reads as absent and the message still parses', () => {
    for (const actions of [
      [{ kind: 'open_url', thread: 'trip' }],
      [{ kind: 'open_terminal', thread: 'NOT A THREAD!' }],
      [{ kind: 'open_terminal' }],
      Array.from({ length: 9 }, () => ({ kind: 'open_terminal', thread: 'trip' })),
      'open_terminal',
      { kind: 'open_terminal', thread: 'trip' },
    ]) {
      const m = Message.parse({ ...base, actions })
      expect(m.actions).toBeUndefined()
      expect(m.text).toBe(base.text)
    }
  })

  test('an action carries nothing else: extra keys are dropped, never kept', () => {
    const a = MessageAction.parse({
      kind: 'open_terminal',
      thread: 'trip',
      url: 'https://example.com',
      run: 'rm -rf /',
    })
    expect(a).toEqual({ kind: 'open_terminal', thread: 'trip' })
  })

  test('a reader that does not know the field (the schema without it) simply ignores it', () => {
    // what an older build does: its Message has no `actions`, and an unknown key is stripped, not refused
    const old = Message.omit({ actions: true }).parse({ ...base, actions: [{ kind: 'open_terminal', thread: 'trip' }] })
    expect((old as Record<string, unknown>).actions).toBeUndefined()
    expect(old.text).toBe(base.text)
  })
})
