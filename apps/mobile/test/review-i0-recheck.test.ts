// Second round of regression checks for the iOS shell.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MOBILE = fileURLToPath(new URL('..', import.meta.url))

describe('the Capacitor CLI can load capacitor.config.ts', () => {
  // The CLI transpiles the config to CommonJS and runs it under "type": "module". Any `import.meta` in the file makes
  // Node treat the output as ESM, so it fails with "exports is not defined in ES module scope" and `cap sync` stops.
  // Vitest imports the file as ESM, so config.test.ts can't see this.
  it('`cap config --json` resolves server.url from TALOS_RELAY_URL', () => {
    const out = execFileSync('npx', ['cap', 'config', '--json'], {
      cwd: MOBILE,
      env: { ...process.env, TALOS_RELAY_URL: 'https://relay.example.test' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    expect(out).not.toMatch(/Parsing capacitor\.config\.ts failed/)
    expect(out).toMatch(/"url":\s*"https:\/\/relay\.example\.test"/)
  }, 90_000)
})
