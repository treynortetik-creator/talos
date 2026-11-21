// One-paste link, two installs: A shows a code, B pastes it, both directions are live. Each install is a real bridge over its own
// FakeRelay (which holds the inbox AND the link routes like the real relay); the redeem call goes from B to A's relay.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePeerLinkCode, peerInboxUrl } from '@talos-app/protocol'
import { t, waitFor } from '@talos-app/testkit'
import { runCli } from '../../src/cli.ts'
import { ConfigFile } from '../../src/config-file.ts'
import { addInboundPeer, PEER_SECRET_SERVICE, peerSecretAccount, readInboundPeers } from '../../src/peer/records.ts'
import type { Harness } from '../helpers.ts'
import { type Install, install, ownerSays, rowsOf, text } from './helpers.ts'

const HOSTS: Record<string, 'a' | 'b'> = { 'a.example.com': 'a', 'b.example.com': 'b' }
let a: Install
let b: Install
let fetched: string[] = []
let redeemDown = false

afterEach(async () => {
  await a?.stop()
  await b?.stop()
})

const byHost = (url: string): Install | undefined => {
  const k = HOSTS[new URL(url).host]
  return k === 'a' ? a : k === 'b' ? b : undefined
}

async function pair() {
  a = await install({ to: byHost })
  b = await install({ to: byHost })
  a.relay.peers.publicOrigin = 'https://a.example.com'
  b.relay.peers.publicOrigin = 'https://b.example.com'
  fetched = []
  redeemDown = false
}

/** What B's redeem call sends: to the relay of the host in the url, as the guarded fetch would. */
const redeemFetch = async (url: string, init: RequestInit): Promise<Response> => {
  fetched.push(url)
  if (redeemDown) throw new Error('connection refused')
  const target = byHost(url)
  if (!target) return new Response(null, { status: 503 })
  return fetch(`${target.relay.httpUrl}${new URL(url).pathname}`, init)
}

async function cli(h: Install, argv: string[], o: { terminal?: boolean } = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(
    argv,
    {
      isTerminal: o.terminal ?? true,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async () => '',
      readSecret: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    },
    { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl },
    { peer: { secrets: h.secrets, link: { fetch: redeemFetch } } },
  )
  return { code, out: out.join('\n'), err: err.join('\n'), all: `${out.join('\n')}\n${err.join('\n')}` }
}

const codeOf = (out: string): string => out.split('\n').find((l) => l.startsWith('talos-link:')) as string
const cfg = (h: Harness) => new ConfigFile(join(h.home, 'config.json')).load()
const secretOf = (h: Install, name: string) =>
  h.secrets.data.get(`${PEER_SECRET_SERVICE}\u0000${peerSecretAccount(name)}`)
/** A's bridge picks up what B sent back (its poll). */
/** How long a driven poll may take (longer on a slow machine: TALOS_TEST_TIME_FACTOR). */
const POLL_MS = t(6000)
/** A wait for the other side, with the same slack. */
const WAIT_MS = t(6000)
// The runner's own limit is 5 s per test. The longest test here starts two installs, drives a poll for up to POLL_MS and then
// waits for the other side three times, and the testkit's waitFor runs at waitScale (3) x its timeout: 3 x 3 x WAIT_MS = 54 s of
// waiting, plus POLL_MS, before the test's own steps. So the limit sits above that real sum, on this machine's scale, and a
// loaded machine fails a check with its message, not the runner's timeout (a 5 s timeout once hit at load 4.7, 2026-11-20; the
// t(40_000) that landed first was under the 54 s the three waits can take, scripts/timing-lint.ts says so).
setDefaultTimeout(t(90_000))

