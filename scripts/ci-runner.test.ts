// scripts/ci-runner.sh (the glue for .github/workflows/ci-runner.yml) and the workflow files themselves. The script is tested by
// running it, with a fake `gh`, `caffeinate`, `sysctl` and tools on the PATH and a fake ci-local.sh that writes down how it was
// called. The workflows are plain text, so what is checked is what they say: their triggers, their token, their pins.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { RUNNER_VARS } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const script = join(here, 'ci-runner.sh')
// The self-hosted runner workflow is left out of the public export (a public repository should not hand pull requests to a
// self-hosted runner), so the tests that read it run only where the file exists.
const runnerYmlPath = join(root, '.github/workflows/ci-runner.yml')
const hasRunnerYml = existsSync(runnerYmlPath)
const runnerYml = hasRunnerYml ? readFileSync(runnerYmlPath, 'utf8') : ''
const itRunnerYml = hasRunnerYml ? it : it.skip
const ciYml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'cir-'))
  dirs.push(d)
  return d
}
/** A bin dir of fake tools: each is a bash body. */
function bin(tools: Record<string, string>) {
  const b = scratch()
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(b, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(b, name), 0o755)
  }
  return b
}
const CLEAN = ['PATH', 'TMPDIR'] // nothing of the real environment's GitHub or CI settings leaks in
function env(extra: Record<string, string> = {}, path?: string): Record<string, string> {
  const e: Record<string, string> = {}
  for (const k of CLEAN) if (process.env[k]) e[k] = process.env[k] as string
  if (path) e.PATH = `${path}:${e.PATH}`
  return { ...e, ...extra }
}
function sh(code: string, extra: Record<string, string> = {}, path?: string) {
  const r = spawnSync('bash', ['-c', `. "${script}"\n${code}`], { env: env(extra, path), encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
function run(sub: string, extra: Record<string, string> = {}, path?: string, scriptPath = script) {
  const r = spawnSync('bash', [scriptPath, sub], { env: env(extra, path), encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const SHA = 'a'.repeat(40)
const prEnv = {
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REPOSITORY: 'owner/talos-app',
  PR_NUMBER: '12',
  PR_HEAD_SHA: SHA,
  PR_HEAD_REPO: 'owner/talos-app',
}

describe('a test never inherits the outer run', () => {
  // The suites run inside a ci-runner.yml job, so every variable that workflow sets is in their environment; a copy of
  // ci-runner.sh or ci-local.sh under test that read one (CI_PLAN_SHA, say) would test or post for the real commit.
  itRunnerYml('cleanEnv drops every variable ci-runner.yml sets', () => {
    const set = [...new Set([...runnerYml.matchAll(/^ +([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]))]
    expect(set.length).toBeGreaterThan(10)
    expect(set.filter((k) => !(RUNNER_VARS as readonly string[]).includes(k))).toEqual([])
  })
})

describe('ci-runner.sh guard: only same-repo PRs and plain refs', () => {
  it('lets a same-repo PR and a plain dispatch through', () => {
    expect(run('guard', prEnv).code).toBe(0)
    expect(run('guard', { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: 'ci/runner-test' }).code).toBe(0)
    expect(run('guard', { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: 'v1.2.3' }).code).toBe(0)
    expect(run('guard', { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: SHA }).code).toBe(0)
  })

  it('refuses a fork, with the reason, whatever the case of the names', () => {
    const r = run('guard', { ...prEnv, PR_HEAD_REPO: 'someone/talos-app' })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/refusing: PR #12 comes from 'someone\/talos-app', not from owner\/talos-app/)
    // A fork with the same repository name, and a name that only differs by what is appended.
    expect(run('guard', { ...prEnv, PR_HEAD_REPO: 'owner/talos-app-fork' }).code).toBe(1)
    expect(run('guard', { ...prEnv, PR_HEAD_REPO: 'OWNER/Talos-App' }).code).toBe(0) // GitHub names are case-insensitive
  })

  it('fails closed on a deleted fork (no head repo), a bad number, a short or odd sha, an unknown event', () => {
    expect(run('guard', { ...prEnv, PR_HEAD_REPO: '' }).code).toBe(1)
    expect(run('guard', { ...prEnv, PR_NUMBER: '12; id' }).code).toBe(1)
    expect(run('guard', { ...prEnv, PR_NUMBER: '' }).code).toBe(1)
    expect(run('guard', { ...prEnv, PR_HEAD_SHA: 'abc123' }).code).toBe(1)
    expect(run('guard', { ...prEnv, PR_HEAD_SHA: `${'a'.repeat(39)}; ` }).code).toBe(1)
    expect(run('guard', { ...prEnv, GITHUB_EVENT_NAME: 'pull_request_target' }).code).toBe(1)
    expect(run('guard', { ...prEnv, GITHUB_EVENT_NAME: 'push' }).code).toBe(1)
    expect(run('guard', { ...prEnv, GITHUB_REPOSITORY: '' }).code).toBe(1)
  })

  it('refuses a dispatch ref that could be an option or a command', () => {
    for (const ref of [
      '',
      '--help',
      '-x',
      'a b',
      'a;b',
      '$(id)',
      '`id`',
      'a..b',
      'a//b',
      "a'b",
      'a\nb',
      'x'.repeat(201),
    ]) {
      const r = run('guard', { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: ref })
      expect(r.code, JSON.stringify(ref)).toBe(1)
    }
  })
})

describe('ci-runner.sh guard: the nightly schedule tests main, as a full sha', () => {
  const nightly = {
    GITHUB_EVENT_NAME: 'schedule',
    GITHUB_REPOSITORY: 'owner/talos-app',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: SHA,
  }
  it('lets the schedule on main through', () => {
    expect(run('guard', nightly).code).toBe(0)
  })
  it('refuses another ref, a short or odd sha, and no repository', () => {
    expect(run('guard', { ...nightly, GITHUB_REF: 'refs/heads/feat/x' }).code).toBe(1)
    expect(run('guard', { ...nightly, GITHUB_SHA: SHA.slice(0, 7) }).code).toBe(1)
    expect(run('guard', { ...nightly, GITHUB_SHA: `${SHA.slice(1)};` }).code).toBe(1)
    expect(run('guard', { ...nightly, GITHUB_REPOSITORY: '' }).code).toBe(1)
  })
  it('refuses an event it does not know', () => {
    expect(run('guard', { ...nightly, GITHUB_EVENT_NAME: 'workflow_run' }).code).toBe(1)
  })
})

describe('ci-runner.sh guard: a push is tested only when it made refs/heads/main', () => {
  const push = {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: 'owner/talos-app',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: SHA,
  }
  it('lets a push to main through', () => {
    expect(run('guard', push).code).toBe(0)
  })
  it('refuses any other ref, a tag called main, and a missing ref, with the reason', () => {
    for (const ref of [
      'refs/heads/feat/x',
      'refs/heads/main2',
      'refs/heads/main/x',
      'refs/tags/main',
      'main',
      'refs/pull/12/merge',
      '',
    ]) {
      const r = run('guard', { ...push, GITHUB_REF: ref })
      expect(r.code, JSON.stringify(ref)).toBe(1)
      expect(r.err, JSON.stringify(ref)).toContain('only refs/heads/main')
    }
  })
  it('refuses a pushed commit that is not a full lowercase sha, or no repository', () => {
    for (const sha of ['', 'abc123', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(39)};`, 'main']) {
      expect(run('guard', { ...push, GITHUB_SHA: sha }).code, JSON.stringify(sha)).toBe(1)
    }
    expect(run('guard', { ...push, GITHUB_REPOSITORY: '' }).code).toBe(1)
  })
})

describe('ci-runner.sh guard: the optional job list of a dispatch', () => {
  const d = { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: 'feat/x' }
  it('takes a comma list of names, or nothing', () => {
    expect(run('guard', { ...d, INPUT_JOBS: '' }).code).toBe(0)
    expect(run('guard', { ...d, INPUT_JOBS: 'desktop' }).code).toBe(0)
    expect(run('guard', { ...d, INPUT_JOBS: 'check,browser,mobile' }).code).toBe(0)
  })
  it('refuses anything that could be an option or a command', () => {
    for (const j of ['--keep', 'a b', 'a;b', '$(id)', ',a', 'a,', 'a,,b', 'A', 'a\nb', 'a-b']) {
      expect(run('guard', { ...d, INPUT_JOBS: j }).code, JSON.stringify(j)).toBe(1)
    }
  })
  it('refuses a name that is not one of the six jobs (a typo would leave a red local-ci/<typo> on the commit)', () => {
    for (const j of ['dekstop', 'desktop,mobil', 'nope', 'checks']) {
      const r = run('guard', { ...d, INPUT_JOBS: j })
      expect(r.code, j).toBe(1)
      expect(r.err, j).toContain('is not a job')
    }
  })
  it('knows exactly the jobs ci-local.sh runs by default', () => {
    const local = readFileSync(join(here, 'ci-local.sh'), 'utf8')
    const all = /^PR="" REF="" JOBS="([a-z,]+)"/m.exec(local)?.[1] ?? ''
    expect(all.split(',')).toHaveLength(6)
    for (const j of all.split(',')) expect(run('guard', { ...d, INPUT_JOBS: j }).code, j).toBe(0)
  })
})

describe('ci-runner.sh tools: use what the runner has where the version matches the pin', () => {
  // The fake tools are shell functions, not files: macOS checks every newly written executable the first time it runs (0.4 to
  // 1.7 s each here, far more under load), and a fresh fake bin per call made this block time out under the full suite. A
  // function shadows a command of the same name on PATH, as a fake bin first on PATH did.
  const tool = (v: string) => `echo "${v}"`
  // A missing tool is a stub that cannot run: it shadows any copy in /usr/bin (a Linux package manager puts node, bun and pnpm there)
  const missing = 'return 127'
  const have = (node: string | null, bun: string | null, pnpm: string | null) =>
    [
      `node() { ${node ? tool(`v${node}`) : missing}; }`,
      `bun() { ${bun ? tool(bun) : missing}; }`,
      `pnpm() { ${pnpm ? tool(pnpm) : missing}; }`,
    ].join('\n')
  // The functions alone decide which tool is there and at which version.
  const needs = (fakes: string) => {
    const r = spawnSync('bash', ['-c', `${fakes}\n. "${script}"; ci_tools "${root}"`], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    })
    return Object.fromEntries(
      r.stdout
        .trim()
        .split('\n')
        .map((l) => l.split('=')),
    )
  }
  const pins = {
    node: readFileSync(join(root, '.nvmrc'), 'utf8').trim().replace(/^v/, ''),
    bun: /bun-version: ([\d.]+)/.exec(ciYml)?.[1] as string,
    pnpm: /"packageManager": "pnpm@([\d.]+)/.exec(readFileSync(join(root, 'package.json'), 'utf8'))?.[1] as string,
  }
  const nodeOk = pins.node.includes('.') ? pins.node : `${pins.node}.13.0` // a pin of "24" means any 24.x

  it('reads the pins from the files ci.yml uses', () => {
    const r = needs(have(nodeOk, pins.bun, pins.pnpm))
    expect(r.pin_node).toBe(pins.node)
    expect(r.pin_bun).toBe(pins.bun)
    expect(r.pin_pnpm).toBe(pins.pnpm)
    expect(pins.bun).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('needs nothing when all three match, and a node 24.x counts for a pin of 24', () => {
    expect(needs(have(nodeOk, pins.bun, pins.pnpm))).toMatchObject({
      need_node: 'false',
      need_bun: 'false',
      need_pnpm: 'false',
    })
  })

  it('needs exactly the tool that is missing or at another version', () => {
    expect(needs(have('1.1.0', pins.bun, pins.pnpm))).toMatchObject({
      need_node: 'true',
      need_bun: 'false',
      need_pnpm: 'false',
    })
    expect(needs(have(`${pins.node}0.0.0`, pins.bun, pins.pnpm)).need_node).toBe('true') // 240 is not 24
    expect(needs(have(nodeOk, `${pins.bun}0`, pins.pnpm))).toMatchObject({ need_node: 'false', need_bun: 'true' })
    expect(needs(have(nodeOk, pins.bun, `${pins.pnpm}1`))).toMatchObject({ need_pnpm: 'true', need_bun: 'false' })
    expect(needs(have(null, null, null))).toMatchObject({ need_node: 'true', need_bun: 'true', need_pnpm: 'true' })
  })

  // The jobs run a copy of the pinned bun kept in the cache, never ~/.bun/bin/bun, which an upgrade replaces in place mid-run.
  const fakeBun = (v: string) => bin({ bun: `[ "$1" = --version ] && echo ${v}` })
  const pinned = (cache: string, b: string) => sh(`ci_bun_pinned "${cache}"`, {}, b)

  it("copies PATH's bun into the cache when it is the pin, and keeps running that copy after PATH's bun changes", () => {
    const cache = scratch()
    const first = pinned(cache, fakeBun(pins.bun))
    expect(first.code, first.err).toBe(0)
    const dir = join(cache, 'bun-bin', pins.bun)
    expect(first.out.trim()).toBe(dir)
    expect(execFileSync(join(dir, 'bun'), ['--version'], { encoding: 'utf8' }).trim()).toBe(pins.bun)
    expect(execFileSync(join(dir, 'bunx'), ['--version'], { encoding: 'utf8' }).trim()).toBe(pins.bun)
    const later = pinned(cache, fakeBun('9.9.9')) // the machine's bun was upgraded mid-run
    expect(later.code, later.err).toBe(0)
    expect(later.out.trim()).toBe(dir)
    expect(execFileSync(join(dir, 'bun'), ['--version'], { encoding: 'utf8' }).trim()).toBe(pins.bun)
  })

  it('refuses when PATH has another bun and the cache has no copy of the pin', () => {
    const cache = scratch()
    const r = pinned(cache, fakeBun('9.9.9'))
    expect(r.code).toBe(1)
    expect(r.err).toContain(`bun 9.9.9`)
    expect(r.err).toContain(`not the pinned ${pins.bun}`)
    expect(existsSync(join(cache, 'bun-bin', pins.bun, 'bun'))).toBe(false)
  })

  it("tools: a bun at another version needs setup-bun unless the cache already has the pin's copy; the matching one skips it", () => {
    const cache = scratch()
    const tools = (b: string) =>
      Object.fromEntries(
        sh(`ci_tools "${root}"`, { TALOS_CI_CACHE: cache, HOME: cache }, b)
          .out.trim()
          .split('\n')
          .map((l) => l.split('=')),
      )
    expect(tools(fakeBun('9.9.9')).need_bun).toBe('true')
    expect(tools(fakeBun(pins.bun)).need_bun).toBe('false')
    expect(pinned(cache, fakeBun(pins.bun)).code).toBe(0)
    expect(tools(fakeBun('9.9.9')).need_bun).toBe('false')
  })
})

describe('ci-runner.sh size: the knobs follow the machine, and an owner-set value wins', () => {
  const size = (cores: number, gb: number) => sh(`ci_size ${cores} ${gb}`).out.trim()

  it('2 slots and load 14 on a 10-core Mac (what was set by hand), more on the big one', () => {
    expect(size(10, 32)).toBe('2 14')
    expect(size(18, 128)).toBe('3 25')
    expect(size(24, 192)).toBe('4 33')
  })

  it('memory can be the limit, never fewer than one slot, never more than six', () => {
    expect(size(18, 24)).toBe('2 25')
    expect(size(4, 8)).toBe('1 5')
    expect(size(128, 1024)).toBe('6 179')
  })

  it('reads the machine it runs on at run time', () => {
    const b = bin({
      sysctl: 'case "$2" in hw.ncpu) echo 20 ;; hw.memsize) echo $((64 * 1073741824)) ;; *) exit 1 ;; esac',
    })
    const r = run('size', {}, b)
    expect(r.code).toBe(0)
    expect(r.out.split('\n').filter(Boolean)).toEqual(['CI_SLOTS=4', 'CI_MAX_LOAD=28'])
  })

  it('a value the environment already has is not replaced', () => {
    const b = bin({
      sysctl: 'case "$2" in hw.ncpu) echo 20 ;; hw.memsize) echo $((64 * 1073741824)) ;; *) exit 1 ;; esac',
    })
    const r = run('size', { CI_SLOTS: '1' }, b)
    expect(r.out.split('\n').filter(Boolean)).toEqual(['CI_MAX_LOAD=28'])
  })

  it('when it cannot read the machine it picks the safest numbers, not a guess upward', () => {
    const b = bin({ sysctl: 'exit 1', nproc: 'exit 1' })
    const r = spawnSync('bash', [script, 'size'], { env: { PATH: `${b}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(['CI_SLOTS=1', 'CI_MAX_LOAD=0'])
    expect(r.stderr).toContain('cannot read cores or memory')
  })
})

describe('ci-runner.sh cache: scratch, locks and logs live where the runner will not wipe them', () => {
  const home = '/home/alex'
  const cache = (extra: Record<string, string>) => sh('ci_cache_dir', { HOME: home, ...extra })

  it("is the runner user's own cache by default", () => {
    expect(cache({}).out.trim()).toBe('/home/alex/.cache/talos-ci')
  })

  it('refuses one inside the workspace, the temp dir or _work, which the runner empties', () => {
    const w = '/home/alex/actions-runner/_work'
    for (const bad of [`${w}/talos-app/talos-app/.ci`, `${w}/_temp/x`, `${w}/talos-app/x`]) {
      const r = cache({
        TALOS_CI_CACHE: bad,
        GITHUB_WORKSPACE: `${w}/talos-app/talos-app`,
        RUNNER_WORKSPACE: `${w}/talos-app`,
        RUNNER_TEMP: `${w}/_temp`,
      })
      expect(r.code, bad).toBe(1)
      expect(r.err).toContain('which the runner wipes')
    }
    expect(cache({ GITHUB_WORKSPACE: `${w}/talos-app/talos-app`, RUNNER_TEMP: `${w}/_temp` }).code).toBe(0)
  })

  it('refuses a relative one, and no HOME', () => {
    expect(cache({ TALOS_CI_CACHE: 'cache' }).code).toBe(1)
    expect(sh('ci_cache_dir', { HOME: '' }).code).toBe(1)
  })
})

describe('ci-runner.sh run: the call into ci-local.sh', () => {
  /** A repo with an origin, a fake ci-local.sh that records its arguments and the settings it was given, and fake tools. */
  function setup() {
    const T = scratch()
    const git = (cwd: string, ...a: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
        cwd,
        encoding: 'utf8',
      }).trim()
    const origin = join(T, 'origin.git')
    execFileSync('git', ['init', '-q', '--bare', origin])
    const clone = join(T, 'clone')
    mkdirSync(join(clone, 'scripts'), { recursive: true })
    git(clone, 'init', '-q', '-b', 'main')
    git(clone, 'remote', 'add', 'origin', origin)
    writeFileSync(join(clone, 'a'), 'a')
    git(clone, 'add', '-A')
    git(clone, 'commit', '-qm', 'a')
    git(clone, 'push', '-q', 'origin', 'main')
    // refs/pull/12/head on the origin points where the test says (a made-up sha is fine for ls-remote: it only reads refs).
    execFileSync('git', ['--git-dir', origin, 'update-ref', 'refs/pull/12/head', git(clone, 'rev-parse', 'HEAD')])
    const real = git(clone, 'rev-parse', 'HEAD')
    const copy = join(clone, 'scripts/ci-runner.sh')
    writeFileSync(copy, readFileSync(script, 'utf8'))
    cpSync(join(here, 'ci-runner'), join(clone, 'scripts/ci-runner'), { recursive: true }) // what the script sources: the scheduled run's skips
    mkdirSync(join(clone, '.github/workflows'), { recursive: true }) // the bun pin is read from ci.yml
    writeFileSync(join(clone, '.github/workflows/ci.yml'), ciYml)
    const fakeLocal = join(T, 'fake-ci-local.sh')
    writeFileSync(
      fakeLocal,
      `#!/bin/bash
{ echo "args: $*"; echo "bun: $(bun --version) ($(command -v bun))"; for v in CI_REPO CI_STATUS_WHERE CI_WT_BASE TALOS_CI_CACHE CI_STATUS_URL TALOS_CI_FORCE_DESKTOP TALOS_CI_FORCE_MOBILE TALOS_FUZZ_MS CI_NIGHTLY CI_HOSTILE CI_SETTLE CI_WORKERS; do echo "$v=\${!v}"; done; } > "$CALLS"\n`,
    )
    // `gh` answers the one question a run asks (is the PR still open); never the real GitHub.
    const b = bin({
      caffeinate: 'echo "caffeinate $*" >> "$CALLS.caff"; exit 0',
      gh: 's=open; [ -n "$GH_PR_STATE" ] && s=$GH_PR_STATE; echo $s',
      bun: `echo ${/bun-version: ([\d.]+)/.exec(ciYml)?.[1]}`, // the pinned bun, as the workflow's tools step leaves it
    })
    return { T, clone, copy, fakeLocal, b, real, calls: join(T, 'calls') }
  }
  const home = () => scratch()

  it("a PR run calls ci-local.sh --pr N with the runner's settings, its scratch under the cache", () => {
    const s = setup()
    const h = home()
    const r = run(
      'run',
      {
        ...prEnv,
        PR_HEAD_SHA: s.real,
        GH_TOKEN: 't',
        HOME: h,
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
        CI_STATUS_URL: 'https://example.test/run/1',
      },
      s.b,
      s.copy,
    )
    // cwd is the clone for ls-remote
    expect(r.code).toBe(0)
    const c = readFileSync(s.calls, 'utf8')
    expect(c).toContain('args: --pr 12')
    expect(c).not.toContain('--full') // only a dispatch runs every job whatever the diff says
    expect(c).toContain('CI_REPO=owner/talos-app')
    expect(c).toContain('CI_STATUS_WHERE=ci-runner')
    expect(c).toContain(`TALOS_CI_CACHE=${h}/.cache/talos-ci`)
    expect(c).toContain(`CI_WT_BASE=${h}/.cache/talos-ci/wt`)
    expect(c).toContain('CI_STATUS_URL=https://example.test/run/1')
    // ci-local.sh runs the cache's copy of the pinned bun, first on PATH, and the step's log says which
    const pin = /bun-version: ([\d.]+)/.exec(ciYml)?.[1] as string
    expect(c).toContain(`bun: ${pin} (${h}/.cache/talos-ci/bun-bin/${pin}/bun)`)
    expect(r.out).toContain(`ci-runner: bun: ${pin} (${h}/.cache/talos-ci/bun-bin/${pin}/bun)`)
  })

  it('refuses to start ci-local.sh when the bun on PATH is not the pin and the cache has no copy of it', () => {
    const s = setup()
    const r = run(
      'run',
      { ...prEnv, PR_HEAD_SHA: s.real, GH_TOKEN: 't', HOME: home(), CALLS: s.calls, CI_LOCAL_SCRIPT: s.fakeLocal },
      `${bin({ bun: 'echo 9.9.9' })}:${s.b}`,
      s.copy,
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('bun 9.9.9')
    expect(existsSync(s.calls)).toBe(false)
  })

  it('a dispatch run calls it with --ref', () => {
    const s = setup()
    const r = run(
      'run',
      {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REPOSITORY: 'owner/talos-app',
        INPUT_REF: 'feat/x',
        GH_TOKEN: 't',
        HOME: home(),
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
      },
      s.b,
      s.copy,
    )
    expect(r.code).toBe(0)
    expect(readFileSync(s.calls, 'utf8')).toContain('args: --ref feat/x --full')
  })

  it('the nightly run tests the sha main had when it started, with --full, so nothing is skipped', () => {
    const s = setup()
    const r = run(
      'run',
      {
        GITHUB_EVENT_NAME: 'schedule',
        GITHUB_REPOSITORY: 'owner/talos-app',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: s.real,
        INPUT_JOBS: 'desktop', // a dispatch input never narrows the nightly
        TALOS_CI_SCHEDULE_QUIET_HOURS: 'off', // the time of day decides nothing here
        GH_TOKEN: 't',
        HOME: home(),
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
      },
      s.b,
      s.copy,
    )
    expect(r.code, r.err).toBe(0)
    expect(readFileSync(s.calls, 'utf8')).toContain(`args: --ref ${s.real} --full\n`)
    // the long security fuzz (apps/bridge/test/review-memory-recheck.test.ts): 60 s nightly instead of 8 s
    expect(readFileSync(s.calls, 'utf8')).toContain('TALOS_FUZZ_MS=60000\n')
    // and it posts under nightly-ci/ only: ci-local.sh (and its fallback) get CI_NIGHTLY=1
    expect(readFileSync(s.calls, 'utf8')).toContain('CI_NIGHTLY=1\n')
  })

  // A scheduled run (the nightly) must never get in the way of the pushes that matter: it skips itself, with a "skipped:" line,
  // no status posted (neither red nor green), only when it was DISPATCHED in the daytime (TALOS_CI_SCHEDULE_QUIET_HOURS, local time, 07:00-22:00). A push run never makes it skip: it
  // yields to the push run(s) already going when it was dispatched, for a bounded time, and then goes.
  describe('a scheduled run skips itself', () => {
    const pad = (n: number) => String(n).padStart(2, '0')
    const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
    // a window of two hours around now (the day), and one that does not hold now (the night), whatever the clock says
    const around = (): string => {
      const a = new Date(Date.now() - 3_600_000)
      const b = new Date(Date.now() + 3_600_000)
      return `${hhmm(a)}-${hhmm(b)}`
    }
    const elsewhere = (): string => {
      const a = new Date(Date.now() + 3 * 3_600_000)
      const b = new Date(Date.now() + 5 * 3_600_000)
      return `${hhmm(a)}-${hhmm(b)}`
    }
    // gh answers what a scheduled run asks of GitHub, as JSON that the real `jq` filters with the script's own --jq (so a wrong filter
    // fails here). $GH_INPROGRESS: the ids of the push runs of ci-runner.yml in progress now (space separated; a run of another
    // workflow, 999, is in the list too); $GH_STARTED_<id>: when that run's jobs started (default long ago; after the dispatch is a
    // run that came later); its Lemnos job ("local-ci on ci-runner") is in_progress for its first $GH_DONE_AFTER polls (default 0),
    // each poll written to "$CALLS.polls"; GH_FAIL_POLL=1: a poll that fails; $GH_CREATED_AT: this run's created_at; GH_FAIL=1: GitHub
    // unreadable.
    const fakeGh = `[ -z "$GH_FAIL" ] || exit 1
expr=; prev=; for a in "$@"; do [ "$prev" = --jq ] && expr=$a; prev=$a; done
emit() { if [ -n "$expr" ]; then jq -r "$expr"; else cat; fi; }
case "$*" in
  *status=in_progress*) { printf '{"workflow_runs":[{"id":999,"path":".github/workflows/other.yml"}'; for i in $GH_INPROGRESS; do printf ',{"id":%s,"path":".github/workflows/ci-runner.yml"}' "$i"; done; printf ']}'; } | emit ;;
  */jobs*) id=$(echo "$*" | sed -n 's|.*actions/runs/\\([0-9]*\\)/jobs.*|\\1|p'); st="\${GH_JOB_ST:-in_progress}"
    case "$*" in *"local-ci on ci-runner"*) [ -z "$GH_FAIL_POLL" ] || exit 1; echo "$id" >> "$CALLS.polls"; n=$(grep -c "^$id$" "$CALLS.polls"); [ "$n" -le "\${GH_DONE_AFTER:-0}" ] || st=completed ;; esac
    eval "started=\\\${GH_STARTED_$id:-2000-01-01T00:00:00Z}"
    printf '{"jobs":[{"name":"plan","status":"completed","started_at":"%s"},{"name":"local-ci on ci-runner","status":"%s","started_at":"%s"}]}' "$started" "$st" "$started" | emit ;;
  *actions/runs/[0-9]*) printf '{"created_at":"%s"}' "$GH_CREATED_AT" | emit ;;
  *) echo open ;;
esac`
    const tools = (more: Record<string, string> = {}) =>
      bin({
        caffeinate: 'exit 0',
        gh: fakeGh,
        bun: `echo ${/bun-version: ([\d.]+)/.exec(ciYml)?.[1]}`,
        ...more,
      })
    const nightly = (
      s: ReturnType<typeof setup>,
      extra: Record<string, string> = {},
      more: Record<string, string> = {},
      sub = 'run',
    ) =>
      run(
        sub,
        {
          GITHUB_EVENT_NAME: 'schedule',
          GITHUB_REPOSITORY: 'owner/talos-app',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_SHA: s.real,
          GH_TOKEN: 't',
          HOME: home(),
          CALLS: s.calls,
          CI_LOCAL_SCRIPT: s.fakeLocal,
          TALOS_CI_SCHEDULE_QUIET_HOURS: elsewhere(),
          ...extra,
        },
        tools(more),
        s.copy,
      )

    it('at night, on main’s head, with no push run going: it runs', () => {
      const s = setup()
      const r = nightly(s)
      expect(r.code, r.err).toBe(0)
      expect(r.out).not.toContain('skipped')
      expect(readFileSync(s.calls, 'utf8')).toContain(`args: --ref ${s.real} --full`)
    })

    it('in the daytime it skips: nothing tested, nothing posted', () => {
      const s = setup()
      const r = nightly(s, { TALOS_CI_SCHEDULE_QUIET_HOURS: around() })
      expect(r.code, r.err).toBe(0)
      expect(r.out).toContain('ci-runner: skipped: it is daytime')
      expect(existsSync(s.calls)).toBe(false)
    })

    it('the daytime is a variable: the default is 07:00-22:00, and off turns the rule off', () => {
      const code = (v: string, hhmm: string) =>
        sh(
          `. "${join(here, 'ci-runner', 'schedule.sh')}"; date() { echo "$FAKE_NOW"; }; ${v === 'default' ? 'unset TALOS_CI_SCHEDULE_QUIET_HOURS' : `TALOS_CI_SCHEDULE_QUIET_HOURS='${v}'`}; ci_quiet_hours_now; echo $?`,
          { FAKE_NOW: hhmm },
        ).out.trim()
      expect(code('default', '06:59')).toBe('1')
      expect(code('default', '07:00')).toBe('0')
      expect(code('default', '21:59')).toBe('0')
      expect(code('default', '22:00')).toBe('1')
      expect(code('22:00-06:00', '23:30')).toBe('0') // a window across midnight
      expect(code('22:00-06:00', '12:00')).toBe('1')
      expect(code('off', '12:00')).toBe('1')
      expect(code('nonsense', '12:00')).toBe('1') // not a window: no rule, it runs
    })

    // main's head is judged as of the DISPATCH: pushes land every ~20 min overnight, so a nightly that skipped because main moved
    // while it waited for a runner or yielded never ran (2026-11-20). It tests the commit main had when it was dispatched.
    it('main having moved on since the dispatch is no reason to skip: it tests the commit main had then, and says so', () => {
      const s = setup()
      const r = nightly(s, { GITHUB_SHA: 'b'.repeat(40) })
      expect(r.code, r.err).toBe(0)
      expect(r.out).not.toContain('skipped')
      expect(r.out).toContain(
        `main has moved on (b${'b'.repeat(6)} was main's head when this run was created, ${s.real.slice(0, 7)} is now)`,
      )
      expect(readFileSync(s.calls, 'utf8')).toContain(`args: --ref ${'b'.repeat(40)} --full`)
    })

    // Rule 1 (bounded yield): a push run never makes a scheduled run skip. It waits only for the push run(s) that were going when it
    // was dispatched, then goes; a push run still queued then, or one that came later, is not waited for; a cap ends the wait.
    describe('a push run never makes it skip: it yields, for a bounded time, to the ones already going when it was dispatched', () => {
      const poll = { CI_SCHEDULE_YIELD_POLL_S: '0' }
      // the workflow's own step yields, then the run step goes on from what it decided (`run` and the fallback never yield)
      const viaStep = (s: ReturnType<typeof setup>, extra: Record<string, string> = {}) => {
        const e = { HOME: home(), GITHUB_RUN_ID: '9001', ...extra }
        const step = nightly(s, e, {}, 'schedule-yield')
        const r = nightly(s, e)
        return { code: r.code, err: r.err, out: step.out + r.out }
      }
      const polls = (s: ReturnType<typeof setup>) =>
        existsSync(`${s.calls}.polls`) ? readFileSync(`${s.calls}.polls`, 'utf8').trim().split('\n').length : 0

      it('waits for the push run going at the dispatch until it completes, then runs (not skipped)', () => {
        const s = setup()
        const r = viaStep(s, { ...poll, GH_INPROGRESS: '111', GH_DONE_AFTER: '2' })
        expect(r.code, r.err).toBe(0)
        expect(r.out).toContain('yielding to the push run(s) going when this run was dispatched (111)') // not 999, another workflow's
        expect(r.out).toContain('this run goes next')
        expect(r.out).not.toContain('skipped')
        expect(polls(s)).toBe(3) // in progress twice, completed the third time
        expect(readFileSync(s.calls, 'utf8')).toContain(`args: --ref ${s.real} --full`)
      })

      it('waits for every push run going at the dispatch', () => {
        const s = setup()
        const r = viaStep(s, { ...poll, GH_INPROGRESS: '111 222', GH_DONE_AFTER: '1' })
        expect(r.out).toContain('(111 222)')
        expect(polls(s)).toBe(4) // two runs, two polls each
        expect(existsSync(s.calls)).toBe(true)
      })

      it('does not wait for a push run that was still queued at the dispatch, nor one that came after it', () => {
        const s = setup()
        // nothing in progress (the run queued or pending in main's concurrency group is not "in progress"): no wait at all
        const queued = viaStep(s, { ...poll, GH_INPROGRESS: '' })
        expect(queued.out).not.toContain('yielding')
        expect(queued.out).not.toContain('skipped')
        // in progress now, but none of its jobs had started by the dispatch: it is a later arrival
        const later = viaStep(s, { ...poll, GH_INPROGRESS: '333', GH_STARTED_333: '2999-01-01T00:00:00Z' })
        expect(later.out).not.toContain('yielding')
        expect(later.out).not.toContain('skipped')
        expect(polls(s)).toBe(0)
        expect(existsSync(s.calls)).toBe(true)
      })

      it('the line is the dispatch time: a run whose jobs started just before it is waited for, one that started just after is not', () => {
        const s = setup()
        const e = Math.floor(Date.now() / 1000) - 3600
        const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
        const r = viaStep(s, {
          ...poll,
          CI_SCHEDULE_DISPATCHED_AT: String(e),
          GH_INPROGRESS: '111 222',
          GH_STARTED_111: iso(e - 60),
          GH_STARTED_222: iso(e + 60),
          GH_DONE_AFTER: '1',
        })
        expect(r.out).toContain('dispatched (111), for at most')
        expect(r.out).not.toContain('222')
      })

      it('a poll GitHub cannot answer does not end the wait: it goes on until the cap', () => {
        const s = setup()
        const r = viaStep(s, {
          CI_SCHEDULE_YIELD_POLL_S: '1',
          CI_SCHEDULE_YIELD_MAX_S: '1',
          GH_INPROGRESS: '111',
          GH_FAIL_POLL: '1',
        })
        expect(r.out).toContain('yielded for 1 s (CI_SCHEDULE_YIELD_MAX_S) and the push run(s) 111 still go')
        expect(existsSync(s.calls)).toBe(true)
      })

      it('stops waiting at the cap (CI_SCHEDULE_YIELD_MAX_S) and runs anyway', () => {
        const s = setup()
        const r = viaStep(s, {
          CI_SCHEDULE_YIELD_POLL_S: '1',
          CI_SCHEDULE_YIELD_MAX_S: '1',
          GH_INPROGRESS: '111',
          GH_DONE_AFTER: '1000',
        })
        expect(r.code, r.err).toBe(0)
        expect(r.out).toContain(
          'yielded for 1 s (CI_SCHEDULE_YIELD_MAX_S) and the push run(s) 111 still go; this run goes now',
        )
        expect(r.out).not.toContain('skipped')
        expect(existsSync(s.calls)).toBe(true)
      })

      it('a push run whose Lemnos job is still queued for a runner is still ahead: the wait goes on until the cap', () => {
        const s = setup()
        const r = viaStep(s, {
          CI_SCHEDULE_YIELD_POLL_S: '1',
          CI_SCHEDULE_YIELD_MAX_S: '1',
          GH_INPROGRESS: '111',
          GH_JOB_ST: 'queued',
          GH_DONE_AFTER: '1000',
        })
        expect(r.out).toContain('yielded for 1 s (CI_SCHEDULE_YIELD_MAX_S) and the push run(s) 111 still go')
      })

      it('only the yield step waits: a run (or fallback) step that finds no decision goes on without yielding', () => {
        const s = setup()
        const r = nightly(s, { ...poll, GITHUB_RUN_ID: '9002', GH_INPROGRESS: '111', GH_DONE_AFTER: '5' })
        expect(r.out).not.toContain('yielding')
        expect(polls(s)).toBe(0)
        expect(existsSync(s.calls)).toBe(true)
      })

      it('the fake gh needs the real jq (it applies the script’s own --jq filters)', () => {
        expect(spawnSync('jq', ['--version']).status, 'install jq: these tests filter GitHub’s JSON with it').toBe(0)
      })

      it('the cap is 90 minutes unless set', () => {
        expect(readFileSync(join(here, 'ci-runner', 'schedule.sh'), 'utf8')).toContain('CI_SCHEDULE_YIELD_MAX_S:-5400')
      })

      it('GitHub unreadable is no reason to wait or to skip', () => {
        const s = setup()
        const r = viaStep(s, { ...poll, GH_FAIL: '1', GH_INPROGRESS: '111' })
        expect(r.code, r.err).toBe(0)
        expect(r.out).not.toContain('yielding')
        expect(existsSync(s.calls)).toBe(true)
      })

      it('the hostile nightly yields the same way', () => {
        const s = setup()
        const r = viaStep(s, { ...poll, CI_HOSTILE: '1', GH_INPROGRESS: '111', GH_DONE_AFTER: '1' })
        expect(r.out).toContain('yielding to the push run(s) going when this run was dispatched (111)')
        expect(readFileSync(s.calls, 'utf8')).toContain('CI_HOSTILE=1')
      })

      it('what a run decided is kept for its fallback step: a main that moved on while it yielded does not turn "ran" into a skip', () => {
        const s = setup()
        const h = home()
        // the workflow's own step before the run step decides (and yields); `run` and the fallback then take what it said
        const step = nightly(
          s,
          { ...poll, HOME: h, GITHUB_RUN_ID: '4242', GH_INPROGRESS: '111', GH_DONE_AFTER: '1' },
          {},
          'schedule-yield',
        )
        expect(step.code, step.err).toBe(0)
        expect(step.out).toContain('yielding')
        expect(existsSync(s.calls)).toBe(false) // it tests nothing itself
        expect(polls(s)).toBe(2)
        const first = nightly(s, { ...poll, HOME: h, GITHUB_RUN_ID: '4242', GH_INPROGRESS: '111', GH_DONE_AFTER: '1' })
        expect(first.out).not.toContain('yielding') // not again
        expect(first.out).not.toContain('skipped')
        expect(polls(s)).toBe(2)
        rmSync(s.calls)
        const again = nightly(s, { HOME: h, GITHUB_RUN_ID: '4242', TALOS_CI_SCHEDULE_QUIET_HOURS: around() }) // now it is daytime
        expect(again.out).not.toContain('skipped')
        expect(existsSync(s.calls)).toBe(true)
        // and a skip is kept as well: said again, the same way
        const skipped = nightly(s, { HOME: h, GITHUB_RUN_ID: '4243', TALOS_CI_SCHEDULE_QUIET_HOURS: around() })
        const skippedAgain = nightly(s, { HOME: h, GITHUB_RUN_ID: '4243' })
        expect(skipped.out).toContain('skipped: it is daytime')
        expect(skippedAgain.out).toContain('skipped: it is daytime')
      })

      it('a day with a dispatched run already started: the yield step and the run step say it once, and it is no skipped night', () => {
        const s = setup()
        const h = home()
        const env = { HOME: h, GITHUB_RUN_ID: '8001' }
        const dir = join(h, '.cache/talos-ci/nightly-dispatch')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `nightly-${execFileSync('date', ['+%F'], { encoding: 'utf8' }).trim()}`), '')
        const step = nightly(s, env, {}, 'schedule-yield')
        const r = nightly(s, env)
        const day = `${step.out}${r.out}`
        expect(day).toContain('a dispatched nightly run already started today')
        expect(day).not.toContain('two nights in a row')
        expect(existsSync(join(h, '.cache/talos-ci/alerts'))).toBe(false)
        expect(existsSync(s.calls)).toBe(false)
      })
    })

    // Rule 2: the daytime is judged when the run was DISPATCHED, not when it gets a runner.
    describe('a run dispatched at night is never skipped for the quiet hours, however late it starts', () => {
      const nowS = () => Math.floor(Date.now() / 1000)
      const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d+Z$/, 'Z')

      it('an explicit dispatch time inside the night: it runs although it starts in the daytime', () => {
        const s = setup()
        const r = nightly(s, {
          TALOS_CI_SCHEDULE_QUIET_HOURS: around(),
          CI_SCHEDULE_DISPATCHED_AT: String(nowS() - 5 * 3600),
        })
        expect(r.code, r.err).toBe(0)
        expect(r.out).not.toContain('skipped')
        expect(readFileSync(s.calls, 'utf8')).toContain(`args: --ref ${s.real} --full`)
      })

      it('an explicit dispatch time inside the daytime: it skips, and says when it was dispatched', () => {
        const s = setup()
        const r = nightly(s, {
          TALOS_CI_SCHEDULE_QUIET_HOURS: around(),
          CI_SCHEDULE_DISPATCHED_AT: String(nowS() - 1800),
        })
        expect(r.out).toMatch(
          /skipped: it is daytime \(.*; dispatched at \d\d:\d\d\), and a scheduled run waits for the night/,
        )
        expect(existsSync(s.calls)).toBe(false)
      })

      it('the run’s own created_at is its dispatch time (GitHub says it)', () => {
        const s = setup()
        const day = { TALOS_CI_SCHEDULE_QUIET_HOURS: around(), GITHUB_RUN_ID: '555' }
        const night = nightly(s, { ...day, GH_CREATED_AT: iso(nowS() - 5 * 3600) })
        expect(night.out).not.toContain('skipped')
        expect(existsSync(s.calls)).toBe(true)
        rmSync(s.calls)
        const noon = nightly(s, { ...day, GH_CREATED_AT: iso(nowS() - 600), HOME: home() })
        expect(noon.out).toContain('skipped: it is daytime')
        expect(existsSync(s.calls)).toBe(false)
      })

      it('a dispatch time that cannot be had is the time it starts: in the daytime it skips', () => {
        const s = setup()
        const r = nightly(s, { TALOS_CI_SCHEDULE_QUIET_HOURS: around(), GITHUB_RUN_ID: '555', GH_FAIL: '1' })
        expect(r.out).toContain('skipped: it is daytime')
        expect(existsSync(s.calls)).toBe(false)
      })

      // the owner's weekday 08:00-14:00 rule: CI_WORKERS=5 (com.talos.cpu-window sets it in a runner's .env, which a runner reads at start)
      describe('a run that goes ahead inside the owner’s weekday window runs with the daytime worker cap', () => {
        const clock = (dow: string, hhmm: string) =>
          ({
            date: `case "$*" in "+%u") echo ${dow} ;; "+%H:%M") echo ${hhmm} ;; *) exec /bin/date "$@" ;; esac`,
          }) as Record<string, string>
        const at = (s: ReturnType<typeof setup>, dow: string, hhmm: string, extra: Record<string, string> = {}) =>
          nightly(
            s,
            { TALOS_CI_SCHEDULE_QUIET_HOURS: 'off', CI_SCHEDULE_DISPATCHED_AT: String(nowS() - 5 * 3600), ...extra },
            clock(dow, hhmm),
          )

        it('at 09:30 on a Wednesday: CI_WORKERS=5, said, and ci-local.sh gets it', () => {
          const s = setup()
          const r = at(s, '3', '09:30')
          expect(r.code, r.err).toBe(0)
          expect(r.out).toContain('CI_WORKERS=5')
          expect(readFileSync(s.calls, 'utf8')).toContain('CI_WORKERS=5\n')
        })

        it('a lower setting of its own stays; a higher one is cut to 5', () => {
          const s = setup()
          at(s, '3', '09:30', { CI_WORKERS: '3' })
          expect(readFileSync(s.calls, 'utf8')).toContain('CI_WORKERS=3\n')
          at(s, '3', '09:30', { CI_WORKERS: '12' })
          expect(readFileSync(s.calls, 'utf8')).toContain('CI_WORKERS=5\n')
        })

        it('outside the window or at the weekend it is the machine’s default (not set here)', () => {
          const s = setup()
          for (const [dow, hhmm] of [
            ['6', '09:30'],
            ['7', '09:30'],
            ['3', '14:00'],
            ['3', '07:59'],
            ['3', '02:30'],
          ]) {
            const r = at(s, dow, hhmm)
            expect(r.out, `${dow} ${hhmm}`).not.toContain('CI_WORKERS=5')
            expect(readFileSync(s.calls, 'utf8'), `${dow} ${hhmm}`).toContain('CI_WORKERS=\n')
          }
        })

        it('the window is 08:00 up to 14:00, Monday to Friday', () => {
          const sets = (dow: string, hhmm: string) =>
            sh(
              `. "${join(here, 'ci-runner', 'schedule.sh')}"; ci_day_workers >/dev/null; echo "\${CI_WORKERS-unset}"`,
              {},
              tools(clock(dow, hhmm)),
            ).out.trim()
          expect(sets('1', '08:00')).toBe('5')
          expect(sets('5', '13:59')).toBe('5')
          expect(sets('5', '14:00')).toBe('unset')
          expect(sets('1', '07:59')).toBe('unset')
          expect(sets('6', '10:00')).toBe('unset')
        })
      })
    })

    it('the hostile nightly runs on whatever main is: a sha that is not main’s head is no reason for it to skip, and says nothing of it', () => {
      const s = setup()
      const r = nightly(s, { GITHUB_SHA: 'b'.repeat(40), CI_HOSTILE: '1' })
      expect(r.code, r.err).toBe(0)
      expect(r.out).not.toContain('skipped')
      expect(r.out).not.toContain('has moved on')
      expect(readFileSync(s.calls, 'utf8')).toContain(`--ref ${'b'.repeat(40)} --full`)
    })

    it('the hostile nightly still skips when it was dispatched in the daytime', () => {
      const s = setup()
      expect(nightly(s, { CI_HOSTILE: '1', TALOS_CI_SCHEDULE_QUIET_HOURS: around() }).out).toContain(
        'skipped: it is daytime',
      )
    })

    // A dispatch with nightly=<kind> is that nightly by hand: the same path as the schedule of that kind.
    describe('a dispatched nightly (nightly=nightly|hostile) is treated as its schedule', () => {
      const dispatched = (kind: string, s: ReturnType<typeof setup>, extra: Record<string, string> = {}) =>
        nightly(s, { GITHUB_EVENT_NAME: 'workflow_dispatch', CI_DISPATCH_NIGHTLY: kind, ...extra })
      const called = (s: ReturnType<typeof setup>) => readFileSync(s.calls, 'utf8')

      it('nightly=nightly runs as the nightly: main, --full, nightly-ci/', () => {
        const s = setup()
        const r = dispatched('nightly', s)
        expect(r.code, r.err).toBe(0)
        expect(called(s)).toContain(`args: --ref ${s.real} --full`)
        expect(called(s)).toContain('CI_NIGHTLY=1')
        expect(called(s)).not.toContain('CI_HOSTILE=1')
      })

      it('nightly=hostile takes hostile mode, with no workflow help', () => {
        const s = setup()
        const r = dispatched('hostile', s)
        expect(r.code, r.err).toBe(0)
        expect(called(s)).toContain('CI_HOSTILE=1')
      })

      it('the daytime skips it, as it skips the schedule; a main that moved on does not', () => {
        const s = setup()
        expect(dispatched('nightly', s, { TALOS_CI_SCHEDULE_QUIET_HOURS: around() }).out).toContain(
          'skipped: it is daytime',
        )
        expect(existsSync(s.calls)).toBe(false)
        const moved = dispatched('nightly', s, { GITHUB_SHA: 'b'.repeat(40) })
        expect(moved.out).not.toContain('skipped')
        expect(existsSync(s.calls)).toBe(true)
      })

      it('a ref other than main is refused, as for a schedule', () => {
        const r = dispatched('nightly', setup(), { GITHUB_REF: 'refs/heads/feat/x' })
        expect(r.code).toBe(1)
        expect(r.err).toContain('only refs/heads/main is tested')
      })

      it('a normal dispatch (nightly=none, no variable) is unchanged: no skips, no marker, ordinary run', () => {
        const s = setup()
        const h = home()
        const r = nightly(s, {
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          CI_DISPATCH_NIGHTLY: '',
          INPUT_REF: 'main',
          HOME: h,
          TALOS_CI_SCHEDULE_QUIET_HOURS: around(),
        })
        expect(r.code, r.err).toBe(0)
        expect(r.out).not.toContain('skipped')
        expect(called(s)).toContain('CI_NIGHTLY=\n')
        expect(existsSync(join(h, '.cache/talos-ci/nightly-dispatch'))).toBe(false)
      })

      it('the schedule of the same kind on the same local day then no-ops, with one line saying why', () => {
        for (const kind of ['nightly', 'hostile']) {
          const s = setup()
          const h = home()
          expect(dispatched(kind, s, { HOME: h }).code).toBe(0)
          rmSync(s.calls)
          const sched = nightly(s, { HOME: h, ...(kind === 'hostile' ? { CI_HOSTILE: '1' } : {}) })
          expect(sched.code, sched.err).toBe(0)
          expect(sched.out.split('\n').filter((l) => l.includes('skipped:'))).toHaveLength(1)
          expect(sched.out).toContain(`a dispatched ${kind} run already started today`)
          expect(existsSync(s.calls)).toBe(false)
        }
      })

      it('a different kind does not block the schedule', () => {
        const s = setup()
        const h = home()
        expect(dispatched('hostile', s, { HOME: h }).code).toBe(0)
        rmSync(s.calls)
        const sched = nightly(s, { HOME: h }) // the nightly, not the hostile one
        expect(sched.out).not.toContain('skipped')
        expect(called(s)).toContain('--full')
      })

      it('a marker from another local day does not block the schedule', () => {
        const s = setup()
        const h = home()
        const dir = join(h, '.cache/talos-ci/nightly-dispatch')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'nightly-2000-01-01'), '')
        expect(nightly(s, { HOME: h }).out).not.toContain('skipped')
      })

      it('a dispatched nightly that skips itself leaves no marker, so the schedule still runs', () => {
        const s = setup()
        const h = home()
        dispatched('nightly', s, { HOME: h, TALOS_CI_SCHEDULE_QUIET_HOURS: around() })
        expect(nightly(s, { HOME: h }).out).not.toContain('skipped')
      })
    })

    it('two nights skipped in a row are said: a warning line, and a message for the lead in alerts/', () => {
      const s = setup()
      const h = home()
      const alerts = join(h, '.cache/talos-ci/alerts')
      const day = { TALOS_CI_SCHEDULE_QUIET_HOURS: around() }
      const first = nightly(s, { HOME: h, ...day })
      expect(first.out).toContain('skipped: it is daytime')
      expect(first.out).not.toContain('two nights in a row') // one skip is a skip
      expect(existsSync(alerts)).toBe(false)
      const second = nightly(s, { HOME: h, ...day })
      expect(second.out).toContain('ci-runner: warning: the nightly run has skipped two nights in a row')
      const files = readdirSync(alerts).filter((f) => f.endsWith('-schedule-skipped.txt'))
      expect(files).toHaveLength(1)
      expect(readFileSync(join(alerts, files[0]), 'utf8')).toContain('the nightly run has skipped two nights in a row')
    })

    it('a night it ran in between, or the hostile one skipping, makes no such warning for the nightly', () => {
      const s = setup()
      const h = home()
      const day = { TALOS_CI_SCHEDULE_QUIET_HOURS: around() }
      nightly(s, { HOME: h, ...day }) // skipped
      expect(nightly(s, { HOME: h }).code).toBe(0) // ran
      const again = nightly(s, { HOME: h, ...day }) // skipped, but not two in a row
      expect(again.out).not.toContain('two nights in a row')
      const hostile = nightly(s, { HOME: h, ...day, CI_HOSTILE: '1' }) // another kind: its own count
      expect(hostile.out).not.toContain('two nights in a row')
    })

    it('a push, a PR and a dispatch never skip for any of this', () => {
      const s = setup()
      const r = run(
        'run',
        {
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          GITHUB_REPOSITORY: 'owner/talos-app',
          INPUT_REF: 'feat/x',
          GH_TOKEN: 't',
          HOME: home(),
          CALLS: s.calls,
          CI_LOCAL_SCRIPT: s.fakeLocal,
          TALOS_CI_SCHEDULE_QUIET_HOURS: around(),
          GH_INPROGRESS: '3', // a push, a PR and a dispatch never look at the push runs
        },
        tools(),
        s.copy,
      )
      expect(r.code, r.err).toBe(0)
      expect(readFileSync(s.calls, 'utf8')).toContain('args: --ref feat/x --full')
    })

    it('GitHub unreadable is no reason to skip: the nightly runs', () => {
      const s = setup()
      const r = nightly(s, { GH_FAIL: '1' })
      expect(r.code, r.err).toBe(0)
      expect(readFileSync(s.calls, 'utf8')).toContain('--full')
    })
  })

  it('a push run tests the pushed sha, not the branch name, and posts under the same repo and run link', () => {
    const s = setup()
    const r = run(
      'run',
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'owner/talos-app',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: s.real,
        // A stale dispatch input must not leak into a push.
        INPUT_REF: 'feat/other',
        INPUT_JOBS: 'desktop',
        GH_TOKEN: 't',
        HOME: home(),
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
        CI_STATUS_URL: 'https://example.test/run/2',
      },
      s.b,
      s.copy,
    )
    expect(r.code).toBe(0)
    const c = readFileSync(s.calls, 'utf8')
    expect(c).toContain(`args: --ref ${s.real}\n`)
    expect(c).not.toContain('--full') // a push may skip jobs its diff cannot affect
    expect(c).not.toContain('--jobs')
    expect(c).toContain('CI_REPO=owner/talos-app')
    expect(c).toContain('CI_STATUS_URL=https://example.test/run/2')
    // No force flag: it would reach every job and the tests they run. ci-local.sh decides for a commit already on main.
    expect(c).toContain('TALOS_CI_FORCE_DESKTOP=\n')
    expect(c).toContain('TALOS_CI_FORCE_MOBILE=\n')
  })

  it('no run (push, PR or dispatch) exports a force flag for the desktop or mobile job', () => {
    const s = setup()
    const common = { GH_TOKEN: 't', HOME: home(), CALLS: s.calls, CI_LOCAL_SCRIPT: s.fakeLocal }
    const runs: Record<string, string>[] = [
      { ...prEnv, PR_HEAD_SHA: s.real },
      { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'owner/talos-app', INPUT_REF: 'feat/x' },
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'owner/talos-app',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: s.real,
      },
    ]
    for (const e of runs) {
      expect(run('run', { ...e, ...common }, s.b, s.copy).code, e.GITHUB_EVENT_NAME).toBe(0)
      const c = readFileSync(s.calls, 'utf8')
      expect(c, e.GITHUB_EVENT_NAME).toContain('TALOS_CI_FORCE_DESKTOP=\n')
      expect(c, e.GITHUB_EVENT_NAME).toContain('TALOS_CI_FORCE_MOBILE=\n')
      expect(c, e.GITHUB_EVENT_NAME).toContain('TALOS_FUZZ_MS=\n') // only the nightly runs the long fuzz
      expect(c, e.GITHUB_EVENT_NAME).toContain('CI_NIGHTLY=\n') // only the nightly posts under nightly-ci/
    }
  })

  it('a push to another branch never reaches ci-local.sh', () => {
    const s = setup()
    const r = run(
      'run',
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'owner/talos-app',
        GITHUB_REF: 'refs/heads/feat/x',
        GITHUB_SHA: s.real,
        GH_TOKEN: 't',
        HOME: home(),
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
      },
      s.b,
      s.copy,
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain("a push to 'refs/heads/feat/x', only refs/heads/main is tested on push or schedule") // the push rule, not the unknown-event fallback
    expect(existsSync(s.calls)).toBe(false)
  })

  it('a dispatch with a job list passes it on as --jobs, one argument', () => {
    const s = setup()
    const base = {
      GITHUB_REPOSITORY: 'owner/talos-app',
      GH_TOKEN: 't',
      HOME: home(),
      CALLS: s.calls,
      CI_LOCAL_SCRIPT: s.fakeLocal,
    }
    const d = run(
      'run',
      { ...base, GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: 'feat/x', INPUT_JOBS: 'desktop,mobile' },
      s.b,
      s.copy,
    )
    expect(d.code).toBe(0)
    expect(readFileSync(s.calls, 'utf8')).toContain('args: --ref feat/x --full --jobs desktop,mobile')
    // Empty is all six jobs, as before.
    const e = setup()
    run(
      'run',
      {
        ...base,
        CALLS: e.calls,
        CI_LOCAL_SCRIPT: e.fakeLocal,
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        INPUT_REF: 'feat/x',
        INPUT_JOBS: '',
      },
      e.b,
      e.copy,
    )
    expect(readFileSync(e.calls, 'utf8')).toContain('args: --ref feat/x --full\n')
  })

  it('keeps the Mac awake for the length of the run (caffeinate on its own pid)', async () => {
    const s = setup()
    run(
      'run',
      {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REPOSITORY: 'owner/talos-app',
        INPUT_REF: 'main',
        GH_TOKEN: 't',
        HOME: home(),
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
      },
      s.b,
      s.copy,
    )
    // caffeinate is started in the background and the script moves on to ci-local.sh at once, so the fake may not have written
    // yet when the script has exited: wait for it, the way the real one is simply running.
    await vi.waitUntil(() => existsSync(`${s.calls}.caff`) && readFileSync(`${s.calls}.caff`, 'utf8') !== '', {
      timeout: 10_000,
      interval: 20,
    })
    const caff = readFileSync(`${s.calls}.caff`, 'utf8')
    expect(caff).toMatch(/^caffeinate -i -m -s -w \d+$/m)
  })

  it('a fork never reaches ci-local.sh', () => {
    const s = setup()
    const r = run(
      'run',
      {
        ...prEnv,
        PR_HEAD_REPO: 'someone/talos-app',
        PR_HEAD_SHA: s.real,
        GH_TOKEN: 't',
        HOME: home(),
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
      },
      s.b,
      s.copy,
    )
    expect(r.code).toBe(1)
    expect(existsSync(s.calls)).toBe(false)
  })

  it('without a token it stops: statuses could not be posted, and a green with no statuses would mislead', () => {
    const s = setup()
    const r = run(
      'run',
      { ...prEnv, PR_HEAD_SHA: s.real, HOME: home(), CALLS: s.calls, CI_LOCAL_SCRIPT: s.fakeLocal },
      s.b,
      s.copy,
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('GH_TOKEN is not set')
    expect(existsSync(s.calls)).toBe(false)
  })

  it('a run that waited for the runner while the PR moved on tests nothing and posts nothing', () => {
    const s = setup()
    const r = run(
      'run',
      {
        ...prEnv,
        PR_HEAD_SHA: 'b'.repeat(40),
        GH_TOKEN: 't',
        HOME: home(),
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
      },
      s.b,
      s.copy,
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain('moved on')
    expect(existsSync(s.calls)).toBe(false)
  })

  it('a PR that was closed while the run waited tests nothing and posts nothing', () => {
    const s = setup()
    const r = run(
      'run',
      {
        ...prEnv,
        PR_HEAD_SHA: s.real,
        GH_TOKEN: 't',
        GH_PR_STATE: 'closed',
        HOME: home(),
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
      },
      s.b,
      s.copy,
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain('is closed')
    expect(existsSync(s.calls)).toBe(false)
  })

  it("refuses a cache inside the runner's workspace before starting anything", () => {
    const s = setup()
    const r = run(
      'run',
      {
        ...prEnv,
        PR_HEAD_SHA: s.real,
        GH_TOKEN: 't',
        HOME: home(),
        TALOS_CI_CACHE: '/work/_work/_temp/c',
        RUNNER_TEMP: '/work/_work/_temp',
        CALLS: s.calls,
        CI_LOCAL_SCRIPT: s.fakeLocal,
      },
      s.b,
      s.copy,
    )
    expect(r.code).toBe(1)
    expect(existsSync(s.calls)).toBe(false)
  })

  describe('the settle step (ci-local.sh waits for a quiet head): asked for by the main push run alone', () => {
    const push = (s: { real: string }, more: Record<string, string> = {}) => ({
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REPOSITORY: 'owner/talos-app',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: s.real,
      ...more,
    })
    const settleOf = (c: string) => /^CI_SETTLE=(.*)$/m.exec(c)?.[1]

    it('a push run of main asks for it', () => {
      const s = setup()
      const r = run(
        'run',
        { ...push(s), GH_TOKEN: 't', HOME: home(), CALLS: s.calls, CI_LOCAL_SCRIPT: s.fakeLocal },
        s.b,
        s.copy,
      )
      expect(r.code, r.err).toBe(0)
      expect(settleOf(readFileSync(s.calls, 'utf8'))).toBe('1')
    })

    it('a PR, a dispatch, the nightly, the hostile nightly and a part machine never do', () => {
      const s = setup()
      const common = { GH_TOKEN: 't', HOME: home(), CALLS: s.calls, CI_LOCAL_SCRIPT: s.fakeLocal }
      const runs: [string, Record<string, string>][] = [
        ['pull request', { ...prEnv, PR_HEAD_SHA: s.real }],
        [
          'dispatch',
          { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'owner/talos-app', INPUT_REF: 'feat/x' },
        ],
        ['nightly', push(s, { GITHUB_EVENT_NAME: 'schedule' })],
        ['hostile nightly', push(s, { GITHUB_EVENT_NAME: 'schedule', CI_HOSTILE: '1' })],
        [
          'hostile dispatch',
          {
            GITHUB_EVENT_NAME: 'workflow_dispatch',
            GITHUB_REPOSITORY: 'owner/talos-app',
            INPUT_REF: 'feat/x',
            CI_HOSTILE: '1',
          },
        ],
        [
          'a push on the other machines',
          push(s, { CI_RUN_JOBS: 'check', CI_RUN_PREFIX: 'report-ci', CI_PLAN_SHA: s.real }),
        ],
      ]
      for (const [what, e] of runs) {
        expect(run('run', { ...e, ...common }, s.b, s.copy).code, what).toBe(0)
        expect(settleOf(readFileSync(s.calls, 'utf8')), what).toBe('')
      }
    })

    it('a re-run (attempt 2 or later of the same workflow run) tests the commit at once: "Re-run all jobs" on an old commit is a request to test it', () => {
      const s = setup()
      for (const [attempt, want] of [
        ['1', '1'],
        ['', '1'], // not given: the first
        ['x', '1'], // not a number: the first
        ['2', ''],
        ['10', ''],
      ] as const) {
        const r = run(
          'run',
          {
            ...push(s),
            GITHUB_RUN_ATTEMPT: attempt,
            GH_TOKEN: 't',
            HOME: home(),
            CALLS: s.calls,
            CI_LOCAL_SCRIPT: s.fakeLocal,
          },
          s.b,
          s.copy,
        )
        expect(r.code, r.err).toBe(0)
        expect(settleOf(readFileSync(s.calls, 'utf8')), `attempt '${attempt}'`).toBe(want)
        if (want === '') expect(r.out).toContain('a re-run')
      }
    })

    it('a stray CI_SETTLE in the environment never reaches a run that is not a main push', () => {
      const s = setup()
      const r = run(
        'run',
        {
          ...prEnv,
          PR_HEAD_SHA: s.real,
          GH_TOKEN: 't',
          HOME: home(),
          CALLS: s.calls,
          CI_LOCAL_SCRIPT: s.fakeLocal,
          CI_SETTLE: '1',
        },
        s.b,
        s.copy,
      )
      expect(r.code, r.err).toBe(0)
      expect(settleOf(readFileSync(s.calls, 'utf8'))).toBe('')
    })

    it('a push run while main is red goes at once: a fix for a red main is not made to wait', () => {
      const s = setup()
      const gh = bin({
        gh: `case "$*" in *"commits?sha=main"*) echo ${s.real} ;; *"/status"*) printf 'local-ci/check\\tfailure\\tfailed on ci-runner\\n' ;; esac`,
      })
      const r = run(
        'run',
        { ...push(s), GH_TOKEN: 't', HOME: home(), CALLS: s.calls, CI_LOCAL_SCRIPT: s.fakeLocal },
        `${gh}:${s.b}`,
        s.copy,
      )
      expect(r.code, r.err).toBe(0)
      expect(settleOf(readFileSync(s.calls, 'utf8'))).toBe('')
      expect(r.out).toContain('main is red')
    })

    it('main green, or GitHub unreadable: it settles (a failed read is no reason to skip the wait)', () => {
      const s = setup()
      for (const body of [
        `case "$*" in *"commits?sha=main"*) echo ${'b'.repeat(40)} ;; *"/status"*) for j in check mod browser image desktop mobile; do printf 'local-ci/%s\\tsuccess\\tpassed on ci-runner in 9s\\n' $j; done ;; esac`,
        'exit 1',
      ]) {
        const gh = bin({ gh: body })
        const r = run(
          'run',
          { ...push(s), GH_TOKEN: 't', HOME: home(), CALLS: s.calls, CI_LOCAL_SCRIPT: s.fakeLocal },
          `${gh}:${s.b}`,
          s.copy,
        )
        expect(r.code, r.err).toBe(0)
        expect(settleOf(readFileSync(s.calls, 'utf8'))).toBe('1')
      }
    })
  })

  describe('ci-runner.sh settled: the later steps of a run that stood aside', () => {
    it('says superseded=true when ci-local.sh left its note, false otherwise', () => {
      const d = scratch()
      const file = join(d, 'ci-sha')
      const out = () => run('settled', { CI_SHA_FILE: file }).out
      expect(out()).toBe('superseded=false\n')
      writeFileSync(`${file}.superseded`, `${'c'.repeat(40)}\n`)
      expect(out()).toBe('superseded=true\n')
      expect(run('settled', {}).out).toBe('superseded=false\n') // no file given: nothing stood aside
    })

    it("the fallback takes nothing over for a run that stood aside: its machines' answers are for a commit nobody tests", () => {
      const s = setup()
      const d = scratch()
      writeFileSync(join(d, 'ci-sha.superseded'), `${'c'.repeat(40)}\n`)
      const r = run(
        'fallback',
        {
          ...prEnv,
          PR_HEAD_SHA: s.real,
          GH_TOKEN: 't',
          HOME: home(),
          CALLS: s.calls,
          CI_LOCAL_SCRIPT: s.fakeLocal,
          CI_FALLBACK: 'titan:image',
          CI_SHA_FILE: join(d, 'ci-sha'),
        },
        s.b,
        s.copy,
      )
      expect(r.code, r.err).toBe(0)
      expect(r.out).toContain('stood aside')
      expect(existsSync(s.calls)).toBe(false)
    })
  })
})

describe("ci-runner.sh sweep: a status this run left pending is closed, nobody else's is touched", () => {
  const url = 'https://example.test/actions/runs/7'
  const fakeGh = (rows: string, readFails = false) => {
    const T = scratch()
    const b = bin({
      gh: `if [ "$1 $2" = "api -X" ]; then echo "$*" >> "${T}/posts"; exit 0; fi
${readFails ? 'exit 1' : `printf '%b' '${rows}'`}`,
    })
    return {
      b,
      posts: () => (existsSync(join(T, 'posts')) ? readFileSync(join(T, 'posts'), 'utf8').trim().split('\n') : []),
      T,
    }
  }
  const envFor = (T: string) => {
    writeFileSync(join(T, 'sha'), `${SHA}\n`)
    return { GITHUB_REPOSITORY: 'owner/talos-app', CI_STATUS_URL: url, CI_SHA_FILE: join(T, 'sha') }
  }

  it("posts error for a local-ci status that is pending and carries this run's link, and for nothing else", () => {
    const g = fakeGh(
      `${[
        `local-ci/check\tpending\t${url}`, // ours, pending: closed
        `local-ci/mod\tpending\t${url}`, // ours, pending: closed
        `local-ci/browser\tsuccess\t${url}`, // ours, done
        `local-ci/image\tpending\thttps://example.test/actions/runs/8`, // a newer run's
        'local-ci/desktop\tpending\t', // the Mac's own run (no link)
        `ci/other\tpending\t${url}`, // not a local-ci context
        `report-ci/fast\tpending\t${url}`, // ours, pending: closed too (it is ours, though outside the verdict)
        `ci-part/bridge-shard-2\tpending\t${url}`, // ours, a part of check posted from another machine: closed too
      ].join('\\n')}\\n`,
    )
    const r = run('sweep', envFor(g.T), g.b)
    expect(r.code).toBe(0)
    const posts = g.posts()
    expect(posts).toHaveLength(4)
    expect(posts.join('\n')).toMatch(/context=report-ci\/fast/)
    expect(posts.join('\n')).toMatch(/context=ci-part\/bridge-shard-2/)
    expect(posts.join('\n')).toMatch(/context=local-ci\/check/)
    expect(posts.join('\n')).toMatch(/context=local-ci\/mod/)
    expect(
      posts.every(
        (p) =>
          p.includes('state=error') &&
          p.includes(`target_url=${url}`) &&
          p.includes(`repos/owner/talos-app/statuses/${SHA}`),
      ),
    ).toBe(true)
    expect(r.out).toContain('closed 4 status(es)')
  })

  // A job cancelled (job.status, which the workflow passes as CI_JOB_STATUS) was not tested: its pending closes as an error that
  // says "not tested:", which no verdict reads as red or green, and never as a success. Any other end (it died) keeps the plain error.
  it('a cancelled job closes its pending as a "not tested:" error, never a success; a job that died keeps the plain error', () => {
    for (const [status, state, words] of [
      ['cancelled', 'error', 'not tested: run cancelled before this job reported (on ci-runner); re-run'],
      ['failure', 'error', 'run on ci-runner ended before this job reported'],
      ['', 'error', 'run on ci-runner ended before this job reported'],
    ] as const) {
      const g = fakeGh(`local-ci/check\tpending\t${url}\n`)
      const r = run('sweep', { ...envFor(g.T), CI_JOB_STATUS: status }, g.b)
      expect(r.code, status).toBe(0)
      const posts = g.posts()
      expect(posts, status).toHaveLength(1)
      expect(posts[0], status).toContain(`state=${state} `)
      expect(posts[0], status).toContain(`description=${words}`)
    }
  })

  it('closes a pending local-ci status that sits past the first 30 statuses of the commit', () => {
    const T = scratch()
    // Like GitHub: 30 rows unless the call asks for per_page=100 with --paginate.
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => `ci/other-${i}\tsuccess\t${url}`),
      `local-ci/check\tpending\t${url}`,
    ].join('\n')
    writeFileSync(join(T, 'rows'), `${rows}\n`)
    const b = bin({
      gh: `if [ "$1 $2" = "api -X" ]; then echo "$*" >> "${T}/posts"; exit 0; fi
case "$*" in *--paginate*per_page=100*) head -n 1000 "${T}/rows" ;; *) head -n 30 "${T}/rows" ;; esac`,
    })
    const r = run('sweep', envFor(T), b)
    expect(r.code).toBe(0)
    expect(r.out).toContain('closed 1 status(es)')
    expect(readFileSync(join(T, 'posts'), 'utf8')).toMatch(/context=local-ci\/check/)
  })

  it('when the statuses cannot be read it says so and changes nothing', () => {
    const g = fakeGh('', true)
    const r = run('sweep', envFor(g.T), g.b)
    expect(r.code).toBe(0)
    expect(r.out).toContain('::warning::')
    expect(g.posts()).toEqual([])
  })

  it('a sha file that holds anything but a commit sha is refused, loudly, and nothing is posted', () => {
    const g = fakeGh(`local-ci/check\tpending\t${url}\n`)
    writeFileSync(join(g.T, 'sha'), 'ef41a44; rm -rf x\n')
    const r = run(
      'sweep',
      { GITHUB_REPOSITORY: 'owner/talos-app', CI_STATUS_URL: url, CI_SHA_FILE: join(g.T, 'sha') },
      g.b,
    )
    expect(r.code).toBe(1)
    expect(r.err).toContain('does not hold a commit sha')
    expect(g.posts()).toEqual([])
  })

  it('a run that never reached a commit has nothing to sweep', () => {
    const g = fakeGh('')
    const r = run(
      'sweep',
      { GITHUB_REPOSITORY: 'owner/talos-app', CI_STATUS_URL: url, CI_SHA_FILE: join(g.T, 'none') },
      g.b,
    )
    expect(r.code).toBe(0)
    expect(g.posts()).toEqual([])
  })

  // The race seen on Titan (0d3b391, run 43422866981): image passed and posted success at 12:10:35; the sweep a second later
  // read the combined status (commits/<sha>/status), which still showed this run's pending, and wrote error over the green.
  // A fake gh that answers the two reads apart: the combined one stale, the newest-first list (commits/<sha>/statuses) fresh.
  const raceGh = (combined: string[], list: string[]) => {
    const T = scratch()
    writeFileSync(join(T, 'combined'), `${combined.join('\n')}\n`)
    writeFileSync(join(T, 'list'), `${list.join('\n')}\n`)
    const b = bin({
      gh: `if [ "$1 $2" = "api -X" ]; then echo "$*" >> "${T}/posts"; exit 0; fi
case "$*" in *"/statuses?"*) cat "${T}/list" ;; *"/status?"*) cat "${T}/combined" ;; *) exit 1 ;; esac`,
    })
    return {
      b,
      T,
      posts: () => (existsSync(join(T, 'posts')) ? readFileSync(join(T, 'posts'), 'utf8').trim().split('\n') : []),
    }
  }

  it('a status this run reported (written down by ci_post_status) is never closed, even when the combined read is stale', () => {
    const g = raceGh([`local-ci/image\tpending\t${url}`], [`local-ci/image\tpending\t${url}`]) // both reads stale
    const e = envFor(g.T)
    writeFileSync(`${e.CI_SHA_FILE}.reported`, `${SHA}\tlocal-ci/image\t${url}\n`)
    const r = run('sweep', e, g.b)
    expect(r.code).toBe(0)
    expect(g.posts()).toEqual([])
    expect(r.out).toContain('closed 0 status(es)')
  })

  it("another run's answer written down (a dead run settled by the reap, another link) does not hide this run's pending", () => {
    const g = raceGh([`local-ci/image\tpending\t${url}`], [`local-ci/image\tpending\t${url}`])
    const e = envFor(g.T)
    writeFileSync(
      `${e.CI_SHA_FILE}.reported`,
      [`${SHA}\tlocal-ci/image\thttps://example.test/actions/runs/6`, `${'b'.repeat(40)}\tlocal-ci/image\t${url}`].join(
        '\n',
      ) + '\n',
    )
    const r = run('sweep', e, g.b)
    expect(g.posts()).toHaveLength(1)
    expect(r.out).toContain('closed 1 status(es)')
  })

  it('a pending the combined read still shows is not closed when the newest-first list already has its answer', () => {
    const g = raceGh(
      [`local-ci/image\tpending\t${url}`, `local-ci/check\tpending\t${url}`],
      [
        `local-ci/image\tsuccess\t${url}`, // newest first: the answer, posted a second before the sweep
        `local-ci/check\tpending\t${url}`, // truly left pending: closed
        `local-ci/image\tpending\t${url}`,
      ],
    )
    const r = run('sweep', envFor(g.T), g.b)
    expect(r.code).toBe(0)
    const posts = g.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatch(/context=local-ci\/check/)
    expect(r.out).toContain('closed 1 status(es)')
  })

  it("a pending whose newest row in the list is another run's (a newer link) is left alone", () => {
    const g = raceGh(
      [`local-ci/image\tpending\t${url}`],
      [`local-ci/image\tpending\thttps://example.test/actions/runs/8`, `local-ci/image\tpending\t${url}`],
    )
    const r = run('sweep', envFor(g.T), g.b)
    expect(g.posts()).toEqual([])
    expect(r.out).toContain('closed 0 status(es)')
  })

  it('when the list cannot be read it falls back to the combined read, as before', () => {
    const T = scratch()
    const b = bin({
      gh: `if [ "$1 $2" = "api -X" ]; then echo "$*" >> "${T}/posts"; exit 0; fi
case "$*" in *"/statuses?"*) exit 1 ;; *) printf 'local-ci/check\\tpending\\t${url}\\n' ;; esac`,
    })
    const r = run('sweep', envFor(T), b)
    expect(r.code).toBe(0)
    expect(r.out).toContain('closed 1 status(es)')
  })

  const jq = spawnSync('jq', ['--version']).status === 0
  it.skipIf(!jq)('the gh --jq expression yields the three columns the sweep reads', () => {
    const text = readFileSync(script, 'utf8')
    const sweep = text.slice(text.indexOf('ci_sweep() {'), text.indexOf('\n}\n', text.indexOf('ci_sweep() {')))
    const expr = /--jq '([^']+)'/.exec(sweep)?.[1] as string
    const json = JSON.stringify({ statuses: [{ context: 'local-ci/check', state: 'pending', target_url: url, id: 1 }] })
    const out = spawnSync('jq', ['-r', expr], { input: json, encoding: 'utf8' }).stdout
    expect(out).toBe(`local-ci/check\tpending\t${url}\n`)
  })
})

