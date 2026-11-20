// The one-paste link from a Talos home that is not the account's default, on a keychain-wide key store (the Keychain): it runs from
// an agent (no terminal), the secrets are kept per home, the peer name is not case-sensitive, and a pasted code may be wrapped.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePeerLinkCode } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { runCli } from '../../src/cli.ts'
import { ConfigFile } from '../../src/config-file.ts'
import { PEER_SECRET_SERVICE, peerSecretAccount } from '../../src/peer/records.ts'
import { homeScopedService } from '../../src/secrets/home-scope.ts'
import { ACCOUNT_HOME_TEST } from '../../src/talos.ts'
import { type Harness, startHarness } from '../helpers.ts'
import { FAKE_SECRET, type Install, install, memorySecrets, text } from './helpers.ts'

const HOSTS: Record<string, 'a' | 'b'> = { 'a.example.com': 'a', 'b.example.com': 'b' }
let a: Install
let b: Install
let fetched: string[] = []
let account: string
const wasAccount = ACCOUNT_HOME_TEST.home

afterEach(async () => {
  await a?.stop()
  await b?.stop()
  ACCOUNT_HOME_TEST.home = wasAccount
  if (account) rmSync(account, { recursive: true, force: true })
})

const byHost = (url: string): Install | undefined => {
  const k = HOSTS[new URL(url).host]
  return k === 'a' ? a : k === 'b' ? b : undefined
}
async function pair() {
  // an account whose default Talos home exists and is neither install's home
  account = mkdtempSync(join(realpathSync(tmpdir()), 'acct-'))
  await Bun.$`mkdir -p ${join(account, '.config', 'talos', 'app')}`.quiet()
  ACCOUNT_HOME_TEST.home = account
  a = await install({ to: byHost })
  b = await install({ to: byHost })
  for (const h of [a, b]) (h.secrets as { backend: string }).backend = 'macos_keychain'
  a.relay.peers.publicOrigin = 'https://a.example.com'
  b.relay.peers.publicOrigin = 'https://b.example.com'
  fetched = []
}
const redeemFetch = async (url: string, init: RequestInit): Promise<Response> => {
  fetched.push(url)
  const target = byHost(url)
  if (!target) return new Response(null, { status: 503 })
  return fetch(`${target.relay.httpUrl}${new URL(url).pathname}`, init)
}
/** An agent run: no terminal. */
async function cli(h: Install, argv: string[], o: { terminal?: boolean } = {}) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(
    argv,
    {
      isTerminal: o.terminal ?? false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async () => '',
      readSecret: async () => FAKE_SECRET,
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
const itemOf = (h: Install, name: string) =>
  h.secrets.data.get(`${homeScopedService(PEER_SECRET_SERVICE, h.home)}\u0000${peerSecretAccount(name)}`)
const legacyOf = (h: Install, name: string) =>
  h.secrets.data.get(`${PEER_SECRET_SERVICE}\u0000${peerSecretAccount(name)}`)

describe('an agent run on a non-default home with a keychain-wide store', () => {
  test('peer link and peer accept run, with a capitalised name; the secret is under the home-scoped item and nowhere else', async () => {
    await pair()
    const l = await cli(a, ['peer', 'link', 'Work'])
    expect(l.code, l.err).toBe(0)
    expect(l.out).toContain('Using the name "work"')
    expect(l.err).not.toMatch(/key store is shared/)
    const code = codeOf(l.out)
    const acc = await cli(b, ['peer', 'accept', code, '--name', 'Atlas'])
    expect(acc.code, acc.err).toBe(0)
    expect(acc.out).toContain('Using the name "atlas"')
    expect(cfg(b).peers.map((p) => p.name)).toEqual(['atlas'])
    expect(itemOf(b, 'atlas')).toBe(a.relay.peers.rows[0]?.secrets[0] as string)
    expect(legacyOf(b, 'atlas')).toBeUndefined()
    // A collects with its bridge, then a message goes through a bridge that reads the same scoped item
    for (let i = 0; i < 60 && cfg(a).peers.length === 0; i++) {
      await a.bridge.poll()
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(itemOf(a, 'work')).toBe(b.relay.peers.rows[0]?.secrets[0] as string)
    expect(legacyOf(a, 'work')).toBeUndefined()
    const sent = await a.bridge.callTool('peer_send', { peer: 'work', text: 'hi', label: 'TASK' })
    expect(sent.isError, text(sent)).toBeFalsy()
    await waitFor(() => b.peerNotes().length === 1, 6000, 'A to B')
    // no secret on any output or in the log
    const secrets = [itemOf(a, 'work') as string, itemOf(b, 'atlas') as string]
    const log = (h: Install) =>
      existsSync(join(h.home, 'bridge.log')) ? readFileSync(join(h.home, 'bridge.log'), 'utf8') : ''
    for (const s of secrets) for (const seen of [l.all, acc.all, log(a), log(b)]) expect(seen).not.toContain(s)
  })

  test('peer add in two homes keeps two secrets; removing in one leaves the other', async () => {
    await pair()
    const url = 'https://work-inbox.example.com/hook/peer/cn_fakefakefakefakefake0'
    const s2 = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
    expect((await cli(a, ['peer', 'add', 'work', '--url', url], { terminal: true })).code).toBe(0)
    b.secrets.data.clear()
    const shared = memorySecrets()
    // both installs on ONE keychain-wide store
    for (const h of [a, b]) Object.assign(h.secrets, { get: shared.get, set: shared.set, delete: shared.delete })
    ;(shared as { backend: string }).backend = 'macos_keychain'
    await shared.set(homeScopedService(PEER_SECRET_SERVICE, a.home), peerSecretAccount('work'), FAKE_SECRET)
    const addB = await runCli(
      ['peer', 'add', 'work', '--url', url],
      {
        isTerminal: true,
        out: () => {},
        err: () => {},
        prompt: async () => '',
        readSecret: async () => s2,
        sleep: async () => {},
        now: () => Date.now(),
      },
      { TALOS_APP_HOME: b.home, TALOS_APP_RELAY_URL: b.relay.httpUrl },
      { peer: { secrets: Object.assign(Object.create(shared), { backend: 'macos_keychain' }) } },
    )
    expect(addB).toBe(0)
    expect(await shared.get(homeScopedService(PEER_SECRET_SERVICE, a.home), peerSecretAccount('work'))).toBe(
      FAKE_SECRET,
    )
    expect(await shared.get(homeScopedService(PEER_SECRET_SERVICE, b.home), peerSecretAccount('work'))).toBe(s2)
    expect(shared.data.size).toBe(2)
  })
})

describe('--name', () => {
  test('peer create and add lower-case the name and say so; a bad name is still refused', async () => {
    await pair()
    const c = await cli(a, ['peer', 'create', 'Home'])
    expect(c.code, c.err).toBe(0)
    expect(c.out).toContain('Using the name "home"')
    expect(existsSync(join(a.home, 'peer-secrets', 'home.secret'))).toBe(true)
    const bad = await cli(a, ['peer', 'create', 'Bad Name'])
    expect(bad.code).toBe(1)
    const bad2 = await cli(b, ['peer', 'accept', 'talos-link:a.example.com/x/y', '--name', 'Bad Name'])
    expect(bad2.code).toBe(1)
    expect(fetched).toEqual([])
  })
})

describe('a wrapped code', () => {
  test('quotes, angle brackets, backticks and a trailing dot or comma are taken off; other wrapping is still refused with no fetch', async () => {
    await pair()
    const wraps = [
      (c: string) => `<${c}>`,
      (c: string) => `"${c}"`,
      (c: string) => `'${c}'`,
      (c: string) => `\`${c}\``,
      (c: string) => `${c},`,
    ]
    for (const [i, wrap] of wraps.entries()) {
      const code = codeOf((await cli(a, ['peer', 'link', `w${i}`])).out)
      const acc = await cli(b, ['peer', 'accept', wrap(code), '--name', `h${i}`])
      expect(acc.code, acc.err).toBe(0)
      const token = (parsePeerLinkCode(code) as { ok: true; value: { token: string } }).value.token
      expect(acc.all).not.toContain(token)
    }
    expect(cfg(b).peers.map((p) => p.name)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4'])
    const conn = 'cn_abcdefghijklmnopqrstuv'
    const tok = 'A'.repeat(43)
    const before = fetched.length
    for (const bad of [
      `<<talos-link:a.example.com/${conn}/${tok}>>`,
      `<talos-link:127.0.0.1/${conn}/${tok}>`,
      `"http://a.example.com/${conn}/${tok}"`,
      `'talos-link:a.example.com:8443/${conn}/${tok}'`,
    ]) {
      const r = await cli(b, ['peer', 'accept', bad, '--name', 'other'])
      expect(r.code, bad).toBe(1)
      expect(r.err).toContain('not a link code')
      expect(r.all).not.toContain(tok)
    }
    expect(fetched).toHaveLength(before)
  })
})

describe('no default home on the account: a home made later never takes the real home legacy secret', () => {
  test('peer list, the send path and peer remove on a non-default home leave the legacy item; the default home made afterwards moves it', async () => {
    account = mkdtempSync(join(realpathSync(tmpdir()), 'acct-'))
    ACCOUNT_HOME_TEST.home = account // no ~/.config/talos/app under it
    a = await install({ to: byHost })
    b = await install({ to: byHost })
    const store = a.secrets
    ;(store as { backend: string }).backend = 'macos_keychain'
    const legacyKey = `${PEER_SECRET_SERVICE}\u0000${peerSecretAccount('work')}`
    store.data.set(legacyKey, FAKE_SECRET)
    const url = 'https://work-inbox.example.com/hook/peer/cn_fakefakefakefakefake0'
    new ConfigFile(join(a.home, 'config.json')).update((c) => ({ ...c, peers: [{ name: 'work', url, daily_cap: 50 }] }))
    const list = await cli(a, ['peer', 'list'])
    expect(list.out).toContain('secret no')
    expect(store.data.get(legacyKey)).toBe(FAKE_SECRET)
    const sent = await a.bridge.callTool('peer_send', { peer: 'work', text: 'hi', label: 'TASK' })
    expect(sent.isError).toBe(true)
    expect(store.data.get(legacyKey)).toBe(FAKE_SECRET)
    await cli(a, ['peer', 'remove', 'work'])
    expect(store.data.get(legacyKey)).toBe(FAKE_SECRET)
    // the real default home appears later and still has its secret
    const { mkdirSync } = await import('node:fs')
    const def = join(account, '.config', 'talos', 'app')
    mkdirSync(def, { recursive: true })
    const { homeScopedStore } = await import('../../src/secrets/home-scope.ts')
    const D = homeScopedStore(store, def, { kind: 'peer' })
    expect(await D.get(PEER_SECRET_SERVICE, peerSecretAccount('work'))).toBe(FAKE_SECRET)
  })
})
