// A Talos home that is not the account's default keeps its linked agents across the per-home key store update: it COPIES the legacy
// (un-namespaced) peer secret into its own name when its config has a peer of that name. It never deletes or changes the legacy item
// (only the default home moves it), marks the copy, and a send the other side rejects after a copy reads as "needs re-linking".
// Fixed fake secrets only.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretStore } from '@talos-app/protocol'
import { loadExampleConfig, t, waitFor } from '@talos-app/testkit'
import { runCli } from '../../src/cli.ts'
import { ConfigFile } from '../../src/config-file.ts'
import { PEER_SECRET_SERVICE, peerSecretAccount } from '../../src/peer/records.ts'
import { relinkLine } from '../../src/peer/relink.ts'
import { PEER_COPIED_FILE, peerScopedStore, peerSecretWasCopied } from '../../src/peer/secret-store.ts'
import { homeScopedService } from '../../src/secrets/home-scope.ts'
import { ACCOUNT_HOME_TEST } from '../../src/talos.ts'
import { type Harness, startHarness } from '../helpers.ts'
import { FAKE_SECRET, type Install, install, linkBoth, rowsOf, text } from './helpers.ts'

const SVC = PEER_SECRET_SERVICE
const ACC = peerSecretAccount('atlas')
const S1 = 'whsec_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'
const S2 = 'whsec_OTHEROTHEROTHEROTHEROTHEROTHEROTHEROTHEROTHE'

function keychain() {
  const data = new Map<string, string>()
  const k = (s: string, a: string) => `${s}\u0000${a}`
  const st = {
    backend: 'macos_keychain',
    strength: 'os_keyring',
    data,
    async get(s: string, a: string) {
      return data.get(k(s, a))
    },
    async set(s: string, a: string, v: string) {
      data.set(k(s, a), v)
    },
    async delete(s: string, a: string) {
      data.delete(k(s, a))
    },
  }
  return st as typeof st & SecretStore
}
type KC = ReturnType<typeof keychain>
const legacy = (kc: KC) => kc.data.get(`${SVC}\u0000${ACC}`)
const own = (kc: KC, home: string) => kc.data.get(`${homeScopedService(SVC, home)}\u0000${ACC}`)

const made: string[] = []
let h: Harness | undefined
let a: Install | undefined
let b: Install | undefined
const wasAccount = ACCOUNT_HOME_TEST.home
afterEach(async () => {
  await h?.stop()
  await a?.stop()
  await b?.stop()
  h = a = b = undefined
  ACCOUNT_HOME_TEST.home = wasAccount
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'copy-')))
  made.push(root)
  const mk = (n: string) => {
    mkdirSync(join(root, n), { recursive: true })
    return join(root, n)
  }
  return { root, account: root, def: mk('.config/talos/app'), custom: mk('home-b') }
}
const setPeers = (home: string, names: string[]) => {
  const path = join(home, 'config.json')
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(loadExampleConfig('default')), { mode: 0o600 })
  new ConfigFile(path).update((c) => ({
    ...c,
    peers: names.map((name) => ({
      name,
      url: 'https://atlas-inbox.example.com/hook/peer/cn_fakefakefakefakefake0',
      daily_cap: 50,
    })),
  }))
}
const store = (kc: SecretStore, home: string, account: string, log?: (l: string) => void) =>
  peerScopedStore(kc, home, { account, ...(log ? { log } : {}) })

