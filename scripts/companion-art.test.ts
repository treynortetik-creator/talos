import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// C-ART: the desktop companion's sprite atlases (apps/desktop/Resources/companion). The checks are Python
// (assets/mascot/3d/tools: Pillow, numpy, scipy; pip install -r assets/mascot/3d/requirements.txt).
//
// Which machines run them: any machine that has the deps (CI installs them), and any change to the art or its tools. A machine WITHOUT the
// deps checking a change that does not touch the art skips these cases, visibly, so one missing pip package never reds every PR. If the art
// did change and the deps are missing, the first case FAILS with the reason: the atlases can never ship unchecked. TALOS_ART_PYTHON picks
// the interpreter (default python3). On a CI runner (GITHUB_ACTIONS=true) that lacks the deps while the art changed, they are installed once
// into a venv (TALOS_ART_VENV, default ~/.cache/talos-ci/art-venv) and used from then on, because the self-hosted runner's scripts come from
// the base branch and cannot install them for the PR that needs them; an install that fails leaves the first case failing with pip's reason.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tools = join(root, 'assets/mascot/3d/tools')
const DEPS = 'import PIL, numpy, scipy'
let python = process.env.TALOS_ART_PYTHON || 'python3'
const py = (...args: string[]) => spawnSync(python, args, { cwd: root, encoding: 'utf8' })

let depsOk = py('-c', DEPS).status === 0

/** true when the working tree or the branch changed the atlases or their tooling (or when git cannot say, which counts as changed on a branch) */
function artChanged(): boolean {
  const paths = ['apps/desktop/Resources/companion', 'assets/mascot/3d', 'scripts/companion-art.test.ts']
  const git = (...a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' })
  const dirty = git('status', '--porcelain', '--', ...paths)
  if (dirty.status === 0 && dirty.stdout.trim() !== '') return true
  for (const base of ['origin/main', 'main']) {
    const mb = git('merge-base', 'HEAD', base)
    if (mb.status !== 0) continue
    const diff = git('diff', '--name-only', mb.stdout.trim(), 'HEAD', '--', ...paths)
    return diff.status === 0 && diff.stdout.trim() !== ''
  }
  return false
}

/** a runner without the deps: make a venv with them (idempotent; the venv is reused by the next run). Returns its python, or null. */
function runnerVenv(): string | null {
  const venv = process.env.TALOS_ART_VENV || join(homedir(), '.cache/talos-ci/art-venv')
  const vpy = join(venv, 'bin/python3')
  const works = () => existsSync(vpy) && spawnSync(vpy, ['-c', DEPS]).status === 0
  if (works()) return vpy
  if (!existsSync(vpy)) spawnSync('python3', ['-m', 'venv', venv], { encoding: 'utf8', timeout: 120_000 })
  const reqs = join(root, 'assets/mascot/3d/requirements.txt')
  spawnSync(vpy, ['-m', 'pip', 'install', '--quiet', '-r', reqs], { encoding: 'utf8', timeout: 300_000 })
  return works() ? vpy : null
}

const onRunner = process.env.GITHUB_ACTIONS === 'true' && !process.env.TALOS_ART_PYTHON
if (!depsOk && onRunner && artChanged()) {
  const vpy = runnerVenv()
  if (vpy) {
    python = vpy
    depsOk = true
  }
}

const mustRun = depsOk || artChanged()
const runIf = mustRun ? it : it.skip
if (!mustRun)
  console.warn(
    'companion-art: Pillow/numpy/scipy not found and the art is unchanged, so its checks are skipped (see the file header)',
  )

const unit = (): Promise<{ status: number | null; stderr: string }> =>
  new Promise((resolve) => {
    // async, not spawnSync: a slow run must not block the worker thread past the test's own timeout
    const p = spawn(python, ['-W', 'ignore', '-m', 'unittest', 'discover', '-s', tools, '-p', 'test_atlas.py'], {
      cwd: root,
    })
    let stderr = ''
    p.stderr.on('data', (d) => {
      stderr += d
    })
    p.on('close', (status) => resolve({ status, stderr }))
  })

describe('companion art (assets/mascot/3d/tools)', () => {
  it('the python deps the checks need are installed (always asked when the art changed)', () => {
    if (!mustRun) return
    const r = py('-c', DEPS)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  runIf('check_atlas.py passes on the committed Resources/companion', () => {
    const r = py(join(tools, 'check_atlas.py'), '--quiet')
    expect(r.stdout).toMatch(/\d+ passed, 0 failed/)
    expect(r.status).toBe(0)
  })

  runIf('check_atlas.py fails (exit 1) on a directory with no manifest', () => {
    const r = py(join(tools, 'check_atlas.py'), '--quiet', join(root, 'assets/mascot'))
    expect(r.status).not.toBe(0)
  })

  runIf('the unit tests, including every case that must go red on broken art, pass', { timeout: 240_000 }, async () => {
    const r = await unit()
    expect(r.stderr).toMatch(/OK/)
    expect(r.status).toBe(0)
  })
})