// Hestia's gate can stop its runner while a job runs (docs/CI-MACHINES.md, "Only while the builder is idle"): that job's own
// sweep never runs, and its report-ci/linux stays pending. The next Hestia run's sweep closes those: on this commit and the last
// 20 of main, a pending report-ci/linux whose link is another run of this workflow that has finished. Never a running one.
describe("ci-runner.sh sweep on Hestia: an earlier, finished Hestia run's pending report-ci/linux is closed", () => {
  const RUN = (id: number) => `https://github.com/owner/talos-app/actions/runs/${id}/attempts/1#hestia`
  const B = 'b'.repeat(40)
  const C = 'c'.repeat(40)
  const D = 'd'.repeat(40)
  const world = (statuses: Record<string, string[]>, runs: Record<number, string>) => {
    const T = scratch()
    for (const [sha, rows] of Object.entries(statuses)) writeFileSync(join(T, `rows-${sha}`), `${rows.join('\n')}\n`)
    for (const [id, row] of Object.entries(runs)) writeFileSync(join(T, `run-${id}`), `${row}\n`)
    const b = bin({
      gh: `if [ "$1 $2" = "api -X" ]; then echo "$*" >> "${T}/posts"; exit 0; fi
echo "$*" >> "${T}/reads"
all="$*"
case "$all" in
  *"/commits?sha=main"*) printf '%s\\n' ${[SHA, B, C, D].join(' ')} ;;
  *"/commits/"*"/status"*) s="\${all#*commits/}"; s="\${s%%/*}"; cat "${T}/rows-$s" 2>/dev/null ;;
  *"/actions/runs/"*) i="\${all#*actions/runs/}"; i="\${i%% *}"; cat "${T}/run-$i" 2>/dev/null || exit 1 ;;
esac`,
    })
    writeFileSync(join(T, 'sha'), `${SHA}\n`)
    return {
      b,
      env: (extra: Record<string, string> = {}) => ({
        GITHUB_REPOSITORY: 'owner/talos-app',
        CI_STATUS_URL: RUN(9),
        CI_SHA_FILE: join(T, 'sha'),
        GITHUB_RUN_ID: '9',
        CI_RUN_JOBS: 'linux',
        CI_STATUS_WHERE: 'hestia',
        ...extra,
      }),
      posts: () => (existsSync(join(T, 'posts')) ? readFileSync(join(T, 'posts'), 'utf8').trim().split('\n') : []),
      reads: () => (existsSync(join(T, 'reads')) ? readFileSync(join(T, 'reads'), 'utf8') : ''),
    }
  }
  const WF = '.github/workflows/ci-runner.yml'

  it('closes the finished ones, under their own link; leaves a running one, another workflow, an unreadable run, and anything else', () => {
    const w = world(
      {
        [SHA]: [`report-ci/linux\tpending\t${RUN(9)}`], // this run's own: closed by the usual sweep, once
        [B]: [`report-ci/linux\tpending\t${RUN(5)}`, `local-ci/check\tpending\t${RUN(5)}`], // run 5 finished: linux closed, local-ci never
        [C]: [`report-ci/linux\tpending\t${RUN(6)}`], // run 6 still running: left
        [D]: [
          `report-ci/linux\tpending\thttps://github.com/owner/talos-app/actions/runs/4/attempts/1#hestia`, // another workflow
          'report-ci/linux\tpending\thttps://elsewhere.test/x', // not a run link
        ],
      },
      { 5: `completed\t${WF}`, 6: `in_progress\t${WF}`, 4: 'completed\t.github/workflows/other.yml' },
    )
    const r = run('sweep', w.env(), w.b)
    expect(r.code, r.err).toBe(0)
    const posts = w.posts()
    expect(posts).toHaveLength(2)
    expect(posts.filter((p) => p.includes(`statuses/${SHA} `))).toHaveLength(1)
    const stale = posts.find((p) => p.includes(`statuses/${B} `)) as string
    expect(stale).toContain('context=report-ci/linux')
    expect(stale).toContain('state=error')
    expect(stale).toContain(`target_url=${RUN(5)}`)
    expect(stale).toContain('earlier Hestia run 5')
    expect(r.out).toContain('closed 1 report-ci/linux status(es) left pending by earlier Hestia runs')
    // a run whose state cannot be read is left alone too
    const u = world({ [SHA]: [], [B]: [`report-ci/linux\tpending\t${RUN(3)}`] }, {})
    expect(run('sweep', u.env(), u.b).code).toBe(0)
    expect(u.posts()).toEqual([])
  })

  it('only on Hestia: Lemnos and the part machines do not look at other commits', () => {
    const w = world({ [B]: [`report-ci/linux\tpending\t${RUN(5)}`] }, { 5: `completed\t${WF}` })
    const r = run('sweep', w.env({ CI_RUN_JOBS: '', CI_STATUS_WHERE: 'ci-runner' }), w.b)
    expect(r.code).toBe(0)
    expect(w.posts()).toEqual([])
    expect(w.reads()).not.toContain('commits?sha=main')
  })
})

