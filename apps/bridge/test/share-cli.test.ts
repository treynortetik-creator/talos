// P1 (docs/V2-FEATURES.md V4.3): `talos-app share revoke <id>` and `talos-app share shortcut`, against a throwaway HTTP
// relay that records what the CLI sent. Shortcut shares stay untrusted Inbox data: there is no way to ask for more.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { tempHome } from './helpers.ts'

const SECRET = `talos_share_${'A'.repeat(43)}`
const TOKEN_ID = 'sh_01JBF3V7Q8K2M4N6P8R0S2T4V6'
const DEV_OLD = 'd_oldoldoldoldoldoldol'
const DEV_NEW = 'd_newnewnewnewnewnewne'

type Seen = { method: string; path: string; auth: string | null; body: string }
let seen: Seen[] = []
let server: ReturnType<typeof Bun.serve>
let replies: { del: number; post: number } = { del: 204, post: 200 }

beforeEach(() => {
  seen = []
  replies = { del: 204, post: 200 }
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body = await req.text()
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get('authorization'), body })
      if (req.method === 'DELETE' && url.pathname.startsWith('/bridge/share/tokens/'))
        return new Response(null, { status: replies.del })
      if (req.method === 'POST' && url.pathname === '/bridge/share/tokens') {
        const b = JSON.parse(body) as { label: string; device_id: string; scopes: string[] }
        if (replies.post !== 200) return Response.json({ error: 'x' }, { status: replies.post })
        return Response.json({
          token: {
            id: TOKEN_ID,
            label: b.label,
            device_id: b.device_id,
            scopes: b.scopes,
            created_at: '2026-10-29T00:00:00.000Z',
            last_used_at: null,
            last_used_net: null,
            revoked_at: null,
          },
          secret: SECRET,
        })
      }
      return new Response('nope', { status: 404 })
    },
  })
})
afterEach(() => server.stop(true))

function cliIO() {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async () => 'n',
      sleep: async () => {},
      now: () => Date.UTC(2026, 9, 29, 12, 0, 0),
    },
  }
}

async function setup(devices: Array<{ id: string; pinned_at?: string; revoked_at?: string }> = []) {
  const home = join(tempHome(), 'app')
  const relay = `http://127.0.0.1:${server.port}`
  const env = { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: relay }
  expect(await runCli(['init', '--relay-url', relay], cliIO().io, { TALOS_APP_HOME: home })).toBe(0)
  mkdirSync(home, { recursive: true })
  writeFileSync(
    paths(home).devicesJson,
    JSON.stringify({
      version: 1,
      devices: devices.map((d) => ({ name: 'phone', pubkey_jwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, ...d })),
    }),
  )
  return { home, env, relay }
}

describe('talos-app share revoke', () => {
  test('sends a signed DELETE /bridge/share/tokens/:id and reports it', async () => {
    const { env } = await setup()
    const { out, err, io } = cliIO()
    expect(await runCli(['share', 'revoke', TOKEN_ID], io, env)).toBe(0)
    expect(err).toEqual([])
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'DELETE', path: `/bridge/share/tokens/${TOKEN_ID}`, body: '' })
    expect(seen[0]?.auth).toMatch(/^TalosBridge /)
    expect(out.join('\n')).toContain('revoked')
  })

  test('an unknown id (404) is a failure with a plain message', async () => {
    const { env } = await setup()
    replies.del = 404
    const { err, io } = cliIO()
    expect(await runCli(['share', 'revoke', TOKEN_ID], io, env)).toBe(1)
    expect(err.join('\n')).toMatch(/no share link/i)
  })

  test('a missing or malformed id never reaches the relay', async () => {
    const { env } = await setup()
    expect(await runCli(['share', 'revoke'], cliIO().io, env)).toBe(2)
    expect(await runCli(['share', 'revoke', '../../api/auth/logout'], cliIO().io, env)).toBe(2)
    expect(seen).toEqual([])
  })
})

