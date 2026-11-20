// The agent runs `peer ...` with no terminal: it never sees a secret (a 0600 file carries it), `peer add --secret-file` takes it
// from that file, and the creator's copy goes when the first message arrives. Fixed fake secrets only.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitFor } from '@talos-app/testkit'
import { runCli } from '../../src/cli.ts'
import { ConfigFile } from '../../src/config-file.ts'
import { PEER_SECRET_SERVICE, PEERS_INBOUND_FILE, peerSecretAccount, readInboundPeers } from '../../src/peer/records.ts'
import { deleteIfSame, deletePeerSecretFile, peerSecretFile, readSecretFile } from '../../src/peer/secret-file.ts'
import { validPeerSecret } from '../../src/peer/sign.ts'
import { ACCOUNT_HOME_TEST } from '../../src/talos.ts'
import { type Harness, startHarness } from '../helpers.ts'
import { deliver, FAKE_SECRET, type Install, install, linkBoth, memorySecrets } from './helpers.ts'

let h: (Harness & { secrets: ReturnType<typeof memorySecrets> }) | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
async function start(lock = false) {
  const base = await startHarness({
    startBridge: false,
    config: (c) => ({ ...c, ...(lock ? { settings_lock: true } : {}) }),
  })
  h = Object.assign(base, { secrets: memorySecrets() })
  return h
}
async function cli(
  argv: string[],
  o: { terminal?: boolean; secret?: string; env?: Record<string, string>; backend?: 'secret_service' } = {},
) {
  const hh = h as NonNullable<typeof h>
  const out: string[] = []
  const err: string[] = []
  let asked = 0
  const code = await runCli(
    argv,
    {
      isTerminal: o.terminal ?? false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async () => {
        asked++
        return ''
      },
      readSecret: async () => {
        asked++
        return o.secret ?? ''
      },
      sleep: async () => {},
      now: () => Date.now(),
    },
    { TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl, ...o.env },
    { peer: { secrets: o.backend ? ({ ...hh.secrets, backend: o.backend } as typeof hh.secrets) : hh.secrets } },
  )
  return { code, out: out.join('\n'), err: err.join('\n'), asked }
}
const dir = () => join((h as Harness).home, 'peer-secrets')
const file = (n = 'work') => join(dir(), `${n}.secret`)
const URL_ARG = 'https://work-inbox.example.com/hook/peer/cn_fakefakefakefakefake0'
const mode = (p: string) => statSync(p).mode & 0o777
const put = (p: string, body: string, m = 0o600) => {
  mkdirSync(join(p, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(p, body, { mode: m })
  chmodSync(p, m)
}

describe('an agent run of peer create / rotate', () => {
  test('create puts no secret on stdout or stderr; the file is 0600 in a 0700 folder and holds a valid secret', async () => {
    await start()
    const r = await cli(['peer', 'create', 'work'])
    expect(r.code, r.err).toBe(0)
    expect(r.out + r.err).not.toMatch(/whsec_/)
    expect(r.out).toContain(file())
    expect(r.out).toMatch(/--secret-file/)
    expect(mode(dir())).toBe(0o700)
    expect(mode(file())).toBe(0o600)
    expect(validPeerSecret(readFileSync(file(), 'utf8').trim())).toBe(true)
  })
  test('rotate writes a new secret into the same file, still printing none', async () => {
    await start()
    await cli(['peer', 'create', 'work'])
    const before = readFileSync(file(), 'utf8')
    const r = await cli(['peer', 'rotate', 'work'])
    expect(r.code, r.err).toBe(0)
    expect(r.out + r.err).not.toMatch(/whsec_/)
    expect(readFileSync(file(), 'utf8')).not.toBe(before)
    expect(mode(file())).toBe(0o600)
  })
  test('a symlink at the path is refused and what it points to is not written', async () => {
    await start()
    mkdirSync(dir(), { recursive: true, mode: 0o700 })
    const target = join((h as Harness).home, 'elsewhere.txt')
    writeFileSync(target, 'keep')
    symlinkSync(target, file())
    const r = await cli(['peer', 'create', 'work'])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })
  test('a symlinked folder is refused too', async () => {
    await start()
    const real = join((h as Harness).home, 'real-dir')
    mkdirSync(real, { mode: 0o700 })
    symlinkSync(real, dir())
    expect((await cli(['peer', 'create', 'work'])).err).toMatch(/symlink/)
    expect(existsSync(join(real, 'work.secret'))).toBe(false)
  })
  test('in a terminal the secret is printed once as before and no file is made', async () => {
    await start()
    const r = await cli(['peer', 'create', 'work'], { terminal: true })
    expect(r.out).toMatch(/secret: +whsec_/)
    expect(existsSync(file())).toBe(false)
  })
})

describe('peer add --secret-file', () => {
  const add = (extra: string[] = [], o = {}) =>
    cli(['peer', 'add', 'work', '--url', URL_ARG, '--secret-file', file(), ...extra], o)
  test('a good file: stored in the secret store, the link made, the file deleted', async () => {
    await start()
    put(file(), `${FAKE_SECRET}\n`)
    const r = await add()
    expect(r.code, r.err).toBe(0)
    expect(await (h as NonNullable<typeof h>).secrets.get(PEER_SECRET_SERVICE, peerSecretAccount('work'))).toBe(
      FAKE_SECRET,
    )
    expect(new ConfigFile(join((h as Harness).home, 'config.json')).load().peers.map((p) => p.name)).toEqual(['work'])
    expect(existsSync(file())).toBe(false)
    expect(r.out + r.err).not.toContain(FAKE_SECRET)
  })
  test('works from a terminal too', async () => {
    await start()
    put(file(), FAKE_SECRET)
    expect((await add([], { terminal: true })).code).toBe(0)
    expect(existsSync(file())).toBe(false)
  })
  test('a mode wider than 0600 is refused and the file kept', async () => {
    await start()
    put(file(), FAKE_SECRET, 0o644)
    const r = await add()
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/0600/)
    expect(existsSync(file())).toBe(true)
  })
  test('a symlink is refused and its target kept', async () => {
    await start()
    const target = join((h as Harness).home, 'real.secret')
    put(target, FAKE_SECRET)
    mkdirSync(dir(), { recursive: true, mode: 0o700 })
    symlinkSync(target, file())
    const r = await add()
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/symlink|regular file/)
    expect(existsSync(target)).toBe(true)
  })
  test('a file that is not a secret is refused and kept; nothing is stored', async () => {
    await start()
    put(file(), 'not-a-secret')
    const r = await add()
    expect(r.code).toBe(1)
    expect(existsSync(file())).toBe(true)
    expect(
      await (h as NonNullable<typeof h>).secrets.get(PEER_SECRET_SERVICE, peerSecretAccount('work')),
    ).toBeUndefined()
  })
  test('a bad url fails and keeps the file', async () => {
    await start()
    put(file(), FAKE_SECRET)
    const r = await cli(['peer', 'add', 'work', '--url', 'http://example.com/x', '--secret-file', file()])
    expect(r.code).toBe(1)
    expect(existsSync(file())).toBe(true)
  })
  test('an agent with no --secret-file is pointed to it and is never asked for a secret', async () => {
    await start()
    const r = await cli(['peer', 'add', 'work', '--url', URL_ARG], { secret: FAKE_SECRET })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/--secret-file/)
    expect(r.asked).toBe(0)
  })
  test('a terminal with no --secret-file is asked, as today', async () => {
    await start()
    const r = await cli(['peer', 'add', 'work', '--url', URL_ARG], { terminal: true, secret: FAKE_SECRET })
    expect(r.code, r.err).toBe(0)
    expect(r.asked).toBe(1)
  })
  test('a secret anywhere in argv is still refused', async () => {
    await start()
    const r = await cli(['peer', 'add', 'work', '--url', URL_ARG, '--secret-file', FAKE_SECRET])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/never goes on the command line/)
  })
})