describe("ci-runner.sh logs: a red run uploads its own commit's logs, not the whole cache", () => {
  const setup = (sha: string | null) => {
    const T = scratch()
    const logs = join(T, 'cache/logs')
    mkdirSync(logs, { recursive: true })
    for (const f of ['aaaaaaa-check.log', 'aaaaaaa-setup.log', 'aaaaaaa-check.log.step_vitest', 'bbbbbbb-check.log'])
      writeFileSync(join(logs, f), f)
    writeFileSync(join(logs, 'timings.tsv'), 'row\n')
    if (sha !== null) writeFileSync(join(T, 'sha'), `${sha}\n`)
    const out = join(T, 'out')
    return { out, e: { HOME: T, TALOS_CI_CACHE: join(T, 'cache'), CI_SHA_FILE: join(T, 'sha'), CI_LOGS_OUT: out } }
  }
  const files = (d: string) => (existsSync(d) ? readdirSync(d).sort() : [])

  it("copies only this sha's <short>-*.log and <short>-*.log.* files, and timings.tsv", () => {
    const { out, e } = setup(SHA)
    const r = run('logs', e)
    expect(r.code, r.err).toBe(0)
    expect(files(out)).toEqual([
      'aaaaaaa-check.log',
      'aaaaaaa-check.log.step_vitest',
      'aaaaaaa-setup.log',
      'timings.tsv',
    ])
  })

  it('a run that never reached a commit copies only timings.tsv', () => {
    const { out, e } = setup(null)
    expect(run('logs', e).code).toBe(0)
    expect(files(out)).toEqual(['timings.tsv'])
  })

  it('a sha file that holds anything but a commit sha copies no logs', () => {
    const { out, e } = setup('*')
    expect(run('logs', e).code).toBe(1)
    expect(files(out)).toEqual(['timings.tsv'])
  })
})

