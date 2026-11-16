// The owner's ruling, 2026-11-14 16:56: "There should be zero Face ID approvals. End of story. Don't ever use those again in the
// app, anywhere, ever." Only sign-in keeps the passkey. This fails if any setting, card or route asks for a passkey step-up again.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as P from '../src/index.ts'

const REPO = join(import.meta.dirname, '..', '..', '..')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) return []
    return statSync(p).isDirectory()
      ? walk(p)
      : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$|\.spec\.tsx?$/.test(n)
        ? [p]
        : []
  })

describe('no passkey step-up anywhere but sign-in', () => {
  it('no setting asks for one', () => {
    for (const [path, row] of Object.entries(P.SETTINGS_TABLE))
      for (const k of ['stepup', 'stepupOnTrue']) expect(k in row, `${path}.${k}`).toBe(false)
  })

  it('no config.patch is told it needs one, whatever it touches', () => {
    for (const entry of P.CONFIG_PATCH_ALLOWLIST) {
      const [top, sub] = entry.split('.') as [string, string | undefined]
      const r = P.checkConfigPatch(sub ? { [top]: { [sub]: null } } : { [top]: null })
      expect(
        Object.keys(r).filter((k) => /step|trust/i.test(k)),
        entry,
      ).toEqual([])
    }
  })

  it('the protocol has no step-up route, purpose, assertion or bridge check', () => {
    for (const name of ['StepupAssertion', 'StepupPurpose', 'StepupToken', 'stepupChallenge', 'STEPUP_BRIDGE_CHECKS'])
      expect(name in P, name).toBe(false)
    for (const r of Object.values(P.routes as Record<string, { path: string }>)) expect(r.path).not.toMatch(/stepup/)
  })

  it('no relay, bridge or web code mints, checks or asks for one', () => {
    const roots = ['apps/relay/src', 'apps/bridge/src', 'apps/web/src', 'packages/protocol/src'].map((d) =>
      join(REPO, d),
    )
    const offenders = roots
      .flatMap(walk)
      .filter((f) =>
        /stepup\/(options|verify)|verifyStepup|requireStepup|mintStepup|stepupChallenge|StepupAssertion/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => f.slice(REPO.length + 1))
    expect(offenders).toEqual([])
  })

  it('a card answer carries "always" in the signed body, never a relay-added field', () => {
    expect(P.UNSIGNED_FIELDS as readonly string[]).not.toContain('always')
    expect(P.SEND_KINDS).toEqual(['email', 'message', 'deploy', 'publish', 'purchase', 'push'])
  })
})