/** Drives A's poll until `ok`, up to POLL_MS. The loop is the wait: no fixed wait after it, only the check. */
async function pollUntil(h: Install, ok: () => boolean, what: string) {
  const end = Date.now() + POLL_MS
  while (!ok() && Date.now() < end) {
    await h.bridge.poll()
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(ok(), `${what}: not within ${POLL_MS} ms of driven polls`).toBe(true)
}
const files = (h: Harness): string =>
  ['bridge.log', 'config.json', 'peers-inbound.json']
    .map((f) => (existsSync(join(h.home, f)) ? readFileSync(join(h.home, f), 'utf8') : ''))
    .join('\n')

describe('one paste links both directions', () => {
  test('link, accept, collect, then a message each way', async () => {
    await pair()
    const l = await cli(a, ['peer', 'link', 'work'])
    expect(l.code, l.err).toBe(0)
    const code = codeOf(l.out)
    expect(l.out.split('\n')).toHaveLength(2) // the code and one line
    expect(l.out).toContain('works once, for 15 minutes')
    expect(l.all).not.toContain('whsec_')
    expect(existsSync(join(a.home, 'peer-secrets')) ? readdirSync(join(a.home, 'peer-secrets')) : []).toEqual([])
    expect(readInboundPeers(a.home)[0]).toMatchObject({ name: 'work', link: { by: 'link', state: 'open' } })

    const acc = await cli(b, ['peer', 'accept', code, '--name', 'home'])
    expect(acc.code, acc.err).toBe(0)
    expect(acc.out).toBe('linked with home; messages work both ways once the other side has collected.')
    expect(acc.all).not.toContain('whsec_')
    expect(fetched).toEqual(['https://a.example.com/peer-link/redeem'])
    // B: A's inbox url is built from the code's host and conn id, A's secret is in the key store, B's own inbox exists
    const aConn = a.relay.peers.rows[0]?.conn_id as string
    expect(cfg(b).peers).toEqual([{ name: 'home', url: peerInboxUrl('https://a.example.com', aConn), daily_cap: 50 }])
    expect(secretOf(b, 'home')).toBe(a.relay.peers.rows[0]?.secrets[0] as string)
    expect(b.relay.peers.rows.map((r) => r.name)).toEqual(['home'])
    expect(readInboundPeers(b.home)[0]).toMatchObject({ name: 'home', link: { by: 'accept', state: 'done' } })

    // A collects
    await pollUntil(a, () => cfg(a).peers.length === 1, 'A collects')
    const bConn = b.relay.peers.rows[0]?.conn_id as string
    expect(cfg(a).peers).toEqual([{ name: 'work', url: peerInboxUrl('https://b.example.com', bConn), daily_cap: 50 }])
    expect(secretOf(a, 'work')).toBe(b.relay.peers.rows[0]?.secrets[0] as string)
    expect(readInboundPeers(a.home)[0]?.link?.state).toBe('done')

    // both directions land
    const ab = await a.bridge.callTool('peer_send', { peer: 'work', text: 'hello from A', label: 'TASK' })
    expect(ab.isError, text(ab)).toBeFalsy()
    await waitFor(() => b.peerNotes().length === 1, WAIT_MS, 'A to B')
    expect(b.peerNotes()[0]?.meta).toMatchObject({ peer: 'home', trust: 'external' })
    const ba = await b.bridge.callTool('peer_send', { peer: 'home', text: 'hello from B', label: 'TASK' })
    expect(ba.isError, text(ba)).toBeFalsy()
    await waitFor(() => a.peerNotes().length === 1, WAIT_MS, 'B to A')
    expect(a.peerNotes()[0]?.meta).toMatchObject({ peer: 'work', trust: 'external' })

    // the rows: one "Linked with" per side, no "Linked peer added", and no "Peer inbox created" on B
    await waitFor(
      () => rowsOf(a).includes('Linked with work') && rowsOf(b).includes('Linked with home'),
      WAIT_MS,
      'rows',
    )
    for (const h of [a, b]) expect(rowsOf(h).filter((t) => t.startsWith('Linked peer added'))).toEqual([])
    expect(rowsOf(b).filter((t) => t.startsWith('Peer inbox created'))).toEqual([])
    expect(rowsOf(a).filter((t) => t.startsWith('Linked with'))).toHaveLength(1)
    // exactly one row about the link on A: no "Peer inbox created" next to it
    expect(rowsOf(a).filter((t) => /^(Linked|Link |Peer inbox)/.test(t))).toEqual(['Linked with work'])

    // no secret and no code token anywhere the owner or a log can see
    const token = (parsePeerLinkCode(code) as { ok: true; value: { token: string } }).value.token
    const secrets = [secretOf(a, 'work') as string, secretOf(b, 'home') as string]
    const seen = [acc.all, files(a), files(b), ...rowsOf(a), ...rowsOf(b)].join('\n')
    for (const s of [...secrets, token, code]) expect(seen).not.toContain(s)
    for (const s of secrets) expect(l.all).not.toContain(s)
    expect(seen).not.toContain('whsec_')
  })

  test('a second accept of the same name is refused before any network call', async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    expect((await cli(b, ['peer', 'accept', code, '--name', 'home'])).code).toBe(0)
    const n = fetched.length
    const calls = b.relay.http.length
    const again = await cli(b, ['peer', 'accept', code, '--name', 'home'])
    expect(again.code).toBe(1)
    expect(again.err).toContain('already has a linked agent named "home"')
    expect(fetched).toHaveLength(n)
    expect(b.relay.http).toHaveLength(calls)
  })

  test('--name is required and must be a name; nothing is called', async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    const calls = b.relay.http.length
    const none = await cli(b, ['peer', 'accept', code])
    expect(none.code).toBe(1)
    expect(none.err).toContain('--name')
    expect((await cli(b, ['peer', 'accept', code, '--name', 'owner'])).code).toBe(1)
    expect((await cli(b, ['peer', 'accept', code, '--name', 'Bad Name'])).code).toBe(1)
    expect(fetched).toEqual([])
    expect(b.relay.http).toHaveLength(calls)
  })
})

