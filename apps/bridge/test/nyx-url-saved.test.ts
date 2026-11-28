// Nyx's address (memory.nyx_url) is checked again where it is saved: the Mac's config file takes an https address from the
// owner's signed patch, refuses http, javascript: and spaces with the field named, and has no address of its own until one is set.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigFile } from '../src/config-file.ts'

const defaults = JSON.parse(readFileSync(join(import.meta.dir, '../../../examples/config.default.json'), 'utf8'))

let dir: string
let file: ConfigFile
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'talos-nyx-url-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify(defaults))
  file = new ConfigFile(join(dir, 'config.json'))
  file.load()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('memory.nyx_url in the config file', () => {
  test('starts with no address', () => {
    expect(file.config.memory?.nyx_url).toBeUndefined()
  })

  test('an https address is saved, kept across a reload, and cleared by null', () => {
    const r = file.applyPatch(0, { memory: { nyx_url: 'https://nyx.example.com' } })
    expect(r.ok).toBe(true)
    const again = new ConfigFile(join(dir, 'config.json'))
    again.load()
    expect(again.config.memory?.nyx_url).toBe('https://nyx.example.com/')
    const cleared = again.applyPatch(again.config.rev, { memory: { nyx_url: null } })
    expect(cleared.ok).toBe(true)
    expect(again.config.memory?.nyx_url).toBeUndefined()
  })

  test.each([
    ['http://nyx.example.com'],
    ['javascript:alert(1)'],
    ['https://nyx.example.com/a b'],
    [' https://nyx.example.com'],
    [`https://user:pw${'@'}nyx.example.com`],
    [7],
  ])('%j is refused, the field named, and nothing is written', (bad) => {
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    const r = file.applyPatch(0, { memory: { nyx_url: bad } })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('config_field_forbidden')
      expect(JSON.stringify(r)).toContain('memory.nyx_url')
    }
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before)
    expect(file.config.rev).toBe(0)
  })

  test('another key of memory is not open', () => {
    const r = file.applyPatch(0, { memory: { other: 'x' } })
    expect(r.ok).toBe(false)
  })
})
