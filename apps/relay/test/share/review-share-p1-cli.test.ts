// Adversarial review of PR #52 (Share P1), end to end: the REAL bridge CLI process (`bun run apps/bridge/src/cli.ts`)
// against the REAL relay (startTestRelay). The PR's own CLI tests only ever talk to a hand-written Bun.serve stub.
//
// `shortcuts` is replaced on PATH by a script that copies input to output at 0600. That mirrors what the real
// `shortcuts sign --mode anyone` did on this Mac (macOS 26, measured 2026-10-29: output always 0600, any input mode),
// minus the AEA wrapper, so the recipe stays readable for the asserts.
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'

vi.setConfig({ testTimeout: 120_000 })

const REPO = resolve(__dirname, '../../../..')
const CLI = join(REPO, 'apps/bridge/src/cli.ts')
const DEV = 'd_abcdefghijklmnopqrst'
const SECRET_RE = /talos_share_[A-Za-z0-9_-]{43}/

let relay: TestRelay | null = null
const roots: string[] = []
afterEach(async () => {
  await relay?.stop()
  relay = null
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function addDevice(r: TestRelay, id = DEV) {
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'phone', '{}', 'b', 1, 0, Date.now())
}

/** A Mac home that holds the relay's own bridge key and one pinned device, plus a fake `shortcuts` on PATH. */
function macHome(r: TestRelay) {
  const root = mkdtempSync(join(tmpdir(), 'talos-p1-review-'))
  roots.push(root)
  const home = join(root, 'app')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const k = r.bridgeKey
  writeFileSync(
    join(home, 'bridge.key'),
    JSON.stringify({ v: 1, pkcs8: k.privateKeyPkcs8B64, public: k.publicKeyB64, key_id: k.keyId }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(home, 'devices.json'),
    JSON.stringify({
      version: 1,
      devices: [
        {
          id: DEV,
          name: 'phone',
          pubkey_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
          pinned_at: '2026-10-20T00:00:00.000Z',
        },
      ],
    }),
    { mode: 0o600 },
  )
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const fake = join(bin, 'shortcuts')
  writeFileSync(
    fake,
    `#!/bin/sh\n# args: sign --mode anyone --input IN --output OUT\necho "$@" >> "${join(root, 'signer.log')}"\ncp "$5" "$7" && chmod 600 "$7"\n`,
  )
  chmodSync(fake, 0o755)
  return { root, home, bin }
}

/** Async on purpose: the relay runs in THIS process, so a spawnSync would block it from answering the CLI. */
function cli(
  m: ReturnType<typeof macHome>,
  r: TestRelay,
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const child = spawn('bun', ['run', CLI, ...args], {
      cwd: join(REPO, 'apps/bridge'),
      env: {
        ...process.env,
        TALOS_APP_HOME: m.home,
        TALOS_APP_RELAY_URL: r.httpBase,
        PATH: `${m.bin}:${process.env.PATH}`,
      },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('close', (code) => done({ code, out, err }))
  })
}

const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))

const share = (r: TestRelay, secret: string) =>
  fetch(`${r.httpBase}/api/share`, {
    method: 'POST',
    body: JSON.stringify({ text: 'from the review' }),
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
  })

const darwin = process.platform === 'darwin'

describe('held: share shortcut + share revoke, real CLI process against the real relay', () => {
  it.runIf(darwin)(
    'mints a text-only token for the pinned device, writes ONE 0600 .shortcut with the right URL, the key never printed, revoke kills it',
    async () => {
      relay = await startTestRelay()
      addDevice(relay)
      const m = macHome(relay)
      const r = await cli(m, relay, ['share', 'shortcut', '--label', "Alex's iPhone"])
      expect(r.code, r.err).toBe(0)
      expect(`${r.out}${r.err}`).not.toMatch(SECRET_RE)

      const dir = join(m.home, 'shortcuts')
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      const files = readdirSync(dir)
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^talos-share-alex-s-iphone-\d{4}-\d{2}-\d{2}\.shortcut$/)
      const file = join(dir, files[0] as string)
      expect(statSync(file).mode & 0o777).toBe(0o600)
      const xml = readFileSync(file, 'utf8')
      expect(xml).toContain(`<string>${relay.httpBase}/api/share</string>`)
      expect(xml).not.toMatch(/trusted|owner|thread/i)
      const secret = (SECRET_RE.exec(xml) ?? [])[0] as string
      expect(secret).toBeTruthy()

      // the key is on disk exactly once (no tmp leftovers, no unsigned copy, not in the signer's args log)
      const holders = walk(m.root).filter((f) => readFileSync(f).includes(secret))
      expect(holders).toEqual([file])

      const row = relay.relay.services.db
        .prepare('select id, label, device_id, scopes from core_share_tokens')
        .all() as Array<{ id: string; label: string; device_id: string; scopes: string }>
      expect(row).toHaveLength(1)
      expect(row[0]).toMatchObject({ device_id: DEV, scopes: '["text"]' })
      expect(row[0]?.label).toMatch(/^Alex's iPhone \(exported \d{4}-\d{2}-\d{2}\)$/)
      expect(r.out).toContain(row[0]?.id as string)

      expect((await share(relay, secret)).status).toBe(202)
      const id = row[0]?.id as string
      expect((await cli(m, relay, ['share', 'revoke', id])).code).toBe(0)
      expect((await share(relay, secret)).status).toBe(401)
      expect((await cli(m, relay, ['share', 'revoke', id])).code).toBe(0) // idempotent
      expect((await cli(m, relay, ['share', 'revoke', 'sh_00000000000000000000000000'])).code).toBe(1)
      expect((await cli(m, relay, ['share', 'shortcut', '--trusted'])).code).toBe(2)
    },
  )

  it.runIf(darwin)('--files mints text+files; SHARE_ENABLED=0 writes no file and mints nothing', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const m = macHome(relay)
    expect((await cli(m, relay, ['share', 'shortcut', '--files'])).code).toBe(0)
    const scopes = (relay.relay.services.db.prepare('select scopes from core_share_tokens').get() as { scopes: string })
      .scopes
    expect(scopes).toBe('["text","files"]')
    await relay.stop()

    relay = await startTestRelay({ env: { SHARE_ENABLED: '0' } })
    addDevice(relay)
    const m2 = macHome(relay)
    const r = await cli(m2, relay, ['share', 'shortcut'])
    expect(r.code).not.toBe(0)
    expect(() => readdirSync(join(m2.home, 'shortcuts'))).toThrow()
  })
})

describe('FAILS on PR #52 (low): the CLI throws away the relay reason', () => {
  // The relay answers 409 with `{error:'too_many_tokens', message:'Revoke a share link first (10 at most).'}`, but
  // RelayHttp.json() discards the body and the CLI prints `talos-app: relay said 409`. The owner gets a number, not
  // the next step. Same for 403 device_not_pinned when the Mac's devices.json is behind the relay.
  it.runIf(darwin)('at the cap of 10 the CLI says to revoke a link (and lists how), not just "409"', async () => {
    relay = await startTestRelay()
    addDevice(relay)
    const m = macHome(relay)
    for (let i = 0; i < 10; i++) expect((await cli(m, relay, ['share', 'shortcut', '--label', `p${i}`])).code).toBe(0)
    const r = await cli(m, relay, ['share', 'shortcut', '--label', 'p10'])
    expect(r.code).toBe(1)
    expect(`${r.out}${r.err}`).toMatch(/revoke/i)
  })
})
