// The real runner against a real macOS keychain: a throwaway one made for this file, never the login keychain. Every
// command is pointed at that file by the spawn wrapper below, which also refuses any command it does not know, so a
// change to the runner cannot reach another keychain through this test.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bunKeychainSpawn,
  KEYCHAIN_SERVICE,
  type KeychainRunner,
  type KeychainSpawn,
  ServerSecrets,
  securityRunner,
} from '../../src/apps/keychain.ts'

const onMac = process.platform === 'darwin'
const SECURITY = '/usr/bin/security'
const ACCT = `${'a'.repeat(16)}/oauth`
const OTHER = `${'b'.repeat(16)}/config`
const KNOWN = ['add-generic-password', 'find-generic-password', 'delete-generic-password']

let dir = ''
let kc = ''
const argvSeen: string[][] = []

/** Same as the real spawn, with the throwaway keychain appended to every keychain command. */
const tempKeychainSpawn: KeychainSpawn = async (argv, stdin) => {
  argvSeen.push(argv)
  if (argv[0] !== SECURITY) throw new Error(`unexpected program ${argv[0]}`)
  if (argv[1] === '-i') {
    const lines = (stdin ?? '').split('\n').filter((l) => l !== '')
    for (const l of lines)
      if (!KNOWN.includes(l.split(' ')[0] as string)) throw new Error('unexpected command on stdin')
    return bunKeychainSpawn(argv, `${lines.map((l) => `${l} ${kc}`).join('\n')}\n`)
  }
  // the throwaway keychain stands in for the default one
  if (argv[1] === 'default-keychain') return { code: 0, stdout: `    "${kc}"\n` }
  if (argv[1] === 'dump-keychain') {
    if (argv.length !== 3 || argv[2] !== kc) throw new Error('the listing must name only the throwaway keychain')
    return bunKeychainSpawn(argv, stdin)
  }
  if (!KNOWN.includes(argv[1] as string)) throw new Error(`unexpected command ${argv[1]}`)
  // the sweep's lookup of the service alone must name the keychain itself (never the whole search list): passed as is
  if (argv[1] === 'find-generic-password' && !argv.includes('-a')) {
    if (argv.at(-1) !== kc || argv.includes('-w')) throw new Error('the lookup must name only the throwaway keychain')
    return bunKeychainSpawn(argv, stdin)
  }
  return bunKeychainSpawn([...argv, kc], stdin)
}

/** Values for these tests are random, so nothing in the file resembles a real secret. */
const secretOf = (chars: number) =>
  randomBytes(Math.ceil(chars * 0.75))
    .toString('base64url')
    .slice(0, chars)

async function itemsInKeychain(): Promise<number> {
  const r = await bunKeychainSpawn([SECURITY, 'dump-keychain', kc])
  return r.stdout.split('\n').filter((l) => l.includes(`"svce"<blob>="${KEYCHAIN_SERVICE}"`)).length
}