describe('a non-default home copies a legacy peer secret it has a peer entry for', () => {
  test('B copies it, the legacy item stays, A (default) still moves it as today', async () => {
    const t = setup()
    const kc = keychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    setPeers(t.custom, ['atlas'])
    const logs: string[] = []
    expect(await store(kc, t.custom, t.account, (l) => logs.push(l)).get(SVC, ACC)).toBe(S1)
    expect(own(kc, t.custom)).toBe(S1)
    expect(legacy(kc)).toBe(S1) // never deleted
    expect(peerSecretWasCopied(t.custom, 'atlas')).toBe(true)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('atlas')
    expect(logs[0]).not.toContain(S1)
    expect(readFileSync(join(t.custom, PEER_COPIED_FILE), 'utf8')).not.toContain(S1)
    expect((statSync(join(t.custom, PEER_COPIED_FILE)).mode & 0o777).toString(8)).toBe('600')
    // the default home: its own move, as before (it deletes the legacy item)
    expect(await store(kc, t.def, t.account).get(SVC, ACC)).toBe(S1)
    expect(own(kc, t.def)).toBe(S1)
    expect(legacy(kc)).toBeUndefined()
    expect(own(kc, t.custom)).toBe(S1) // B keeps its copy
  })

  test('B without a peer entry of that name gets nothing, and the legacy item stays', async () => {
    const t = setup()
    const kc = keychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    setPeers(t.custom, ['work'])
    const s = store(kc, t.custom, t.account)
    expect(await s.get(SVC, ACC)).toBeUndefined()
    expect(own(kc, t.custom)).toBeUndefined()
    expect(legacy(kc)).toBe(S1)
    await s.delete(SVC, ACC) // a delete of B's own item never touches the legacy one either
    expect(legacy(kc)).toBe(S1)
    expect(existsSync(join(t.custom, PEER_COPIED_FILE))).toBe(false)
  })

  test('another service never copies, even with a peer entry', async () => {
    const t = setup()
    const kc = keychain()
    kc.data.set('com.talos.app.railway\u0000token', S1)
    kc.data.set(`${SVC}\u0000other:atlas`, S1)
    setPeers(t.custom, ['atlas'])
    const s = store(kc, t.custom, t.account)
    expect(await s.get('com.talos.app.railway', 'token')).toBeUndefined()
    expect(await s.get(SVC, 'other:atlas')).toBeUndefined()
    expect(kc.data.get(`${homeScopedService('com.talos.app.railway', t.custom)}\u0000token`)).toBeUndefined()
  })

  test('a newer namespaced item is kept and the legacy item left alone', async () => {
    const t = setup()
    const kc = keychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    kc.data.set(`${homeScopedService(SVC, t.custom)}\u0000${ACC}`, S2)
    setPeers(t.custom, ['atlas'])
    expect(await store(kc, t.custom, t.account).get(SVC, ACC)).toBe(S2)
    expect(legacy(kc)).toBe(S1)
    expect(peerSecretWasCopied(t.custom, 'atlas')).toBe(false)
  })

  test('a secret that appears just before the write is not overwritten', async () => {
    const t = setup()
    const kc = keychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    setPeers(t.custom, ['atlas'])
    const ns = `${homeScopedService(SVC, t.custom)}\u0000${ACC}`
    let reads = 0
    const racing: SecretStore = {
      ...kc,
      get: async (s, ac) => {
        const v = await kc.get(s, ac)
        if (s === SVC && ++reads === 1) kc.data.set(ns, S2) // a newer item lands after the legacy read
        return v
      },
    }
    expect(await store(racing as SecretStore, t.custom, t.account).get(SVC, ACC)).toBe(S2)
    expect(kc.data.get(ns)).toBe(S2)
    expect(legacy(kc)).toBe(S1)
  })

  test('a symlinked path names the same item as its real path; a swapped link cannot redirect B to the default home', async () => {
    const t = setup()
    const kc = keychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    setPeers(t.custom, ['atlas'])
    const link = join(t.root, 'link-b')
    symlinkSync(t.custom, link)
    expect(await store(kc, link, t.account).get(SVC, ACC)).toBe(S1)
    expect(own(kc, t.custom)).toBe(S1)
    expect(kc.data.size).toBe(2)
    // a link that points at the default home: B-by-link is the default home, which moves as today (never a copy under another name)
    const swap = join(t.root, 'swap')
    symlinkSync(t.custom, swap)
    const kc2 = keychain()
    kc2.data.set(`${SVC}\u0000${ACC}`, S1)
    let first = true
    const swapping: SecretStore = {
      ...kc2,
      get: async (s, ac) => {
        if (first) {
          first = false
          unlinkSync(swap)
          symlinkSync(t.def, swap) // the link now points at the default home, mid call
        }
        return kc2.get(s, ac)
      },
    }
    await store(swapping as SecretStore, swap, t.account).get(SVC, ACC)
    // the item was named from the real path resolved at the start of the call (home-b), and nothing was written under the default's name
    expect(kc2.data.get(`${homeScopedService(SVC, t.def)}\u0000${ACC}`)).toBeUndefined()
    expect(legacy(kc2)).toBe(S1)
  })

  test('a new secret or a removal drops the mark', async () => {
    const t = setup()
    const kc = keychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    setPeers(t.custom, ['atlas'])
    const s = store(kc, t.custom, t.account)
    await s.get(SVC, ACC)
    expect(peerSecretWasCopied(t.custom, 'atlas')).toBe(true)
    await s.set(SVC, ACC, S2)
    expect(peerSecretWasCopied(t.custom, 'atlas')).toBe(false)
    expect(own(kc, t.custom)).toBe(S2)
    expect(legacy(kc)).toBe(S1)
  })

  test('the config and the mark are read at the one real path of the call: a link swapped mid-call cannot make another config approve a copy', async () => {
    const t = setup()
    const kc = keychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    const noPeer = t.custom // home-b: no atlas
    mkdirSync(join(t.root, 'home-c'), { recursive: true })
    const withPeer = join(t.root, 'home-c')
    setPeers(noPeer, ['work'])
    setPeers(withPeer, ['atlas'])
    const link = join(t.root, 'swap-link')
    symlinkSync(noPeer, link)
    let first = true
    const swapping: SecretStore = {
      ...kc,
      get: async (s, ac) => {
        if (first) {
          first = false
          unlinkSync(link)
          symlinkSync(withPeer, link) // after the home was resolved, the link now leads to a home whose config lists atlas
        }
        return kc.get(s, ac)
      },
    }
    expect(await store(swapping as SecretStore, link, t.account).get(SVC, ACC)).toBeUndefined()
    expect(kc.data.size).toBe(1) // nothing was written under any name
    expect(existsSync(join(withPeer, PEER_COPIED_FILE))).toBe(false)
    expect(existsSync(join(noPeer, PEER_COPIED_FILE))).toBe(false)
  })

  test('a mark that cannot be dropped never fails a set or a delete: one log line', async () => {
    const t = setup()
    const kc = keychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    setPeers(t.custom, ['atlas'])
    const logs: string[] = []
    const s = store(kc, t.custom, t.account, (l) => logs.push(l))
    await s.get(SVC, ACC)
    expect(peerSecretWasCopied(t.custom, 'atlas')).toBe(true)
    logs.length = 0
    chmodSync(t.custom, 0o500) // the mark file cannot be rewritten now
    try {
      await s.set(SVC, ACC, S2)
    } finally {
      chmodSync(t.custom, 0o700)
    }
    expect(own(kc, t.custom)).toBe(S2)
    expect(logs).toHaveLength(1)
    expect(logs[0]).not.toContain(S2)
  })
})

