// scripts/gate-inputs.txt: the gate's own inputs, in ONE place. gate-push.sh's rebase-clean pass (a gate that passed, main moved,
// the rebase was clean and the new commits touch nothing of this change) pushes after the cheap checks only, and only when no new
// commit touches a file listed here. It must fail closed: anything under scripts/ or .github/workflows/ counts, so a gate file
// added later is an input with no edit to the list.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gateTestEnv } from './gate-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const LIST = join(here, 'gate-inputs.txt')
// the patterns as gate-push.sh reads them: every line but comments and blank ones, one extended regex each
const patterns = () =>
  readFileSync(LIST, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
// the same match gate-push.sh makes (grep -E -f), so the test speaks for the script, not for a JS regex dialect
const inputs = (paths: string[]) => {
  const r = spawnSync('bash', ['-c', `grep -E -f <(grep -v '^#' "$1" | grep -v '^[[:space:]]*$')`, 'x', LIST], {
    input: `${paths.join('\n')}\n`,
    env: gateTestEnv(), // nothing from a gate this may run inside
    encoding: 'utf8',
  })
  expect(r.status === 0 || r.status === 1, r.stderr).toBe(true) // 2 would be a pattern grep cannot read
  return r.stdout.split('\n').filter(Boolean)
}

describe('scripts/gate-inputs.txt: what the gate itself runs on', () => {
  it('is there, and every line is a pattern grep -E takes', () => {
    expect(patterns().length).toBeGreaterThan(5)
    for (const p of patterns())
      expect(spawnSync('grep', ['-E', p], { input: '', env: gateTestEnv() }).status, p).not.toBe(2)
  })

  it('anything under scripts/ or .github/workflows/ counts: a gate file added tomorrow is an input already', () => {
    const must = [
      'scripts/gate.sh',
      'scripts/gate-push.sh',
      'scripts/pre-push.sh',
      'scripts/heavy-lock.sh',
      'scripts/ci-local/locks.sh',
      'scripts/a-gate-file-nobody-wrote-yet.sh',
      'scripts/gate-inputs.txt',
      'scripts/size-budget.json',
      '.github/workflows/ci-runner.yml',
      '.github/workflows/new.yml',
    ]
    expect(inputs(must)).toEqual(must)
  })

  it('the root configs the gate runs with, at any depth where a project keeps its own', () => {
    const must = [
      'package.json',
      'apps/web/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'tsconfig.base.json',
      'apps/bridge/tsconfig.json',
      'biome.json',
      'vitest.config.ts',
      'apps/web/playwright.config.ts',
      'e2e/playwright.config.ts',
      '.githooks/pre-push',
      '.nvmrc', // gate.sh's Node major
      'scripts/talos-machine.sh', // gate-push.sh's fleet name
      // the related-test picker's helpers: the bridge suite's own runner, the web specs' port helper the config reads
      'apps/bridge/scripts/test-parallel.ts',
      'apps/web/test/helpers/pw-port.ts',
      // what the runners read beside their configs (Fable round 2)
      'apps/bridge/vitest.contract.config.ts',
      'vitest.run-tmp.ts',
      'apps/web/test/setup-clock.ts',
      'apps/web/vite.config.ts',
      'apps/web/vite.brand.ts',
      'e2e/harness/global-setup.ts',
      '.pnpmfile.cjs', // pnpm runs it on install
      'apps/bridge/test/preload.ts', // bunfig.toml's preload, and what it loads
      'apps/bridge/test/run-tmp.ts',
      'apps/bridge/test/fake-claude.ts',
      '.gitignore', // biome.json lints with it (vcs.useIgnoreFile)
      'apps/web/.gitignore',
      'apps/desktop/Package.swift', // a Swift suite on a landed tree runs the manifest and its plugins
      'apps/mobile/ios/BridgeGuard/Package.swift',
      'apps/desktop/Package.resolved',
      '.gitattributes', // what git writes at checkout (Fable R1-3)
      'apps/web/.gitattributes',
    ]
    expect(inputs(must)).toEqual(must)
  })

  it('product code, tests and words are not the gate', () => {
    expect(
      inputs([
        'apps/web/src/a.ts',
        'apps/bridge/src/bridge.ts',
        'apps/bridge/test/x.test.ts',
        'docs/CI-MACHINES.md',
        'README.md',
        'apps/desktop/Sources/App.swift',
        'myscripts/x.sh', // a folder that only ends in "scripts"
      ]),
    ).toEqual([])
  })

  it('every file gate.sh and gate-push.sh name is an input', () => {
    const named = new Set<string>()
    for (const f of ['gate.sh', 'gate-push.sh']) {
      const text = readFileSync(join(here, f), 'utf8')
      for (const m of text.matchAll(
        /(?:^|[\s"'(=])((?:scripts|apps\/[a-z]+\/scripts)\/[A-Za-z0-9._/-]+\.(?:sh|ts|json|txt|mjs))/g,
      ))
        named.add(m[1] as string)
    }
    expect(named.size).toBeGreaterThan(5)
    expect(inputs([...named]).sort()).toEqual([...named].sort())
  })

  it('gate-push.sh reads this list and fails closed without it', () => {
    const gp = readFileSync(join(here, 'gate-push.sh'), 'utf8')
    expect(gp).toContain('scripts/gate-inputs.txt')
    expect(gp).toMatch(/no gate-inputs list/)
  })
})

// The same list as the handoff checks and the rebase-clean pass read it: through scripts/path-fold.sh, every name folded as a
// Mac's disk folds it, in one node process, every line a case-blind JS regex.
const folded = (paths: string[]) => {
  const out: string[] = []
  for (const p of paths) {
    const r = spawnSync('bash', ['-c', '. "$1" && path_fold inputs "$2"', 'x', join(here, 'path-fold.sh'), LIST], {
      input: `${p}\0`,
      env: gateTestEnv(),
      encoding: 'utf8',
    })
    expect(r.status === 0 || r.status === 1, `${p}: ${r.status} ${r.stderr}`).toBe(true)
    if (r.status === 0) out.push(p)
  }
  return out
}

describe('scripts/gate-inputs.txt as the handoff checks read it (path-fold.sh)', () => {
  it('every line compiles as the case-blind Unicode regex path-fold.sh makes of it', () => {
    for (const p of patterns()) expect(() => new RegExp(p, 'iu'), p).not.toThrow()
  })

  it('agrees with grep -E on plain names, inputs and not', () => {
    const plain = [
      'scripts/gate.sh',
      'scripts/talos-machine.sh',
      'scripts/heavy-lock.sh',
      'scripts/old-client.sh',
      'apps/web/package.json',
      '.githooks/pre-push',
      'tsconfig.json',
      'apps/web/src/a.ts',
      'docs/CI-MACHINES.md',
      'myscripts/x.sh',
    ]
    expect(folded(plain)).toEqual(inputs(plain))
  })

  it('takes what a Mac takes for a gate input: case, the Kelvin sign, the long s, an invisible joiner', () => {
    const look = [
      'Scripts/x.sh',
      'SCRIPTS/gate.sh',
      'apps/new/pac\u212Aage.json',
      'apps/new/package.j\u017Fon',
      '.githoo\u212As/pre-push',
      '\u017Fcripts/gate.sh',
      'Package.JSON',
      'scripts\u200D/x.sh',
      'tsconfig.\u004As\u004FN',
    ]
    expect(folded(look)).toEqual(look)
    expect(folded(['apps/web/src/caf\u00e9.ts', 'apps/web/src/cafe\u0301.ts', 'myscripts/x.sh'])).toEqual([])
  })

  it('holds everything the old five-name handoff regex refused', () => {
    const old =
      /^(scripts\/(gate|gate-push|pre-push|check-no-personal|install-hooks)\.sh|scripts\/denylist\.generic\.txt|scripts\/size-budget\.json|\.githooks\/|pnpm-lock\.yaml|pnpm-workspace\.yaml)|(^|\/)(package\.json|biome\.jsonc?|vitest\.config\.[a-z]+|tsconfig[^/]*\.json|playwright\.config\.[a-z]+)$/i
    const sample = [
      'scripts/gate.sh',
      'scripts/gate-push.sh',
      'scripts/pre-push.sh',
      'scripts/check-no-personal.sh',
      'scripts/install-hooks.sh',
      'scripts/denylist.generic.txt',
      'scripts/size-budget.json',
      '.githooks/pre-push',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'apps/web/package.json',
      'biome.jsonc',
      'apps/web/vitest.config.mts',
      'apps/x/tsconfig.build.json',
      'e2e/playwright.config.ts',
    ]
    for (const p of sample) expect(old.test(p), p).toBe(true)
    expect(folded(sample)).toEqual(sample)
  })

  it('the hook and the landing check read this list, not a list of their own', () => {
    for (const f of ['pre-push.sh', 'gate-push.sh']) {
      const text = readFileSync(join(here, f), 'utf8')
      expect(text, f).toContain('scripts/gate-inputs.txt')
      expect(text, f).toContain('path_fold_range') // every commit's names, matched folded (path-fold.sh)
      expect(text, f).not.toContain('check-no-personal|install-hooks')
    }
  })
})

// scripts/gate-wide-inputs.txt: the part of the list that changes how every test runs. The rebase-clean pass refuses a new main commit
// only for these (any other gate input refuses only on a file this change shares); the handoff checks keep the whole list above.
const WIDE = join(here, 'gate-wide-inputs.txt')
const widePatterns = () =>
  readFileSync(WIDE, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
const wide = (paths: string[]) => {
  const r = spawnSync('bash', ['-c', `grep -E -i -f <(grep -v '^#' "$1" | grep -v '^[[:space:]]*$')`, 'x', WIDE], {
    input: `${paths.join('\n')}\n`,
    env: gateTestEnv(),
    encoding: 'utf8',
  })
  expect(r.status === 0 || r.status === 1, r.stderr).toBe(true)
  return r.stdout.split('\n').filter(Boolean)
}

describe('scripts/gate-wide-inputs.txt: the gate itself and the build and test config', () => {
  it('is there, and every line is a pattern grep -E takes and the case-blind regex path-fold.sh makes', () => {
    expect(widePatterns().length).toBeGreaterThan(10)
    for (const p of widePatterns()) {
      expect(spawnSync('grep', ['-E', p], { input: '', env: gateTestEnv() }).status, p).not.toBe(2)
      expect(() => new RegExp(p, 'iu'), p).not.toThrow()
    }
  })

  it('holds the gate itself and the config that changes how every test runs', () => {
    const must = [
      'scripts/gate.sh',
      'scripts/gate-push.sh',
      'scripts/gate/plan.sh',
      'scripts/gate-inputs.txt',
      'scripts/gate-wide-inputs.txt',
      'scripts/pre-push.sh',
      // every script the gate sources or runs, and the lists and readers it reads
      'scripts/gate-fast.sh',
      'scripts/gate-fast-keepout.txt',
      'scripts/path-fold.sh',
      'scripts/talos-machine.sh',
      'scripts/check-no-personal.sh',
      'scripts/check-ref-personal.sh',
      'scripts/denylist.generic.txt',
      'scripts/gate-excuse.sh',
      'scripts/gate-excuse.pl',
      'scripts/ci-alert-tests.pl',
      'scripts/heavy-lock.sh',
      'scripts/ci-local/locks.sh',
      'scripts/old-client.sh',
      'scripts/web-bundle-manifest.mjs',
      'scripts/tmp-sweep.sh',
      'scripts/tmp-sweep-prefixes.txt',
      'scripts/test-env-clean.ts', // the setup file of the whole scripts project (vitest.config.ts)
      'scripts/size-budget.test.ts',
      'scripts/size-budget.json',
      'scripts/size-report.ts',
      'apps/bridge/scripts/test-parallel.ts',
      '.githooks/pre-push',
      'package.json',
      'apps/web/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
      'apps/bridge/tsconfig.json',
      'biome.json',
      'biome.jsonc',
      'vitest.config.ts',
      'apps/web/vite.config.ts',
      'e2e/playwright.config.ts',
      '.nvmrc',
      '.npmrc',
      '.pnpmfile.cjs',
      'bunfig.toml',
      'apps/web/test/setup-clock.ts',
      'e2e/harness/global-setup.ts',
      'apps/bridge/test/preload.ts',
      'apps/bridge/test/run-tmp.ts',
      'apps/bridge/test/fake-claude.ts',
      'apps/web/test/helpers/pw-port.ts',
      'apps/desktop/Package.swift',
      'apps/desktop/Package.resolved',
      '.gitattributes',
      '.gitignore',
      'apps/web/.gitignore',
      'docs/protected-paths.txt',
    ]
    expect(wide(must)).toEqual(must)
  })

  it('other gate inputs, product code and words are not gate-wide', () => {
    expect(
      wide([
        'scripts/some-other.test.ts',
        'scripts/new-tool.sh',
        'scripts/ci-affected.sh', // the gate does not read it
        'apps/bridge/scripts/install.sh',
        'apps/bridge/scripts/capture-memory.ts',
        '.github/workflows/ci-runner.yml',
        'apps/web/src/a.ts',
        'docs/CI-MACHINES.md',
        'myscripts/gate.sh',
      ]),
    ).toEqual([])
  })

  it('every gate-wide path is also a gate input: it is never outside the whole list', () => {
    const sample = [
      'scripts/gate.sh',
      'scripts/gate/plan.sh',
      'scripts/gate-wide-inputs.txt',
      '.githooks/pre-push',
      'apps/web/package.json',
      'tsconfig.json',
      'vitest.config.ts',
      'apps/bridge/test/preload.ts',
      'docs/protected-paths.txt',
      '.gitignore',
    ]
    expect(wide(sample)).toEqual(sample)
    expect(inputs(sample)).toEqual(sample)
  })

  it('gate-push.sh reads it for the rebase-clean pass and fails closed without it', () => {
    const gp = readFileSync(join(here, 'gate-push.sh'), 'utf8')
    expect(gp).toContain('scripts/gate-wide-inputs.txt')
    expect(gp).toMatch(/no gate-wide list/)
  })
})
