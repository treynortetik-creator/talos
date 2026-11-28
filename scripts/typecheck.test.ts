// scripts/typecheck.mjs: the one place that picks the compiler of every typecheck (the gate, CI, each package's `typecheck`).
// Default tsgo (the native compiler); TALOS_TYPECHECK=tsc is the fallback. tsc exits 2 on type errors and tsgo exits 1: both are a failure.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const real = join(here, 'typecheck.mjs')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * A scratch repo root: a copy of the script in scripts/ and fake `tsc` and `tsgo` in node_modules/.bin (the only place the script looks), each recording its
 * name and arguments and exiting with the code asked for. `bins: false` leaves node_modules/.bin empty.
 */
function bin(exits: { tsc?: number; tsgo?: number } = {}, bins = true) {
  const dir = mkdtempSync(join(tmpdir(), 'tc-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'scripts'))
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  copyFileSync(real, join(dir, 'scripts', 'typecheck.mjs'))
  const log = join(dir, 'calls.log')
  for (const name of bins ? (['tsc', 'tsgo'] as const) : []) {
    const f = join(dir, 'node_modules', '.bin', name)
    writeFileSync(f, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${exits[name] ?? 0}\n`)
    chmodSync(f, 0o755)
  }
  return { dir, calls: () => (readFileSync(log, 'utf8') || '').trim().split('\n') }
}
function run(b: { dir: string }, env: Record<string, string | undefined>, args: string[] = [], path?: string) {
  const e: Record<string, string | undefined> = {
    PATH: [path, dirname(process.execPath), '/usr/bin', '/bin'].filter(Boolean).join(delimiter),
    ...env,
  }
  return spawnSync(process.execPath, [join(b.dir, 'scripts', 'typecheck.mjs'), ...args], {
    env: e as NodeJS.ProcessEnv,
    encoding: 'utf8',
  })
}

describe('typecheck.mjs', () => {
  it('runs tsgo by default, with the arguments a package script had', () => {
    const b = bin()
    expect(run(b, {}).status).toBe(0)
    expect(b.calls()).toEqual(['tsgo --noEmit -p tsconfig.json'])
  })
  it('TALOS_TYPECHECK=tsc runs tsc instead', () => {
    const b = bin()
    expect(run(b, { TALOS_TYPECHECK: 'tsc' }).status).toBe(0)
    expect(b.calls()).toEqual(['tsc --noEmit -p tsconfig.json'])
  })
  it('an empty TALOS_TYPECHECK is the default; TALOS_TYPECHECK=tsgo is tsgo', () => {
    for (const v of ['', 'tsgo']) {
      const b = bin()
      run(b, { TALOS_TYPECHECK: v })
      expect(b.calls()).toEqual(['tsgo --noEmit -p tsconfig.json'])
    }
  })
  it('any other value is refused, and no compiler runs', () => {
    const b = bin()
    const r = run(b, { TALOS_TYPECHECK: 'swc' })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('TALOS_TYPECHECK')
    expect(() => readFileSync(join(b.dir, 'calls.log'))).toThrow()
  })
  it('arguments given are passed as they are (typecheck:mod names its own tsconfig)', () => {
    const b = bin()
    run(b, {}, ['-p', 'plugins/talos-app-mod/tsconfig.json'])
    expect(b.calls()).toEqual(['tsgo -p plugins/talos-app-mod/tsconfig.json'])
  })
  it('an exit of 1 (tsgo) or 2 (tsc) with type errors is a failure, for either compiler', () => {
    for (const [which, code] of [
      ['tsgo', 1],
      ['tsc', 2],
      ['tsc', 1],
      ['tsgo', 2],
    ] as const) {
      const b = bin({ [which]: code })
      expect(run(b, { TALOS_TYPECHECK: which }).status, `${which} exit ${code}`).not.toBe(0)
    }
  })
  it('a missing local compiler is a failure, not a pass', () => {
    const b = bin({}, false)
    const r = run(b, {})
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('tsgo')
  })
  it('only the repo\u2019s own node_modules/.bin is used: a tsc or tsgo of another version on PATH never runs', () => {
    const b = bin({}, false)
    const other = mkdtempSync(join(tmpdir(), 'tc-path-'))
    dirs.push(other)
    for (const name of ['tsc', 'tsgo']) {
      writeFileSync(join(other, name), `#!/bin/sh\necho "${name} on PATH" >> "${join(other, 'ran.log')}"\nexit 0\n`)
      chmodSync(join(other, name), 0o755)
    }
    for (const v of ['', 'tsc']) expect(run(b, { TALOS_TYPECHECK: v }, [], other).status).toBe(1)
    expect(() => readFileSync(join(other, 'ran.log'))).toThrow()
  })
})

describe('every workspace package that has a typecheck goes through typecheck.mjs', () => {
  it('apps/*, packages/*, e2e: the script is `node <up>/scripts/typecheck.mjs`, and the root typecheck:mod passes its tsconfig', () => {
    const root = join(here, '..')
    const pkgs = ['e2e', ...['apps', 'packages'].flatMap((d) => readdirSync(join(root, d)).map((n) => join(d, n)))]
    const seen: string[] = []
    for (const p of pkgs) {
      let scripts: Record<string, string> | undefined
      try {
        scripts = (
          JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
        ).scripts
      } catch {}
      if (!scripts?.typecheck) continue
      seen.push(p)
      const up = p
        .split('/')
        .map(() => '..')
        .join('/')
      expect(scripts.typecheck, p).toBe(`node ${up}/scripts/typecheck.mjs`)
    }
    expect(seen).toContain('e2e')
    expect(seen.length).toBeGreaterThanOrEqual(8)
    const rootScripts = (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    ).scripts
    expect(rootScripts['typecheck:mod']).toBe('node scripts/typecheck.mjs -p plugins/talos-app-mod/tsconfig.json')
  })
})