describe('peer list on a custom home after a copy', () => {
  test('says secret yes and no re-linking line', async () => {
    const t = setup()
    ACCOUNT_HOME_TEST.home = t.account
    h = await startHarness({ startBridge: false })
    const kc = keychain()
    kc.data.set(`${SVC}\u0000${ACC}`, FAKE_SECRET)
    setPeers(h.home, ['atlas'])
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(
      ['peer', 'list'],
      {
        isTerminal: true,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        prompt: async () => '',
        readSecret: async () => '',
        sleep: async () => {},
        now: () => Date.now(),
      },
      { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl },
      { peer: { secrets: kc }, wsl: { isWsl: false } as never },
    )
    expect(code, err.join('\n')).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('secret yes')
    expect(text).not.toContain('re-linking')
    expect(text).not.toContain(FAKE_SECRET)
    expect(own(kc, h.home)).toBe(FAKE_SECRET)
    expect(legacy(kc)).toBe(FAKE_SECRET)
  })
})

describe('a send rejected after a copy', () => {
  const wrong = `whsec_${Buffer.alloc(32, 9).toString('base64')}`
  const key = `${SVC}\u0000${peerSecretAccount('work')}`
  async function pair() {
    const t = setup()
    ACCOUNT_HOME_TEST.home = t.account
    a = await install({ to: () => b })
    b = await install({ to: () => a })
    await linkBoth(a, b)
    return a
  }
  const sendWork = (h: Install) => h.bridge.callTool('peer_send', { peer: 'work', text: 'a message', label: 'TASK' })
  const relinkRows = (h: Install) => rowsOf(h).filter((x) => x.includes(relinkLine('work')))

  test('401 for a copied peer: one relink line, one try, and later sends are refused quietly', async () => {
    const h1 = await pair()
    h1.secrets.data.set(key, wrong) // the legacy item is another home's
    ;(h1.secrets as { backend: string }).backend = 'macos_keychain'
    await sendWork(h1)
    await waitFor(() => relinkRows(h1).length === 1, 1000, 'the relink row')
    expect(h1.calls).toHaveLength(1)
    expect(h1.calls[0]?.status).toBe(401)
    expect(rowsOf(h1).some((x) => x.includes('refused a message'))).toBe(false)
    expect(readFileSync(join(h1.home, PEER_COPIED_FILE), 'utf8')).not.toContain(wrong)
    const again = await sendWork(h1)
    expect(again.isError).toBe(true)
    expect(text(again)).toContain(relinkLine('work'))
    h1.clock.advance(60_000)
    await new Promise((r) => setTimeout(r, t(150)))
    expect(h1.calls).toHaveLength(1)
    expect(relinkRows(h1)).toHaveLength(1)
  })

  test('401 for a peer that was not copied is the plain refusal, as before', async () => {
    const h1 = await pair()
    h1.secrets.data.set(key, wrong) // a file store: no copy, no mark
    await sendWork(h1)
    await waitFor(() => rowsOf(h1).some((x) => x.includes('refused a message (unauthorized)')), 1000, 'the row')
    expect(rowsOf(h1).some((x) => x.includes('needs re-linking'))).toBe(false)
    expect(h1.calls).toHaveLength(1)
  })

  test('a send that lands clears the copy mark', async () => {
    const h1 = await pair() // the right secret sits under the plain name; a keychain store makes it a legacy item
    ;(h1.secrets as { backend: string }).backend = 'macos_keychain'
    await sendWork(h1)
    await waitFor(() => h1.calls.length === 1, 700, 'the try')
    expect(h1.calls[0]?.status).toBe(200)
    await waitFor(() => !peerSecretWasCopied(h1.home, 'work'), 700, 'the mark cleared')
    expect(rowsOf(h1).some((x) => x.includes('needs re-linking'))).toBe(false)
  })
})
