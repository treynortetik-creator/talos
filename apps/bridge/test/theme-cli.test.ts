// `talos-app theme reset|show`: the Mac's way back to the default theme.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STOCK_THEMES } from '@talos-app/protocol'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { paths } from '../src/config.ts'
import { cmdTheme } from '../src/theme-cli.ts'

function setup(theme: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'talos-theme-'))
  const env = { home } as never
  const p = paths(home).configJson
  writeFileSync(p, JSON.stringify({ ...defaultConfig, ...(theme === undefined ? {} : { theme }) }))
  const lines: string[] = []
  const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }
  return { env, p, lines, io }
}

describe('talos-app theme', () => {
  test('reset removes a custom theme from config and show says so', () => {
    const s = setup({ ...STOCK_THEMES[2], name: 'dusk' })
    expect(cmdTheme(s.env, ['show'], s.io)).toBe(0)
    expect(s.lines.at(-1)).toBe('theme: custom "dusk"')
    expect(cmdTheme(s.env, ['reset'], s.io)).toBe(0)
    expect('theme' in JSON.parse(readFileSync(s.p, 'utf8'))).toBe(false)
    cmdTheme(s.env, ['show'], s.io)
    expect(s.lines.at(-1)).toBe('theme: talos')
  })
  test('reset on the default is a no-op, and bad usage exits 2', () => {
    const s = setup(undefined)
    expect(cmdTheme(s.env, ['reset'], s.io)).toBe(0)
    expect(cmdTheme(s.env, ['wipe'], s.io)).toBe(2)
    expect(cmdTheme(s.env, [], s.io)).toBe(2)
  })
})
