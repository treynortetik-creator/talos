// SecretStore.has(): is the item there, asked WITHOUT reading its value (`talos-app facts` uses nothing else). It never writes, moves
// or copies, and "could not tell" is undefined, never a guess.
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretStore } from '@talos-app/protocol'
import { homeScopedStore } from '../src/secrets/home-scope.ts'
import {
  fileSecretStore,
  macosKeychainStore,
  type SecretSpawn,
  secretServiceStore,
  unavailableStore,
} from '../src/secrets/store.ts'
import { tempHome } from './helpers.ts'

const spawnOf = (answer: { code: number; stdout?: string; stderr?: string } | Error) => {
  const calls: string[][] = []
  const spawn: SecretSpawn = async (argv) => {
    calls.push(argv)
    if (answer instanceof Error) throw answer
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { spawn, calls }
}

describe('macOS Keychain', () => {
  test('find-generic-password WITHOUT -w: 0 is yes, 44 is no, anything else is "could not tell"', async () => {
    for (const [code, want] of [
      [0, true],
      [44, false],
      [36, undefined],
      [1, undefined],
    ] as const) {
      const { spawn, calls } = spawnOf({ code, stdout: 'password: "SHOULD-NEVER-BE-ASKED"' })
      expect(await macosKeychainStore(spawn).has('com.talos.app.peer', 'peer:work'), String(code)).toBe(want)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual([
        '/usr/bin/security',
        'find-generic-password',
        '-s',
        'com.talos.app.peer',
        '-a',
        'peer:work',
      ])
      expect(calls[0]).not.toContain('-w')
    }
  })
  test('a name that could be parsed as more than a name is refused', async () => {
    await expect(macosKeychainStore(spawnOf({ code: 0 }).spawn).has('a b', 'x')).rejects.toThrow()
  })
})

describe('Secret Service', () => {
  const item = "([objectpath '/org/freedesktop/secrets/collection/login/5'], @ao [])"
  test('SearchItems over D-Bus through gdbus, never secret-tool', async () => {
    const yes = spawnOf({ code: 0, stdout: `${item}\n` })
    expect(await secretServiceStore(yes.spawn).has('com.talos.app.peer', 'peer:work')).toBe(true)
    const argv = yes.calls[0] as string[]
    expect(argv[0]).toBe('gdbus')
    expect(argv).toContain('org.freedesktop.Secret.Service.SearchItems')
    expect(argv).toContain('--timeout')
    expect(argv.join(' ')).toContain("{'service': 'com.talos.app.peer', 'account': 'peer:work'}")
    for (const c of yes.calls) expect(c.join(' ')).not.toContain('secret-tool')
    expect(
      await secretServiceStore(
        spawnOf({ code: 0, stdout: "(@ao [], [objectpath '/org/freedesktop/secrets/collection/login/5'])" }).spawn,
      ).has('s', 'a'),
    ).toBe(true)
  })
  test('an empty answer is no; an error, a refusal, garbage or a spawn that throws is "could not tell"', async () => {
    expect(await secretServiceStore(spawnOf({ code: 0, stdout: '(@ao [], @ao [])\n' }).spawn).has('s', 'a')).toBe(false)
    for (const a of [{ code: 1, stderr: 'Error' }, { code: -1 }, { code: 0, stdout: 'banana' }, new Error('no gdbus')])
      expect(await secretServiceStore(spawnOf(a).spawn).has('s', 'a'), JSON.stringify(a)).toBeUndefined()
  })
})

describe('0600 file store', () => {
  const store = () => {
    const dir = join(realpathSync(tempHome('talos-has-')), 'secrets')
    mkdirSync(dir, { mode: 0o700 })
    return { dir, s: fileSecretStore(dir) }
  }
  test('the item\'s path is looked at and nothing is opened: an unreadable file is still "there"', async () => {
    const { dir, s } = store()
    await s.set('com.talos.app.peer', 'peer:work', 'a-secret')
    expect(await s.has('com.talos.app.peer', 'peer:work')).toBe(true)
    expect(await s.has('com.talos.app.peer', 'peer:other')).toBe(false)
    for (const f of require('node:fs').readdirSync(dir)) chmodSync(join(dir, f), 0)
    expect(await s.has('com.talos.app.peer', 'peer:work')).toBe(true)
    await expect(s.get('com.talos.app.peer', 'peer:work')).rejects.toThrow() // while a read would fail
  })
  test('no secrets folder: no; a folder others can open: could not tell', async () => {
    const dir = join(realpathSync(tempHome('talos-has-')), 'none')
    expect(await fileSecretStore(dir).has('s', 'a')).toBe(false)
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, 'x'), '')
    expect(await fileSecretStore(dir).has('s', 'a')).toBeUndefined()
  })
  test('has() makes no folder and no file', async () => {
    const root = realpathSync(tempHome('talos-has-'))
    await fileSecretStore(join(root, 'secrets')).has('s', 'a')
    expect(require('node:fs').readdirSync(root)).toEqual([])
  })
})

