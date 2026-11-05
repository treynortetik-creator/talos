// @vitest-environment node
// The rule that keeps third-party pages in an opaque origin, enforced on the source: one component builds iframes,
// its attributes are fixed, and nothing in the app names a sandbox token that would widen them.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(import.meta.dirname, '../../src')
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
const all = files(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }))
const code = (t: string) => t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('sandbox lint', () => {
  it('no source file names a sandbox token that widens allow-scripts', () => {
    const bad =
      /allow-(same-origin|popups|forms|modals|downloads|top-navigation|presentation|pointer-lock|orientation-lock|storage-access)/
    expect(all.filter((f) => bad.test(code(f.text))).map((f) => f.path)).toEqual([])
  })

  it('only ui/SandboxedFrame.tsx creates an iframe, and none uses srcdoc', () => {
    const makers = all.filter((f) => /<iframe|createElement\(\s*['"]iframe/.test(code(f.text))).map((f) => f.path)
    expect(makers).toEqual(['ui/SandboxedFrame.tsx'])
    expect(all.filter((f) => /srcDoc|srcdoc/i.test(code(f.text))).map((f) => f.path)).toEqual([])
  })

  it('SandboxedFrame fixes sandbox, referrer policy and permissions, and accepts no rest props', () => {
    const t = code(all.find((f) => f.path === 'ui/SandboxedFrame.tsx')?.text ?? '')
    expect(t).toMatch(/SANDBOX_ATTR = 'allow-scripts'/)
    expect(t).toMatch(/sandbox=\{SANDBOX_ATTR\}/)
    expect(t).toMatch(/referrerPolicy="no-referrer"/)
    expect(t).not.toMatch(/\ballow=/)
    expect(t).not.toMatch(/\.\.\.(props|rest)/)
  })

  it('app views load /media/:id/app and previews /media/:id/page, never the other way round', () => {
    const card = code(all.find((f) => f.path === 'features/apps/AppViewCard.tsx')?.text ?? '')
    const att = code(all.find((f) => f.path === 'features/threads/Attachments.tsx')?.text ?? '')
    expect(card).toMatch(/mediaAppUrl/)
    expect(card).not.toMatch(/mediaPageUrl/)
    expect(att).toMatch(/mediaPageUrl/)
    expect(att).not.toMatch(/mediaAppUrl/)
  })

  it('the host never reaches the frame by any route but postMessage to its window', () => {
    for (const f of all.filter((x) => x.path.startsWith('features/apps/'))) {
      const t = code(f.text)
      expect(t, f.path).not.toMatch(
        /contentDocument|\.contentWindow\.(document|location|eval)|srcdoc|\.innerHTML|dangerouslySetInnerHTML/,
      )
    }
  })
})
