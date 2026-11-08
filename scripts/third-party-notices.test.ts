// Every production dependency of the shipped apps (apps/web, and the Capacitor packages in apps/mobile) must be named in
// THIRD_PARTY_NOTICES.md. Reads two files, builds nothing. The full list of what the web bundle really contains comes
// from a build: `node scripts/third-party-web.ts --check` (see that script).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')

function prodDeps(app: string): string[] {
  const j = JSON.parse(readFileSync(join(ROOT, app, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  return Object.entries(j.dependencies ?? {})
    .filter(([, range]) => !range.startsWith('workspace:'))
    .map(([name]) => name)
}

describe('THIRD_PARTY_NOTICES.md', () => {
  it.each([...prodDeps('apps/web'), ...prodDeps('apps/mobile')])('names the production dependency %s', (name) => {
    expect(notices, `${name} is a production dependency but THIRD_PARTY_NOTICES.md never names it`).toContain(name)
  })

  it('keeps the generated section between its markers', () => {
    expect(notices).toContain('<!-- BEGIN bundled-npm')
    expect(notices).toContain('<!-- END bundled-npm -->')
  })
})
