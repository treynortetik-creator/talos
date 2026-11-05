// The artifacts that ship: the relay bundle and the web bundle. Boots the BUILT relay as a separate process in
// production mode (what the container runs) and checks it, and checks the bundles for anything that must not ship.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { RELAY_DIST, ROOT, WEB_DIST } from '../harness/paths.ts'
import { freePort, vapidKeys, waitUntil } from '../harness/stack.ts'

function productionEnv(port: number, data: string, over: Record<string, string | undefined> = {}) {
  const vapid = vapidKeys()
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    PORT: String(port),
    PUBLIC_ORIGIN: 'https://relay.example.com',
    RP_ID: 'relay.example.com',
    DATA_DIR: data,
    DATA_KEY: randomBytes(32).toString('base64'),
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:owner@example.com',
    TALOS_WEB_DIR: WEB_DIST,
    LOG_LEVEL: 'warn',
    ...over,
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

test('the built relay boots in production mode and serves /healthz, the app and nothing test-only', async () => {
  const data = mkdtempSync(join(process.env.E2E_TMP_ROOT ?? tmpdir(), 'talos-prod-'))
  const port = await freePort()
  let out = ''
  const child: ChildProcess = spawn(process.execPath, [RELAY_DIST], { env: productionEnv(port, data), cwd: data })
  child.stdout?.on('data', (d) => {
    out += d.toString()
  })
  child.stderr?.on('data', (d) => {
    out += d.toString()
  })
  try {
    await waitUntil(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok
        } catch {
          return false
        }
      },
      `the built relay to answer /healthz (output: ${out.slice(-400)})`,
      20_000,
    )

    const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as Record<string, unknown>
    expect(health.ok).toBe(true)

    const home = await fetch(`http://127.0.0.1:${port}/`)
    expect(home.status).toBe(200)
    expect(home.headers.get('content-type')).toContain('text/html')
    expect(home.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(home.headers.get('strict-transport-security')).toBeTruthy()
    expect(await home.text()).toContain('<div id="root">')

    // X-Test-Session (and friends) are not a thing here.
    for (const path of ['/api/me', '/api/devices', '/api/connections', '/api/inbox?tab=priority']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { 'X-Test-Session': 'none', 'X-Test-Bridge': '1', 'X-Test-Stepup': 'st_test_x' },
      })
      expect(res.status, path).toBe(401)
    }
    // The database was created on the volume path, with the migrations applied.
    expect(statSync(join(data, 'relay.sqlite')).size).toBeGreaterThan(0)
  } finally {
    child.kill('SIGTERM')
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 'the relay to stop', 10_000)
    rmSync(data, { recursive: true, force: true })
  }
})

test('the built relay refuses to start with a bad environment and says which variable', async () => {
  const data = mkdtempSync(join(process.env.E2E_TMP_ROOT ?? tmpdir(), 'talos-prod-'))
  try {
    const run = (over: Record<string, string | undefined>) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const c = spawn(process.execPath, [RELAY_DIST], { env: productionEnv(1, data, over), cwd: data })
        let out = ''
        c.stdout.on('data', (d) => {
          out += d.toString()
        })
        c.stderr.on('data', (d) => {
          out += d.toString()
        })
        c.on('exit', (code) => resolve({ code, out }))
      })
    const noKey = await run({ DATA_KEY: undefined })
    expect(noKey.code).not.toBe(0)
    expect(noKey.out).toContain('DATA_KEY')
    const http = await run({ PUBLIC_ORIGIN: 'http://relay.example.com' })
    expect(http.code).not.toBe(0)
    expect(http.out).toContain('PUBLIC_ORIGIN')
    const noVapid = await run({ VAPID_PUBLIC_KEY: undefined })
    expect(noVapid.code).not.toBe(0)
    expect(noVapid.out).toContain('VAPID_PUBLIC_KEY')
  } finally {
    rmSync(data, { recursive: true, force: true })
  }
})

test('no test hook or fake client is in the shipped bundles', () => {
  const forbidden = [
    /X-Test-Session/i,
    /X-Test-Bridge/i,
    /X-Test-Stepup/i,
    /createTestAuth/,
    /installTestAuth/,
    /createFakeClient/,
    /FakeRelay/,
    /FakeClaude/,
    /\/__test/,
  ]
  const files = [RELAY_DIST, ...walk(WEB_DIST).filter((f) => /\.(js|mjs|html|json|webmanifest)$/.test(f))]
  expect(files.length).toBeGreaterThan(10)
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const re of forbidden) expect(re.test(text), `${f.replace(ROOT, '')} contains ${re}`).toBe(false)
  }
})

test('every package the relay bundle imports at run time is a declared dependency of the relay', () => {
  const bundle = readFileSync(RELAY_DIST, 'utf8')
  const imported = new Set<string>()
  for (const m of bundle.matchAll(/(?:from\s*|import\s*\(\s*)"([^"./][^"]*)"/g)) {
    const spec = m[1] as string
    if (spec.startsWith('node:') || !/^(@[a-z0-9~-][\w.~-]*\/)?[a-z0-9~-][\w.~-]*(\/.*)?$/.test(spec)) continue
    imported.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] as string))
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'apps', 'relay', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
  }
  const missing = [...imported].filter((n) => !(n in pkg.dependencies))
  expect(missing).toEqual([])
  expect(imported.size).toBeGreaterThan(8)
})