describe('home-scoped store', () => {
  const raw = (items: Record<string, boolean | undefined>) => {
    const asked: string[] = []
    const store: SecretStore = {
      backend: 'secret_service',
      strength: 'os_keyring',
      get: async () => {
        throw new Error('has() must not read a value')
      },
      set: async () => {
        throw new Error('has() must not write')
      },
      delete: async () => {
        throw new Error('has() must not delete')
      },
      has: async (service) => {
        asked.push(service)
        const key = Object.keys(items).find((k) => service === k || service.startsWith(`${k}.`))
        return key === undefined ? false : items[key]
      },
    }
    return { store, asked }
  }
  const home = () => realpathSync(tempHome('talos-has-'))

  test("the home's own item first; found, nothing else is asked, nothing is read, moved or copied", async () => {
    const r = raw({ 'com.talos.app.peer': true })
    const s = homeScopedStore(r.store, home(), { kind: 'peer', account: null })
    expect(await s.has('com.talos.app.peer', 'peer:work')).toBe(true)
    expect(r.asked).toHaveLength(1)
    expect(r.asked[0]).toMatch(/^com\.talos\.app\.peer\.[0-9a-f]{16}$/)
  })
  test('then the legacy item, only when this home may take or copy it', async () => {
    // the legacy item exists (answered for the bare service name only)
    const legacyOnly = (): SecretStore => {
      const r = raw({})
      return { ...r.store, has: async (service) => service === 'com.talos.app.peer' }
    }
    const copyable = homeScopedStore(legacyOnly(), home(), { kind: 'peer', account: null, copyLegacyFor: () => true })
    expect(await copyable.has('com.talos.app.peer', 'peer:work')).toBe(true)
    const notOurs = homeScopedStore(legacyOnly(), home(), { kind: 'peer', account: null, copyLegacyFor: () => false })
    expect(await notOurs.has('com.talos.app.peer', 'peer:work')).toBe(false)
    const plain = homeScopedStore(legacyOnly(), home(), { kind: 'peer', account: null })
    expect(await plain.has('com.talos.app.peer', 'peer:work')).toBe(false)
  })
  test('"could not tell" about the home\'s own item is "could not tell"', async () => {
    const r = raw({ 'com.talos.app.peer': undefined })
    expect(
      await homeScopedStore(r.store, home(), { kind: 'peer', account: null }).has('com.talos.app.peer', 'peer:work'),
    ).toBeUndefined()
  })
  test('a home that is not there cannot be named: refused, as every other call is', async () => {
    const r = raw({})
    await expect(
      homeScopedStore(r.store, join(home(), 'gone'), { kind: 'peer', account: null }).has('s', 'a'),
    ).rejects.toThrow()
  })
  test('the per-home file store is returned as it is, with its own has()', async () => {
    const f = fileSecretStore(join(home(), 'secrets'))
    expect(homeScopedStore(f, home(), { kind: 'peer' })).toBe(f)
  })
})

describe('an unusable store', () => {
  test('says why, as its other calls do', async () => {
    await expect(unavailableStore('file_0600', 'nothing chosen').has('s', 'a')).rejects.toThrow('nothing chosen')
  })
})
