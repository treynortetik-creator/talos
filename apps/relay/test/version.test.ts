import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('../../../scripts/version.mjs', import.meta.url))
const run = (env: Record<string, string>) =>
  execFileSync('node', [script], { env: { PATH: process.env.PATH ?? '', ...env } })
    .toString()
    .trim()

describe('build version', () => {
  it('APP_VERSION wins, then the platform commit sha, and it is never 0.0.0', () => {
    expect(run({ APP_VERSION: 'v1.2.3', RAILWAY_GIT_COMMIT_SHA: 'abcdef123456' })).toBe('v1.2.3')
    expect(run({ RAILWAY_GIT_COMMIT_SHA: 'abcdef123456' })).toBe('abcdef1')
    expect(run({})).not.toBe('0.0.0')
  })
})
