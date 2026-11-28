// @vitest-environment node
// The last pane lines of a quiet session (protocol quiet-lines.ts): the app says in its hello that it reads them, keeps what arrives IN MEMORY only
// (never in the thread's rows, the saved cache or the sequence), and cleans it again before it can be drawn.
import { QUIET_LINES_FEATURE } from '@talos-app/protocol'
import { mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useQuietLines } from '../src/features/threads/quietLines.ts'
import { connectedRig, type Rig } from './helpers/socket-frames.ts'

let rig: Rig
beforeEach(async () => {
  useQuietLines.getState().clear()
  rig = await connectedRig()
})
afterEach(async () => {
  await rig.stop()
})

const frame = (id: string, lines: unknown) =>
  mkFrame('quiet.lines', { message_id: id, thread_id: 'general', lines } as never)

describe('quiet.lines', () => {
  it('the hello lists the feature, so the relay sends the frame to this app', () => {
    const hello = rig.relay.frames.find((f) => f.raw.type === 'hello')?.raw as { client?: { features?: string[] } }
    expect(hello.client?.features).toContain(QUIET_LINES_FEATURE)
  })

  it('the lines are kept by message id, in memory only: not a row, not in the store state, not a sequence', async () => {
    rig.relay.sendToApps(frame('m_01JBF3V7Q8K2M4N6P8R0S1T2V3', ['zq-line-one', 'zq-line-two']))
    await waitFor(() => useQuietLines.getState().byMessage.m_01JBF3V7Q8K2M4N6P8R0S1T2V3 !== undefined, 2000, 'lines')
    expect(useQuietLines.getState().byMessage.m_01JBF3V7Q8K2M4N6P8R0S1T2V3).toEqual(['zq-line-one', 'zq-line-two'])
    const state = rig.client.store.getState()
    expect(JSON.stringify(state.messages)).not.toContain('zq-line-one')
    expect(state.lastSeq).toBe(0)
  })

  it('what is drawn is cleaned again: control characters, secrets, mail addresses', async () => {
    const GH = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`
    const id = 'm_01JBF3V7Q8K2M4N6P8R0S1T2V4'
    rig.relay.sendToApps(frame(id, ['b[31m', `token=${GH}`, 'mail me@example.com']))
    await waitFor(() => useQuietLines.getState().byMessage[id] !== undefined, 2000, 'lines')
    const got = useQuietLines.getState().byMessage[id] ?? []
    expect(got).toHaveLength(3)
    expect(JSON.stringify(got)).not.toContain(GH)
    expect(JSON.stringify(got)).not.toContain('me@example.com')
    expect(JSON.stringify(got)).not.toContain('')
  })

  it('a frame that is not lines of text changes nothing, and only a few are kept (the oldest go)', async () => {
    rig.relay.sendToApps(frame('m_01JBF3V7Q8K2M4N6P8R0S1T2V5', [] as never))
    for (let i = 0; i < 60; i++) useQuietLines.getState().set(`m_x${i}`, ['x'])
    expect(Object.keys(useQuietLines.getState().byMessage).length).toBeLessThanOrEqual(40)
    expect(useQuietLines.getState().byMessage.m_x59).toEqual(['x'])
    expect(useQuietLines.getState().byMessage.m_x0).toBeUndefined()
  })
})
