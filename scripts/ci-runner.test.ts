// scripts/ci-runner.sh (the glue for .github/workflows/ci-runner.yml) and the workflow files themselves. The script is tested by
// running it, with a fake `gh`, `caffeinate`, `sysctl` and tools on the PATH and a fake ci-local.sh that writes down how it was
// called. The workflows are plain text, so what is checked is what they say: their triggers, their token, their pins.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

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
  const tool = (v: string) => `echo "${v}"`
  const have = (node: string | null, bun: string | null, pnpm: string | null) =>
    bin({
      ...(node ? { node: tool(`v${node}`) } : {}),
      ...(bun ? { bun: tool(bun) } : {}),
      ...(pnpm ? { pnpm: tool(pnpm) } : {}),
    })
  // The runner's own PATH has no node, bun or pnpm: only the fake bin has them, so a missing one is really missing.
  const needs = (b: string) => {
    const r = spawnSync('bash', ['-c', `. "${script}"; ci_tools "${root}"`], {
      env: { PATH: `${b}:/usr/bin:/bin` },
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
    const fakeLocal = join(T, 'fake-ci-local.sh')
    writeFileSync(
      fakeLocal,
      `#!/bin/bash
{ echo "args: $*"; for v in CI_REPO CI_STATUS_WHERE CI_WT_BASE TALOS_CI_CACHE CI_STATUS_URL TALOS_CI_FORCE_DESKTOP TALOS_CI_FORCE_MOBILE; do echo "$v=\${!v}"; done; } > "$CALLS"\n`,
    )
    // `gh` answers the one question a run asks (is the PR still open); never the real GitHub.
    const b = bin({
      caffeinate: 'echo "caffeinate $*" >> "$CALLS.caff"; exit 0',
      gh: 's=open; [ -n "$GH_PR_STATE" ] && s=$GH_PR_STATE; echo $s',
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
    expect(r.err).toContain("a push to 'refs/heads/feat/x', only refs/heads/main is tested on push") // the push rule, not the unknown-event fallback
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
      ].join('\\n')}\\n`,
    )
    const r = run('sweep', envFor(g.T), g.b)
    expect(r.code).toBe(0)
    const posts = g.posts()
    expect(posts).toHaveLength(2)
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
    expect(r.out).toContain('closed 2 status(es)')
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

  const jq = spawnSync('jq', ['--version']).status === 0
  it.skipIf(!jq)('the gh --jq expression yields the three columns the sweep reads', () => {
    const expr = /--jq '([^']+)'/.exec(readFileSync(script, 'utf8'))?.[1] as string
    const json = JSON.stringify({ statuses: [{ context: 'local-ci/check', state: 'pending', target_url: url, id: 1 }] })
    const out = spawnSync('jq', ['-r', expr], { input: json, encoding: 'utf8' }).stdout
    expect(out).toBe(`local-ci/check\tpending\t${url}\n`)
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
    it('"with warnings" in the description is still green: a warned step (personal data, audit, sleep) never changes a job status', () => {
      const warned = allPassed.map((l) => `${l}, with warnings (see its log)`)
      expect(classify(warned)[0]).toBe('green')
      expect(classify([...allPassed.slice(0, 5), ok('mobile').concat(', with warnings (see its log)')])[0]).toBe(
        'green',
      )
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
    'ci-runner.yml triggers: dispatch with a ref, the four PR events, and a push to main only, nothing else',
    () => {
      const on = block(runnerYml, 'on')
      expect(on).toMatch(/workflow_dispatch:\s+inputs:\s+ref:/)
      expect(on).toMatch(/jobs:\s+description:/) // optional: one job for a quick look; it reaches the script as INPUT_JOBS, env only
      expect(runnerYml).toMatch(/INPUT_JOBS: \$\{\{ inputs\.jobs \}\}/)
      expect(on).toMatch(/pull_request:\s+types: \[opened, synchronize, reopened, ready_for_review\]/)
      expect(on).toMatch(/\n {2}push:\n {4}branches: \[main\]\s*$/)
      expect(on).not.toMatch(/pull_request_target|schedule:|workflow_run|tags:|branches-ignore|paths/)
      expect([...on.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1])).toEqual(['workflow_dispatch', 'pull_request', 'push'])
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
    expect(c).toMatch(/cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}/)
  })

  itRunnerYml(
    'a one-job dispatch of a ref does not cancel the full run of it: the job list is part of the group',
    () => {
      const c = block(runnerYml, 'concurrency')
      expect(c).toMatch(/format\('ref-\{0\}-\{1\}', inputs\.ref, inputs\.jobs\)/)
    },
  )

  itRunnerYml('the token can post statuses and read contents, nothing wider, and nothing else is a secret', () => {
    expect(runnerYml).toMatch(/^permissions: \{\}$/m)
    const job = block(runnerYml, 'jobs')
    const perms = /\n {4}permissions:\n((?: {6}.+\n)+)/.exec(job)?.[1] as string
    const granted = perms
      .split('\n')
      .filter(Boolean)
      .map((l) => l.trim().replace(/\s+#.*$/, ''))
    expect(granted.sort()).toEqual(['contents: read', 'statuses: write'])
    const secrets = [...runnerYml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1])
    expect(secrets.length).toBeGreaterThan(0)
    expect(new Set(secrets)).toEqual(new Set(['GITHUB_TOKEN']))
    expect(runnerYml).not.toMatch(/GH_TOKEN: \$\{\{ (?!secrets\.GITHUB_TOKEN)/)
  })

  itRunnerYml('only the two steps that talk to GitHub get the token', () => {
    const withToken = runnerYml.split('\n      - ').filter((s) => s.includes('GH_TOKEN'))
    expect(withToken).toHaveLength(2)
    expect(withToken[0]).toContain('scripts/ci-runner.sh run')
    expect(withToken[1]).toContain('sweep')
  })

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
    expect(/bun-version: ([\d.]+)/.exec(runnerYml)?.[1]).toBe(/bun-version: ([\d.]+)/.exec(ciYml)?.[1])
    expect(runnerYml).toMatch(/node-version-file: \.nvmrc/)
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
    expect(uses.length).toBe(5)
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

  itRunnerYml('the cleanup step runs after a cancel, and reaps before it sweeps', () => {
    const step = runnerYml.split('\n      - ').find((s) => s.includes('Leave nothing behind')) as string
    expect(step).toMatch(/if: always\(\)/)
    expect(step.indexOf('ci-local.sh --reap')).toBeLessThan(step.indexOf('ci-runner.sh sweep'))
  })
})
