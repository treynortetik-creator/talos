// The owner's ruling, 2026-11-14: "There should be zero Face ID approvals... make sure it's gone from the app everywhere."
// Sign-in keeps its passkey; nothing else in the web app asks for one, names one, or says Face ID. This fails if a card, a
// setting, a revoke or any other screen brings a passkey step back (the protocol side is packages/protocol/test/no-step-up.test.ts).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFakeClient } from '../src/lib/fakeClient.ts'

const WEB = join(import.meta.dirname, '..')
const SRC = join(WEB, 'src')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })

const WORDS = /passkey|face ?id|step-?up/i

/** Where a hit is fine: sign-in itself, and the device list's note about a sign-in passkey shared between devices. */
const ALLOWED: Array<[file: RegExp, line: RegExp]> = [
  [/^features\/auth\//, /./], // sign-in and setup: the passkey lives here
  [/^App\.tsx$/, /features\/auth\/passkeys\.ts/], // the sign-in module's import
  [/^lib\/native\/shell\.ts$/, /sign in with the setup code/], // the shells sign in without a passkey
  // Settings -> Devices: revoking a device does not remove a sign-in passkey another device shares; signing back in uses it
  [
    /^features\/settings\/sections\.tsx$/,
    /shared_passkey|SHARED_PASSKEY|passkey is shared|shares its passkey|A passkey is a separate thing|whose passkey other devices still use|sign back in with your passkey/,
  ],
  // an older relay or Mac may still answer with the two retired error codes: they are read, never asked for
  [/^features\/cards\/CardView\.tsx$/, /'stepup_required'|'stepup_invalid'/],
]

describe('no passkey anywhere in the web app but sign-in', () => {
  it('no source line outside sign-in mentions a passkey, Face ID or a step-up', () => {
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f).split('\\').join('/')
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!WORDS.test(line)) return
          if (ALLOWED.some(([file, ok]) => file.test(rel) && ok.test(line))) return
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(offenders).toEqual([])
  })

  it('the step-up modules are gone, and the client has no step-up method', () => {
    for (const gone of ['lib/stepup.ts', 'lib/passkeyGate.ts', 'lib/confirmLabel.ts'])
      expect(existsSync(join(SRC, gone)), gone).toBe(false)
    expect('stepup' in createFakeClient()).toBe(false)
    const client = readFileSync(join(SRC, 'lib/client.ts'), 'utf8')
    expect(client).not.toMatch(/stepup\(|stepupToken/)
    for (const f of ['lib/socket-client-owner.ts', 'lib/fakeClient.ts'])
      expect(readFileSync(join(SRC, f), 'utf8'), f).not.toMatch(/stepup_token|startAuthentication/)
  })

  it('sign-in still uses its passkey', () => {
    const auth = readFileSync(join(SRC, 'features/auth/passkeys.ts'), 'utf8')
    expect(auth).toMatch(/startAuthentication/)
    expect(auth).toMatch(/export async function signInWithPasskey/)
    expect(readFileSync(join(SRC, 'features/auth/LoginPage.tsx'), 'utf8')).toMatch(/signInWithPasskey/)
  })
})
