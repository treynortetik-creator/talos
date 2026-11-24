// The plain re-link words: `peer list` under a peer whose secret is missing, and the doctor's `linked agents` row.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SecretStore } from '@talos-app/protocol'
import { runCli } from '../../src/cli.ts'
import { ConfigFile } from '../../src/config-file.ts'
import { PEER_SECRET_SERVICE, peerSecretAccount } from '../../src/peer/records.ts'
import { linkedAgentsCheck, relinkLine } from '../../src/peer/relink.ts'
import { ACCOUNT_HOME_TEST } from '../../src/talos.ts'
import { type Harness, startHarness } from '../helpers.ts'
import { FAKE_SECRET, memorySecrets } from './helpers.ts'

const made: string[] = []
let h: Harness | undefined
const wasAccount = ACCOUNT_HOME_TEST.home
afterEach(async () => {
  await h?.stop()
  h = undefined
  ACCOUNT_HOME_TEST.home = wasAccount
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const URL_OF = (n: string) => `https://${n}-inbox.example.com/hook/peer/cn_fakefakefakefakefake0`
const setPeers = (home: string, names: string[]) =>
  new ConfigFile(join(home, 'config.json')).update((c) => ({
    ...c,
    peers: names.map((name) => ({ name, url: URL_OF(name), daily_cap: 50 })),
  }))
const envOf = (home: string) => ({ home }) as never

async function cli(argv: string[], secrets: SecretStore) {
  const out: string[] = []
  const err: string[] = []
  const code = await runCli(
    argv,
    {
      isTerminal: true,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async () => '',
      readSecret: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    },
    { TALOS_APP_HOME: (h as Harness).home, TALOS_APP_RELAY_URL: (h as Harness).relay.httpUrl },
    { peer: { secrets }, wsl: { isWsl: false } as never },
  )
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('relinkLine', () => {
  test('is the fixed text for a valid name and refuses anything else', () => {
    expect(relinkLine('atlas')).toBe(
      'link to atlas needs re-linking: run talos-app peer remove atlas here, then ask atlas for a new link code (talos-app peer link on that Talos) and run talos-app peer accept <code> --name atlas.',
    )
    for (const bad of ['Atlas', 'a b', 'x; rm -rf /', 'owner', '']) expect(() => relinkLine(bad), bad).toThrow()
  })
})

describe('peer list', () => {
  test('a configured peer with no secret gets the line under its row; with a secret, none', async () => {
    h = await startHarness({ startBridge: false })
    const secrets = memorySecrets()
    setPeers(h.home, ['atlas'])
    const none = await cli(['peer', 'list'], secrets)
    expect(none.code, none.err).toBe(0)
    const lines = none.out.split('\n')
    const at = lines.findIndex((l) => l.startsWith('atlas') && l.includes('secret no'))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(lines[at + 1]?.trim()).toBe(relinkLine('atlas'))
    secrets.data.set(`${PEER_SECRET_SERVICE}\u0000${peerSecretAccount('atlas')}`, FAKE_SECRET)
    const have = await cli(['peer', 'list'], secrets)
    expect(have.out).toContain('secret yes')
    expect(have.out).not.toContain('re-linking')
    expect(have.out).not.toContain(FAKE_SECRET)
  })

  test('an unreadable key store is not called a missing link', async () => {
    h = await startHarness({ startBridge: false })
    setPeers(h.home, ['atlas'])
    const broken: SecretStore = {
      ...memorySecrets(),
      get: async () => {
        throw new Error('locked')
      },
    }
    const r = await cli(['peer', 'list'], broken)
    expect(r.out).toContain('secret unreadable')
    expect(r.out).not.toContain('re-linking')
  })
})

describe('doctor: linked agents', () => {
  // a home with a real config.json: the harness makes one
  const home = async () => {
    h = await startHarness({ startBridge: false })
    return h.home
  }
  const put = (s: ReturnType<typeof memorySecrets>, n: string) =>
    s.data.set(`${PEER_SECRET_SERVICE}\u0000${peerSecretAccount(n)}`, FAKE_SECRET)

  test('no peers: ok, none (the store is not even opened)', async () => {
    const d = await home()
    setPeers(d, [])
    expect(await linkedAgentsCheck(envOf(d), {})).toEqual({ level: 'ok', name: 'linked agents', detail: 'none' })
  })

  test('every secret there: ok with the count', async () => {
    const d = await home()
    setPeers(d, ['atlas', 'work'])
    const s = memorySecrets()
    put(s, 'atlas')
    put(s, 'work')
    const c = await linkedAgentsCheck(envOf(d), { secrets: s })
    expect(c).toEqual({ level: 'ok', name: 'linked agents', detail: '2 linked agents' })
  })

  test('missing ones: warn, one line each, no secret anywhere', async () => {
    const d = await home()
    setPeers(d, ['atlas', 'work', 'zed'])
    const s = memorySecrets()
    put(s, 'work')
    const c = await linkedAgentsCheck(envOf(d), { secrets: s })
    expect(c?.level).toBe('warn')
    expect(c?.detail).toBe(`${relinkLine('atlas')} ${relinkLine('zed')}`)
    expect(JSON.stringify(c)).not.toContain(FAKE_SECRET)
  })

  test('a store that throws: warn with one plain line', async () => {
    const d = await home()
    setPeers(d, ['atlas'])
    const broken: SecretStore = {
      ...memorySecrets(),
      get: async () => {
        throw new Error('locked')
      },
    }
    const c = await linkedAgentsCheck(envOf(d), { secrets: broken })
    expect(c?.level).toBe('warn')
    expect(c?.detail).toContain('key store could not be read')
    expect(c?.detail).toContain('locked')
  })

  test('a non-default home with a peer entry and a legacy item while the default home exists: ok (copied), legacy untouched', async () => {
    const account = mkdtempSync(join(realpathSync(tmpdir()), 'acct-'))
    made.push(account)
    mkdirSync(join(account, '.config', 'talos', 'app'), { recursive: true })
    ACCOUNT_HOME_TEST.home = account
    const d = await home()
    setPeers(d, ['atlas'])
    const s = memorySecrets()
    ;(s as { backend: string }).backend = 'macos_keychain'
    const legacy = `${PEER_SECRET_SERVICE}\u0000${peerSecretAccount('atlas')}`
    s.data.set(legacy, FAKE_SECRET)
    const c = await linkedAgentsCheck(envOf(d), { secrets: s })
    expect(c?.level).toBe('ok')
    expect(s.data.get(legacy)).toBe(FAKE_SECRET) // a copy never deletes the legacy item
    expect(JSON.stringify(c)).not.toContain(FAKE_SECRET)
  })

  test('doctor --json carries the row', async () => {
    h = await startHarness({ startBridge: false })
    setPeers(h.home, ['atlas'])
    const r = await cli(['doctor', '--json', '--agent-dir', h.home], memorySecrets())
    const row = (JSON.parse(r.out) as { checks: { name: string; level: string; detail: string }[] }).checks.find(
      (c) => c.name === 'linked agents',
    )
    expect(row?.level).toBe('warn')
    expect(row?.detail).toContain(relinkLine('atlas'))
  })
})
