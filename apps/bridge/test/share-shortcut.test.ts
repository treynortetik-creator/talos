// The Shortcut recipe itself (apps/bridge/src/share/shortcut.ts). Structure is checked everywhere; `plutil` and the real
// `shortcuts sign` only on a Mac (signing also needs TALOS_TEST_SHORTCUTS_SIGN=1: it wants an iCloud sign-in).
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildShortcutPlist, exportLabel, signWithShortcutsCli, slug } from '../src/share/shortcut.ts'

const SECRET = `talos_share_${'B'.repeat(43)}`
const spec = { relayUrl: 'https://relay.example.com/', secret: SECRET, files: false, askForNote: true }

describe('share shortcut recipe', () => {
  test('posts the three documented form fields to /api/share with a bearer header, and shows in the share sheet', () => {
    const xml = buildShortcutPlist({ ...spec, files: true })
    expect(xml).toContain('https://relay.example.com/api/share')
    expect(xml).toContain('<string>Authorization</string>')
    expect(xml).toContain(`<string>Bearer ${SECRET}</string>`)
    for (const k of ['text', 'file', 'note']) expect(xml).toContain(`<string>${k}</string>`)
    expect(xml).toContain('<string>ActionExtension</string>')
    expect(xml).toContain('WFGenericFileContentItem')
  })

  test('text-only: no file field; no note prompt when asked not to', () => {
    const xml = buildShortcutPlist({ ...spec, askForNote: false })
    expect(xml).not.toContain('<string>file</string>')
    expect(xml).not.toContain('<string>note</string>')
    expect(xml).not.toContain('is.workflow.actions.ask')
  })

  test('nothing in the recipe can ask for more than untrusted Inbox data', () => {
    const xml = buildShortcutPlist({ ...spec, files: true }).toLowerCase()
    expect(xml).not.toMatch(/trusted|owner|thread/)
  })

  test('XML-escapes everything it writes', () => {
    expect(buildShortcutPlist({ ...spec, relayUrl: 'https://r.example.com/?a=1&b=<2>' })).toContain(
      'a=1&amp;b=&lt;2&gt;',
    )
  })

  test('labels: suffix with the date, cut to 40 characters; slug is file-safe', () => {
    expect(exportLabel('iPhone', '2026-10-29')).toBe('iPhone (exported 2026-10-29)')
    expect(exportLabel('', '2026-10-29')).toBe('iPhone (exported 2026-10-29)')
    expect(exportLabel('y'.repeat(99), '2026-10-29')).toHaveLength(40)
    expect(slug('My iPhone / 15!')).toBe('my-iphone-15')
    expect(slug('///')).toBe('share')
  })

  test.skipIf(process.platform !== 'darwin')('plutil accepts the property list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-shortcut-'))
    const f = join(dir, 'r.plist')
    writeFileSync(f, buildShortcutPlist({ ...spec, files: true }))
    const p = Bun.spawn(['plutil', '-lint', f], { stdout: 'pipe', stderr: 'pipe' })
    expect(await p.exited).toBe(0)
  })

  test.skipIf(process.platform !== 'darwin' || process.env.TALOS_TEST_SHORTCUTS_SIGN !== '1')(
    '`shortcuts sign --mode anyone` accepts it and writes a signed file',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'talos-shortcut-'))
      const input = join(dir, 'r.unsigned.shortcut')
      const output = join(dir, 'r.shortcut')
      writeFileSync(input, buildShortcutPlist({ ...spec, files: true }))
      expect(await signWithShortcutsCli(input, output)).toEqual({ ok: true })
      expect(readFileSync(output).length).toBeGreaterThan(100)
    },
  )
})