describe.skipIf(!onMac)('the real runner against a throwaway keychain', () => {
  let runner: KeychainRunner
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'talos-kc-'))
    kc = join(dir, 'throwaway.keychain-db')
    const made = await bunKeychainSpawn([SECURITY, 'create-keychain', '-p', 'x', kc])
    if (made.code !== 0) throw new Error('could not create the throwaway keychain')
    await bunKeychainSpawn([SECURITY, 'unlock-keychain', '-p', 'x', kc])
    runner = securityRunner(tempKeychainSpawn)
  })
  afterAll(async () => {
    if (kc) await bunKeychainSpawn([SECURITY, 'delete-keychain', kc])
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  // 2,247 characters is the last that stays one item and 2,248 the first that is chunked.
  // Up to about 2,900 characters fits one `security -i` line (it splits near 4 KB); from 3,100 up the line was cut and nothing was stored.
  for (const chars of [10, 2000, 2247, 2248, 2900, 3100, 3500, 4100, 6000, 10000, 40000]) {
    it(`a ${chars}-character value reads back exactly`, async () => {
      const secret = secretOf(chars)
      await runner.write(ACCT, secret)
      expect(await runner.read(ACCT)).toBe(secret)
      // a second runner, as a restarted bridge would have
      expect(await securityRunner(tempKeychainSpawn).read(ACCT)).toBe(secret)
    })
  }

  it('a value with multi-byte characters reads back exactly', async () => {
    const secret = `${secretOf(1500)}é中\u{1f511}${secretOf(5000)}`
    await runner.write(ACCT, secret)
    expect(await runner.read(ACCT)).toBe(secret)
  })

  it('the value never appears in any command line', async () => {
    argvSeen.length = 0
    const secret = secretOf(6000)
    await runner.write(OTHER, secret)
    await runner.read(OTHER)
    const argv = JSON.stringify(argvSeen)
    expect(argv).not.toContain(secret.slice(0, 40))
    expect(argv).not.toContain(Buffer.from(secret).toString('base64url').slice(0, 40))
  })

  it('writing again replaces the value, and a long one leaves nothing behind when it is replaced or deleted', async () => {
    await runner.write(OTHER, secretOf(9000))
    const second = secretOf(7000)
    await runner.write(OTHER, second)
    expect(await runner.read(OTHER)).toBe(second)
    const short = secretOf(50)
    await runner.write(OTHER, short)
    expect(await runner.read(OTHER)).toBe(short)
    await runner.write(OTHER, secretOf(12000))
    await runner.delete(OTHER)
    await runner.delete(ACCT)
    expect(await runner.read(OTHER)).toBeUndefined()
    expect(await runner.read(ACCT)).toBeUndefined()
    expect(await itemsInKeychain()).toBe(0)
  })

  it('delete and logout remove pieces no manifest names, and nothing else', async () => {
    const put = async (service: string, account: string) => {
      const r = await tempKeychainSpawn(
        [SECURITY, '-i'],
        `add-generic-password -U -s ${service} -a ${account} -w v1.AAAA\n`,
      )
      expect(r.code).toBe(0)
    }
    const id = 'f'.repeat(16)
    const secrets = new ServerSecrets(runner)
    await secrets.saveOauth(id, { tokens: { access_token: secretOf(9000) } })
    await secrets.saveConfig(id, { type: 'http', url: 'https://x.example.com' })
    for (const kind of ['oauth', 'config']) {
      await put(KEYCHAIN_SERVICE, `${id}/${kind}.aaaaaaaa.0`) // left by a failed write
      await put(KEYCHAIN_SERVICE, `${id}/${kind}.bbbbbbbb.3`) // left by a failed delete
    }
    // look alike, another account, another service: all stay
    const stay = [`${id}/oauth.1.0`, `${id}/oauth.aaaaaaaa.0.0`, `${'9'.repeat(16)}/oauth.aaaaaaaa.0`]
    for (const a of stay) await put(KEYCHAIN_SERVICE, a)
    await put('another-service', `${id}/oauth.aaaaaaaa.5`)
    await secrets.logout(id)
    const dump = (await bunKeychainSpawn([SECURITY, 'dump-keychain', kc])).stdout
    const accounts = [...dump.matchAll(/"acct"<blob>="([^"]*)"/g)].map((m) => m[1]).sort()
    expect(accounts).toEqual([...stay, `${id}/oauth.aaaaaaaa.5`].sort())
    for (const a of stay)
      await bunKeychainSpawn([SECURITY, 'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', a, kc])
    await bunKeychainSpawn([
      SECURITY,
      'delete-generic-password',
      '-s',
      'another-service',
      '-a',
      `${id}/oauth.aaaaaaaa.5`,
      kc,
    ])
    // about 30 `security` runs: a gate that loads every core makes 5 s too short for them, not the code wrong
  }, 30_000)

  // An empty listing is unknown to the sweep unless a lookup of the service finds nothing of ours left. Here the
  // throwaway keychain holds nothing but Talos's own pieces, so after the named deletes it is truly empty: that real
  // state must pass, not be retried into a failure.
  it('a keychain holding only Talos pieces lists truly empty after the named deletes, and delete and logout pass', async () => {
    const raw = async () => (await bunKeychainSpawn([SECURITY, 'dump-keychain', kc])).stdout
    expect(await raw()).toBe('') // nothing at all in the keychain, of any service
    const id = 'e'.repeat(16)
    const secrets = new ServerSecrets(runner)
    await secrets.saveOauth(id, { tokens: { access_token: secretOf(9000) } }) // a manifest and its chunks
    await secrets.saveConfig(id, { type: 'http', url: 'https://x.example.com' })
    expect(await itemsInKeychain()).toBeGreaterThan(2)
    await secrets.logout(id)
    expect(await raw()).toBe('')
    // and a plain delete of a chunked value that is the only thing in the keychain
    await runner.write(ACCT, secretOf(9000))
    await runner.delete(ACCT)
    expect(await raw()).toBe('')
    expect(await runner.read(ACCT)).toBeUndefined()
  }, 30_000)
})
