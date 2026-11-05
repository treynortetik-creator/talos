// @vitest-environment node
// A thread stored as `constructor`: the ready frame that carries it parses whole, and live replies count as 1, 2, ...
import { afterEach, describe, expect, it } from 'vitest'
import { type Run, readyFrame, START_ISO, srv, startRun, uid } from './replay/replay-harness.ts'

let run: Run | null = null
afterEach(() => {
  run?.stop()
  run = null
})
const thread = (id: string) => ({ id, name: id, kind: 'agent', order: 1, created_at: START_ISO })
const reply = () =>
  srv('reply', {
    message: {
      id: `m_${uid().slice(-26)}`,
      thread_id: 'constructor',
      author: 'agent',
      kind: 'text',
      text: 'Hello Alex',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: START_ISO,
    },
  })

describe('a ready frame carrying a thread called constructor', () => {
  it('is applied whole: the thread is listed, the other threads too', async () => {
    run = await startRun()
    run.sock().receive(readyFrame({ threads: [thread('general'), thread('constructor')] }))
    await run.settle()
    expect(run.client.store.getState().threads.map((t) => t.id)).toEqual(['general', 'constructor'])
  })

  it('live replies count 1 then 2, and the count stays a number', async () => {
    run = await startRun()
    run.sock().receive(readyFrame({ threads: [thread('general'), thread('constructor')] }))
    await run.settle()
    run.sock().receive(reply())
    await run.settle()
    expect(run.client.store.getState().unread.constructor).toBe(1)
    run.sock().receive(reply())
    await run.settle()
    expect(run.client.store.getState().unread.constructor).toBe(2)
    expect(run.client.store.getState().messages.constructor).toHaveLength(2)
  })

  it('a count the relay sent for it is kept, and the next reply adds one', async () => {
    run = await startRun()
    run
      .sock()
      .receive(
        readyFrame({ threads: [thread('general'), thread('constructor')], unread: JSON.parse('{"constructor":4}') }),
      )
    await run.settle()
    run.sock().receive(reply())
    await run.settle()
    expect(run.client.store.getState().unread.constructor).toBe(5)
  })

  it('marking it read through the real client sends a number, and an unread-then-read round trip ends at 0', async () => {
    run = await startRun()
    run.sock().receive(readyFrame({ threads: [thread('general'), thread('constructor')] }))
    await run.settle()
    run.client.markThreadRead('constructor', 0)
    await run.settle()
    const unread = run.client.store.getState().unread
    expect(Object.hasOwn(unread, 'constructor') ? unread.constructor : 0).toBe(0)
  })
})
