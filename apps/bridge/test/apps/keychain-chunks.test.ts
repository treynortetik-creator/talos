// Values longer than one `security -i` line are stored as chunks behind a manifest. These tests drive the real runner
// against a fake `security` that cuts a stdin line at 4 KB the way the real one does, so they run on any machine.
// keychain-real.test.ts runs the same runner against a real throwaway keychain on a Mac.
import { describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { KeychainError, type KeychainSpawn, ServerSecrets, securityRunner } from '../../src/apps/keychain.ts'

const ACCT = `${'c'.repeat(16)}/oauth`
const SECURITY_LINE_LIMIT = 4096
const secretOf = (chars: number) =>
  randomBytes(Math.ceil(chars * 0.75))
    .toString('base64url')
    .slice(0, chars)

class FakeSecurity {
  readonly items = new Map<string, string>()
  readonly calls: Array<{ argv: string[]; stdin: string | undefined }> = []
  readonly lineLengths: number[] = []
  /** Return true to make a write to this account fail with exit 1 (nothing stored). */
  failPut: (account: string) => boolean = () => false
  /** Return true to accept the write with exit 0 but store nothing. */
  dropPut: (account: string) => boolean = () => false
  failDelete: (account: string) => boolean = () => false
  /** Items of other services, listed by `dump-keychain` and never reached by the runner's service-scoped commands. */
  readonly foreign = new Set<string>()
  failDump = false
  /** How many of the next listings print nothing and exit 0, as a real one can while another process writes the keychain. */
  emptyDumps = 0
  /** What a lookup of the service alone answers instead of the truth: a timeout, or another exit. */
  lookupOverride: { code: number; stdout: string; timedOut?: boolean } | undefined
  /** The listing runs past its time limit, as the real spawn reports it. */
  hangDump = false
  /** Finding the default keychain runs past its time limit, as the real spawn reports it. */
  hangDefault = false
  /** What `security default-keychain` prints. */
  defaultKeychainOut = '    "/fake.keychain-db"\n'
  readonly spawn: KeychainSpawn = async (argv, stdin) => {
    this.calls.push({ argv, stdin })
    if (argv[1] === 'default-keychain')
      return this.hangDefault ? { code: -1, stdout: '', timedOut: true } : { code: 0, stdout: this.defaultKeychainOut }
    if (argv[1] === '-i') {
      let code = 0
      for (const line of (stdin ?? '').split('\n')) {
        if (line === '') continue
        this.lineLengths.push(line.length)
        if (line.length >= SECURITY_LINE_LIMIT) return { code: 1, stdout: '' } // cut: the tail is an unknown command
        const m = /^add-generic-password -U -s \S+ -a (\S+) -w (\S+)$/.exec(line)
        if (!m) return { code: 1, stdout: '' }
        const acct = m[1] as string
        if (this.failPut(acct)) code = 1
        else if (!this.dropPut(acct)) this.items.set(acct, m[2] as string)
      }
      return { code, stdout: '' }
    }
    if (argv[1] === 'dump-keychain') {
      if (this.hangDump) return { code: -1, stdout: '', timedOut: true }
      if (this.failDump || argv[2] !== '/fake.keychain-db' || argv.length !== 3) return { code: 1, stdout: '' }
      if (this.emptyDumps > 0) {
        this.emptyDumps--
        return { code: 0, stdout: '' }
      }
      const block = (svc: string, acct: string) =>
        `keychain: "/fake.keychain-db"\nversion: 512\nclass: "genp"\nattributes:\n    "acct"<blob>="${acct}"\n    "svce"<blob>="${svc}"\n`
      const out = [
        ...[...this.items.keys()].map((a) => block('talos-app.direct', a)),
        ...[...this.foreign].map((a) => block('other-service', a)),
      ]
      return { code: 0, stdout: out.join('') }
    }
    // the service alone, no account: is any item of ours there at all (attributes only, never a value)
    if (argv[1] === 'find-generic-password' && !argv.includes('-a')) {
      if (argv.includes('-w') || argv.at(-1) !== '/fake.keychain-db') return { code: 1, stdout: '' }
      if (this.lookupOverride) return this.lookupOverride
      return this.items.size > 0 ? { code: 0, stdout: 'keychain: "/fake.keychain-db"\n' } : { code: 44, stdout: '' }
    }
    const acct = argv[argv.indexOf('-a') + 1] as string
    if (argv[1] === 'find-generic-password') {
      const v = this.items.get(acct)
      return v === undefined ? { code: 44, stdout: '' } : { code: 0, stdout: `${v}\n` }
    }
    if (argv[1] === 'delete-generic-password') {
      if (this.failDelete(acct)) return { code: 1, stdout: '' }
      return { code: this.items.delete(acct) ? 0 : 44, stdout: '' }
    }
    return { code: 1, stdout: '' }
  }
}

function setup() {
  const fake = new FakeSecurity()
  const problems: Array<{ message: string; fields: Record<string, unknown> }> = []
  const readable = { yes: true, asked: [] as string[] }
  const runner = securityRunner(fake.spawn, {
    onProblem: (message, fields) => problems.push({ message, fields }),
    keychainReadable: (path) => (readable.asked.push(path), readable.yes),
  })
  return { fake, runner, problems, readable }
}

describe('values longer than one security line', () => {
  it('round-trip through chunks, every stdin line stays under 3,100 characters, and no value is in argv', async () => {
    const { fake, runner } = setup()
    for (const chars of [2000, 2247, 2248, 3500, 6000, 10000, 40000]) {
      const secret = secretOf(chars)
      await runner.write(ACCT, secret)
      expect(await runner.read(ACCT)).toBe(secret)
    }
    expect(Math.max(...fake.lineLengths)).toBeLessThan(3100)
    for (const c of fake.calls) expect(c.argv.join(' ').length).toBeLessThan(200)
  })

  it('a short value is still one plain `v1.` item, so values written before still read', async () => {
    const { fake, runner } = setup()
    await runner.write(ACCT, 'short')
    expect([...fake.items.keys()]).toEqual([ACCT])
    expect(fake.items.get(ACCT)).toStartWith('v1.')
    fake.items.set(ACCT, `v1.${Buffer.from('written by the old runner').toString('base64url')}`)
    expect(await runner.read(ACCT)).toBe('written by the old runner')
  })

  it('a long value is a manifest plus chunks; replacing it leaves only the new set, and so does going back to short', async () => {
    const { fake, runner } = setup()
    await runner.write(ACCT, secretOf(8000)) // 10,667 encoded characters: four chunks of up to 2,997
    const first = [...fake.items.keys()].sort()
    expect(first.length).toBe(1 + 4)
    expect(fake.items.get(ACCT)).toMatch(/^v2\.[0-9a-f]{8}\.4\.[0-9a-f]{64}$/)
    const second = secretOf(8000)
    await runner.write(ACCT, second)
    const after = [...fake.items.keys()]
    expect(after.length).toBe(1 + 4)
    expect(after.filter((k) => first.includes(k))).toEqual([ACCT]) // no chunk of the first set survives
    expect(await runner.read(ACCT)).toBe(second)
    await runner.write(ACCT, 'short again')
    expect([...fake.items.keys()]).toEqual([ACCT])
    expect(await runner.read(ACCT)).toBe('short again')
  })

  it('delete removes the manifest and every chunk, and a missing item is not an error', async () => {
    const { fake, runner } = setup()
    await runner.write(ACCT, secretOf(20000))
    expect(fake.items.size).toBeGreaterThan(5)
    await runner.delete(ACCT)
    expect(fake.items.size).toBe(0)
    expect(await runner.read(ACCT)).toBeUndefined()
    await runner.delete(ACCT)
  })

  it('a delete that leaves a chunk behind fails loudly and is reported', async () => {
    const { fake, runner, problems } = setup()
    await runner.write(ACCT, secretOf(9000))
    fake.failDelete = (a) => a.endsWith('.2')
    await expect(runner.delete(ACCT)).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
  })

  it('logout still removes the config when removing the sign-in fails, and then says so', async () => {
    const { fake, runner } = setup()
    const secrets = new ServerSecrets(runner)
    const id = 'd'.repeat(16)
    await secrets.saveOauth(id, { tokens: { access_token: secretOf(9000) } })
    await secrets.saveConfig(id, { type: 'http', url: 'https://x.example.com' })
    fake.failDelete = (a) => a === `${id}/oauth`
    await expect(secrets.logout(id)).rejects.toBeInstanceOf(KeychainError)
    expect(await runner.read(`${id}/config`)).toBeUndefined()
  })

  it('characters outside ASCII survive', async () => {
    const { runner } = setup()
    const secret = `${secretOf(2000)}é中\u{1f511}${secretOf(4000)}`
    await runner.write(ACCT, secret)
    expect(await runner.read(ACCT)).toBe(secret)
  })
})

describe('a write that does not hold', () => {
  it('a security tool that says yes but stores nothing is an error and a problem report, for short and long values', async () => {
    for (const chars of [20, 9000]) {
      const { fake, runner, problems } = setup()
      fake.dropPut = () => true
      await expect(runner.write(ACCT, secretOf(chars))).rejects.toBeInstanceOf(KeychainError)
      expect(problems.length).toBeGreaterThan(0)
      expect(await runner.read(ACCT)).toBeUndefined()
    }
  })

  it('a manifest that names more chunks than the cap is refused before any chunk is read', async () => {
    const { fake, runner } = setup()
    fake.items.set(ACCT, `v2.${'0'.repeat(8)}.257.${'0'.repeat(64)}`)
    await expect(runner.read(ACCT)).rejects.toBeInstanceOf(KeychainError)
    expect(fake.calls.filter((c) => c.argv[1] === 'find-generic-password').length).toBe(1)
  })

  it('a chunk that fails part-way leaves the old value whole and removes the new chunks', async () => {
    const { fake, runner, problems } = setup()
    const old = secretOf(9000)
    await runner.write(ACCT, old)
    const before = new Map(fake.items)
    fake.failPut = (a) => a.endsWith('.2')
    await expect(runner.write(ACCT, secretOf(12000))).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
    expect(fake.items).toEqual(before)
    expect(await runner.read(ACCT)).toBe(old)
  })

  it('a failed manifest write leaves the old value whole', async () => {
    const { fake, runner } = setup()
    const old = secretOf(9000)
    await runner.write(ACCT, old)
    const before = new Map(fake.items)
    fake.failPut = (a) => a === ACCT
    await expect(runner.write(ACCT, secretOf(12000))).rejects.toBeInstanceOf(KeychainError)
    expect(await runner.read(ACCT)).toBe(old)
    expect(fake.items).toEqual(before) // the new chunks are gone too
  })

  it('a manifest that was accepted but not stored is an error, and a report', async () => {
    const { fake, runner, problems } = setup()
    fake.dropPut = (a) => a === ACCT
    await expect(runner.write(ACCT, secretOf(9000))).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
    expect(fake.items.size).toBe(0) // no chunk of the unsaved value is left
  })

  it('a step that fails after the value landed keeps the new value and still removes the old chunks', async () => {
    const { fake, runner } = setup()
    await runner.write(ACCT, secretOf(9000))
    const next = secretOf(9000)
    let manifestWrites = 0
    const spawn = fake.spawn
    // the manifest is stored, then the tool reports failure
    const flaky: KeychainSpawn = async (argv, stdin) => {
      const r = await spawn(argv, stdin)
      if (stdin?.includes(`-a ${ACCT} -w v2.`) && ++manifestWrites === 1) return { code: 1, stdout: '' }
      return r
    }
    await securityRunner(flaky).write(ACCT, next)
    expect(await runner.read(ACCT)).toBe(next)
    expect(fake.items.size).toBe(1 + 5)
  })

  it('when the keychain cannot be read after the manifest was written, nothing is deleted and the value survives', async () => {
    const { fake, runner, problems } = setup()
    const next = secretOf(9000)
    let manifestLanded = false
    const spawn = fake.spawn
    const locked: KeychainSpawn = async (argv, stdin) => {
      if (manifestLanded && argv[1] === 'find-generic-password' && argv.includes(ACCT)) return { code: 36, stdout: '' }
      const r = await spawn(argv, stdin)
      if (stdin?.includes(`-a ${ACCT} -w v2.`)) manifestLanded = true
      return r
    }
    await expect(
      securityRunner(locked, { onProblem: (message, fields) => problems.push({ message, fields }) }).write(ACCT, next),
    ).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBeGreaterThan(0)
    expect(fake.items.size).toBe(1 + 5) // the manifest and every new chunk are still there
    expect(await runner.read(ACCT)).toBe(next)
  })

  it('a chunk stored wrong is caught before the manifest points at it', async () => {
    const { fake, runner } = setup()
    const old = secretOf(9000)
    await runner.write(ACCT, old)
    const spawn = fake.spawn
    const bent: KeychainSpawn = async (argv, stdin) => {
      if (argv[1] === '-i' && stdin?.includes('.1 -w ')) return spawn(argv, stdin.replace(/(-w v1\.)(.)/, '$1_$2'))
      return spawn(argv, stdin)
    }
    await expect(securityRunner(bent).write(ACCT, secretOf(12000))).rejects.toBeInstanceOf(KeychainError)
    expect(await runner.read(ACCT)).toBe(old)
  })

  it('a locked keychain on write is an error and a report', async () => {
    const problems: string[] = []
    const r = securityRunner(async () => ({ code: 36, stdout: '' }), { onProblem: (m) => problems.push(m) })
    await expect(r.write(ACCT, secretOf(9000))).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
  })

  it('a report never carries the value or the account hash', async () => {
    const { fake, runner, problems } = setup()
    fake.dropPut = () => true
    const secret = secretOf(9000)
    await runner.write(ACCT, secret).catch(() => undefined)
    const text = JSON.stringify(problems)
    expect(text).not.toContain(secret.slice(0, 30))
    expect(text).not.toContain('c'.repeat(16))
    expect(problems[0]?.fields.item).toBe('oauth')
  })

  it('writes that overlap on one account end with one whole value and one chunk set', async () => {
    const { fake, runner } = setup()
    const a = secretOf(8000)
    const b = secretOf(8500)
    await Promise.all([runner.write(ACCT, a), runner.write(ACCT, b)])
    const got = await runner.read(ACCT)
    expect([a, b]).toContain(got as string)
    expect(fake.items.size).toBe(1 + 4)
  })
})

describe('a stored value that is damaged', () => {
  async function stored() {
    const s = setup()
    const secret = secretOf(9000)
    await s.runner.write(ACCT, secret)
    return { ...s, secret }
  }

  it('a missing chunk is an error and a report, not a short value', async () => {
    const { fake, runner, problems } = await stored()
    const chunk = [...fake.items.keys()].find((k) => k !== ACCT) as string
    fake.items.delete(chunk)
    await expect(runner.read(ACCT)).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
  })

  it('a changed chunk fails the hash', async () => {
    const { fake, runner } = await stored()
    const chunk = [...fake.items.keys()].find((k) => k !== ACCT) as string
    const v = fake.items.get(chunk) as string
    fake.items.set(chunk, `${v.slice(0, 10)}${v[10] === 'A' ? 'B' : 'A'}${v.slice(11)}`)
    await expect(runner.read(ACCT)).rejects.toBeInstanceOf(KeychainError)
  })

  it('a manifest that is not ours or names too many chunks is refused', async () => {
    const { fake, runner } = await stored()
    fake.items.set(ACCT, `v2.${'0'.repeat(8)}.99999.${'0'.repeat(64)}`)
    await expect(runner.read(ACCT)).rejects.toBeInstanceOf(KeychainError)
    expect(fake.calls.filter((c) => c.argv[1] === 'find-generic-password').length).toBeLessThan(40)
  })

  it('a chunk set replaced by another process between the two reads is read again, not called damaged', async () => {
    const { fake, runner } = setup()
    const secret = secretOf(9000)
    await runner.write(ACCT, secret)
    const oldKeys = [...fake.items.keys()]
    const oldSnapshot = new Map(fake.items)
    const next = secretOf(7000)
    // the other process finishes its replacement while this read is in flight
    let swapped = false
    const spawn = fake.spawn
    const racing: KeychainSpawn = async (argv, stdin) => {
      if (
        !swapped &&
        argv[1] === 'find-generic-password' &&
        argv.includes(oldKeys.find((k) => k.endsWith('.1')) as string)
      ) {
        swapped = true
        await securityRunner(fake.spawn).write(ACCT, next)
      }
      return spawn(argv, stdin)
    }
    expect(oldSnapshot.size).toBeGreaterThan(1)
    expect(await securityRunner(racing).read(ACCT)).toBe(next)
  })
})

describe('delete and logout sweep every piece of the account', () => {
  const OTHER = `${'d'.repeat(16)}/oauth`
  const orphans = [`${ACCT}.aaaaaaaa.0`, `${ACCT}.aaaaaaaa.1`, `${ACCT}.bbbbbbbb.0`, `${ACCT}.bbbbbbbb.7`]
  // names that start like a piece of ACCT but are not one, plus another account's pieces and another service's item
  const survivors = [
    `${ACCT}.1.0`,
    `${ACCT}.aaaaaaaa`,
    `${ACCT}.aaaaaaaa.0.0`,
    `${ACCT}x.aaaaaaaa.0`,
    `${OTHER}.aaaaaaaa.0`,
  ]

  function plant(fake: FakeSecurity) {
    for (const a of orphans) fake.items.set(a, 'v1.AAAA')
    for (const a of survivors) fake.items.set(a, 'v1.BBBB')
    fake.foreign.add(`${ACCT}.aaaaaaaa.9`)
  }

  it('removes pieces left by earlier failed writes, and only the pieces of this account', async () => {
    const { fake, runner } = setup()
    await runner.write(ACCT, secretOf(9000))
    plant(fake)
    await runner.delete(ACCT)
    expect([...fake.items.keys()].sort()).toEqual([...survivors].sort())
    expect(fake.foreign.has(`${ACCT}.aaaaaaaa.9`)).toBe(true)
    // nothing outside this account's own pieces was even asked to be deleted
    const asked = fake.calls
      .filter((c) => c.argv[1] === 'delete-generic-password')
      .map((c) => c.argv[c.argv.indexOf('-a') + 1])
    expect(asked).not.toContain(`${ACCT}.aaaaaaaa.9`)
  })

  it('sweeps when the account holds a short value or nothing at all', async () => {
    for (const first of ['short', undefined]) {
      const { fake, runner } = setup()
      if (first) await runner.write(ACCT, first)
      plant(fake)
      await runner.delete(ACCT)
      expect([...fake.items.keys()].sort()).toEqual([...survivors].sort())
    }
  })

  it('logout sweeps both the sign-in and the settings', async () => {
    const { fake, runner } = setup()
    const secrets = new ServerSecrets(runner)
    const id = 'e'.repeat(16)
    await secrets.saveOauth(id, { tokens: { access_token: secretOf(9000) } })
    await secrets.saveConfig(id, { type: 'http', url: 'https://x.example.com', headers: { a: secretOf(5000) } })
    for (const kind of ['oauth', 'config']) fake.items.set(`${id}/${kind}.aaaaaaaa.0`, 'v1.AAAA')
    await secrets.logout(id)
    expect([...fake.items.keys()]).toEqual([])
  })

  it('listing the items never asks for secrets, and names only the default keychain', async () => {
    const { fake, runner } = setup()
    await runner.delete(ACCT)
    const dump = fake.calls.filter((c) => c.argv[1] === 'dump-keychain')
    expect(dump.length).toBe(1)
    expect(dump[0]?.argv).toEqual(['/usr/bin/security', 'dump-keychain', '/fake.keychain-db'])
  })

  it('a listing that runs out of time is an error and one report', async () => {
    const { fake, runner, problems } = setup()
    plant(fake)
    fake.hangDump = true
    await expect(runner.delete(ACCT)).rejects.toThrow('timed out')
    expect(problems.length).toBe(1)
    expect(problems[0]?.fields.step).toBe('sweep')
  })

  it('finding the default keychain that runs out of time is an error and one report, and nothing is listed', async () => {
    const { fake, runner, problems } = setup()
    plant(fake)
    fake.hangDefault = true
    await expect(runner.delete(ACCT)).rejects.toThrow('timed out')
    expect(problems.length).toBe(1)
    expect(problems[0]?.fields.step).toBe('sweep')
    expect(fake.calls.some((c) => c.argv[1] === 'dump-keychain')).toBe(false)
  })

  it('a default keychain that cannot be found is an error and one report, and nothing is listed', async () => {
    for (const out of ['', 'no quotes here\n', '    "relative/path.keychain-db"\n', '    "/a/b"\n    "/c/d"\n']) {
      const { fake, runner, problems } = setup()
      fake.defaultKeychainOut = out
      await expect(runner.delete(ACCT)).rejects.toBeInstanceOf(KeychainError)
      expect(problems.length).toBe(1)
      expect(fake.calls.some((c) => c.argv[1] === 'dump-keychain')).toBe(false)
    }
  })

  it('an empty listing is not taken for "no pieces": it is tried again, and the pieces still go', async () => {
    const { fake, runner, problems } = setup()
    await runner.write(ACCT, secretOf(9000))
    plant(fake)
    fake.emptyDumps = 1
    await runner.delete(ACCT)
    expect([...fake.items.keys()].sort()).toEqual([...survivors].sort())
    expect(fake.calls.filter((c) => c.argv[1] === 'dump-keychain').length).toBe(2)
    // the one lookup between the two listings names the service and the default keychain only: no account, no value
    const lookups = fake.calls.filter((c) => c.argv[1] === 'find-generic-password' && !c.argv.includes('-a'))
    expect(lookups.map((c) => c.argv)).toEqual([
      ['/usr/bin/security', 'find-generic-password', '-s', 'talos-app.direct', '/fake.keychain-db'],
    ])
    expect(problems).toEqual([])
  })

  it('a listing that stays empty while items of ours remain fails the delete, after the value and its named pieces went', async () => {
    const { fake, runner, problems } = setup()
    await runner.write(ACCT, secretOf(9000))
    const named = [...fake.items.keys()].filter((a) => a !== ACCT)
    expect(named.length).toBeGreaterThan(1)
    plant(fake)
    fake.emptyDumps = 99
    await expect(runner.delete(ACCT)).rejects.toThrow(
      'Keychain value removed; leftover pieces could not be checked (Keychain items could not be listed)',
    )
    // what is certain was done: the manifest and every piece it named are gone; only the unchecked leftovers stay
    expect(fake.items.has(ACCT)).toBe(false)
    for (const a of named) expect(fake.items.has(a)).toBe(false)
    expect([...fake.items.keys()].sort()).toEqual([...orphans, ...survivors].sort())
    expect(fake.calls.filter((c) => c.argv[1] === 'dump-keychain').length).toBe(4)
    expect(problems.length).toBe(1)
    expect(problems[0]?.fields.step).toBe('sweep')
  })

  it('a keychain that truly holds nothing of ours after the named deletes lists empty, and that passes', async () => {
    const { fake, runner, problems, readable } = setup()
    await runner.write(ACCT, secretOf(9000))
    fake.foreign.add('someone-else') // other services do not count: the lookup is of our service alone
    fake.emptyDumps = 99
    await runner.delete(ACCT)
    expect(fake.items.size).toBe(0)
    expect(fake.calls.filter((c) => c.argv[1] === 'dump-keychain').length).toBe(1)
    // two lookups agree, and the keychain file itself was checked to be there
    expect(fake.calls.filter((c) => c.argv[1] === 'find-generic-password' && !c.argv.includes('-a')).length).toBe(2)
    expect(readable.asked).toContain('/fake.keychain-db')
    expect(problems).toEqual([])
  })

  it('an empty listing of a keychain file that is missing or unreadable is not "nothing of ours": the sweep fails', async () => {
    const { fake, runner, problems, readable } = setup()
    await runner.write(ACCT, secretOf(9000))
    fake.items.clear() // the lookup would say 44, as security does for a file it cannot open
    readable.yes = false
    fake.emptyDumps = 99
    await expect(runner.delete(ACCT)).rejects.toThrow('leftover pieces could not be checked')
    expect(problems.length).toBe(1)
  })

  it('a listing that fails, with nothing of ours left in a readable keychain, passes', async () => {
    const { fake, runner, problems } = setup()
    fake.failDump = true
    await runner.delete(ACCT)
    expect(problems).toEqual([])
  })

  it('a lookup that times out fails the sweep at once; one that answers neither 0 nor 44 is retried, then fails', async () => {
    for (const [override, dumps] of [
      [{ code: -1, stdout: '', timedOut: true }, 1],
      [{ code: 1, stdout: '' }, 4],
    ] as const) {
      const { fake, runner, problems } = setup()
      await runner.write(ACCT, 'short')
      fake.emptyDumps = 99
      fake.lookupOverride = override
      await expect(runner.delete(ACCT)).rejects.toThrow(
        override.timedOut ? 'timed out' : 'Keychain items could not be listed',
      )
      expect(fake.calls.filter((c) => c.argv[1] === 'dump-keychain').length).toBe(dumps)
      expect(problems.length).toBe(1)
    }
  })

  it('a named piece that would not go, with a listing that never came back, says the pieces were not deleted', async () => {
    const { fake, runner, problems } = setup()
    await runner.write(ACCT, secretOf(9000))
    fake.failDelete = (a) => a.endsWith('.2')
    fake.emptyDumps = 99
    await expect(runner.delete(ACCT)).rejects.toThrow('Keychain pieces not deleted')
    expect(problems.length).toBe(1)
    expect(problems[0]?.fields.step).toBe('delete')
  })

  it('logout deletes the sign-in, then the settings, never both at once', async () => {
    const { fake, runner } = setup()
    const secrets = new ServerSecrets(runner)
    const id = 'e'.repeat(16)
    await secrets.saveOauth(id, { tokens: { access_token: secretOf(9000) } })
    await secrets.saveConfig(id, { type: 'http', url: 'https://x.example.com' })
    const from = fake.calls.length
    await secrets.logout(id)
    // every call for the settings comes after the sign-in's delete has finished, its listing included
    const firstConfig = fake.calls.slice(from).findIndex((c) => c.argv.join(' ').includes(`${id}/config`))
    expect(firstConfig).toBeGreaterThan(0)
    const dumpsBefore = fake.calls.slice(from, from + firstConfig).filter((c) => c.argv[1] === 'dump-keychain').length
    expect(dumpsBefore).toBe(1)
    const after = fake.calls.slice(from + firstConfig)
    expect(after.some((c) => `${c.argv.join(' ')} ${c.stdin ?? ''}`.includes(`${id}/oauth`))).toBe(false)
    expect(fake.items.size).toBe(0)
  })

  it('a listing that fails makes the delete an error and a report, not a quiet success', async () => {
    const { fake, runner, problems } = setup()
    plant(fake)
    fake.failDump = true
    await expect(runner.delete(ACCT)).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
  })
})

describe('one failure files one problem report', () => {
  it('a failed write is one report however many steps noticed it', async () => {
    for (const make of [
      (f: FakeSecurity) => {
        f.dropPut = () => true
      },
      (f: FakeSecurity) => {
        f.failPut = () => true
      },
      (f: FakeSecurity) => {
        f.failPut = (a) => a.endsWith('.2') || !a.includes('.') // a short value has no third piece
        f.failDelete = () => true // the new pieces cannot be removed either
      },
    ]) {
      for (const chars of [20, 9000]) {
        const { fake, runner, problems } = setup()
        make(fake)
        await expect(runner.write(ACCT, secretOf(chars))).rejects.toBeInstanceOf(KeychainError)
        expect(problems.length).toBe(1)
        expect(problems[0]?.fields.item).toBe('oauth')
        expect(typeof problems[0]?.fields.step).toBe('string')
      }
    }
  })

  it('pieces that could not be removed after a failed write are named in the one report', async () => {
    const { fake, runner, problems } = setup()
    fake.failPut = (a) => a.endsWith('.2')
    fake.failDelete = () => true
    await expect(runner.write(ACCT, secretOf(9000))).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
    expect(problems[0]?.fields.step).toBe('chunk+cleanup')
  })

  it('a read-back that hit a locked keychain, with pieces left behind, names the write step in the one report', async () => {
    const { fake, problems } = setup()
    const spawn = fake.spawn
    const locked: KeychainSpawn = async (argv, stdin) => {
      if (argv[1] === 'find-generic-password' && argv.some((a) => a.startsWith(`${ACCT}.`)))
        return { code: 36, stdout: '' }
      return spawn(argv, stdin)
    }
    fake.failDelete = () => true
    const runner = securityRunner(locked, { onProblem: (message, fields) => problems.push({ message, fields }) })
    await expect(runner.write(ACCT, secretOf(9000))).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
    expect(problems[0]?.fields.step).toBe('write+cleanup')
  })

  it('a damaged value is one report', async () => {
    const { fake, runner, problems } = setup()
    await runner.write(ACCT, secretOf(9000))
    fake.items.delete([...fake.items.keys()].find((k) => k !== ACCT) as string)
    await expect(runner.read(ACCT)).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
  })

  it('a keychain that cannot be read after the manifest was written is one report', async () => {
    const { fake, problems } = setup()
    const spawn = fake.spawn
    let landed = false
    const locked: KeychainSpawn = async (argv, stdin) => {
      if (landed && argv[1] === 'find-generic-password' && argv.includes(ACCT)) return { code: 36, stdout: '' }
      const r = await spawn(argv, stdin)
      if (stdin?.includes(`-a ${ACCT} -w v2.`)) landed = true
      return r
    }
    const runner = securityRunner(locked, { onProblem: (message, fields) => problems.push({ message, fields }) })
    await expect(runner.write(ACCT, secretOf(9000))).rejects.toBeInstanceOf(KeychainError)
    expect(problems.length).toBe(1)
  })
})

describe('a write that failed but did land is not a failure', () => {
  it('the tool says no after storing the value: the write succeeds and files nothing', async () => {
    for (const chars of [20, 9000]) {
      const { fake, runner, problems } = setup()
      const spawn = fake.spawn
      const said = { no: 0 }
      const flaky: KeychainSpawn = async (argv, stdin) => {
        const r = await spawn(argv, stdin)
        const last = chars > 100 ? 'v2.' : 'v1.'
        if (stdin?.includes(`-a ${ACCT} -w ${last}`) && said.no++ === 0) return { code: 1, stdout: '' }
        return r
      }
      const value = secretOf(chars)
      await securityRunner(flaky, { onProblem: (message, fields) => problems.push({ message, fields }) }).write(
        ACCT,
        value,
      )
      expect(problems.length).toBe(0)
      expect(await runner.read(ACCT)).toBe(value)
    }
  })
})
