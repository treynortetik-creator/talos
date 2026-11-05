// History hardening: unique names, a tight folder, and CLI-side logging.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveConfigVersion } from '../src/config-history.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfh'))
  writeFileSync(join(dir, 'config.json'), '{"a":1}')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const hist = () => join(dir, 'config-history')

describe('config history hardening', () => {
  test('two saves in the same millisecond keep both versions', () => {
    const now = () => 1_700_000_000_000
    saveConfigVersion({ configPath: join(dir, 'config.json'), dir: hist(), now })
    writeFileSync(join(dir, 'config.json'), '{"a":2}')
    saveConfigVersion({ configPath: join(dir, 'config.json'), dir: hist(), now })
    const seen = readdirSync(hist()).map((f) => readFileSync(join(hist(), f), 'utf8'))
    expect(seen.sort()).toEqual(['{"a":1}', '{"a":2}'])
  })

  test('an existing 0755 folder becomes 0700 on write', () => {
    mkdirSync(hist(), { mode: 0o755 })
    chmodSync(hist(), 0o755)
    saveConfigVersion({ configPath: join(dir, 'config.json'), dir: hist() })
    expect(statSync(hist()).mode & 0o777).toBe(0o700)
  })

  test('names are <stamp>-<pid>-<random>.json', () => {
    saveConfigVersion({ configPath: join(dir, 'config.json'), dir: hist() })
    expect(readdirSync(hist())[0]).toMatch(new RegExp(`^\\d{8}T\\d{9}Z-${process.pid}-[a-z0-9]+\\.json$`))
  })

  test('trimming keeps the newest 20 by mtime, then name', () => {
    for (let i = 0; i < 25; i++) {
      writeFileSync(join(dir, 'config.json'), `{"n":${i}}`)
      saveConfigVersion({ configPath: join(dir, 'config.json'), dir: hist(), now: () => 1_700_000_000_000 })
    }
    const seen = readdirSync(hist()).map((f) => JSON.parse(readFileSync(join(hist(), f), 'utf8')).n)
    expect(seen).toHaveLength(20)
    expect(Math.min(...seen)).toBe(5)
  })
})
