// A revoke is the relay's own 404 `not_found`; anything else with that status is a platform page and is retried. A revoke is
// remembered: peer_send refuses until `peer add` links it again.
import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor } from '@talos-app/testkit'
import { runCli } from '../../src/cli.ts'
import { FAKE_SECRET, type Install, install, linkBoth, rowsOf, text } from './helpers.ts'

let a: Install | undefined
let b: Install | undefined
afterEach(async () => {
  await a?.stop()
  await b?.stop()
  a = b = undefined
})
async function pair() {
  a = await install({ to: () => b })
  b = await install({ to: () => a })
  await linkBoth(a, b)
  return { a, b }
}
const send = (h: Install, args: Record<string, unknown> = {}) =>
  h.bridge.callTool('peer_send', { peer: 'work', text: 'hi', label: 'TASK', ...args })

describe('what counts as a revoke', () => {
  for (const [status, body] of [
    [404, '<html>Not Found</html>'],
    [404, '{"error":"other"}'],
    [410, '{"error":"not_found"}'],
    [410, ''],
  ] as const)
    test(`${status} with ${body || 'no body'} is retried like a 5xx`, async () => {
      const { a } = await pair()
      a.override = { status, body }
      await send(a)
      await waitFor(() => a.calls.length === 1 && a.clock.pending > 0, 4000, 'first try, retry armed')
      a.clock.advance(20_000)
      await waitFor(() => a.calls.length === 2, 4000, 'retried')
      expect(rowsOf(a).some((t) => t.includes('no longer accepts'))).toBe(false)
    })

  test('a 408 is retried', async () => {
    const { a } = await pair()
    a.override = { status: 408 }
    await send(a)
    await waitFor(() => a.calls.length === 1 && a.clock.pending > 0, 4000, 'first, retry armed')
    a.clock.advance(20_000)
    await waitFor(() => a.calls.length === 2, 4000, 'retried')
    expect(rowsOf(a).some((t) => t.includes('refused'))).toBe(false)
  })

  test("the relay's own 404 not_found revokes: remembered, peer_send refuses, `peer add` clears it", async () => {
    const { a, b } = await pair()
    b.relay.peers.remove('home')
    await send(a)
    await waitFor(() => rowsOf(a).some((t) => t.includes('work no longer accepts messages')), 4000, 'the row')
    const r = await send(a)
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('work no longer accepts messages; run talos-app peer add again once it is linked')
    expect(a.calls).toHaveLength(1)
    // the owner links it again from the terminal
    const out: string[] = []
    const code = await runCli(
      ['peer', 'add', 'work', '--url', 'https://work-inbox.example.com/hook/peer/cn_abcdefghijklmnopqrstuv'],
      {
        isTerminal: true,
        out: (l) => out.push(l),
        err: (l) => out.push(l),
        prompt: async () => '',
        readSecret: async () => FAKE_SECRET,
        sleep: async () => {},
        now: () => Date.now(),
      },
      { TALOS_APP_HOME: a.home, TALOS_APP_RELAY_URL: a.relay.httpUrl },
      { peer: { secrets: a.secrets } },
    )
    expect(code, out.join('\n')).toBe(0)
    const again = await send(a)
    expect(text(again)).not.toContain('no longer accepts')
  })
})
