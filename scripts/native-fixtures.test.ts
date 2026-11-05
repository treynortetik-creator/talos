import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const run = (...args: string[]) =>
  spawnSync('node', [join(root, 'scripts/native-fixtures.ts'), ...args], { cwd: root, encoding: 'utf8' })

describe('scripts/native-fixtures.ts', () => {
  it('--check passes against the committed fixtures', () => {
    const r = run('--check')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('--check fails when the committed fixtures differ from the schemas (a schema change)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-fx-'))
    cpSync(join(root, 'packages/protocol/fixtures/native'), dir, { recursive: true })
    const file = join(dir, 'messages.json')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.web_to_native.badge.sample.count = 99 // stand-in for "the schema moved and nobody regenerated"
    delete doc.web_to_native.haptic
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
    const r = run('--check', '--dir', dir)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/native fixtures are out of date/)
  })

  it('--check fails when the fixture directory is missing', () => {
    const r = run('--check', '--dir', join(tmpdir(), 'native-fx-does-not-exist'))
    expect(r.status).toBe(1)
  })

  it('writes then checks clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-fx-'))
    expect(run('--dir', dir).status).toBe(0)
    expect(run('--check', '--dir', dir).status).toBe(0)
  })
})