describe('talos-app share shortcut', () => {
  test('mints a text-only token for the newest pinned device and writes a 0600 plist that holds the key', async () => {
    const { home, env, relay } = await setup([
      { id: DEV_OLD, pinned_at: '2026-10-01T00:00:00.000Z' },
      { id: DEV_NEW, pinned_at: '2026-10-20T00:00:00.000Z' },
    ])
    const { out, err, io } = cliIO()
    const code = await runCli(['share', 'shortcut', '--label', 'My iPhone'], io, env, { platform: 'linux' })
    expect(err).toEqual([])
    expect(code).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/bridge/share/tokens' })
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      label: 'My iPhone (exported 2026-10-29)',
      device_id: DEV_NEW,
      scopes: ['text'],
    })
    const dir = join(home, 'shortcuts')
    const plist = readdirSync(dir).find((f) => f.endsWith('.unsigned.shortcut'))
    expect(plist).toBeDefined()
    const file = join(dir, plist ?? '')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const xml = readFileSync(file, 'utf8')
    expect(xml).toContain('<?xml')
    expect(xml).toContain(`Bearer ${SECRET}`)
    expect(xml).toContain(`${relay}/api/share`)
    expect(xml).toContain('is.workflow.actions.downloadurl')
    expect(xml).toContain('ActionExtension') // shows in the share sheet
    expect(xml).not.toContain('WFGenericFileContentItem') // text-only token: no files
    // the key never goes to the terminal
    expect(out.join('\n')).not.toContain(SECRET)
    expect(out.join('\n')).toContain(file)
  })

  test('non-macOS: no signing attempted; the output says exactly how to sign on a Mac', async () => {
    const { env } = await setup([{ id: DEV_NEW, pinned_at: '2026-10-20T00:00:00.000Z' }])
    const signed: string[][] = []
    const { out, io } = cliIO()
    expect(
      await runCli(['share', 'shortcut'], io, env, {
        platform: 'linux',
        sign: async (i, o) => {
          signed.push([i, o])
          return { ok: true }
        },
      }),
    ).toBe(0)
    expect(signed).toEqual([])
    const text = out.join('\n')
    expect(text).toContain('shortcuts sign --mode anyone --input')
    expect(text).toMatch(/not signed|unsigned/i)
  })

  test('macOS: signs with shortcuts sign, leaves one .shortcut file, removes the unsigned copy', async () => {
    const { home, env } = await setup([{ id: DEV_NEW, pinned_at: '2026-10-20T00:00:00.000Z' }])
    let call: string[] = []
    const { out, io } = cliIO()
    expect(
      await runCli(['share', 'shortcut', '--files'], io, env, {
        platform: 'darwin',
        sign: async (i, o) => {
          call = [i, o]
          writeFileSync(o, 'SIGNED')
          return { ok: true }
        },
      }),
    ).toBe(0)
    expect(JSON.parse(seen[0]?.body ?? '{}').scopes).toEqual(['text', 'files'])
    expect(call[0]).toMatch(/\.unsigned\.shortcut$/)
    expect(call[1]).toMatch(/[^d]\.shortcut$/)
    expect(existsSync(call[0] ?? '')).toBe(false)
    expect(readdirSync(join(home, 'shortcuts')).filter((f) => f.endsWith('.shortcut'))).toHaveLength(1)
    expect(out.join('\n')).toContain('Add Shortcut')
    expect(out.join('\n')).toMatch(/contains the key/i)
  })

  test('macOS but signing fails (no iCloud sign-in): keeps the plist and falls back to the manual steps, exit 0', async () => {
    const { home, env } = await setup([{ id: DEV_NEW, pinned_at: '2026-10-20T00:00:00.000Z' }])
    const { out, io } = cliIO()
    expect(
      await runCli(['share', 'shortcut'], io, env, {
        platform: 'darwin',
        sign: async () => ({ ok: false, error: 'Error: not signed in to iCloud' }),
      }),
    ).toBe(0)
    expect(readdirSync(join(home, 'shortcuts')).some((f) => f.endsWith('.unsigned.shortcut'))).toBe(true)
    expect(out.join('\n')).toContain('not signed in to iCloud')
    expect(out.join('\n')).toContain('shortcuts sign --mode anyone --input')
  })

  test('a long label is cut so label + export date fits the relay limit of 40', async () => {
    const { env } = await setup([{ id: DEV_NEW, pinned_at: '2026-10-20T00:00:00.000Z' }])
    expect(await runCli(['share', 'shortcut', '--label', 'x'.repeat(60)], cliIO().io, env, { platform: 'linux' })).toBe(
      0,
    )
    const label = JSON.parse(seen[0]?.body ?? '{}').label as string
    expect(label.length).toBeLessThanOrEqual(40)
    expect(label).toMatch(/\(exported 2026-10-29\)$/)
  })

  test('no pinned device: says so and mints nothing; revoked devices do not count', async () => {
    const { env } = await setup([
      { id: DEV_OLD, pinned_at: '2026-10-01T00:00:00.000Z', revoked_at: '2026-10-02T00:00:00.000Z' },
    ])
    const { err, io } = cliIO()
    expect(await runCli(['share', 'shortcut'], io, env, { platform: 'linux' })).toBe(1)
    expect(err.join('\n')).toMatch(/pinned device/i)
    expect(seen).toEqual([])
  })

  test('there is no way to ask for a trusted token', async () => {
    const { env } = await setup([{ id: DEV_NEW, pinned_at: '2026-10-20T00:00:00.000Z' }])
    for (const flag of ['--trusted', '--trust=owner', '--scopes=owner']) {
      const { io } = cliIO()
      expect(await runCli(['share', 'shortcut', flag], io, env, { platform: 'linux' })).not.toBe(0)
    }
    expect(seen).toEqual([])
  })

  test('relay refuses (409 too many links): reports it and writes no file', async () => {
    const { home, env } = await setup([{ id: DEV_NEW, pinned_at: '2026-10-20T00:00:00.000Z' }])
    replies.post = 409
    const { err, io } = cliIO()
    expect(await runCli(['share', 'shortcut'], io, env, { platform: 'linux' })).toBe(1)
    expect(err.join('\n')).toContain('409')
    expect(existsSync(join(home, 'shortcuts'))).toBe(false)
  })
})
