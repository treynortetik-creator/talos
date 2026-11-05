// `pnpm dev:all`: the whole product on this machine, with FakeClaude standing in for Claude Code.
//   relay (built bundle, port 8787)  +  web dev server (port 5173, proxies the API and the socket to the relay)
//   +  the real bridge behind FakeClaude (auto-replies "ack: <your message>", approves primary card actions).
// State lives in ./.dev (ignored by git). Open http://localhost:5173/enroll#<code> with the link printed below.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeClaude } from '../packages/testkit/src/index.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEV = join(ROOT, '.dev')
const HOME = join(DEV, 'bridge-home')
const DATA = join(DEV, 'relay-data')
const WEB_PORT = 5173
const RELAY_PORT = 8787
const ORIGIN = `http://localhost:${WEB_PORT}`
mkdirSync(DATA, { recursive: true })

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })

// 1. The Mac side: key, config and bridge.env (kept between runs).
const init = run('bun', ['run', 'apps/bridge/src/cli.ts', 'init', '--relay-url', ORIGIN], { TALOS_APP_HOME: HOME })
const pubkey = /BRIDGE_PUBKEY=(\S+)/.exec(init.stdout)?.[1]
if (!pubkey) throw new Error(`talos-app init failed: ${init.stdout}${init.stderr}`)

// 2. The relay bundle.
const built = spawnSync('pnpm', ['--filter', '@talos-app/relay', 'build'], { cwd: ROOT, stdio: 'inherit' })
if (built.status !== 0) process.exit(1)
const keyFile = join(DEV, 'data-key')
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 })

const children = [
  spawn('node', ['apps/relay/dist/index.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(RELAY_PORT),
      PUBLIC_ORIGIN: ORIGIN,
      RP_ID: 'localhost',
      DATA_DIR: DATA,
      DATA_KEY: readFileSync(keyFile, 'utf8').trim(),
      BRIDGE_PUBKEY: pubkey,
      TRUST_PROXY_HOPS: '0',
      LOG_LEVEL: 'info',
    },
  }),
  spawn('pnpm', ['--filter', '@talos-app/web', 'exec', 'vite', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, TALOS_E2E_RELAY: `http://localhost:${RELAY_PORT}` },
  }),
]

// 3. The bridge, started the way Claude Code starts it.
const claude = new FakeClaude({
  command: 'bun',
  args: ['run', join(ROOT, 'apps/bridge/src/server.ts')],
  cwd: join(ROOT, 'apps/bridge'),
  autoReply: true,
  env: { TALOS_APP_HOME: HOME, TALOS_APP_RELAY_URL: ORIGIN, TALOS_APP_BRIDGE: '1' },
})
setTimeout(() => {
  claude
    .start()
    .then(() => {
      console.log(`\nbridge connected. To add this browser as a device, run in another terminal:\n`)
      console.log(`  TALOS_APP_HOME=${HOME} bun run apps/bridge/src/cli.ts enroll --label dev\n`)
      console.log(`then open the link it prints (it points at ${ORIGIN}).\n`)
    })
    .catch((e) => console.error('bridge failed to start:', e))
}, 2500)

const stop = () => {
  void claude.stop().catch(() => {})
  for (const c of children) c.kill('SIGTERM')
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