describe('secret-forget and remove', () => {
  test('secret-forget deletes the file and says so; again, it is idempotent and says there was none', async () => {
    await start()
    put(file(), FAKE_SECRET)
    const a = await cli(['peer', 'secret-forget', 'work'])
    expect(a.code).toBe(0)
    expect(a.out).toMatch(/deleted/i)
    expect(existsSync(file())).toBe(false)
    const b = await cli(['peer', 'secret-forget', 'work'])
    expect(b.code).toBe(0)
    expect(b.out).toMatch(/no secret file/i)
  })
  test('remove deletes it too', async () => {
    await start()
    await cli(['peer', 'create', 'work'])
    expect(existsSync(file())).toBe(true)
    await cli(['peer', 'remove', 'work'])
    expect(existsSync(file())).toBe(false)
  })
})

describe('the lock and the terminal-only commands, through runCli', () => {
  test('lock on: peer list is refused with the one sentence; off: it runs', async () => {
    await start(true)
    const r = await cli(['peer', 'list'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('Talos settings are locked')
    await h?.stop()
    await start(false)
    expect((await cli(['peer', 'list'])).code).toBe(0)
  })
  test('a thread session runs peer list (the fence lets it through) and is refused enroll', async () => {
    await start()
    const env = { TALOS_APP_WORKER_THREAD: 'trip', TALOS_SESSION_ROLE: 'worker' }
    expect((await cli(['peer', 'list'], { env })).code).toBe(0)
    expect((await cli(['enroll'], { env })).err).toMatch(/not available in a thread session/)
  })
  test('enroll, rotate and trust on from an agent are refused as before, the lock off', async () => {
    await start()
    for (const argv of [['enroll'], ['rotate'], ['trust', 'on']]) {
      const r = await cli(argv)
      expect(r.code, argv.join(' ')).toBe(1)
      expect(r.err, argv.join(' ')).toMatch(/only runs in (a terminal|Terminal)|needs a terminal/)
    }
  })
})

describe("the first inbound message deletes the creator's secret file", () => {
  let a: Install | undefined
  let b: Install | undefined
  afterEach(async () => {
    await a?.stop()
    await b?.stop()
    a = b = undefined
  })
  test('it is gone once the first message arrives, and there is no complaint when there was none', async () => {
    a = await install({ to: () => b })
    b = await install({ to: () => a })
    await linkBoth(a, b)
    const f = join(a.home, 'peer-secrets', 'work.secret')
    put(f, FAKE_SECRET)
    await deliver(a, 'work', {})
    await waitFor(() => !existsSync(f), 4000, 'the file to go')
    await deliver(a, 'work', {}) // none to delete: fine
    expect(a.peerNotes().length).toBeGreaterThanOrEqual(1)
  })
})

describe('the order of a create, and what a failed write leaves', () => {
  test('the secret file is written before the local inbox record: a write that fails leaves no record and says what to run', async () => {
    await start()
    rmSync(dir(), { recursive: true, force: true })
    writeFileSync(dir(), 'a file where the folder goes') // nothing can be written under it
    try {
      const r = await cli(['peer', 'create', 'work'])
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/peer remove work/)
      expect(r.err).toMatch(/peer create work/)
      expect(r.out + r.err).not.toMatch(/whsec_/)
      expect(readInboundPeers((h as Harness).home)).toEqual([])
      expect(existsSync(join((h as Harness).home, PEERS_INBOUND_FILE))).toBe(false)
    } finally {
      rmSync(dir(), { force: true })
    }
  })
  test('a good create records that its file is a create one, with the time', async () => {
    await start()
    const before = Date.now()
    await cli(['peer', 'create', 'work'])
    const rec = readInboundPeers((h as Harness).home)[0]
    expect(rec?.secret_file?.kind).toBe('create')
    expect(rec?.secret_file?.at).toBeGreaterThanOrEqual(before)
  })
  test('a rotate by the agent says in one line when its file goes, and records that it is a rotate one', async () => {
    await start()
    await cli(['peer', 'create', 'work'])
    const r = await cli(['peer', 'rotate', 'work'])
    expect(r.out).toMatch(/first message.*24 hours/)
    expect(readInboundPeers((h as Harness).home)[0]?.secret_file?.kind).toBe('rotate')
  })
})

describe('secret files: leftovers, odd names, a swapped file', () => {
  test('secret-forget and remove also take the leftover temp files of that name, and only that name', async () => {
    await start()
    put(file(), FAKE_SECRET)
    put(join(dir(), 'work.secret.aabbcc.tmp'), 'x')
    put(join(dir(), 'play.secret.aabbcc.tmp'), 'x')
    await cli(['peer', 'secret-forget', 'work'])
    expect(existsSync(join(dir(), 'work.secret.aabbcc.tmp'))).toBe(false)
    expect(existsSync(join(dir(), 'play.secret.aabbcc.tmp'))).toBe(true)
    put(join(dir(), 'work.secret.ddeeff.tmp'), 'x')
    const r = await cli(['peer', 'secret-forget', 'work'])
    expect(r.out).toMatch(/deleted/i)
    expect(existsSync(join(dir(), 'work.secret.ddeeff.tmp'))).toBe(false)
  })
  test('a name that is not a PeerName never becomes a path', async () => {
    await start()
    const home = (h as Harness).home
    writeFileSync(join(home, 'x.secret'), 'keep')
    expect(() => peerSecretFile(home, '../x')).toThrow(/not a peer name/)
    expect(() => deletePeerSecretFile(home, '../x')).toThrow()
    expect(readFileSync(join(home, 'x.secret'), 'utf8')).toBe('keep')
  })
  test('a file swapped after it was read is kept, not deleted', async () => {
    await start()
    put(file(), FAKE_SECRET)
    const read = readSecretFile(file())
    expect(read.secret).toBe(FAKE_SECRET)
    put(join(dir(), 'other'), FAKE_SECRET)
    renameSync(join(dir(), 'other'), file()) // a different file now sits at the path
    expect(deleteIfSame(file(), read.id)).toBe('changed')
    expect(existsSync(file())).toBe(true)
    const same = readSecretFile(file())
    expect(deleteIfSame(file(), same.id)).toBe('deleted')
    expect(deleteIfSame(file(), same.id)).toBe('gone')
  })
})

describe('a keychain-wide key store is kept per Talos home', () => {
  test('an agent run on a keychain-wide store at a non-default home runs: the secret is kept under the home-scoped item', async () => {
    await start()
    put(file(), FAKE_SECRET)
    const r = await cli(['peer', 'add', 'work', '--url', URL_ARG, '--secret-file', file()], {
      backend: 'secret_service',
    })
    expect(r.code, r.err).toBe(0)
    expect(existsSync(file())).toBe(false)
    const keys = [...(h as NonNullable<typeof h>).secrets.data.keys()]
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatch(new RegExp(`^${PEER_SECRET_SERVICE.replace(/\./g, '\\.')}\\.[0-9a-f]{16}\u0000`))
  })
  test('an agent run on a per-home file store at a non-default home runs (and the file goes)', async () => {
    await start()
    put(file(), FAKE_SECRET)
    const r = await cli(['peer', 'add', 'work', '--url', URL_ARG, '--secret-file', file()])
    expect(r.code, r.err).toBe(0)
    expect(existsSync(file())).toBe(false)
  })
  test('an agent run on a keychain-wide store at the account default home runs', async () => {
    const account = mkdtempSync(join(realpathSync(tmpdir()), 'acct-'))
    const was = ACCOUNT_HOME_TEST.home
    ACCOUNT_HOME_TEST.home = account // the seam: the account's home is this folder, so its default Talos home is under it
    try {
      const base = await startHarness({ startBridge: false, home: join(account, '.config', 'talos', 'app') })
      h = Object.assign(base, { secrets: memorySecrets() })
      put(file(), FAKE_SECRET)
      const r = await cli(['peer', 'add', 'work', '--url', URL_ARG, '--secret-file', file()], {
        backend: 'secret_service',
      })
      expect(r.code, r.err).toBe(0)
      expect(existsSync(file())).toBe(false)
    } finally {
      ACCOUNT_HOME_TEST.home = was
      rmSync(account, { recursive: true, force: true })
    }
  })
})

describe('the inbound side: create, rotate and a hand-edited name', () => {
  let a: Install | undefined
  let b: Install | undefined
  afterEach(async () => {
    await a?.stop()
    await b?.stop()
    a = b = undefined
  })
  const HOURS = 3600_000
  test('after a rotate the file stays through the 24 hour grace and goes on the first message after it', async () => {
    a = await install({ to: () => b })
    b = await install({ to: () => a })
    await linkBoth(a, b)
    const { addInboundPeer, readInboundPeers: read } = await import('../../src/peer/records.ts')
    const conn = (read(a.home).find((p) => p.name === 'work') as { conn_id: string }).conn_id
    const f = join(a.home, 'peer-secrets', 'work.secret')
    put(f, FAKE_SECRET)
    addInboundPeer(a.home, { name: 'work', conn_id: conn, secret_file: { kind: 'rotate', at: a.clock.now() } })
    await deliver(a, 'work', {})
    await waitFor(() => a?.peerNotes().length === 1, 4000, 'the first message')
    expect(existsSync(f)).toBe(true) // within 24 hours the sender may still be on the old secret
    // 25 hours pass: the bridge's clock is the real one in this harness, so the record's time is moved back instead of the clock forward
    addInboundPeer(a.home, {
      name: 'work',
      conn_id: conn,
      secret_file: { kind: 'rotate', at: a.bridge.ctx.clock.now() - 25 * HOURS },
    })
    await deliver(a, 'work', {})
    await waitFor(() => !existsSync(f), 4000, 'the file to go after the grace')
  })
  test('a create file goes on the first message, however old the record', async () => {
    a = await install({ to: () => b })
    b = await install({ to: () => a })
    await linkBoth(a, b)
    const { addInboundPeer, readInboundPeers: read } = await import('../../src/peer/records.ts')
    const conn = (read(a.home).find((p) => p.name === 'work') as { conn_id: string }).conn_id
    const f = join(a.home, 'peer-secrets', 'work.secret')
    put(f, FAKE_SECRET)
    addInboundPeer(a.home, { name: 'work', conn_id: conn, secret_file: { kind: 'create', at: a.clock.now() } })
    await deliver(a, 'work', {})
    await waitFor(() => !existsSync(f), 4000, 'the file to go')
  })
  test('a hand-edited ../x in peers-inbound.json deletes nothing outside peer-secrets/', async () => {
    a = await install({ to: () => b })
    b = await install({ to: () => a })
    await linkBoth(a, b)
    writeFileSync(join(a.home, 'x.secret'), 'keep')
    writeFileSync(
      join(a.home, PEERS_INBOUND_FILE),
      JSON.stringify({ v: 1, peers: [{ name: '../x', conn_id: 'cn_handeditedhandedited0' }] }),
    )
    await deliver(a, '../x', {}, 'cn_handeditedhandedited0')
    await new Promise((r) => setTimeout(r, 300))
    expect(readFileSync(join(a.home, 'x.secret'), 'utf8')).toBe('keep')
  })
})
