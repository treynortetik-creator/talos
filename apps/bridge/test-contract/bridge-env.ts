// The environment every contract harness gives the real bridge process it spawns, and the one folder that holds what that
// bridge may touch. Nothing a contract bridge reads or writes is under the owner's real home: its HOME, inbox, Claude folder and
// Chronos are all under `root`, and the bridge refuses a Chronos outside it (TALOS_TEST_ROOT).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNotRealHome, isolatedBridgeEnv } from '@talos-app/testkit'
import { afterAll } from 'vitest'

const roots = new Set<string>()
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots.clear()
})

/** A throw-away folder for one bridge and its home. Removed by `removeRoot`, and at the end of the file if a test never got there. */
export function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'talos-contract-'))
  roots.add(root)
  return root
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
  roots.delete(root)
}

/** A folder somebody else removes (a Chronos box): swept at the end of the file all the same if it is still there. */
export function sweepAtEnd(root: string): void {
  roots.add(root)
}

export function bridgeEnv(
  home: string,
  relayHttp: string,
  root: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env = {
    TALOS_APP_HOME: home,
    TALOS_APP_RELAY_URL: relayHttp,
    TALOS_APP_BRIDGE: '1',
    ...isolatedBridgeEnv(root),
    ...extra,
  }
  // the safety net: a contract bridge whose HOME is the owner's real home fails the run before it starts
  assertNotRealHome({ ...process.env, ...env }, 'contract harness')
  return env
}
