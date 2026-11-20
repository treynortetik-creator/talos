// A keychain-wide store (macOS Keychain, Secret Service) keeps one item per (service, account) for the whole computer. Two Talos
// homes on one account must not share or overwrite each other's peer secrets, and the legacy (un-namespaced) item is moved only by
// the home that can own it. Fixed fake secrets only.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretStore } from '@talos-app/protocol'
import { homeScopedService, homeScopedStore, homeScopeSuffix } from '../src/secrets/home-scope.ts'

const SVC = 'com.talos.app.peer'
const ACC = 'peer:work'
const S1 = 'whsec_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'
const S2 = 'whsec_OTHEROTHEROTHEROTHEROTHEROTHEROTHEROTHEROTHE'

/** One in-memory store that two homes share, like the login Keychain. `failDelete` makes a delete of that service throw. */
function sharedKeychain() {
  const data = new Map<string, string>()
  const k = (s: string, a: string) => `${s}\u0000${a}`
  const st = {
    backend: 'macos_keychain',
    strength: 'os_keyring',
    data,
    failDelete: false,
    async get(s: string, a: string) {
      return data.get(k(s, a))
    },
    async set(s: string, a: string, v: string) {
      data.set(k(s, a), v)
    },
    async delete(s: string, a: string) {
      if (st.failDelete) throw new Error('locked')
      data.delete(k(s, a))
    },
  }
  return st as typeof st & SecretStore
}