describe('ci-runner.sh verdict: the last verdict on main, and why newer commits have none', () => {
  const ok = (c: string) => `local-ci/${c}\tsuccess\tpassed on ci-runner in 40s`
  const six = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
  const allPassed = six.map(ok)
  const classify = (lines: string[]) =>
    sh(`ci_classify <<'X'\n${lines.join('\n')}\nX`)
      .out.replace(/\n$/, '')
      .split('\t')

  describe('the grading of one commit (ci_classify)', () => {
    it('all six contexts, each "passed on ...", is green', () => {
      expect(classify(allPassed)[0]).toBe('green')
    })
    it('a commit a main run stood aside from (settle) has only report-ci/superseded: no verdict, neither red nor green', () => {
      const mark = "report-ci/superseded\tsuccess\tnot tested: superseded by abc1234; CI tests main's newest commit"
      expect(classify([mark])[0]).toBe('none')
      // the mark never turns a commit's own results into something else, either way
      expect(classify([mark, ...allPassed])[0]).toBe('green')
      expect(classify([mark, ...allPassed.slice(0, 5), 'local-ci/mobile\tfailure\tfailed on ci-runner'])[0]).toBe('red')
    })
    it('"with warnings" in the description is still green: a warned step (personal data, audit, sleep) never changes a job status', () => {
      const warned = allPassed.map((l) => `${l}, with warnings (see its log)`)
      expect(classify(warned)[0]).toBe('green')
      expect(classify([...allPassed.slice(0, 5), ok('mobile').concat(', with warnings (see its log)')])[0]).toBe(
        'green',
      )
    })
    it('a job skipped because none of its inputs changed since it last passed is no failure, and not a pass: listed apart', () => {
      const rows = allPassed.map((l) =>
        l.startsWith('local-ci/mobile\t')
          ? 'local-ci/mobile\tsuccess\tskipped: no mobile inputs changed since abc1234'
          : l,
      )
      const r = classify(rows)
      expect(r[0]).toBe('green')
      expect(r[1]).toContain('skipped, no affected files: mobile')
      // check is never skipped that way, so a check that says so is no verdict
      const check = allPassed.map((l) =>
        l.startsWith('local-ci/check\t')
          ? 'local-ci/check\tsuccess\tskipped: no check inputs changed since abc1234'
          : l,
      )
      expect(classify(check)[0]).toBe('skipped')
      // only those words, with a commit: anything else after "skipped" is no verdict
      for (const why of [
        'skipped: no mobile inputs changed',
        'skipped: no mobile inputs changed since',
        'skipped: no inputs',
        'skipped: no browser inputs changed since abc1234', // another job's words
        'skipped: no mobile inputs changed since zzz1234', // not a sha
      ]) {
        const odd = allPassed.map((l) => (l.startsWith('local-ci/mobile\t') ? `local-ci/mobile\tsuccess\t${why}` : l))
        expect(classify(odd)[0], why).toBe('skipped')
      }
    })
    it('a cancelled run\'s "not tested:" error is no verdict, never red or green; a real failure beside it is still red', () => {
      const cancelled = six.map(
        (c) => `local-ci/${c}\terror\tnot tested: run cancelled before this job reported (on ci-runner); re-run`,
      )
      expect(classify(cancelled)[0]).not.toMatch(/^(red|green)$/)
      const half = allPassed.map((l, i) => (i < 3 ? l : (cancelled[i] as string)))
      expect(classify(half)[0]).not.toMatch(/^(red|green)$/)
      const red = [`local-ci/check\tfailure\tfailed on ci-runner`, ...cancelled.slice(1)]
      expect(classify(red)[0]).toBe('red')
    })
    it('report-ci/fast is not one of the six: its failure or its pending never changes the verdict', () => {
      for (const row of [
        'report-ci/fast\tfailure\tfailed on ci-runner',
        'report-ci/fast\tpending\trunning',
        // an older ci-local.sh closing a newer run's fast lane posts it under local-ci/: not one of the six either
        'local-ci/fast\terror\trun ended before this job reported',
      ])
        expect(classify([row, ...allPassed])[0], row).toBe('green')
    })

    it('"passed on retry" in the description is green, and the verdict names the jobs that had a flake', () => {
      const retried = allPassed.map((l) =>
        l.startsWith('local-ci/check\t') ? `${l}, passed on retry (2 flaky tests, see flakes.tsv)` : l,
      )
      const r = classify(retried)
      expect(r[0]).toBe('green')
      expect(r[1]).toContain('passed on retry: check')
    })
    it('a missing context is never green: a stubbed job or a shortened JOBS list leaves one out', () => {
      for (const gone of six) {
        const r = classify(allPassed.filter((l) => !l.startsWith(`local-ci/${gone}\t`)))
        expect(r[0], gone).toBe('partial')
        expect(r[1], gone).toContain(gone)
      }
      expect(classify(allPassed.slice(0, 3))[0]).toBe('partial') // JOBS cut to three
    })
    it('a skipped job is never green, whatever the reason it gives', () => {
      for (const why of [
        'skipped (no desktop changes)',
        'skipped (swift is not installed)',
        'passed',
        'skipped (passed on a rumour)',
        '',
      ]) {
        const r = classify([...allPassed.slice(0, 4), `local-ci/desktop\tsuccess\t${why}`, ok('mobile')])
        expect(r[0], why).toBe('skipped')
        expect(r[1], why).toContain('desktop')
      }
    })
    it('"skipped: no affected files" is no failure and no pass: green, with the skipped jobs listed apart', () => {
      const skip = (c: string) => `local-ci/${c}\tsuccess\tskipped: no affected files`
      const r = classify([...allPassed.slice(0, 4), skip('desktop'), skip('mobile')])
      expect(r[0]).toBe('green')
      expect(r[1]).toBe('passed: check mod browser image; skipped, no affected files: desktop mobile')
      // one skipped job among passes
      expect(classify([...allPassed.slice(0, 5), skip('mobile')])[0]).toBe('green')
    })
    it('that skip is read only as exactly those words, and never for check, the job that always runs', () => {
      const withDesktop = (d: string) => [...allPassed.slice(0, 4), `local-ci/desktop\tsuccess\t${d}`, ok('mobile')]
      for (const d of [
        'skipped: no affected files.',
        'skipped: no affected files, passed on ci-runner',
        'Skipped: no affected files',
        'skipped (no affected files)',
        ' skipped: no affected files',
      ]) {
        expect(classify(withDesktop(d))[0], d).toBe('skipped')
      }
      const checkSkipped = allPassed.map((l) =>
        l.startsWith('local-ci/check\t') ? 'local-ci/check\tsuccess\tskipped: no affected files' : l,
      )
      expect(classify(checkSkipped)[0]).toBe('skipped')
      expect(classify(checkSkipped)[1]).toContain('check')
    })
    it('a skip does not hide a failure, a pending job or a missing context', () => {
      const skip = (c: string) => `local-ci/${c}\tsuccess\tskipped: no affected files`
      const base = [...allPassed.slice(0, 3), skip('desktop'), skip('mobile')] // image is missing
      expect(classify(base)[0]).toBe('partial')
      const red = [...allPassed.slice(0, 3), 'local-ci/image\tfailure\tx', skip('desktop'), skip('mobile')]
      expect(classify(red)[0]).toBe('red')
      const pend = [...allPassed.slice(0, 3), 'local-ci/image\tpending\tx', skip('desktop'), skip('mobile')]
      expect(classify(pend)[0]).toBe('pending')
    })
    it('pending, failed and errored contexts are not green, and each is named', () => {
      const swap = (c: string, state: string, d = 'x') =>
        allPassed.map((l) => (l.startsWith(`local-ci/${c}\t`) ? `local-ci/${c}\t${state}\t${d}` : l))
      expect(classify(swap('image', 'pending'))).toEqual(['pending', 'still pending: image'])
      expect(classify(swap('mod', 'failure'))[0]).toBe('red')
      expect(classify(swap('mod', 'failure'))[1]).toContain('failed: mod')
      expect(classify(swap('mod', 'error'))[0]).toBe('interrupted')
      expect(classify(swap('mod', 'brand-new-state'))[0]).toBe('interrupted') // an unknown value degrades to not-green
    })
    it('a final failure is RED even when other jobs never reported, were skipped or errored; nothing hides it', () => {
      const failMod = allPassed.map((l) => (l.startsWith('local-ci/mod\t') ? 'local-ci/mod\tfailure\tx' : l))
      const noMobile = failMod.filter((l) => !l.startsWith('local-ci/mobile\t'))
      const r1 = classify(noMobile)
      expect(r1[0]).toBe('red')
      expect(r1[1]).toContain('failed: mod')
      expect(r1[1]).toContain('never reported: mobile')
      const skippedToo = failMod.map((l) =>
        l.startsWith('local-ci/desktop\t') ? 'local-ci/desktop\tsuccess\tskipped (x)' : l,
      )
      expect(classify(skippedToo)[0]).toBe('red')
      expect(classify(skippedToo)[1]).toContain('skipped: desktop')
      const errToo = failMod.map((l) => (l.startsWith('local-ci/image\t') ? 'local-ci/image\terror\tx' : l))
      expect(classify(errToo)[0]).toBe('red')
      expect(classify(errToo)[1]).toContain('error state: image')
    })
    it('a pending context outranks a failure for the class, but the failed job is still named', () => {
      const l = allPassed.map((x) =>
        x.replace(
          /^local-ci\/(mod|image)\tsuccess\t.*/,
          (_m, c) => `local-ci/${c}\t${c === 'mod' ? 'failure' : 'pending'}\tx`,
        ),
      )
      expect(classify(l)[0]).toBe('pending')
      expect(classify(l)[1]).toContain('failed: mod')
    })
    it('no local-ci status, or only other contexts, is "none"', () => {
      expect(classify([''])[0]).toBe('none')
      expect(classify(['ci/other\tsuccess\tfine'])[0]).toBe('none')
    })
    it('other contexts are ignored, and the first of a repeated context (the newest) wins', () => {
      expect(classify(['ci/other\tfailure\tx', ...allPassed])[0]).toBe('green')
      expect(classify(['local-ci/mod\tfailure\tnew', ...allPassed])[0]).toBe('red')
      expect(classify([...allPassed, 'local-ci/mod\tfailure\told'])[0]).toBe('green')
    })
    it('hostile description text is data: it cannot turn a skip into a pass', () => {
      const r = classify([
        ...allPassed.slice(0, 5),
        'local-ci/mobile\tsuccess\t$(touch /tmp/x); passed on\tpassed on x',
      ])
      expect(r[0]).toBe('skipped')
    })
  })

  // A fake `gh api` that answers the three questions the verdict asks from fixture files, and fails like GitHub does (exit 1) for
  // anything not in them. It prints what the real call prints after --jq.
  function world(commits: string[], statuses: Record<string, string[]>, runs: Record<string, string[]> = {}) {
    const fix = scratch()
    writeFileSync(join(fix, 'commits'), `${commits.join('\n')}\n`)
    for (const [k, v] of Object.entries(statuses)) writeFileSync(join(fix, `status-${k}`), `${v.join('\n')}\n`)
    for (const [k, v] of Object.entries(runs)) writeFileSync(join(fix, `runs-${k}`), `${v.join('\n')}\n`)
    const b = bin({
      // Like GitHub, a status read gives 30 rows unless the call asks for per_page=100 and --paginate.
      gh: `[ "$1" = api ] || exit 1
paginate=0; path=
for a in "$@"; do case "$a" in --paginate) paginate=1 ;; repos/*) path="$a" ;; esac; done
echo "$path" >> "$FIX/calls"
limit=100000
case "$path" in
  repos/owner/talos-app/commits\\?sha=main\\&per_page=*) pp="\${path##*per_page=}"; head -n "$pp" "$FIX/commits" > "$FIX/page"; f="$FIX/page" ;;
  repos/owner/talos-app/commits/*/status | repos/owner/talos-app/commits/*/status\\?per_page=*)
    s="\${path%%/status*}"; f="$FIX/status-\${s##*/}"
    case "$path" in *per_page=100) [ "$paginate" = 1 ] || limit=100 ;; *) limit=30 ;; esac ;;
  repos/owner/talos-app/actions/runs\\?head_sha=*) s="\${path#*head_sha=}"; f="$FIX/runs-\${s%%&*}" ;;
  *) exit 1 ;;
esac
[ -f "$f" ] || exit 1
head -n "$limit" "$f"`,
    })
    const go = (args: string[] = []) => {
      const r = spawnSync('bash', [script, 'verdict', ...args], {
        env: env({ GITHUB_REPOSITORY: 'owner/talos-app', FIX: fix }, b),
        encoding: 'utf8',
      })
      return {
        code: r.status,
        out: r.stdout,
        err: r.stderr,
        calls: existsSync(join(fix, 'calls')) ? readFileSync(join(fix, 'calls'), 'utf8') : '',
      }
    }
    return { go }
  }
  const c = (ch: string) => ch.repeat(40)
  const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map(c)

  it('reads every status of a commit: local-ci rows past the first 30, and past the first 100, still count', () => {
    // 110 other rows come first, so the six local-ci rows sit after row 100: only a --paginate read sees them
    const noise = Array.from({ length: 110 }, (_, i) => `ci/other-${i}\tsuccess\tok`)
    const w = world([A], { [A]: [...noise, ...allPassed] })
    const r = w.go()
    expect(r.code).toBe(0)
    expect(r.out).toContain('last verdict: aaaaaaa GREEN')
    expect(r.calls).toContain('per_page=100')
  })

  it('prints the newest commit with all six final, and tells the three kinds of "no verdict" apart', () => {
    const w = world(
      [A, B, C, D, E],
      {
        [A]: [], // nothing posted, no run at all
        [B]: [], // nothing posted, its run is queued
        [C]: [], // nothing posted, its run was cancelled in the queue
        [D]: [...allPassed.slice(0, 4), 'local-ci/desktop\tsuccess\tskipped (no desktop changes)', ok('mobile')],
        [E]: allPassed,
      },
      { [A]: [], [B]: ['push\tqueued\t'], [C]: ['push\tcompleted\tcancelled'] },
    )
    const r = w.go()
    expect(r.code).toBe(0)
    expect(r.out).toContain('last verdict: eeeeeee GREEN')
    const line = (sha: string) => r.out.split('\n').find((l) => l.includes(`  ${sha.slice(0, 7)}  `)) as string
    expect(line(A)).toContain('runner is down')
    expect(line(B)).toContain('not tested yet')
    expect(line(C)).toContain('never tested')
    expect(line(C)).toContain('cancelled')
    expect(line(D)).toContain('skipped')
    expect(line(D)).toContain('never green')
    // newest first, and nothing after the verdict commit is listed
    expect(r.out.indexOf('aaaaaaa')).toBeLessThan(r.out.indexOf('bbbbbbb'))
    expect(r.out).toMatch(/GREEN.*\n.*newer commits with no verdict \(newest first\):/s)
  })

  it('a commit whose desktop and mobile were skipped for lack of affected files is a verdict, and the line does not claim six passes', () => {
    const skip = (c: string) => `local-ci/${c}\tsuccess\tskipped: no affected files`
    const w = world([A, B], { [A]: [...allPassed.slice(0, 4), skip('desktop'), skip('mobile')], [B]: allPassed })
    const r = w.go()
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      'last verdict: aaaaaaa GREEN (no job failed; passed: check mod browser image; skipped, no affected files: desktop mobile)',
    )
    expect(r.out).not.toContain('all six passed')
    expect(r.out).toContain('newer commits with no verdict: none')
    // the other skip texts stay "no verdict"
    const old = world([A, B], {
      [A]: [...allPassed.slice(0, 4), 'local-ci/desktop\tsuccess\tskipped (no desktop changes)', ok('mobile')],
      [B]: allPassed,
    })
    expect(old.go().out).toContain('last verdict: bbbbbbb GREEN (all six passed')
  })

  it('a red verdict is printed as red with the failed job named, exit 1; it is a verdict, so older commits are not read', () => {
    const w = world([A, B], {
      [A]: allPassed.map((l) =>
        l.replace(
          'local-ci/browser\tsuccess\tpassed on ci-runner in 40s',
          'local-ci/browser\tfailure\tfailed on ci-runner',
        ),
      ),
      [B]: allPassed,
    })
    const r = w.go()
    expect(r.code).toBe(1)
    expect(r.out).toContain('last verdict: aaaaaaa RED (failed: browser')
    expect(r.out).toContain('newer commits with no verdict: none')
    expect(r.calls).not.toContain(B)
  })

  it('a newer commit with a failure and a gap is RED and is the verdict; the older green does not hide it', () => {
    const w = world([A, B], {
      [A]: allPassed
        .slice(0, 5)
        .map((l) => l.replace('local-ci/mod\tsuccess\tpassed on ci-runner in 40s', 'local-ci/mod\tfailure\tf')),
      [B]: allPassed,
    })
    const r = w.go()
    expect(r.code).toBe(1)
    expect(r.out).toContain('last verdict: aaaaaaa RED (failed: mod')
    expect(r.out).toContain('never reported: mobile')
  })

  it('a pending newer commit names the job that already failed in it', () => {
    const w = world([A, B], {
      [A]: [
        ...allPassed
          .slice(0, 3)
          .map((l) => l.replace('local-ci/check\tsuccess\tpassed on ci-runner in 40s', 'local-ci/check\tfailure\tf')),
        'local-ci/image\tpending\tr',
      ],
      [B]: allPassed,
    })
    const r = w.go()
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/aaaaaaa {2}no verdict yet, still pending: image; failed: check/)
  })

  it('a push bigger than the window does not lose the last verdict: it looks further back (up to 100) and says so', () => {
    const shas = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(40, '0'))
    const statuses: Record<string, string[]> = {}
    for (const sh of shas) statuses[sh] = []
    statuses[shas[25] as string] = allPassed
    const runs: Record<string, string[]> = {}
    for (const sh of shas) runs[sh] = []
    const r = world(shas, statuses, runs).go(['5'])
    expect(r.code).toBe(0)
    expect(r.out).toContain(`last verdict: ${shas[25]?.slice(0, 7)} GREEN`)
    expect(r.out).toContain('looked further back')
    expect(r.out).toContain('an inner commit of a multi-commit push')
  })

  it("exit 0 says which commit it is about, and that main's tip is newer and still running", () => {
    const w = world([A, B], { [A]: [...allPassed.slice(0, 5), 'local-ci/mobile\tpending\trunning'], [B]: allPassed })
    const r = w.go()
    expect(r.code).toBe(0)
    expect(r.out).toContain(`main tip: ${A.slice(0, 7)} is newer than the verdict commit ${B.slice(0, 7)}`)
    expect(r.out).toContain('1 newer commit is still running')
    expect(r.out).toContain(`exit 0 is about ${B.slice(0, 7)}, not main's tip`)
  })

  it('a newer commit with no pending status is not called running', () => {
    const w = world([A, B], { [A]: allPassed.slice(0, 5), [B]: allPassed })
    const r = w.go()
    expect(r.out).toContain(`main tip: ${A.slice(0, 7)} is newer than the verdict commit`)
    expect(r.out).toContain('none of the newer commits has a pending status')
  })

  it('when the verdict commit is the tip, it says the exit code speaks for main as it stands', () => {
    const w = world([A, B], { [A]: allPassed, [B]: allPassed })
    const r = w.go()
    expect(r.code).toBe(0)
    expect(r.out).toContain(`main tip: ${A.slice(0, 7)} is the verdict commit`)
    expect(r.out).not.toContain('is newer than the verdict commit')
  })

  it('a pending commit is "no verdict yet" and says a dead runner leaves the same sign', () => {
    const w = world([A, B], { [A]: [...allPassed.slice(0, 5), 'local-ci/mobile\tpending\trunning'], [B]: allPassed })
    const r = w.go()
    expect(r.code).toBe(0)
    expect(r.out).toContain('aaaaaaa  no verdict yet, still pending: mobile (running, or the runner died')
  })

  it('no verdict anywhere in the window is exit 2 and says so; it never prints green', () => {
    const w = world([A, B], { [A]: [], [B]: allPassed.slice(0, 5) })
    const r = w.go()
    expect(r.code).toBe(2)
    expect(r.out).toContain('last verdict: none in the last 100 (or all there are) commits')
    expect(r.out).not.toMatch(/GREEN|RED/)
    expect(r.out).toContain('never reported: mobile')
  })

  it('when GitHub cannot be read it says that, on stderr with exit 2, and prints no verdict line at all', () => {
    const noCommits = world([], {}).go()
    expect(noCommits.code).toBe(2)
    expect(noCommits.err).toContain('GitHub was not read')
    expect(noCommits.out).toBe('')
    const noStatus = world([A, B], { [B]: allPassed }).go() // A's status read fails (a 404 or a network error), B is green
    expect(noStatus.code).toBe(2)
    expect(noStatus.err).toContain('statuses of aaaaaaa')
    expect(noStatus.out).not.toMatch(/GREEN/)
  })

  it('a failing run lookup for a commit with no status is said, not read as "no run"', () => {
    const r = world([A, B], { [A]: [], [B]: allPassed }).go() // no runs fixture for A: the lookup fails
    expect(r.out).toContain('could not read its workflow runs')
    expect(r.out).not.toContain('runner is down')
  })

  it('the window is the argument, capped at 100; a bad one is refused', () => {
    const w = world([A], { [A]: allPassed })
    expect(w.go(['5']).calls).toContain('per_page=5')
    expect(w.go(['500']).calls).toContain('per_page=100')
    for (const bad of ['0', 'x', '-1', '1;ls']) expect(w.go([bad]).code, bad).toBe(2)
  })

  it('is a subcommand of the script, listed in its usage', () => {
    expect(run('nonsense').err + run('nonsense').out).toContain('verdict')
  })
})

