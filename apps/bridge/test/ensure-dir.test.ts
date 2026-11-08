// ensureDir makes a folder 0700 and never changes the mode of a folder a link points at.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from '../src/fsutil.ts'

const root = mkdtempSync('/tmp/ed')
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('ensureDir', () => {
  test('makes a folder 0700 and tightens one that exists', () => {
    const d = join(root, 'a', 'b')
    ensureDir(d)
    expect(statSync(d).mode & 0o777).toBe(0o700)
    mkdirSync(join(root, 'loose'), { mode: 0o755 })
    ensureDir(join(root, 'loose'))
    expect(statSync(join(root, 'loose')).mode & 0o777).toBe(0o700)
  })
  test('does not chmod the target of a link', () => {
    const target = join(root, 'target')
    mkdirSync(target, { mode: 0o755 })
    symlinkSync(target, join(root, 'link'))
    ensureDir(join(root, 'link'))
    expect(statSync(target).mode & 0o777).toBe(0o755)
  })
})
