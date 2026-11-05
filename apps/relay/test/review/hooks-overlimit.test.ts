// Review fix #12 (spec 5.4): over the per-connection limit, Slack, Linear and Zoom get 200 and the event is dropped (and
// shows in Recent deliveries); every other sender gets 429 so it retries.
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { fakeWork, setup } from '../hooks/harness.ts'

afterEach(() => resetAuthImplementation())

function slackSetup() {
  return setup({
    modules: { slack: fakeWork('slack') },
    config: (c) => {
      c.threads.push({
        id: 'work',
        name: 'Work',
        icon: 'briefcase',
        kind: 'fixed',
        order: 5,
        notify: 'all',
        voice_context: 'recent',
        archived: false,
        created_at: '2026-10-28T00:00:00.000Z',
      })
      c.work.thread = 'work'
      c.work.enabled = ['slack']
    },
  })
}

const fill = (s: ReturnType<typeof setup>, id: string) => {
  const ins = s.f.db.prepare("insert into hooks_deliveries (conn_id, at, status, reason) values (?, ?, 200, 'ok')")
  for (let i = 0; i < 600; i++) ins.run(id, s.f.clock.now() - 1000)
}

describe('over the limit', () => {
  it('Slack gets 200 and the event is dropped and counted', async () => {
    const s = slackSetup()
    const c = await s.create('slack')
    fill(s, c.id)
    const res = await s.send('slack', c.id, c.secret, { title: 'too many' })
    expect(res.status).toBe(200)
    await s.drain()
    expect(s.events()).toHaveLength(0)
    expect(s.count('hooks_inbound')).toBe(0)
    const row = s.f.db.prepare("select status from hooks_deliveries where reason = 'over_limit'").all() as Array<{
      status: number
    }>
    expect(row).toEqual([{ status: 200 }])
  })

  it('a sender that is not on the list still gets 429', async () => {
    const s = setup()
    const c = await s.create('generic')
    fill(s, c.id)
    expect((await s.send('generic', c.id, c.secret, { title: 'x' })).status).toBe(429)
  })
})
