import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const RELAY_DIST = join(ROOT, 'apps', 'relay', 'dist', 'index.js')
// E2E_WEB_DIST serves another built web app instead, the saved bundle of the old-client step (scripts/old-client.sh).
export const WEB_DIST = process.env.E2E_WEB_DIST ? resolve(process.env.E2E_WEB_DIST) : join(ROOT, 'apps', 'web', 'dist')
export const BRIDGE_DIR = join(ROOT, 'apps', 'bridge')
export const BRIDGE_SERVER = join(BRIDGE_DIR, 'src', 'server.ts')
export const BRIDGE_CLI = join(BRIDGE_DIR, 'src', 'cli.ts')
export const STUBS_DIR = join(ROOT, 'e2e', 'harness', 'stubs')
