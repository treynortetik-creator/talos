import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeTestTempDirs, testTempDir } from './temp-dirs.ts'

describe('test temp folders', () => {
  test('a folder is made under $TMPDIR and removed with its contents, even one a test locked down', () => {
    const dir = testTempDir('talos-tempdirs-')
    expect(existsSync(dir)).toBe(true)
    mkdirSync(join(dir, 'locked'))
    writeFileSync(join(dir, 'locked', 'f'), 'x')
    chmodSync(join(dir, 'locked'), 0o000)
    removeTestTempDirs()
    expect(existsSync(dir)).toBe(false)
  })

  test('folders made by this file stay while this file runs', () => {
    const a = testTempDir('talos-tempdirs-')
    const b = testTempDir('talos-tempdirs-')
    expect([existsSync(a), existsSync(b)]).toEqual([true, true])
  })
})