describe('the workflows', () => {
  const block = (yml: string, key: string) => {
    const lines = yml.split('\n')
    const i = lines.findIndex((l) => new RegExp(`^${key}:`).test(l))
    const out: string[] = []
    for (const l of lines.slice(i + 1)) {
      if (l && !/^\s/.test(l)) break
      out.push(l)
    }
    return out.join('\n')
  }

  it('ci.yml stays manual-only: the cloud overflow, not a trigger', () => {
    const on = block(ciYml, 'on')
    expect(on.trim()).toBe('workflow_dispatch:')
    expect(ciYml).not.toMatch(/pull_request|push:|schedule:/)
  })

  itRunnerYml(
    'ci-runner.yml triggers: dispatch with a ref, the four PR events, a push to main and two schedules (the nightly, the hostile one), nothing else',
    () => {
      const on = block(runnerYml, 'on')
      expect(on).toMatch(/workflow_dispatch:\s+inputs:\s+ref:/)
      expect(on).toMatch(/jobs:\s+description:/) // optional: one job for a quick look; it reaches the script as INPUT_JOBS, env only
      expect(runnerYml).toMatch(/INPUT_JOBS: \$\{\{ inputs\.jobs \}\}/)
      expect(on).toMatch(/pull_request:\s+types: \[opened, synchronize, reopened, ready_for_review\]/)
      expect(on).toMatch(/\n {2}push:\n {4}branches: \[main\]\n/)
      expect(on).toMatch(/\n {2}schedule:\n {4}- cron: "17 9 \* \* \*"/) // once a day, 09:17 UTC
      expect(on).toMatch(/\n {4}- cron: "43 11 \* \* \*"/) // the hostile nightly (scripts/ci-hostile.test.ts)
      expect(on.match(/- cron:/g)).toHaveLength(2)
      expect(on).not.toMatch(/pull_request_target|workflow_run|tags:|branches-ignore|paths/)
      expect([...on.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])).toEqual([
        'workflow_dispatch',
        'pull_request',
        'push',
        'schedule',
      ])
    },
  )

  itRunnerYml(
    'main is one run at a time and a push never cancels the running one; PRs and dispatches still cancel',
    () => {
      const c = block(runnerYml, 'concurrency')
      // Pushes share one fixed group, apart from the PR groups and the dispatch groups.
      expect(c).toMatch(/github\.event_name == 'push' && 'main'/)
      // Evaluate the two expressions as GitHub would (its && and || return an operand, as JavaScript's do; == is JavaScript's ===).
      const evalExpr = (key: string, github: object, inputs: object) => {
        const raw = new RegExp(`${key}: (.*)$`, 'm').exec(c)?.[1] as string
        const body = (/\$\{\{ (.*) \}\}/.exec(raw)?.[1] ?? raw).replace(/ == /g, ' === ').replace(/ != /g, ' !== ')
        const format = (f: string, ...a: unknown[]) => f.replace(/\{(\d)\}/g, (_, i) => String(a[Number(i)]))
        return new Function('github', 'inputs', 'format', `return (${body})`)(github, inputs, format)
      }
      const group = (event_name: string, extra: object = {}, inputs: object = {}) =>
        evalExpr('group', { event_name, ...extra }, inputs).replace(/^/, 'ci-runner-')
      const cancel = (event_name: string) => evalExpr('cancel-in-progress', { event_name }, {})
      const pr = (n: number) => ({ event: { pull_request: { number: n } } })
      const gPush = group('push')
      // Every push is in the same group, whatever it carries: another sha, another pusher, a tag-looking ref.
      expect(gPush).toBe(group('push', { sha: 'b'.repeat(40), ref: 'refs/heads/main', actor: 'someone-else' }))
      expect(gPush).toBe(group('push', { sha: 'c'.repeat(40), event: { before: 'd'.repeat(40) } }))
      expect(gPush).not.toBe(group('pull_request', pr(7)))
      expect(gPush).not.toBe(group('workflow_dispatch', {}, { ref: 'main', jobs: '' }))
      expect(group('pull_request', pr(7))).not.toBe(group('pull_request', pr(8)))
      expect(cancel('push')).toBe(false)
      expect(cancel('pull_request')).toBe(true)
      expect(cancel('workflow_dispatch')).toBe(true)
      // The nightly has its own group and is never cancelled: it can't replace a pending push run, and no push replaces it.
      const nightly = { event: { schedule: '17 9 * * *' } }
      expect(group('schedule', nightly)).toBe('ci-runner-nightly')
      expect(group('schedule', nightly)).not.toBe(gPush)
      expect(group('schedule', nightly)).not.toBe(group('workflow_dispatch', {}, { ref: 'main', jobs: '' }))
      expect(cancel('schedule')).toBe(false)
      expect(c).not.toMatch(/cancel-in-progress: true/)
    },
  )

  itRunnerYml(
    'pin (unchanged by the push trigger): a push checks out and tests the pushed commit itself: the checkout falls back to github.sha, and the sha reaches the script as GITHUB_SHA',
    () => {
      const co = runnerYml.split('\n      - ').find((x) => x.includes('actions/checkout')) as string
      expect(co).toMatch(/ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/)
      // The Bootstrap step only ever touches a pull_request run, so a push can't be moved off its own commit by it.
      const boot = runnerYml.split('\n      - ').find((x) => x.includes('Bootstrap')) as string
      expect(boot).toContain("github.event_name == 'pull_request'")
      // The run step has no override of the sha or ref.
      expect(runnerYml).not.toMatch(/GITHUB_SHA:|GITHUB_REF:/)
    },
  )

  itRunnerYml(
    'pin (unchanged by the push trigger): the job is not skipped for a push, and the runner scripts still guard it',
    () => {
      // The fork-skipping `if` only narrows pull_request, so it lets a push through; the guard step then runs for every event.
      expect(runnerYml).toMatch(/if: github\.event_name != 'pull_request' \|\| /)
      expect(runnerYml).toContain('scripts/ci-runner.sh guard')
    },
  )

  itRunnerYml('one run per PR: a new push cancels the old one', () => {
    const c = block(runnerYml, 'concurrency')
    expect(c).toMatch(/group: ci-runner-.*github\.event\.pull_request\.number/)
    expect(c).toMatch(
      /cancel-in-progress: \$\{\{ github\.event_name != 'push' && github\.event_name != 'schedule' && !inputs\.hostile && inputs\.nightly != 'nightly' && inputs\.nightly != 'hostile' \}\}/,
    )
  })

  itRunnerYml(
    'a one-job dispatch of a ref does not cancel the full run of it: the job list is part of the group',
    () => {
      const c = block(runnerYml, 'concurrency')
      expect(c).toMatch(/format\('ref-\{0\}-\{1\}', inputs\.ref, inputs\.jobs\)/)
    },
  )

  // the jobs of the split (docs/CI-MACHINES.md), parsed with Bun's YAML in a child: [name, its object]
  const jobs = (): Record<string, Record<string, unknown>> =>
    JSON.parse(
      execFileSync(
        'bun',
        [
          '-e',
          'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text()).jobs))',
          runnerYmlPath,
        ],
        {
          encoding: 'utf8',
        },
      ),
    )

  itRunnerYml('each job gets only the permissions it needs, and GITHUB_TOKEN is the only secret', () => {
    expect(runnerYml).toMatch(/^permissions: \{\}$/m)
    const want: Record<string, Record<string, string>> = {
      plan: { contents: 'read' },
      ci: { statuses: 'write', contents: 'read', actions: 'read' }, // actions: read for the parts of check run elsewhere
      delphi: { statuses: 'write', contents: 'read' },
      cyclops: { statuses: 'write', contents: 'read' },
      hestia: { statuses: 'write', contents: 'read', actions: 'read' }, // actions: read for the earlier Hestia runs' state (sweep)
      titan: { statuses: 'write', contents: 'read' },
      'browser-e2e': { statuses: 'write', contents: 'read' }, // it never waits for Lemnos: no actions: read
      'check-titan': { statuses: 'write', contents: 'read' }, // nor does check's part
      close: { actions: 'write' }, // cancel the run; it checks nothing out, so no code under test meets this token
      green: { contents: 'write', statuses: 'read', actions: 'read' }, // push refs/heads/green; actions: read for the run behind each status
      relays: { contents: 'read', deployments: 'read', statuses: 'read', actions: 'read' }, // reads each relay's deployments and the deployed commit's statuses after green; no write of any kind
      inbox: { contents: 'read', issues: 'write' }, // the lead's inbox issue; it runs only lead-inbox.sh flush, on main's code
    }
    const j = jobs()
    expect(Object.keys(j).sort()).toEqual(Object.keys(want).sort())
    for (const [name, perms] of Object.entries(want)) expect(j[name]?.permissions, name).toEqual(perms)
    const close = JSON.stringify(j.close)
    expect(close).not.toContain('actions/checkout')
    expect(close).not.toContain('scripts/')
    const secrets = [...runnerYml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])
    expect(secrets.length).toBeGreaterThan(0)
    expect(new Set(secrets)).toEqual(new Set(['GITHUB_TOKEN']))
    expect(runnerYml).not.toMatch(/GH_TOKEN: \$\{\{ (?!secrets\.GITHUB_TOKEN)/)
  })

  itRunnerYml(
    'only the steps that talk to GitHub get the token: superseded, dispatch-wait, schedule-yield, run, fallback, alert, sweep, close, green, relays and inbox',
    () => {
      const withToken = runnerYml.split('\n      - ').filter((s) => s.includes('GH_TOKEN'))
      // run and sweep in ci and in each of the six remote jobs, ci's superseded, dispatch-wait, fallback, alert, e2e-shadow,
      // check-shadow and both pairs, schedule-yield, close, green, relays, and inbox
      expect(withToken).toHaveLength(27)
      for (const step of withToken)
        expect(step).toMatch(
          /scripts\/ci-pair\.sh part|ci-runner\.sh e2e-shadow|ci-runner\.sh check-shadow|scripts\/ci-runner\.sh run|ci-runner\.sh superseded|ci-runner\.sh dispatch-wait|ci-runner\.sh schedule-yield|ci-runner\.sh fallback|ci-runner\.sh alert|ci-runner\.sh sweep|ci-runner\.sh green|ci-runner\.sh relays|lead-inbox\.sh flush|Cancel the run/,
        )
    },
  )

  itRunnerYml(
    "the inbox job: after ci on Lemnos's runner, main's own code, only lead-inbox.sh flush; alone holds issues: write",
    () => {
      const j = jobs()
      const inbox = j.inbox as { needs?: string[]; if?: string; 'runs-on'?: string[]; steps: Record<string, unknown>[] }
      expect(inbox.needs).toEqual(['ci'])
      expect(inbox.if).toContain('always()')
      expect(inbox.if).toContain("github.event_name != 'pull_request'") // a PR writes no alert, and runs nothing here
      expect(inbox['runs-on']).toEqual(j.ci?.['runs-on']) // the same machine: the same ~/.cache/talos-ci/alerts
      const checkout = inbox.steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@')) as {
        with?: Record<string, unknown>
      }
      expect(checkout?.with?.ref).toBe('main') // never a dispatched branch's code
      expect(checkout?.with?.['persist-credentials']).toBe(false) // the token is never left in the shared .git/config
      const runs = inbox.steps.filter((s) => s.run).map((s) => s.run)
      expect(runs).toEqual(['bash scripts/lead-inbox.sh flush'])
      for (const [name, job] of Object.entries(j))
        if (name !== 'inbox') expect((job.permissions as Record<string, string>)?.issues, name).toBeUndefined()
      expect(j.close?.needs).toContain('inbox') // close never cancels the run under a flush
      // ci-runner.sh posts nothing itself any more: the job that runs code under test holds no issue token
      expect(readFileSync(join(here, 'ci-runner/alert.sh'), 'utf8')).not.toContain('lead-inbox')
      expect(readFileSync(join(here, 'ci-runner.sh'), 'utf8')).not.toContain('ci_alert_inbox')
    },
  )

  itRunnerYml('with every repository variable unset only plan, ci and close run: the remote jobs are skipped', () => {
    const j = jobs()
    for (const m of ['delphi', 'cyclops', 'hestia']) {
      expect(j[m]?.needs, m).toBe('plan')
      expect(String(j[m]?.if), m).toMatch(new RegExp(`^needs\\.plan\\.outputs\\.${m} != ''`))
    }
    // Titan: image; its browser-e2e part only with CI_TITAN_BROWSER e2e-shadow or e2e
    expect(j.titan?.needs).toBe('plan')
    expect(String(j.titan?.if)).toMatch(/^needs\.plan\.outputs\.titan != '' && /)
    expect(j['browser-e2e']?.needs).toBe('plan')
    expect(String(j['browser-e2e']?.if)).toMatch(/^needs\.plan\.outputs\.browser_e2e != '' && /)
    expect(j['check-titan']?.needs).toBe('plan')
    expect(String(j['check-titan']?.if)).toMatch(/^needs\.plan\.outputs\.check_titan != '' && /)
    // and plan's outputs come only from those variables (ci-runner-machines.test.ts: all off gives empty lists)
    expect(JSON.stringify((j.plan as { env: unknown }).env)).toMatch(
      /vars\.CI_DELPHI.*vars\.CI_CYCLOPS.*vars\.CI_HESTIA.*vars\.CI_TITAN_IMAGE.*vars\.CI_TITAN_BROWSER.*vars\.CI_BROWSER_E2E_WAIT.*vars\.CI_TITAN_CHECK.*vars\.CI_CHECK_WAIT/,
    )
    // Lemnos is told the planned commit and the parts to fold in. Only with a part elsewhere do its statuses link to the attempt
    // and read the attempt's answers; with every switch off its link is the run's, as before, and nothing extra is read.
    const ciEnv = (j.ci as { env: Record<string, string> }).env
    expect(ciEnv.CI_PLAN_SHA).toBe('${{ needs.plan.outputs.sha }}')
    expect(ciEnv.CI_REMOTE_PARTS).toBe('${{ needs.plan.outputs.remote_parts }}')
    // and the jobs another machine runs (image on Titan), with what to take over if it does not answer
    expect(ciEnv.CI_REMOTE_JOBS).toBe('${{ needs.plan.outputs.remote_jobs }}')
    expect(ciEnv.CI_FALLBACK).toBe('${{ needs.plan.outputs.fallback }}')
    // (e2e: the part is folded, so browser reads this attempt's answers; e2e-shadow folds nothing: links as off)
    const parts =
      "(needs.plan.outputs.delphi != '' || needs.plan.outputs.cyclops != '' || needs.plan.outputs.remote_jobs != '' || needs.plan.outputs.browser_e2e == 'ci-part' || needs.plan.outputs.check_titan == 'ci-part')"
    expect(ciEnv.CI_ATTEMPT_URL.startsWith(`\${{ ${parts} && format(`)).toBe(true)
    expect(
      ciEnv.CI_ATTEMPT_URL.endsWith(
        "/attempts/{3}#', github.server_url, github.repository, github.run_id, github.run_attempt) || '' }}",
      ),
    ).toBe(true)
    expect(ciEnv.CI_STATUS_URL.startsWith(`\${{ ${parts} && format(`)).toBe(true)
    expect(
      ciEnv.CI_STATUS_URL.endsWith(
        "|| format('{0}/{1}/actions/runs/{2}', github.server_url, github.repository, github.run_id) }}",
      ),
    ).toBe(true)
    // close runs only when a remote job was planned, and never after a cancel
    const closeIf = String((j.close as { if: string }).if)
    expect(closeIf).toContain('!cancelled()')
    expect(closeIf).toContain(
      "needs.plan.outputs.delphi != '' || needs.plan.outputs.cyclops != '' || needs.plan.outputs.hestia != '' || needs.plan.outputs.titan != '' || needs.plan.outputs.browser_e2e != '' || needs.plan.outputs.check_titan != ''",
    )
    // a base older than plan plans nothing (and so the bootstrap PR still runs)
    const planStep = (j.plan as { steps: { id?: string; run: string }[] }).steps.find((st) => st.id === 'plan')
      ?.run as string
    expect(planStep).toContain("grep -q '^  plan) ci_plan' scripts/ci-runner.sh")
  })

  itRunnerYml(
    'a plan that failed never leaves a commit without a verdict: ci then runs as today; the remote jobs and close do not',
    () => {
      const j = jobs()
      const fork =
        "github.event_name != 'pull_request' || (github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft)"
      // ci: whatever plan's result (success, failure), unless the run is cancelled, and never for a fork or a draft
      expect(String((j.ci as { if: string }).if)).toBe(`\${{ !cancelled() && (${fork}) }}`)
      // with no plan outputs its split inputs are empty: today's run (no --sha, the event's own commit)
      expect((j.ci as { env: Record<string, string> }).env.CI_PLAN_SHA).toBe('${{ needs.plan.outputs.sha }}')
      // the remote jobs and close keep the implicit success(): they need a plan that worked
      for (const m of ['delphi', 'cyclops', 'hestia', 'titan', 'browser-e2e', 'check-titan'])
        expect(String((j[m] as { if: string }).if), m).not.toContain('cancelled()')
      expect(String((j.close as { if: string }).if)).toContain("needs.plan.result == 'success'")
    },
  )

  itRunnerYml(
    'the delphi job sets CI_OWNER_MACHINE itself and runs the preflight before anything else of the run',
    () => {
      const j = jobs()
      const delphi = j.delphi as { env: Record<string, unknown>; steps: { name?: string; run?: string }[] }
      expect(String(delphi.env.CI_OWNER_MACHINE)).toBe('1')
      const names = delphi.steps.map((st) => st.name ?? st.run ?? '')
      const pre = names.findIndex((n) => /Preflight/.test(n))
      expect(pre).toBeGreaterThan(0)
      expect(pre).toBeLessThan(names.findIndex((n) => /Guard/.test(n)))
      expect(delphi.steps[pre]?.run).toBe('bash scripts/ci-runner.sh preflight')
      // every remote job refuses a fork in its first step and keeps the fork-and-draft if
      for (const m of ['delphi', 'cyclops', 'hestia', 'titan', 'browser-e2e', 'check-titan']) {
        const job = j[m] as { if: string; steps: { name?: string }[] }
        expect(job.steps[0]?.name, m).toBe('Refuse a fork before fetching anything of it')
        expect(job.if, m).toContain(
          'github.event.pull_request.head.repo.full_name == github.repository && !github.event.pull_request.draft',
        )
      }
      expect((j.hestia as Record<string, unknown>)['continue-on-error']).toBe(true)
    },
  )

  itRunnerYml(
    "shard tools: plan reads each part machine's advertised tools and hands every machine that deals shards the same list",
    () => {
      const j = jobs()
      const plan = j.plan as { env: Record<string, string>; outputs: Record<string, string> }
      expect(plan.env.CI_TOOLS_DELPHI).toBe('${{ vars.CI_TOOLS_DELPHI }}')
      expect(plan.env.CI_TOOLS_CYCLOPS).toBe('${{ vars.CI_TOOLS_CYCLOPS }}')
      expect(plan.outputs.shard_tools).toBe('${{ steps.plan.outputs.shard_tools }}')
      for (const m of ['ci', 'delphi', 'cyclops'])
        expect((j[m] as { env: Record<string, string> }).env.CI_SHARD_TOOLS, m).toBe(
          '${{ needs.plan.outputs.shard_tools }}',
        )
    },
  )

  itRunnerYml(
    "titan (phase B): image on Titan's runner, gating or shadow as plan says; Lemnos takes it over if it does not answer",
    () => {
      const j = jobs()
      const titan = j.titan as {
        'runs-on': string[]
        env: Record<string, string>
        'continue-on-error': boolean
        steps: { name?: string; run?: string }[]
      }
      expect(titan['runs-on']).toEqual(['self-hosted', 'Linux', 'talos-ci-linux'])
      expect(titan.env.CI_STATUS_WHERE).toBe('titan')
      expect(titan.env.CI_RUN_JOBS).toBe('${{ needs.plan.outputs.titan }}')
      expect(titan.env.CI_RUN_PREFIX).toBe('${{ needs.plan.outputs.titan_prefix }}')
      expect(titan.env.CI_PLAN_SHA).toBe('${{ needs.plan.outputs.sha }}')
      // its statuses link to this attempt and name the job: the attempt filter and the two-answers reads know them
      expect(titan.env.CI_ATTEMPT_URL).toBe(
        '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}/attempts/${{ github.run_attempt }}#',
      )
      expect(titan.env.CI_STATUS_URL).toBe(`${titan.env.CI_ATTEMPT_URL}titan`)
      expect(titan['continue-on-error']).toBe(true) // the verdict is read from statuses; Lemnos's fallback covers a dead Titan
      expect(titan.steps.some((st) => st.run === 'exec bash scripts/ci-runner.sh run')).toBe(true)
      expect(titan.steps.some((st) => /ci-runner\.sh sweep/.test(st.run ?? ''))).toBe(true)
      // plan hands the outputs on
      const planOut = (j.plan as { outputs: Record<string, string> }).outputs
      for (const o of [
        'titan',
        'titan_prefix',
        'remote_jobs',
        'fallback',
        'browser_e2e',
        'e2e_wait',
        'check_titan',
        'check_wait',
      ])
        expect(planOut[o], o).toBe(`\${{ steps.plan.outputs.${o} }}`)
      // Lemnos's fallback: after its own run, green or red, only when plan handed something to another machine
      const ci = j.ci as { steps: { name?: string; run?: string; if?: string }[] }
      const runAt = ci.steps.findIndex((st) => st.run === 'exec bash scripts/ci-runner.sh run')
      // exec: a cancel signals only the step's own process, which must become the fallback's ci-local.sh
      const fb = ci.steps.findIndex((st) => st.run === 'exec bash scripts/ci-runner.sh fallback')
      expect(fb).toBe(runAt + 1)
      // (and never for a dispatch closed as superseded: ci-dispatch-guard.test.ts)
      expect(ci.steps[fb]?.if).toBe(
        "${{ !cancelled() && needs.plan.outputs.fallback != '' && steps.dispatch.outputs.superseded != 'true' }}",
      )
      // the ci job's limit leaves room for both steps
      const mins = (st: unknown) => Number((st as { 'timeout-minutes': number })['timeout-minutes'])
      expect(mins(j.ci)).toBeGreaterThan(mins(ci.steps[runAt]) + mins(ci.steps[fb]))
    },
  )

  itRunnerYml(
    'a scheduled run yields in a step of its own before the run step, so the yield never uses up the run step’s time',
    () => {
      const ci = jobs().ci as { steps: { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }[] }
      const y = ci.steps.findIndex((st) => st.run === 'bash scripts/ci-runner.sh schedule-yield')
      const runAt = ci.steps.findIndex((st) => st.run === 'exec bash scripts/ci-runner.sh run')
      expect(y).toBeGreaterThan(-1)
      expect(y).toBeLessThan(runAt)
      expect(ci.steps[y]?.['continue-on-error']).toBe(true) // no decision kept: the run step decides
      const cond = String(ci.steps[y]?.if)
      expect(cond).toContain("github.event_name == 'schedule'")
      expect(cond).toContain("inputs.nightly == 'nightly'")
      expect(cond).toContain("inputs.nightly == 'hostile'")
      expect(cond).toContain("steps.dispatch.outputs.superseded != 'true'")
      const mins = (st: unknown) => Number((st as { 'timeout-minutes': number })['timeout-minutes'])
      expect(mins(ci.steps[y])).toBeGreaterThan(5400 / 60) // the cap CI_SCHEDULE_YIELD_MAX_S is 90 minutes
      expect(mins(jobs().ci)).toBeGreaterThan(mins(ci.steps[y]) + mins(ci.steps[runAt]))
    },
  )

  itRunnerYml(
    'a run that stood aside ends at once: ci says so, green has nothing to move, close cancels every remote job',
    () => {
      const j = jobs()
      expect((j.ci as { outputs: Record<string, string> }).outputs.superseded).toBe(
        '${{ steps.settled.outputs.superseded }}',
      )
      // the push's own time, for the settle step (a push only)
      expect((j.ci as Job).env?.CI_PUSHED_AT).toBe(
        "${{ github.event_name == 'push' && github.event.repository.pushed_at || '' }}",
      )
      expect(String((j.green as { if: string }).if)).toContain("needs.ci.outputs.superseded != 'true'")
      expect((j.green as { needs: string[] }).needs).toContain('ci')
      const step = (j.close as { steps: { env: Record<string, string> }[] }).steps[0]
      expect(step?.env.SUPERSEDED).toBe('${{ needs.ci.outputs.superseded }}')
      expect(String((j.close as { if: string }).if)).toContain('!cancelled()') // a skipped green does not stop it
    },
  )

  itRunnerYml(
    'a run that stood aside in the settle step (a newer push has its own run) waits on no Titan part and compares nothing',
    () => {
      const ci = (jobs().ci as { steps: { id?: string; name?: string; run?: string; if?: string }[] }).steps
      const at = ci.findIndex((st) => st.id === 'settled')
      expect(at).toBeGreaterThan(ci.findIndex((st) => st.run === 'exec bash scripts/ci-runner.sh fallback'))
      // a push only: a PR's scripts are the base's, which may not have the subcommand yet
      expect(ci[at]?.if).toContain("github.event_name == 'push'")
      expect(ci[at]?.run).toBe('bash scripts/ci-runner.sh settled | tee -a "$GITHUB_OUTPUT"')
      // every step that waits for, or compares with, a Titan part of this run is skipped by it (the fallback decides itself:
      // ci_fallback reads the same note, tested above)
      const waiting = ci.filter((st) => /ci-pair\.sh part|e2e-shadow|check-shadow/.test(st.run ?? ''))
      expect(waiting).toHaveLength(4)
      for (const st of waiting) {
        expect(ci.indexOf(st), st.name).toBeGreaterThan(at)
        expect(st.if, st.name).toContain("steps.settled.outputs.superseded != 'true'")
      }
    },
  )

  type Step = {
    name?: string
    run?: string
    if?: string
    env?: Record<string, string>
    uses?: string
    with?: Record<string, unknown>
  }
  type Job = { name?: string; env?: Record<string, string>; steps: Step[]; strategy?: unknown; uses?: string }
  // The name the jobs API lists for a job: its `name:`, else its key. A matrix job or a called workflow's job would be listed
  // as "<name> (<values>)" or "<caller> / <job>", which no plain string in this file can name: so neither is allowed for these.
  const apiName = (key: string, job: Job) => {
    expect(job.strategy, key).toBeUndefined()
    expect(job.uses, key).toBeUndefined()
    expect(String(job.name ?? key), key).not.toContain('${{')
    return job.name ?? key
  }

  itRunnerYml(
    "phase C revised: CI_BROWSER_E2E_PART is the browser-e2e job's name exactly as the jobs API lists it, and its link ends in it",
    () => {
      const j = jobs() as unknown as Record<string, Job>
      // the part's job: the one job that runs browser-e2e, found by what it runs, not by its name
      const parts = Object.entries(j).filter(([, job]) => job.env?.CI_RUN_JOBS === 'browser-e2e')
      expect(parts).toHaveLength(1)
      const [partKey, part] = parts[0] as [string, Job]
      const partName = apiName(partKey, part)
      expect(partName).toMatch(/^[a-z0-9-]+$/) // what ci-local.sh accepts as CI_BROWSER_E2E_PART
      // Lemnos's ci is the only place CI_BROWSER_E2E_PART is set, to that name, in e2e mode only
      const text = JSON.stringify(jobs())
      expect(text.match(/CI_BROWSER_E2E_PART/g)).toHaveLength(1)
      expect((j.ci as Job).env?.CI_BROWSER_E2E_PART).toBe(
        `\${{ needs.plan.outputs.browser_e2e == 'ci-part' && '${partName}' || '' }}`,
      )
      // ci-local.sh reads a refusal of the part under "<attempt link><its machine>": the part's own link
      expect(part.env?.CI_STATUS_URL).toBe(`${part.env?.CI_ATTEMPT_URL}${partName}`)
      expect(part.env?.CI_ATTEMPT_URL).toBe((j.titan as Job).env?.CI_ATTEMPT_URL)
      // ci's pair names the part's job as the API lists it; the part never waits for Lemnos (Titan has one runner)
      const ciPair = (j.ci as Job).steps.find((st) => st.run === 'bash scripts/ci-pair.sh part') as Step
      expect(ciPair.env?.CI_PART_JOB).toBe(partName)
      expect(JSON.stringify(part)).not.toContain('ci-pair.sh')
      // close waits for the part while it works, and cancels it queued (its jobs filter names it)
      expect(JSON.stringify(j.close)).toContain(`.name == \\"${partName}\\"`)
    },
  )

  itRunnerYml(
    "phase C revised, the browser-e2e job: Titan's runner, plan's prefix, never after a failed setup, its logs for the shadow step",
    () => {
      const j = jobs() as unknown as Record<string, Job & { 'runs-on': string[]; 'continue-on-error': boolean }>
      const part = j['browser-e2e'] as Job & { 'runs-on': string[]; 'continue-on-error': boolean; if: string }
      // Titan's runner, or titan-b for the hostile nightly's report-only copies (plan's linux_label)
      expect(part['runs-on']).toEqual([
        'self-hosted',
        'Linux',
        "${{ needs.plan.outputs.linux_label || 'talos-ci-linux' }}",
      ])
      expect(part['continue-on-error']).toBe(true)
      expect(part.env?.CI_RUN_PREFIX).toBe('${{ needs.plan.outputs.browser_e2e }}')
      expect(part.env?.CI_STATUS_WHERE).toBe('titan')
      expect(part.env?.CI_PART_E2E_WORKERS).toBe("${{ vars.CI_PART_E2E_WORKERS || '8' }}")
      expect(part.if).toMatch(/^needs\.plan\.outputs\.browser_e2e != '' && /)
      const runs = part.steps.map((st) => st.run ?? st.uses ?? '')
      const run = runs.indexOf('exec bash scripts/ci-runner.sh run')
      expect(run).toBeGreaterThan(0)
      // the run keeps the default success(): never after a failed setup step
      expect(part.steps[run]?.if).toBeUndefined()
      // the failed run's logs are uploaded under the name ci's shadow step reads
      const upload = part.steps.findIndex((st) => String(st.uses).startsWith('actions/upload-artifact@'))
      expect(upload).toBeGreaterThan(run)
      expect(part.steps[upload]?.with?.name).toBe('ci-logs-browser-e2e-${{ github.run_attempt }}')
      expect(readFileSync(join(here, 'ci-runner/e2e-shadow.sh'), 'utf8')).toContain('-n "ci-logs-browser-e2e-$n"')
      const mins = (x: unknown) => Number((x as { 'timeout-minutes': number })['timeout-minutes'])
      expect(mins(part)).toBeGreaterThan(mins(part.steps[run]))
      // Lemnos's ci: the shadow comparison in e2e-shadow, the pair whenever the part runs; neither after a cancel
      const ci = j.ci as Job
      const shadow = ci.steps.find((st) => st.run === 'bash scripts/ci-runner.sh e2e-shadow') as Step
      expect(shadow.if).toBe(
        "${{ !cancelled() && needs.plan.outputs.browser_e2e == 'report-ci' && env.CI_HOSTILE != '1' && steps.dispatch.outputs.superseded != 'true' && steps.settled.outputs.superseded != 'true' }}",
      )
      expect((shadow as { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
      // the shadow step names the part's job and run step as the API lists them (when Titan's run began, for its wait)
      expect(shadow.env?.CI_PART_JOB).toBe('browser-e2e')
      expect(shadow.env?.CI_PART_RUN_STEP).toBe(part.steps[run]?.name)
      const ciPair = ci.steps.find((st) => st.run === 'bash scripts/ci-pair.sh part') as Step
      expect(mins(ciPair)).toBeGreaterThan(mins(part)) // it outlasts the part's whole job
      // only in e2e (the fold: plan says ci-part only with a positive CI_BROWSER_E2E_WAIT), never in e2e-shadow, where the part
      // is report-only (run 43549764317: Titan's infra red failed Lemnos's job); and the script checks CI_BROWSER_E2E_PART,
      // which the job sets in e2e only, and it must not override it
      expect(ciPair.if).toBe(
        "${{ !cancelled() && needs.plan.outputs.browser_e2e == 'ci-part' && steps.dispatch.outputs.superseded != 'true' && steps.settled.outputs.superseded != 'true' }}",
      )
      expect(ciPair.env?.CI_BROWSER_E2E_PART).toBeUndefined()
      expect((ciPair as { 'continue-on-error'?: boolean })['continue-on-error']).toBeUndefined()
      // nothing else of the shadow path can fail or hold Lemnos's job: the comparison never fails it and is bounded
      expect(mins(shadow)).toBeGreaterThan(0)
      expect(mins(shadow)).toBeLessThanOrEqual(40)
      const shadowSteps = ci.steps.filter((st) => /browser_e2e == 'report-ci'|browser_e2e != ''/.test(String(st.if)))
      expect(shadowSteps).toEqual([shadow])
      // the ci job's limit covers every step that can run in it: a dispatch's wait, the run, the fallback, the shadow, the pair
      const all = ci.steps.reduce((n, st) => n + (mins(st) || 0), 0)
      expect(mins(ci)).toBeGreaterThanOrEqual(all)
      expect(ci.env?.CI_BROWSER_E2E_WAIT).toBe('${{ needs.plan.outputs.e2e_wait }}')
      expect(ci.env?.CI_BROWSER_E2E_SHADOW).toBe("${{ needs.plan.outputs.browser_e2e == 'report-ci' && '1' || '' }}")
      // and nothing of step 6's whole browser on Titan is left
      expect(JSON.stringify(jobs())).not.toMatch(
        /CI_BROWSER_MAC_PART|browser-mac|titan_browser|remote_deadline|ci-browser-mac/,
      )
    },
  )

  itRunnerYml(
    "check on Titan: CI_CHECK_PART is check-titan's name exactly as the jobs API lists it, and its link ends in it",
    () => {
      const j = jobs() as unknown as Record<
        string,
        Job & { 'runs-on'?: string[]; 'continue-on-error'?: boolean; if?: string }
      >
      const parts = Object.entries(j).filter(([, job]) => job.env?.CI_RUN_JOBS === 'check')
      expect(parts).toHaveLength(1)
      const [partKey, part] = parts[0] as [string, Job & { 'runs-on'?: string[]; 'continue-on-error'?: boolean }]
      const partName = apiName(partKey, part)
      expect(partName).toBe('check-titan')
      expect(JSON.stringify(jobs()).match(/CI_CHECK_PART\b/g)).toHaveLength(1)
      expect((j.ci as Job).env?.CI_CHECK_PART).toBe(
        `\${{ needs.plan.outputs.check_titan == 'ci-part' && '${partName}' || '' }}`,
      )
      expect((j.ci as Job).env?.CI_CHECK_WAIT).toBe('${{ needs.plan.outputs.check_wait }}')
      expect(part.env?.CI_STATUS_URL).toBe(`${part.env?.CI_ATTEMPT_URL}${partName}`)
      expect(part.env?.CI_ATTEMPT_URL).toBe((j.titan as Job).env?.CI_ATTEMPT_URL)
      expect(part.env?.CI_RUN_PREFIX).toBe('${{ needs.plan.outputs.check_titan }}')
      expect(part.env?.CI_STATUS_WHERE).toBe('titan')
      expect(String(part.env?.CI_WORKERS)).toBe('6')
      // Titan's runner, or titan-b for the hostile nightly's report-only copies (plan's linux_label)
      expect(part['runs-on']).toEqual([
        'self-hosted',
        'Linux',
        "${{ needs.plan.outputs.linux_label || 'talos-ci-linux' }}",
      ])
      expect(part['continue-on-error']).toBe(true)
      const runs = part.steps.map((st) => st.run ?? st.uses ?? '')
      const run = runs.indexOf('exec bash scripts/ci-runner.sh run')
      expect(run).toBeGreaterThan(0)
      expect(part.steps[run]?.if).toBeUndefined() // never after a failed setup step
      // its per-test results are uploaded on every run, under the name the shadow step reads (its full logs on red only)
      const logs = part.steps.findIndex((st) => st.run === 'bash scripts/ci-runner.sh logs')
      expect(logs).toBeGreaterThan(run)
      expect(part.steps[logs]?.if).toBe("always() && hashFiles('scripts/ci-runner.sh') != ''")
      const upload = part.steps.findIndex((st) => String(st.uses).startsWith('actions/upload-artifact@'))
      expect(upload).toBeGreaterThan(logs)
      expect(part.steps[upload]?.if).toBe('always()')
      expect(part.steps[upload]?.with?.name).toBe('ci-tests-check-titan-${{ github.run_attempt }}')
      expect(readFileSync(join(here, 'ci-runner/check-shadow.sh'), 'utf8')).toContain('-n "ci-tests-check-titan-$n"')
      expect(JSON.stringify(part)).not.toContain('ci-pair.sh')
      expect(JSON.stringify(j.close)).toContain(`.name == \\"${partName}\\"`)
      const mins = (x: unknown) => Number((x as { 'timeout-minutes': number })['timeout-minutes'])
      expect(mins(part)).toBeGreaterThan(mins(part.steps[run]))
      // Lemnos: the shadow comparison in shadow only (never fails the job, bounded); the pair in on only
      const ci = j.ci as Job
      const shadow = ci.steps.find((st) => st.run === 'bash scripts/ci-runner.sh check-shadow') as Step
      expect(shadow.if).toBe(
        "${{ !cancelled() && needs.plan.outputs.check_titan == 'report-ci' && env.CI_HOSTILE != '1' && steps.dispatch.outputs.superseded != 'true' && steps.settled.outputs.superseded != 'true' }}",
      )
      expect((shadow as { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
      expect(mins(shadow)).toBeGreaterThan(0)
      expect(mins(shadow)).toBeLessThanOrEqual(40)
      expect(shadow.env?.CI_PART_JOB).toBe(partName)
      expect(shadow.env?.CI_PART_RUN_STEP).toBe(part.steps[run]?.name)
      const pairs = ci.steps.filter(
        (st) => st.run === 'bash scripts/ci-pair.sh part' && st.env?.CI_PART_JOB === partName,
      )
      expect(pairs).toHaveLength(1)
      const pair = pairs[0] as Step
      expect(pair.if).toBe(
        "${{ !cancelled() && needs.plan.outputs.check_titan == 'ci-part' && steps.dispatch.outputs.superseded != 'true' && steps.settled.outputs.superseded != 'true' }}",
      )
      expect((pair as { 'continue-on-error'?: boolean })['continue-on-error']).toBeUndefined()
      expect(mins(pair)).toBeGreaterThan(mins(part))
      expect(ci.steps.filter((st) => /check_titan/.test(String(st.if)))).toEqual([shadow, pair])
      const all = ci.steps.reduce((n, st) => n + (mins(st) || 0), 0)
      expect(mins(ci)).toBeGreaterThanOrEqual(all)
    },
  )

  itRunnerYml(
    'check on Titan, dispatch-only test hooks: a forced refusal for check-titan alone, and a wait for that dispatch alone',
    () => {
      const wf = JSON.parse(
        execFileSync(
          'bun',
          ['-e', 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))', runnerYmlPath],
          { encoding: 'utf8' },
        ),
      ) as {
        on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } }
      }
      const inputs = wf.on.workflow_dispatch.inputs
      expect(inputs.check_part_refuse?.type).toBe('boolean')
      expect(inputs.check_part_refuse?.default).toBe(false)
      expect(inputs.check_wait_s?.default).toBe('')
      const j = jobs() as unknown as Record<string, Job>
      // the refusal: only on check-titan, only for a dispatch that asked; never from a push, a PR or a variable
      expect((j['check-titan'] as Job).env?.CI_CHECK_PART_REFUSE).toBe(
        "${{ github.event_name == 'workflow_dispatch' && inputs.check_part_refuse && '1' || '' }}",
      )
      expect(JSON.stringify(jobs()).match(/CI_CHECK_PART_REFUSE/g)).toHaveLength(1)
      expect(runnerYml.match(/inputs\.check_part_refuse/g)).toHaveLength(1)
      expect(runnerYml).not.toMatch(/vars\.CI_CHECK_PART_REFUSE/)
      // the wait: plan's CI_CHECK_WAIT is the dispatch's input only for a dispatch that gave one, else the variable
      expect((j.plan as Job).env?.CI_CHECK_WAIT).toBe(
        "${{ github.event_name == 'workflow_dispatch' && inputs.check_wait_s != '' && inputs.check_wait_s || vars.CI_CHECK_WAIT }}",
      )
      expect(runnerYml.match(/inputs\.check_wait_s/g)).toHaveLength(2)
      // Lemnos reads the wait from plan (which checks it), never from the input itself
      expect((j.ci as Job).env?.CI_CHECK_WAIT).toBe('${{ needs.plan.outputs.check_wait }}')
    },
  )

  const hasJq = spawnSync('jq', ['--version']).status === 0
  ;(hasRunnerYml && hasJq ? it : it.skip)(
    'close: cancels the run when Lemnos is done and a remote job is still queued; waits for one working; never fails',
    () => {
      const j = jobs()
      const step = (j.close as { steps: { run: string }[] }).steps[0]?.run as string
      const T = scratch()
      // A fake gh that runs the step's own --jq over a jobs JSON: the name filter is the real one
      const b = bin({
        gh: `if [ "$1 $2" = "api -X" ]; then echo "$*" >> "${T}/posts"; [ -f "${T}/postfail" ] && exit 1; exit 0; fi
n=$(cat "${T}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${T}/n"
[ -f "${T}/fail" ] && exit 1
f="${T}/jobs.$n.json"; [ -f "$f" ] || f="${T}/jobs.json"
q=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && q="$2"; shift; done
jq -r "$q" "$f"`,
      })
      const runs = (list: [string, string][]) =>
        JSON.stringify({ jobs: list.map(([name, status]) => ({ name, status })) })
      const close = (files: Record<string, string>, flags: string[] = [], extra: Record<string, string> = {}) => {
        for (const f of ['n', 'posts', 'fail', 'postfail', 'jobs.json', 'jobs.0.json'])
          rmSync(join(T, f), { force: true })
        for (const [f, text] of Object.entries(files)) writeFileSync(join(T, f), text)
        for (const f of flags) writeFileSync(join(T, f), '')
        const r = spawnSync('bash', ['-eo', 'pipefail', '-c', step], {
          encoding: 'utf8',
          env: env({ REPO: 'owner/talos-app', RUN_ID: '9', CLOSE_POLL: '0', GH_TOKEN: 't', ...extra }, b),
        })
        const posts = existsSync(join(T, 'posts')) ? readFileSync(join(T, 'posts'), 'utf8') : ''
        return { code: r.status, out: r.stdout + r.stderr, posts }
      }
      // plan, ci and close themselves are never waited for or counted
      const lemnos: [string, string][] = [
        ['plan', 'completed'],
        ['local-ci on ci-runner', 'in_progress'],
        ['close', 'in_progress'],
      ]
      expect(close({ 'jobs.json': runs([...lemnos, ['delphi', 'completed'], ['hestia', 'completed']]) }).posts).toBe('')
      for (const st of ['queued', 'waiting', 'pending', 'requested']) {
        const q = close({ 'jobs.json': runs([...lemnos, ['delphi', st], ['cyclops', 'completed']]) })
        expect(q.code, st).toBe(0)
        expect(q.posts, st).toContain('repos/owner/talos-app/actions/runs/9/cancel')
      }
      // one working: wait, then decide on what it became
      expect(
        close({ 'jobs.0.json': runs([['hestia', 'in_progress']]), 'jobs.json': runs([['hestia', 'completed']]) }).posts,
      ).toBe('')
      // the jobs cannot be read, or the cancel fails: close does not fail
      // Lemnos stood aside for a newer push (settle): the whole run is cancelled at once, a remote job still working included, and the
      // jobs are not even read: waiting for them held main's concurrency group up to 40 minutes and the cap never came
      const gone = close(
        { 'jobs.json': runs([...lemnos, ['titan', 'in_progress'], ['check-titan', 'in_progress']]) },
        [],
        {
          SUPERSEDED: 'true',
        },
      )
      expect(gone.code).toBe(0)
      expect(gone.posts).toContain('repos/owner/talos-app/actions/runs/9/cancel')
      expect(existsSync(join(T, 'n'))).toBe(false)
      expect(close({ 'jobs.json': runs([['titan', 'in_progress']]) }, ['postfail'], { SUPERSEDED: 'true' }).code).toBe(
        0,
      )
      expect(close({ 'jobs.json': runs([]) }, ['fail']).code).toBe(0)
      expect(close({ 'jobs.json': runs([['titan', 'queued']]) }, ['postfail']).code).toBe(0)
    },
  )

  itRunnerYml('runs on the self-hosted runner only, and a fork is refused twice over', () => {
    expect(runnerYml).toMatch(/runs-on: \[self-hosted, macOS, ARM64, talos-ci\]/)
    expect(runnerYml).toMatch(
      /if: github\.event_name != 'pull_request' \|\| \(github\.event\.pull_request\.head\.repo\.full_name == github\.repository && !github\.event\.pull_request\.draft\)/,
    )
    expect(runnerYml).toMatch(/\$PR_HEAD_REPO" != "\$GITHUB_REPOSITORY"/)
    expect(runnerYml).toContain('scripts/ci-runner.sh guard')
    // The fork check comes before the checkout, so nothing of a fork is fetched to get refused.
    expect(runnerYml.indexOf('Refuse a fork')).toBeLessThan(runnerYml.indexOf('actions/checkout'))
  })

  itRunnerYml('no event field is spliced into a shell command: they reach the scripts as env', () => {
    const lines = runnerYml.split('\n')
    let inRun = false
    let indent = 0
    for (const l of lines) {
      const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(l)
      if (m) {
        expect(m[2], l).not.toContain('${{')
        inRun = m[2] === '|'
        indent = (m[1] ?? '').length
        continue
      }
      if (inRun) {
        if (l.trim() && l.search(/\S/) <= indent) inRun = false
        else expect(l, l).not.toContain('${{')
      }
    }
  })

  itRunnerYml('tools are pinned as ci.yml pins them', () => {
    // ci.yml names a major version (a tag); here each is the full commit sha of a release, with that major version as a comment.
    for (const action of ['actions/checkout', 'pnpm/action-setup', 'actions/setup-node', 'oven-sh/setup-bun']) {
      const major = (yml: string) => new RegExp(`${action}@(v\\d+)`).exec(yml)?.[1]
      const sha = new RegExp(`${action}@([0-9a-f]{40}) # (v\\d+)`).exec(runnerYml)
      expect(sha, action).not.toBeNull()
      expect(sha?.[2], action).toBe(major(ciYml))
    }
    expect(runnerYml).toMatch(/node-version-file: \.nvmrc/)
  })

  it("every setup-bun step in every workflow pins the one Bun version ci-runner.sh reads (ci.yml's first bun-version)", () => {
    const pin = sh('ci_pin_bun').out.trim()
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/)
    const dir = join(root, '.github/workflows')
    let steps = 0
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      for (const step of readFileSync(join(dir, f), 'utf8')
        .split(/\n\s*- /)
        .filter((s) => s.includes('oven-sh/setup-bun'))) {
        steps++
        expect(/bun-version: (\S+)/.exec(step)?.[1], `${f}: ${step}`).toBe(pin)
      }
    }
    expect(steps).toBeGreaterThanOrEqual(hasRunnerYml ? 10 : 3) // ci-runner.yml 7, ci.yml 2, web-bundle.yml 1
  })

  itRunnerYml('every setup step is conditional on the runner lacking the pinned version', () => {
    for (const a of ['pnpm/action-setup', 'actions/setup-node', 'oven-sh/setup-bun']) {
      const step = runnerYml.split('\n      - ').find((s) => s.includes(a)) as string
      expect(step, a).toMatch(/if: steps\.tools\.outputs\.need_\w+ == 'true'/)
    }
  })

  itRunnerYml('sizes the knobs from the machine at run time, in the workflow, not as numbers', () => {
    expect(runnerYml).toContain('scripts/ci-runner.sh size >> "$GITHUB_ENV"')
    expect(runnerYml).not.toMatch(/CI_SLOTS: *\d|CI_MAX_LOAD: *\d/)
  })

  itRunnerYml('every action is pinned to a full commit sha, never a tag that can move; none is left on a tag', () => {
    const uses = [...runnerYml.matchAll(/^\s*(?:- )?uses: (\S+)/gm)].map((m) => m[1] as string)
    expect(uses.length).toBeGreaterThanOrEqual(5) // checkout and the tools in each job that runs code, the log upload
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })

  itRunnerYml('a pull_request run takes its scripts from the BASE commit, never from the PR it tests', () => {
    const co = runnerYml.split('\n      - ').find((x) => x.includes('actions/checkout')) as string
    expect(co).toMatch(/ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/)
    expect(co).not.toContain('head.sha')
    // The one way the PR's own copy is used: the base has no runner script yet (the PR that adds it), said out loud, before the guard.
    const boot = runnerYml.split('\n      - ').find((x) => x.includes('Bootstrap')) as string
    expect(boot).toContain("hashFiles('scripts/ci-runner.sh') == ''")
    expect(boot).toContain('::warning::')
    expect(runnerYml.indexOf('Bootstrap')).toBeGreaterThan(runnerYml.indexOf('actions/checkout'))
    expect(runnerYml.indexOf('Bootstrap')).toBeLessThan(runnerYml.indexOf('scripts/ci-runner.sh guard'))
  })

  itRunnerYml('a failing command on the left of a pipe fails the step (the default shell has no pipefail)', () => {
    expect(block(runnerYml, 'defaults')).toMatch(/run:\s+shell: bash\s*$/)
    expect(runnerYml).not.toMatch(/^\s+shell: (?!bash\s*$)/m)
  })

  itRunnerYml(
    'the run step is exec: a cancel signals the step process, and that process must be ci-local.sh in the end',
    () => {
      const step = runnerYml.split('\n      - ').find((x) => x.includes('Run scripts/ci-local.sh')) as string
      expect(/^\s+run: (.*)$/m.exec(step)?.[1]).toBe('exec bash scripts/ci-runner.sh run')
    },
  )

  itRunnerYml(
    'and it works: a signal sent to the step process alone (as the runner does) reaches the script',
    async () => {
      const step = runnerYml.split('\n      - ').find((x) => x.includes('Run scripts/ci-local.sh')) as string
      const cmd = /^\s+run: (.*)$/m.exec(step)?.[1] as string
      const d = scratch()
      mkdirSync(join(d, 'scripts'))
      const got = join(d, 'got')
      const up = join(d, 'up')
      // Stands in for ci-runner.sh -> ci-local.sh: it traps INT as ci-local.sh does and says it was reached.
      writeFileSync(
        join(d, 'scripts/ci-runner.sh'),
        `trap 'echo INT > "${got}"; exit 130' INT\ntrap 'exit 143' TERM\n: > "${up}"\nsleep 5 & wait\n`,
      )
      // The shell the runner starts: `bash -e {0}` with the step's text in a file; here -c does the same.
      const child = spawn('/bin/bash', ['-e', '-c', cmd], { cwd: d })
      try {
        await vi.waitUntil(() => existsSync(up), { timeout: 10_000, interval: 20 })
        process.kill(child.pid as number, 'SIGINT')
        await vi.waitUntil(() => existsSync(got), { timeout: 10_000, interval: 20 })
      } finally {
        child.kill('SIGKILL')
      }
    },
  )

  itRunnerYml('a red run uploads the folder ci-runner.sh logs fills, not the whole log cache, kept a day', () => {
    const steps = runnerYml.split('\n      - ')
    const gather = steps.find((s) => s.includes('ci-runner.sh logs')) as string
    const upload = steps.find((s) => s.includes('upload-artifact') && s.includes('name: ci-logs')) as string
    expect(gather).toMatch(/if: always\(\)/)
    expect(gather).toMatch(/CI_LOGS_OUT: \$\{\{ runner\.temp \}\}\/ci-logs/)
    expect(gather).toMatch(/CI_JOB_STATUS: \$\{\{ job\.status \}\}/)
    expect(upload).toMatch(/if: always\(\) && steps\.logs\.outputs\.full == 'true'/)
    expect(upload).toMatch(/path: \$\{\{ runner\.temp \}\}\/ci-logs\n/)
    expect(upload).not.toContain('.cache/talos-ci')
    expect(upload).toMatch(/retention-days: 1\n/)
    expect(steps.indexOf(gather)).toBeLessThan(steps.indexOf(upload))
  })

  itRunnerYml('the cleanup step runs after a cancel, and reaps before it sweeps', () => {
    const step = runnerYml.split('\n      - ').find((s) => s.includes('Leave nothing behind')) as string
    expect(step).toMatch(/if: always\(\)/)
    expect(step.indexOf('ci-local.sh --reap')).toBeLessThan(step.indexOf('ci-runner.sh sweep'))
  })
})

describe('ci_post_status writes down each context it answered, so the sweep after it never overwrites that answer', () => {
  const locks = join(here, 'ci-local', 'locks.sh')
  const post = (state: string, shaFile: string | undefined, ghExit = 0) => {
    const b = bin({ gh: `exit ${ghExit}` })
    const r = spawnSync(
      'bash',
      ['-c', `. "${locks}"\nci_post_status owner/talos-app ${SHA} image "${state}" words https://example.test/r/7`],
      { env: env(shaFile ? { CI_SHA_FILE: shaFile } : {}, b), encoding: 'utf8' },
    )
    return r.status
  }

  it('a final post (success, failure, error) is written down; a pending is not', () => {
    const T = scratch()
    const f = join(T, 'ci-sha')
    post('pending', f)
    expect(existsSync(`${f}.reported`)).toBe(false)
    post('success', f)
    expect(readFileSync(`${f}.reported`, 'utf8')).toBe(`${SHA}\tlocal-ci/image\thttps://example.test/r/7\n`)
  })

  it('a post GitHub refused is not written down (its pending is still the sweep’s to close)', () => {
    const T = scratch()
    const f = join(T, 'ci-sha')
    expect(post('success', f, 1)).not.toBe(0)
    expect(existsSync(`${f}.reported`)).toBe(false)
  })

  it('with no CI_SHA_FILE (a hand run on a Mac) nothing is written anywhere', () => {
    expect(post('success', undefined)).toBe(0)
  })
})

// The nightly's own contexts (2026-11-14: the nightly of 87169cd9 set its local-ci/* back to pending over a push run's green
// verdict, and main read as untested for two hours): ci-runner.sh exports CI_NIGHTLY=1 on a schedule run, and both ci_ns (here
// and in scripts/ci-local/locks.sh) put every context under nightly-ci/.
describe('the nightly posts under nightly-ci/ only', () => {
  const locks = join(here, 'ci-local', 'locks.sh')
  const ctxs = [
    'local-ci/check',
    'ci-part/check',
    'ci-part/browser-e2e',
    'report-ci/fast',
    'report-ci/linux',
    'other/x',
  ]
  const map = (file: string, nightly: string) =>
    spawnSync('bash', ['-c', `. "${file}"\nfor c in ${ctxs.join(' ')}; do ci_ns "$c"; done`], {
      env: env({ CI_NIGHTLY: nightly }),
      encoding: 'utf8',
    }).stdout.trim()

  it('ci_ns: the same mapping in ci-runner.sh and locks.sh; off outside the nightly', () => {
    const want =
      'nightly-ci/check nightly-ci/part-check nightly-ci/part-browser-e2e nightly-ci/report-fast nightly-ci/report-linux other/x'
    expect(map(script, '1').split('\n').join(' ')).toBe(want)
    expect(map(locks, '1').split('\n').join(' ')).toBe(want)
    expect(map(script, '').split('\n').join(' ')).toBe(ctxs.join(' '))
    expect(map(locks, '').split('\n').join(' ')).toBe(ctxs.join(' '))
  })

  it('a schedule run sets CI_NIGHTLY; a push, PR or dispatch does not', () => {
    for (const [ev, want] of [
      ['schedule', '1'],
      ['push', ''],
      ['pull_request', ''],
      ['workflow_dispatch', ''],
    ])
      expect(sh('printf %s "${CI_NIGHTLY:-}"', { GITHUB_EVENT_NAME: ev as string }).out, ev).toBe(want)
  })

  it('ci_post_status under CI_NIGHTLY posts nightly-ci/<job>, nightly-ci/part-<part> and nightly-ci/report-fast', () => {
    const T = scratch()
    const b = bin({ gh: `echo "$*" >> "${T}/posts"` })
    for (const [prefix, job] of [
      ['', 'image'],
      ['ci-part', 'check'],
      ['', 'fast'],
    ])
      spawnSync('bash', ['-c', `. "${locks}"\nci_post_status owner/talos-app ${SHA} ${job} success words`], {
        env: env({ CI_NIGHTLY: '1', CI_STATUS_PREFIX: prefix as string }, b),
        encoding: 'utf8',
      })
    const posts = readFileSync(join(T, 'posts'), 'utf8')
    expect(posts.match(/context=\S+/g)).toEqual([
      'context=nightly-ci/image',
      'context=nightly-ci/part-check',
      'context=nightly-ci/report-fast',
    ])
  })

  it("the verdict (ci_classify) and gate-push's red_verdict never read nightly-ci/*: a red nightly leaves a green push verdict green", () => {
    const six = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
    const rows = [
      ...six.map((c) => `nightly-ci/${c}\tfailure\tfailed on ci-runner`),
      'nightly-ci/report-linux\tfailure\tfailed on hestia',
      ...six.map((c) => `local-ci/${c}\tsuccess\tpassed on ci-runner in 40s`),
    ]
    expect(sh(`ci_classify <<'X'\n${rows.join('\n')}\nX`).out.split('\t')[0]).toBe('green')
    // only the nightly's statuses: no verdict at all, never red
    expect(sh(`ci_classify <<'X'\n${rows.slice(0, 7).join('\n')}\nX`).out.split('\t')[0]).toBe('none')
    const gp = readFileSync(join(here, 'gate-push.sh'), 'utf8')
    expect(gp).toContain(`ci="$(grep -E '^(local-ci|report-ci)/' <<<"$rows")"`) // red_verdict reads these two only
  })

  it('the sweep closes a pending nightly-ci/* the run left, under its own link', () => {
    const T = scratch()
    writeFileSync(join(T, 'sha'), `${SHA}\n`)
    const b = bin({
      gh: `case "$*" in *"-X POST"*) echo "$*" >> "${T}/posts" ;; *"/status?"*) printf 'nightly-ci/check\\tpending\\thttps://r/1\\nlocal-ci/check\\tsuccess\\thttps://r/0\\n' ;; *) printf 'nightly-ci/check\\tpending\\thttps://r/1\\n' ;; esac`,
    })
    const r = run('sweep', { CI_SHA_FILE: join(T, 'sha'), CI_STATUS_URL: 'https://r/1', GITHUB_REPOSITORY: 'o/r' }, b)
    expect(r.code, r.err).toBe(0)
    const posts = readFileSync(join(T, 'posts'), 'utf8')
    expect(posts).toContain('context=nightly-ci/check')
    expect(posts).not.toContain('context=local-ci/check')
  })
})

describe('ci-runner.sh logs: the per-test files on every run, the full logs only on red or not tested', () => {
  const setup = (status: string, red = false) => {
    const T = scratch()
    const logs = join(T, 'cache/logs')
    mkdirSync(logs, { recursive: true })
    for (const f of ['aaaaaaa-check.log', 'aaaaaaa-check-tests.tsv', 'bbbbbbb-check-tests.tsv'])
      writeFileSync(join(logs, f), f === 'aaaaaaa-check.log' ? 'x\nlock wait 12s for suites\ny\n' : f)
    writeFileSync(join(T, 'sha'), `${SHA}\n`)
    if (red) writeFileSync(join(T, 'sha.red'), 'local-ci/check\terror\n')
    const e = {
      HOME: T,
      TALOS_CI_CACHE: join(T, 'cache'),
      CI_SHA_FILE: join(T, 'sha'),
      CI_LOGS_OUT: join(T, 'out'),
      CI_TESTS_OUT: join(T, 'tests'),
      CI_JOB_STATUS: status,
      GITHUB_OUTPUT: join(T, 'gh-out'),
    }
    const r = run('logs', e)
    const ls = (d: string) => (existsSync(join(T, d)) ? readdirSync(join(T, d)).sort() : [])
    return { r, out: ls('out'), tests: ls('tests'), gh: readFileSync(join(T, 'gh-out'), 'utf8'), T }
  }

  it('a green run: its per-test file and lock-wait lines, no full logs (full=false)', () => {
    const s = setup('success')
    expect(s.r.code, s.r.err).toBe(0)
    expect(s.tests).toEqual(['aaaaaaa-check-lock-wait.txt', 'aaaaaaa-check-tests.tsv'])
    expect(readFileSync(join(s.T, 'tests/aaaaaaa-check-lock-wait.txt'), 'utf8')).toBe('lock wait 12s for suites\n')
    expect(s.out).toEqual([])
    expect(s.gh).toBe('full=false\n')
  })

  it('a red job, or a job that posted a failure or a "not tested" error, uploads its full logs too (full=true)', () => {
    for (const s of [setup('failure'), setup('cancelled'), setup('success', true)]) {
      expect(s.r.code, s.r.err).toBe(0)
      expect(s.out).toEqual(['aaaaaaa-check-tests.tsv', 'aaaaaaa-check.log'])
      expect(s.tests).toContain('aaaaaaa-check-tests.tsv')
      expect(s.gh).toBe('full=true\n')
    }
  })

  it('ci_post_status writes a failure or an error down for the logs step; a success or a pending is not', () => {
    const T = scratch()
    const f = join(T, 'ci-sha')
    const b = bin({ gh: 'exit 0' })
    for (const st of ['pending', 'success', 'failure', 'error'])
      spawnSync('bash', ['-c', `. "${join(here, 'ci-local/locks.sh')}"\nci_post_status o/r ${SHA} check ${st} words`], {
        env: env({ CI_SHA_FILE: f }, b),
      })
    expect(readFileSync(`${f}.red`, 'utf8')).toBe('local-ci/check\tfailure\nlocal-ci/check\terror\n')
  })
})

describe('artifact uploads: small, kept a day, never a red job', () => {
  const wf = (
    f: string,
  ): Record<string, { if?: string; permissions?: Record<string, string>; steps: Record<string, unknown>[] }> =>
    JSON.parse(
      execFileSync(
        'bun',
        ['-e', 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text()).jobs))', f],
        {
          encoding: 'utf8',
        },
      ),
    )
  const uploads = (jobs: ReturnType<typeof wf>) =>
    Object.entries(jobs).flatMap(([job, j]) =>
      j.steps.filter((s) => String(s.uses).startsWith('actions/upload-artifact@')).map((s) => ({ job, s })),
    )

  it('every upload-artifact step of every workflow is continue-on-error and kept one day', () => {
    const dir = join(root, '.github/workflows')
    let n = 0
    for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)))
      for (const { job, s } of uploads(wf(join(dir, f)))) {
        n++
        expect(s['continue-on-error'], `${f} ${job}`).toBe(true)
        expect((s.with as Record<string, unknown>)['retention-days'], `${f} ${job}`).toBe(1)
      }
    expect(n).toBeGreaterThanOrEqual(hasRunnerYml ? 11 : 0) // web-bundle.yml no longer uploads an artifact
  })

  itRunnerYml('ci-runner.yml: full logs only when the logs step says full; the per-test results on every run', () => {
    const jobs = wf(runnerYmlPath)
    for (const { job, s } of uploads(jobs)) {
      const name = String((s.with as Record<string, unknown>).name)
      if (name.startsWith('ci-logs')) expect(s.if, job).toBe("always() && steps.logs.outputs.full == 'true'")
      else {
        expect(name, job).toMatch(/^ci-tests/)
        expect(s.if, job).toBe('always()')
      }
    }
    for (const job of ['ci', 'delphi', 'cyclops', 'check-titan'])
      expect(
        uploads({ [job]: jobs[job] as never }).map((u) => String((u.s.with as Record<string, unknown>).name)),
        job,
      ).toEqual([expect.stringMatching(/^ci-tests/), expect.stringMatching(/^ci-logs/)])
    // check-shadow reads Titan's per-test file from the artifact check-titan uploads on every run
    const ct = uploads({ c: jobs['check-titan'] as never })[0]?.s.with as Record<string, unknown>
    expect(ct.name).toBe('ci-tests-check-titan-${{ github.run_attempt }}')
    expect(readFileSync(join(here, 'ci-runner/check-shadow.sh'), 'utf8')).toContain('-n "ci-tests-check-titan-$n"')
  })

  it('web-bundle.yml: only build saves the cache, for a successful production deploy; publish restores it and deletes the entry once released', () => {
    const jobs = wf(join(root, '.github/workflows/web-bundle.yml'))
    const key = 'web-bundle-${{ needs.resolve.outputs.sha }}-${{ github.run_id }}' // no run_attempt: a re-run of publish must still match
    const usesOf = (job: string, prefix: string) =>
      (jobs[job]?.steps ?? []).filter((s) => String(s.uses).startsWith(prefix))
    const withOf = (s: Record<string, unknown> | undefined) => (s?.with ?? {}) as Record<string, unknown>
    expect(uploads(jobs)).toEqual([]) // the artifact storage quota is account-wide and was full: no workflow artifact
    expect(JSON.stringify(jobs)).not.toMatch(/upload-artifact|download-artifact|gh run download/)
    // a deployment_status run has no branch ref (the cache refuses it) and a workflow_run run gets the cache read-only
    // (4bfe3054): web-bundle-deploy.yml sees the deploy and starts this workflow by workflow_dispatch, its only trigger
    const deployPath = join(root, '.github/workflows/web-bundle-deploy.yml')
    const deploy = wf(deployPath) as Record<
      string,
      { if?: string; permissions?: Record<string, string>; steps: Record<string, unknown>[] }
    >
    const deployText = readFileSync(deployPath, 'utf8')
    expect(deployText).toMatch(/^on:\n {2}deployment_status:\n/m)
    expect(deployText).toMatch(/^permissions: \{\}$/m)
    expect(deployText).toContain('name: "Web bundle: production deploy seen"')
    expect(deploy.seen?.if).toBe(
      "github.event.deployment_status.state == 'success' && github.event.deployment.environment == 'talos-app / production'",
    )
    expect(deploy.seen?.permissions).toEqual({ actions: 'write' })
    expect(JSON.stringify(deploy.seen?.steps)).toContain('gh workflow run web-bundle.yml --ref main -f sha=\\"$SHA\\"')
    expect(JSON.stringify(deploy)).not.toMatch(/checkout|pnpm|cache/) // no code of the repository where the token is
    const text = readFileSync(join(root, '.github/workflows/web-bundle.yml'), 'utf8')
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n/m)
    expect(text).not.toMatch(/^ {2}(workflow_run|deployment_status):/m) // no other trigger
    expect(text).not.toMatch(/github\.event\.deployment\b/)
    expect(jobs.resolve?.if).toBeUndefined()
    expect(text).toMatch(/^concurrency:\n {2}group: web-bundle\n/m)
    // only the live deploy: a rolled-back sha would become the "newest" bundle
    expect(JSON.stringify(jobs.resolve)).toContain('is not the live production deploy')
    expect((jobs.resolve as { permissions?: Record<string, string> }).permissions).toEqual({ deployments: 'read' })
    expect(JSON.stringify(jobs.resolve)).toContain('has no successful production deploy')
    // a broken save is seen: report posts web-bundle/save on the deployed commit whatever the other jobs did
    const report = jobs.report as {
      if?: string
      needs?: string[]
      permissions?: Record<string, string>
      steps: Record<string, unknown>[]
    }
    expect(report.if).toBe('always()') // a resolve that fails (API, not live) is said too
    expect(report.needs).toEqual(['resolve', 'build', 'publish', 'specs'])
    expect(report.permissions).toEqual({ statuses: 'write' })
    expect(JSON.stringify(report.steps)).toContain('context=web-bundle/save')
    expect(JSON.stringify(report.steps)).not.toMatch(/checkout|pnpm|bun /)
    // the status is success only when every job succeeded: run the step's own shell with a stand-in gh, per outcome
    const say = String(report.steps.find((st) => String(st.run ?? '').includes('context=web-bundle/save'))?.run)
    const bin = mkdtempSync(join(tmpdir(), 'wbs-'))
    writeFileSync(join(bin, 'gh'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$GH_ARGS"\n', { mode: 0o755 })
    const stateFor = (o: Record<string, string>) => {
      const args = join(bin, 'args')
      const r = spawnSync('bash', ['-c', say], {
        encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, GH_ARGS: args, SHA: 'a'.repeat(40), GH_REPO: 'o/r', URL: 'u', ...o },
      })
      expect(r.status, r.stderr).toBe(0)
      return readFileSync(args, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('state='))
    }
    const ok = { RESOLVE: 'success', BUILD: 'success', PUBLISH: 'success', SPECS: 'success' }
    expect(stateFor(ok)).toBe('state=success')
    for (const k of Object.keys(ok))
      for (const bad of ['failure', 'cancelled', 'skipped'])
        expect(stateFor({ ...ok, [k]: bad }), `${k} ${bad}`).toBe('state=failure')
    const save = usesOf('build', 'actions/cache/save@')
    expect(save.length).toBe(1)
    expect(String(save[0]?.uses)).toMatch(/^actions\/cache\/save@[0-9a-f]{40}$/)
    expect(save[0]?.['continue-on-error']).toBe(true)
    expect(withOf(save[0]).key).toBe(key)
    expect(usesOf('publish', 'actions/cache/save@')).toEqual([])
    const pub = jobs.publish as { steps: Record<string, unknown>[]; permissions?: Record<string, string> }
    const restore = usesOf('publish', 'actions/cache/restore@')
    expect(restore.length).toBe(1)
    expect(String(restore[0]?.uses)).toMatch(/^actions\/cache\/restore@[0-9a-f]{40}$/)
    expect(withOf(restore[0]).key).toBe(key)
    expect(withOf(restore[0])['fail-on-cache-miss']).toBe(true)
    expect(pub.permissions?.actions).toBe('write')
    expect(JSON.stringify(pub.steps)).not.toMatch(/checkout|pnpm|bun /) // no repository code where the write token is
    const del = pub.steps.findIndex((s) =>
      String(s.run).includes('-X DELETE "repos/$GH_REPO/actions/caches?key=web-bundle-${SHA}-${RUN_ID}"'),
    )
    const rel = pub.steps.findIndex((s) => String(s.run).includes('gh release create'))
    expect(pub.steps.indexOf(restore[0] as never)).toBeLessThan(rel)
    expect(del).toBeGreaterThan(rel)
    expect(pub.steps[del]?.if).toBeUndefined() // only after a successful publish: a failed one can still be re-run
    expect(pub.steps[del]?.['continue-on-error']).toBe(true)
  })
})

describe('ci-runner.sh main-queue part: what a main push run and a dispatch do about the run queue', () => {
  const runner = readFileSync(script, 'utf8')
  const part = readFileSync(join(here, 'ci-runner/main-queue.sh'), 'utf8')
  it('ci_settle_want, ci_settled, ci_superseded_mark and ci_dispatch_wait live in main-queue.sh, sourced for the steps that need them', () => {
    for (const f of ['ci_settle_want', 'ci_settled', 'ci_superseded_mark', 'ci_dispatch_wait'] as const) {
      expect(part, f).toMatch(new RegExp(`^${f}\\(\\) \\{`, 'm'))
      expect(runner, f).not.toMatch(new RegExp(`^${f}\\(\\) \\{`, 'm'))
    }
    for (const sub of ['run', 'fallback', 'settled', 'superseded', 'dispatch-wait'])
      expect(runner, sub).toMatch(new RegExp(`^  ${sub}\\) \\. "\\$HERE/ci-runner/main-queue\\.sh" && `, 'm'))
    expect(runner.split('\n').length).toBeLessThan(1000)
  })
})