const made: string[] = []
const dir = (name: string) => {
  const d = join(made[0] as string, name)
  mkdirSync(d, { recursive: true })
  return d
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
function setup(withDefault: boolean) {
  made.push(mkdtempSync(join(tmpdir(), 'scope-')))
  const account = dir('acct')
  const def = withDefault ? dir('acct/.config/talos/app') : undefined
  return { account, def, a: dir('home-a'), b: dir('home-b') }
}
const scoped = (kc: SecretStore, home: string, account: string | null, log?: (l: string) => void) =>
  homeScopedStore(kc, home, { kind: 'peer', account, ...(log ? { log } : {}) })

describe('two homes on one keychain-wide store', () => {
  test('peer secrets are separate; removing in B leaves A', async () => {
    const t = setup(false)
    const kc = sharedKeychain()
    const A = scoped(kc, t.a, t.account)
    const B = scoped(kc, t.b, t.account)
    await A.set(SVC, ACC, S1)
    await B.set(SVC, ACC, S2)
    expect(await A.get(SVC, ACC)).toBe(S1)
    expect(await B.get(SVC, ACC)).toBe(S2)
    expect(kc.data.size).toBe(2)
    expect([...kc.data.keys()].every((x) => x.startsWith(`${SVC}.${'x'.repeat(0)}`))).toBe(true)
    await B.delete(SVC, ACC)
    expect(await B.get(SVC, ACC)).toBeUndefined()
    expect(await A.get(SVC, ACC)).toBe(S1)
  })
  test('the name is service.<16 hex of sha256 of the real path>; a link to the home gives the same name', async () => {
    const t = setup(false)
    const link = join(t.account, 'link-to-a')
    symlinkSync(t.a, link)
    expect(homeScopeSuffix(t.a)).toMatch(/^[0-9a-f]{16}$/)
    expect(homeScopeSuffix(link)).toBe(homeScopeSuffix(t.a))
    expect(homeScopeSuffix(t.a)).not.toBe(homeScopeSuffix(t.b))
  })
  test('a home that is not there is refused, not hashed', async () => {
    const t = setup(false)
    const A = scoped(sharedKeychain(), join(t.a, 'gone'), t.account)
    await expect(A.set(SVC, ACC, S1)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(A.get(SVC, ACC)).rejects.toMatchObject({ code: 'unavailable' })
  })
  test('the per-home file store is passed through untouched', async () => {
    const t = setup(false)
    const kc = Object.assign(sharedKeychain(), { backend: 'file_0600' as const })
    const A = scoped(kc, t.a, t.account)
    await A.set(SVC, ACC, S1)
    expect([...kc.data.keys()]).toEqual([`${SVC}\u0000${ACC}`])
  })
})

describe('moving a legacy item', () => {
  test('the default home moves it: write, verify, delete; one log line without the secret', async () => {
    const t = setup(true)
    const kc = sharedKeychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    const lines: string[] = []
    const D = scoped(kc, t.def as string, t.account, (l) => lines.push(l))
    expect(await D.get(SVC, ACC)).toBe(S1)
    expect(kc.data.has(`${SVC}\u0000${ACC}`)).toBe(false)
    expect(kc.data.size).toBe(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('peer')
    expect(lines[0]).toContain('"work"')
    expect(lines.join('\n')).not.toContain(S1)
    expect(await D.get(SVC, ACC)).toBe(S1) // now from its own item: no second line
    expect(lines).toHaveLength(1)
  })
  test('with no default home yet, a non-default home never reads, moves or deletes the legacy item; the default home made later still moves it', async () => {
    const t = setup(false)
    const kc = sharedKeychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    const A = scoped(kc, t.a, t.account)
    expect(await A.get(SVC, ACC)).toBeUndefined()
    await A.delete(SVC, ACC)
    expect(kc.data.get(`${SVC}\u0000${ACC}`)).toBe(S1)
    const def = dir('acct/.config/talos/app') // created afterwards
    expect(await scoped(kc, def, t.account).get(SVC, ACC)).toBe(S1)
    expect(kc.data.has(`${SVC}\u0000${ACC}`)).toBe(false)
  })
  test('no account home known: nothing is moved', async () => {
    const t = setup(true)
    const kc = sharedKeychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    expect(await scoped(kc, t.def as string, null).get(SVC, ACC)).toBeUndefined()
    expect(kc.data.size).toBe(1)
  })
  test('a secret that appears just before the write is not overwritten, and the legacy item stays', async () => {
    const t = setup(true)
    const kc = sharedKeychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    const D = scoped(kc, t.def as string, t.account)
    const ns = `${homeScopedService(SVC, t.def as string)}\u0000${ACC}`
    const realGet = kc.get
    let legacyReads = 0
    kc.get = async (s: string, a: string) => {
      const v = await realGet(s, a)
      if (s === SVC && ++legacyReads === 1) kc.data.set(ns, S2) // another process links in between
      return v
    }
    expect(await D.get(SVC, ACC)).toBe(S2)
    expect(kc.data.get(ns)).toBe(S2)
    expect(kc.data.get(`${SVC}\u0000${ACC}`)).toBe(S1)
  })
  test('both homes exist: the non-default home never sees or touches the default home legacy secret', async () => {
    const t = setup(true)
    const kc = sharedKeychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    const B = scoped(kc, t.b, t.account)
    expect(await B.get(SVC, ACC)).toBeUndefined()
    expect(kc.data.get(`${SVC}\u0000${ACC}`)).toBe(S1)
    await B.set(SVC, ACC, S2)
    await B.delete(SVC, ACC)
    expect(kc.data.get(`${SVC}\u0000${ACC}`)).toBe(S1) // B's delete left it
    const D = scoped(kc, t.def as string, t.account)
    expect(await D.get(SVC, ACC)).toBe(S1) // the default home still gets its own
  })
  test('a delete that fails after the write loses nothing', async () => {
    const t = setup(true)
    const kc = sharedKeychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    kc.failDelete = true
    const A = scoped(kc, t.def as string, t.account)
    expect(await A.get(SVC, ACC)).toBe(S1)
    expect(kc.data.size).toBe(2) // in both places
    expect(await A.get(SVC, ACC)).toBe(S1)
  })
  test('removing on the default home also clears the legacy item, so it does not come back', async () => {
    const t = setup(true)
    const kc = sharedKeychain()
    kc.data.set(`${SVC}\u0000${ACC}`, S1)
    const D = scoped(kc, t.def as string, t.account)
    await D.delete(SVC, ACC)
    expect(kc.data.size).toBe(0)
    expect(await D.get(SVC, ACC)).toBeUndefined()
  })
})

describe('a home that is a symlink swapped mid-call', () => {
  test('pointing it at the default folder during a store read never moves the legacy item into another home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ks-race-'))
    try {
      const account = join(root, 'acct')
      const def = join(account, '.config', 'talos', 'app')
      mkdirSync(def, { recursive: true })
      const y = join(root, 'y')
      mkdirSync(y)
      const x = join(root, 'x')
      symlinkSync(y, x)
      const data = new Map<string, string>([[`${SVC}\u0000${ACC}`, S1]])
      let first = true
      const inner: SecretStore = {
        backend: 'secret_service',
        strength: 'os_keyring',
        async get(s, a) {
          // the agent flips its home's link to the default folder while the first (subprocess) read is in flight
          if (first) {
            first = false
            unlinkSync(x)
            symlinkSync(def, x)
          }
          return data.get(`${s}\u0000${a}`)
        },
        async set(s, a, v) {
          data.set(`${s}\u0000${a}`, v)
        },
        async delete(s, a) {
          data.delete(`${s}\u0000${a}`)
        },
      } as SecretStore
      const st = homeScopedStore(inner, x, { kind: 'peer', account })
      expect(await st.get(SVC, ACC)).toBeUndefined()
      expect(data.get(`${SVC}\u0000${ACC}`)).toBe(S1) // the legacy item is untouched
      expect(data.has(`${homeScopedService(SVC, y)}\u0000${ACC}`)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
