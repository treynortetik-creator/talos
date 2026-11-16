// fake-tool.ts: the same fake is one shared file however many tests link it, a changed fake is a new file, and a test that
// replaces one of its tools never changes what another test's link runs.
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { fakeTool } from './fake-tool'

const T = mkdtempSync(join(tmpdir(), 'fake-tool-'))
afterAll(() => rmSync(T, { recursive: true, force: true }))
const bin = (n: string) => {
  const d = join(T, n)
  mkdirSync(d)
  return d
}
const run = (p: string) => spawnSync(p, { encoding: 'utf8' }).stdout

it('links the same content to one shared file, runs it, and gives changed content a file of its own', () => {
  const a = bin('a')
  const b = bin('b')
  const one = `#!/bin/sh\necho one-${process.pid}\n`
  fakeTool(a, 'gh', one)
  fakeTool(b, 'gh', one)
  expect(lstatSync(join(a, 'gh')).isSymbolicLink()).toBe(true)
  expect(readlinkSync(join(a, 'gh'))).toBe(readlinkSync(join(b, 'gh')))
  expect(run(join(a, 'gh'))).toBe(`one-${process.pid}\n`)

  // replacing a tool in one bin relinks it; the other bin still runs the first
  fakeTool(a, 'gh', `#!/bin/sh\necho two-${process.pid}\n`)
  expect(readlinkSync(join(a, 'gh'))).not.toBe(readlinkSync(join(b, 'gh')))
  expect(run(join(a, 'gh'))).toBe(`two-${process.pid}\n`)
  expect(run(join(b, 'gh'))).toBe(`one-${process.pid}\n`)
})