const DIDNT = (n: string) => `Link with ${n} didn't finish on this side; run talos-app peer remove ${n} and link again.`
const WAS_USED = (n: string) =>
  `${n} was already linked or its code was used; run talos-app peer remove ${n} and link again.`

describe('a link that does not finish on A', () => {
  test('a collect lost after the relay committed: one fixed row, the record closed, re-link refused', async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    expect((await cli(b, ['peer', 'accept', code, '--name', 'home'])).code).toBe(0)
    a.relay.peers.getLink('work') // the relay handed it over (and wiped it) but the answer never got here
    await pollUntil(a, () => rowsOf(a).includes(DIDNT('work')), 'the row')
    await a.bridge.poll()
    await new Promise((r) => setTimeout(r, 300))
    expect(rowsOf(a).filter((t) => t.startsWith('Link with work'))).toHaveLength(1)
    expect(readInboundPeers(a.home)[0]?.link?.state).toBe('closed')
    expect(cfg(a).peers).toEqual([])
    const again = await cli(a, ['peer', 'link', 'work'])
    expect(again.code).toBe(1)
    expect(again.err).toContain(WAS_USED('work'))
  })

  test('the relay no longer has the inbox: the same row', async () => {
    await pair()
    await cli(a, ['peer', 'link', 'work'])
    a.relay.peers.remove('work')
    await pollUntil(a, () => rowsOf(a).includes(DIDNT('work')), 'the row')
  })

  test('a taken or failed link cannot be re-linked', async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    expect((await cli(b, ['peer', 'accept', code, '--name', 'home'])).code).toBe(0)
    a.secrets.set = async () => {
      throw new Error('store locked')
    }
    await pollUntil(a, () => rowsOf(a).some((t) => t.startsWith('Link to work was taken')), 'the taken row')
    const r = await cli(a, ['peer', 'link', 'work'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(WAS_USED('work'))
  })

  test('an expired code that nobody used can be re-linked', async () => {
    await pair()
    await cli(a, ['peer', 'link', 'work'])
    a.clock.set(a.clock.now() + 16 * 60_000)
    await pollUntil(a, () => readInboundPeers(a.home)[0]?.link?.state === 'closed', 'the poll closes it')
    expect((await cli(a, ['peer', 'link', 'work'])).code).toBe(0)
  })

  test("A's clock running ahead never marks a code the relay still accepts as expired: no re-link on that inbox", async () => {
    await pair()
    await cli(a, ['peer', 'link', 'work'])
    // A's clock ran ahead: by A's reckoning the code's window (plus slack) is over, while A's relay still holds it open
    const rec = readInboundPeers(a.home)[0] as NonNullable<ReturnType<typeof readInboundPeers>[0]>
    addInboundPeer(a.home, {
      ...rec,
      link: { ...(rec.link as NonNullable<typeof rec.link>), until: Date.now() - 5 * 60_000 },
    })
    expect([...a.relay.peers.links.values()][0]?.state).toBe('open')
    await pollUntil(a, () => readInboundPeers(a.home)[0]?.link?.state === 'closed', 'the poll closes it')
    expect(readInboundPeers(a.home)[0]?.link?.expired).toBeFalsy()
    const r = await cli(a, ['peer', 'link', 'work'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(WAS_USED('work'))
  })

  test("A re-checks what the relay hands over: an http url or a bad secret is refused, nothing stored, the row says it didn't finish", async () => {
    for (const bad of ['url', 'secret'] as const) {
      await pair()
      const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
      expect((await cli(b, ['peer', 'accept', code, '--name', 'home'])).code).toBe(0)
      const l = [...a.relay.peers.links.values()][0] as { backUrl?: string; backSecret?: string }
      if (bad === 'url') l.backUrl = `http://b.example.com/hook/peer/${'cn_BBBBBBBBBBBBBBBBBBBBBB'}`
      else l.backSecret = 'whsec_short'
      await pollUntil(a, () => rowsOf(a).includes(DIDNT('work')), `the row (${bad})`)
      expect(cfg(a).peers).toEqual([])
      expect(secretOf(a, 'work')).toBeUndefined()
      expect(readInboundPeers(a.home)[0]?.link?.state).toBe('closed')
      await a.stop()
      await b.stop()
    }
  })
})

describe('the code is checked before anything is sent', () => {
  test('an IP literal, http, a port, a stray path or garbage is refused with no fetch and no inbox', async () => {
    await pair()
    const conn = 'cn_abcdefghijklmnopqrstuv'
    const tok = 'A'.repeat(43)
    for (const bad of [
      `talos-link:127.0.0.1/${conn}/${tok}`,
      `talos-link:8.8.8.8/${conn}/${tok}`,
      `talos-link:a.example.com:8443/${conn}/${tok}`,
      `http://a.example.com/${conn}/${tok}`,
      `talos-link:localhost/${conn}/${tok}`,
      `talos-link:a.example.com/${conn}/${tok}/more`,
      'not a code',
    ]) {
      const r = await cli(b, ['peer', 'accept', bad, '--name', 'home'])
      expect(r.code, bad).toBe(1)
      expect(r.err).toContain('not a link code')
      expect(r.all).not.toContain(tok) // the code is never echoed back
    }
    expect(fetched).toEqual([])
    expect(b.relay.peers.rows).toEqual([])
    expect(b.relay.http.some((h) => h.path === '/bridge/peers')).toBe(false)
  })

  test('whsec_ anywhere in the arguments is still refused', async () => {
    await pair()
    const r = await cli(b, ['peer', 'accept', 'talos-link:a.example.com/x/whsec_abc', '--name', 'home'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('never goes on the command line')
  })
})

describe('a code that cannot be used', () => {
  const UNUSABLE = "this link code can't be used: it expired, was already used, or is wrong."

  test('expired: the line, and B leaves nothing behind', async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    a.clock.set(a.clock.now() + 16 * 60_000)
    const r = await cli(b, ['peer', 'accept', code, '--name', 'home'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(UNUSABLE)
    expect(r.err).toContain('talos-app peer link on the other Talos')
    expect(b.relay.peers.rows).toEqual([])
    expect(readInboundPeers(b.home)).toEqual([])
    expect(cfg(b).peers).toEqual([])
    expect(secretOf(b, 'home')).toBeUndefined()
  })

  test('used twice: the second accept fails the same way', async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    expect((await cli(b, ['peer', 'accept', code, '--name', 'home'])).code).toBe(0)
    const r = await cli(b, ['peer', 'accept', code, '--name', 'other'])
    expect(r.err).toContain(UNUSABLE)
    expect(b.relay.peers.rows.map((x) => x.name)).toEqual(['home']) // the second half-made inbox is gone
  })

  test('a stolen code: a third party redeems first, the owner fails loudly, B is clean, A says it was taken', async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    const p = parsePeerLinkCode(code)
    if (!p.ok) throw new Error('code')
    const thief = await fetch(`${a.relay.httpUrl}/peer-link/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conn_id: p.value.conn_id,
        token: p.value.token,
        back: {
          url: peerInboxUrl('https://thief.example.com', 'cn_TTTTTTTTTTTTTTTTTTTTTT'),
          secret: `whsec_${Buffer.alloc(32, 3).toString('base64')}`,
        },
      }),
    })
    expect(thief.status).toBe(200)
    const owner = await cli(b, ['peer', 'accept', code, '--name', 'home'])
    expect(owner.code).toBe(1)
    expect(owner.err).toContain(UNUSABLE)
    expect(b.relay.peers.rows).toEqual([])
    expect(readInboundPeers(b.home)).toEqual([])
    expect(cfg(b).peers).toEqual([])
    // A's poll: it collected the thief's half, then the relay says the code was used again
    await pollUntil(
      a,
      () => rowsOf(a).includes('Link to work was taken by another install; run talos-app peer remove work'),
      'the taken row',
    )
    expect(rowsOf(a).filter((t) => t.startsWith('Link to work was taken'))).toHaveLength(1) // once
  })

  test("A's own accept failing after the relay said redeemed: the taken row, nothing half stored", async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    const p = parsePeerLinkCode(code)
    if (!p.ok) throw new Error('code')
    expect((await cli(b, ['peer', 'accept', code, '--name', 'home'])).code).toBe(0)
    // the key store cannot be written on A
    a.secrets.set = async () => {
      throw new Error('store locked')
    }
    await pollUntil(a, () => rowsOf(a).some((t) => t.startsWith('Link to work was taken')), 'the taken row')
    expect(cfg(a).peers).toEqual([])
    expect(readInboundPeers(a.home)[0]?.link?.state).toBe('closed')
  })

  test('the relay cannot be reached at the redeem: B leaves nothing behind and says only the host', async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    redeemDown = true
    const r = await cli(b, ['peer', 'accept', code, '--name', 'home'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('a.example.com')
    expect(r.all).not.toContain('talos-link')
    expect(r.all).not.toContain((parsePeerLinkCode(code) as { ok: true; value: { token: string } }).value.token)
    expect(b.relay.peers.rows).toEqual([])
    expect(readInboundPeers(b.home)).toEqual([])
  })
})

describe('peer link', () => {
  test('a second link while a code is waiting is refused, touches nothing, and the pending link still completes', async () => {
    await pair()
    const first = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    const calls = a.relay.http.length
    const again = await cli(a, ['peer', 'link', 'work'])
    expect(again.code).toBe(1)
    expect(again.err).toContain(
      'a link code is already waiting for work; use it or cancel it with talos-app peer remove work.',
    )
    expect(a.relay.http).toHaveLength(calls) // no relay call at all, so no collect either
    expect((await cli(b, ['peer', 'accept', first, '--name', 'home'])).code).toBe(0)
    await pollUntil(a, () => cfg(a).peers.length === 1, 'A collects')
    await waitFor(() => rowsOf(a).includes('Linked with work'), 6000, 'the row')
  })

  test('a code that was redeemed but not yet collected is still waiting: refused, and nothing is consumed', async () => {
    await pair()
    const first = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    expect((await cli(b, ['peer', 'accept', first, '--name', 'home'])).code).toBe(0)
    const calls = a.relay.http.length
    const again = await cli(a, ['peer', 'link', 'work'])
    expect(again.err).toContain('a link code is already waiting for work')
    expect(a.relay.http).toHaveLength(calls)
    await pollUntil(a, () => cfg(a).peers.length === 1, 'A collects')
  })

  test('peer remove, then link, works', async () => {
    await pair()
    await cli(a, ['peer', 'link', 'work'])
    expect((await cli(a, ['peer', 'remove', 'work'])).code).toBe(0)
    expect((await cli(a, ['peer', 'link', 'work'])).code).toBe(0)
  })

  test('an open record past its time that the poll has not closed yet fails closed, with no relay call', async () => {
    await pair()
    await cli(a, ['peer', 'link', 'work'])
    const rec = readInboundPeers(a.home)[0]
    addInboundPeer(a.home, {
      ...(rec as NonNullable<typeof rec>),
      link: { by: 'link', state: 'open', until: Date.now() - 1000 },
    })
    const calls = a.relay.http.length
    const r = await cli(a, ['peer', 'link', 'work'])
    expect(r.code).toBe(1)
    expect(r.err).toContain(WAS_USED('work'))
    expect(a.relay.http).toHaveLength(calls)
  })

  test('refuses a name that is already a normal inbox', async () => {
    await pair()
    expect((await cli(a, ['peer', 'create', 'work'])).code).toBe(0)
    const r = await cli(a, ['peer', 'link', 'work'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('already an inbox named "work"')
  })

  test('a relay that is not on public https says so and leaves no inbox behind', async () => {
    await pair()
    a.relay.peers.publicOrigin = null // the fake's own http address
    const r = await cli(a, ['peer', 'link', 'work'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('two-step')
    expect(a.relay.peers.rows).toEqual([])
    expect(readInboundPeers(a.home)).toEqual([])
  })
})

describe('the gate, from an agent run', () => {
  test('lock on: link and accept are refused; nothing is called', async () => {
    await pair()
    const cfgFile = new ConfigFile(join(a.home, 'config.json'))
    for (const h of [a, b]) new ConfigFile(join(h.home, 'config.json')).update((c) => ({ ...c, settings_lock: true }))
    void cfgFile
    const l = await cli(a, ['peer', 'link', 'work'], { terminal: false })
    expect(l.code).toBe(1)
    expect(l.err).toContain('locked')
    const r = await cli(
      b,
      ['peer', 'accept', 'talos-link:a.example.com/cn_abcdefghijklmnopqrstuv/' + 'A'.repeat(43), '--name', 'home'],
      { terminal: false },
    )
    expect(r.code).toBe(1)
    expect(fetched).toEqual([])
    expect(a.relay.peers.rows).toEqual([])
    // a terminal still runs
    expect((await cli(a, ['peer', 'link', 'work'])).code).toBe(0)
  })

  test("the owner's paste as his latest words: accept runs from the agent; outside text after it refuses", async () => {
    await pair()
    const code = codeOf((await cli(a, ['peer', 'link', 'work'])).out)
    await ownerSays(b, `link with my work Talos: ${code}`)
    const ok = await cli(b, ['peer', 'accept', code, '--name', 'home'], { terminal: false })
    expect(ok.code, ok.err).toBe(0)
    // a second code, but outside text reached the agent after the owner's words
    const code2 = codeOf((await cli(a, ['peer', 'link', 'other'])).out)
    b.bridge.ctx.store.kvSet('outside_text_at:general', String(Date.now() + 1000))
    const no = await cli(b, ['peer', 'accept', code2, '--name', 'two'], { terminal: false })
    expect(no.code).toBe(1)
    expect(no.err).toContain('outside text')
    expect(b.relay.peers.rows.map((r) => r.name)).toEqual(['home'])
    // and the same for a link
    expect((await cli(b, ['peer', 'link', 'third'], { terminal: false })).code).toBe(1)
  })
})
