// The sandbox's relay: the built relay bundle, bound to 127.0.0.1 only, on the port and data folder of one sandbox.
//   node e2e/sandbox/relay-main.ts <sandbox root>
// The production entry point listens on every interface; this one never does. Settings come from <root>/relay.json, so a
// restart (`drive <id> online`) comes back with the same database and keys.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RELAY_DIST } from '../harness/paths.ts'

type RelayModule = typeof import('../../apps/relay/src/index.ts')

const root = process.argv[2]
if (!root) {
  console.error('usage: relay-main.ts <sandbox root>')
  process.exit(2)
}
const settings = JSON.parse(readFileSync(join(root, 'relay.json'), 'utf8')) as {
  port: number
  env: Record<string, string>
}
const mod = (await import(pathToFileURL(RELAY_DIST).href)) as RelayModule
const relay = await mod.startRelay({ env: mod.loadEnv(settings.env), port: settings.port, host: '127.0.0.1' })
console.log(JSON.stringify({ t: new Date().toISOString(), event: 'relay_listening', port: settings.port }))
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  setTimeout(() => process.exit(1), 8000).unref()
  void relay.stop().then(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
