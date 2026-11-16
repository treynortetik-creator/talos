// scripts/ci-runner.sh for the split over machines (docs/CI-MACHINES.md, phase A step 3): `plan` (which machine runs what, from
// the repository's switches), `run` for a part or report-only machine, `fallback` (Lemnos takes a gating job another machine did
// not answer) and `preflight` (the owner's Mac). Run for real, with a fake ci-local.sh that writes down how it was called and a
// fake `gh` that serves the commit's statuses and the run's jobs from files.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { copyCiLocalParts, systemPathWithout } from './ci-test-env'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-runner.sh')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+rwx', d])
    rmSync(d, { recursive: true, force: true })
  }
}, 60_000) // many temp trees: the default 10 s ran out under a busy gate
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'cirm-'))
  dirs.push(d)
  return d
}
const SHA = 'a'.repeat(40)
const ATTEMPT = 'https://example.test/r/runs/9/attempts/1#'

/** A clone with origin, the script copied in, a fake ci-local.sh and fake tools. */
function setup(tools: Record<string, string> = {}) {
  const T = scratch()
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
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
  const real = git(clone, 'rev-parse', 'HEAD')
  for (const f of ['ci-runner.sh', 'ci-local.sh'])
    if (existsSync(join(here, f))) writeFileSync(join(clone, 'scripts', f), readFileSync(join(here, f), 'utf8'))
  copyCiLocalParts(join(clone, 'scripts')) // the parts ci-local.sh sources in place
  mkdirSync(join(clone, '.github/workflows'), { recursive: true }) // the bun pin is read from ci.yml
  const ciYml = readFileSync(join(here, '../.github/workflows/ci.yml'), 'utf8')
  writeFileSync(join(clone, '.github/workflows/ci.yml'), ciYml)
  const calls = join(T, 'calls')
  const fakeLocal = join(T, 'fake-ci-local.sh')
  writeFileSync(
    fakeLocal,
    `#!/bin/bash
{ echo "args: $*"; for v in CI_STATUS_PREFIX CI_REMOTE_PARTS CI_REMOTE_JOBS CI_ATTEMPT_URL CI_RUN_ID CI_STATUS_URL TALOS_FUZZ_MS CI_FALLBACK_NOTES CI_BROWSER_MAC_PART CI_PUSH_BEFORE CI_BROWSER_E2E_PART CI_BROWSER_E2E_WAIT CI_BROWSER_E2E_SHADOW CI_PART_E2E_WORKERS CI_CHECK_PART CI_CHECK_WAIT CI_WORKERS; do echo "$v=\${!v}"; done; } > "${calls}"\n`,
  )
  const bin = join(T, 'bin')
  mkdirSync(bin)
  const tool = (name: string, body: string) => fakeTool(bin, name, `#!/bin/bash\n${body}\n`)
  tool('caffeinate', 'exit 0')
  tool('bun', `echo ${/bun-version: ([\d.]+)/.exec(ciYml)?.[1]}`) // the pinned bun, as the tools step leaves it
  tool(
    'gh',
    `case "$*" in
  *"/statuses?"*) cat "${T}/rows" 2>/dev/null ;;
  *"/jobs"*) cat "${T}/jobs" 2>/dev/null ;;
  *"/pulls/"*) echo "\${GH_PR_STATE:-open}" ;;
esac
exit 0`,
  )
  for (const [n, b] of Object.entries(tools)) tool(n, b)
  const run = (sub: string, env: Record<string, string>) => {
    const r = spawnSync('bash', [join(clone, 'scripts/ci-runner.sh'), sub], {
      cwd: clone,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: join(T, 'home'),
        TMPDIR: T,
        CI_LOCAL_SCRIPT: fakeLocal,
        GH_TOKEN: 't',
        GITHUB_REPOSITORY: 'owner/talos-app',
        ...env,
      },
    })
    return { code: r.status, out: r.stdout, err: r.stderr }
  }
  const called = () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '')
  const rows = (lines: string[]) => writeFileSync(join(T, 'rows'), `${lines.join('\n')}\n`)
  const jobs = (lines: string[]) => writeFileSync(join(T, 'jobs'), `${lines.join('\n')}\n`)
  mkdirSync(join(T, 'home'))
  return { T, clone, real, run, called, rows, jobs, local: join(clone, 'scripts/ci-local.sh') }
}
const push = (sha: string) => ({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha })
const outputs = (out: string) =>
  Object.fromEntries(
    out
      .trim()
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )

describe('ci-runner.sh guard: drafts and the jobs a machine is handed', () => {
  const pr = {
    GITHUB_EVENT_NAME: 'pull_request',
    PR_NUMBER: '12',
    PR_HEAD_SHA: SHA,
    PR_HEAD_REPO: 'owner/talos-app',
  }
  it('a draft PR is refused here too, not only by the workflow if', () => {
    const s = setup()
    expect(s.run('guard', { ...pr, PR_DRAFT: 'true' }).code).toBe(1)
    expect(s.run('guard', { ...pr, PR_DRAFT: 'true' }).err).toContain('is a draft')
    expect(s.run('guard', { ...pr, PR_DRAFT: 'false' }).code).toBe(0)
    expect(s.run('guard', pr).code).toBe(0)
  })

  it('CI_RUN_JOBS holds only the part and report-only jobs, of one kind', () => {
    const s = setup()
    for (const ok of ['bridge-shard-1,vitest', 'bridge-shard-2', 'linux', 'image', 'browser-e2e', 'check'])
      expect(s.run('guard', { ...push(SHA), CI_RUN_JOBS: ok }).code, ok).toBe(0)
    for (const bad of [
      'check,vitest',
      'check,image',
      'vitest,linux',
      'x',
      'vitest,',
      'vitest;rm',
      'image,linux',
      'image,vitest',
      'image,browser',
      'browser,browser-mac',
      'mod',
      // step 6's whole browser on Titan and its @mac-only part are gone (phase C revised)
      'browser',
      'browser-mac',
      'browser-e2e,image',
    ])
      expect(s.run('guard', { ...push(SHA), CI_RUN_JOBS: bad }).code, bad).toBe(1)
  })
})

describe('ci-runner.sh plan: one commit, and which machine runs what', () => {
  it('every switch off: nothing goes anywhere else; the commit is fixed', () => {
    const s = setup()
    const r = s.run('plan', push(s.real))
    expect(r.code, r.err).toBe(0)
    expect(outputs(r.out)).toEqual({
      sha: s.real,
      remote_parts: '',
      delphi: '',
      cyclops: '',
      hestia: '',
      titan: '',
      titan_prefix: '',
      remote_jobs: '',
      fallback: '',
      browser_e2e: '',
      e2e_wait: '',
      shard_tools: '',
      check_titan: '',
      check_wait: '',
    })
  })

  it('Delphi and Cyclops on: their parts go to them, and Lemnos is told to fold them in', () => {
    const s = setup()
    const o = outputs(s.run('plan', { ...push(s.real), CI_DELPHI: 'on', CI_CYCLOPS: 'on' }).out)
    expect(o.delphi).toBe('bridge-shard-1,vitest')
    expect(o.cyclops).toBe('bridge-shard-2')
    expect(o.remote_parts).toBe('bridge-shard-1:delphi vitest:delphi bridge-shard-2:cyclops')
  })

  it('shadow: the parts run there too, but Lemnos does not wait for them or read them', () => {
    const s = setup()
    const o = outputs(s.run('plan', { ...push(s.real), CI_DELPHI: 'shadow', CI_CYCLOPS: 'on' }).out)
    expect(o.delphi).toBe('bridge-shard-1,vitest')
    expect(o.remote_parts).toBe('bridge-shard-2:cyclops')
  })

  it('Hestia on: the report-only Linux job; any other value is off', () => {
    const s = setup()
    expect(outputs(s.run('plan', { ...push(s.real), CI_HESTIA: 'on' }).out).hestia).toBe('linux')
    for (const v of ['yes', 'ON', ''])
      expect(outputs(s.run('plan', { ...push(s.real), CI_HESTIA: v, CI_DELPHI: v }).out), v).toMatchObject({
        hestia: '',
        delphi: '',
      })
    // Hestia is report-only: it has no shadow mode
    expect(outputs(s.run('plan', { ...push(s.real), CI_HESTIA: 'shadow' }).out).hestia).toBe('')
  })

  it('a dispatch without check sends no parts anywhere', () => {
    const s = setup()
    const o = outputs(
      s.run('plan', {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        INPUT_REF: s.real,
        INPUT_JOBS: 'mod',
        CI_DELPHI: 'on',
        CI_CYCLOPS: 'on',
      }).out,
    )
    expect(o).toMatchObject({ delphi: '', cyclops: '', remote_parts: '' })
  })

  it('the commit: a PR its head, a push its sha, a dispatch its ref resolved once', () => {
    const s = setup()
    const pr = {
      GITHUB_EVENT_NAME: 'pull_request',
      PR_NUMBER: '12',
      PR_HEAD_SHA: 'b'.repeat(40),
      PR_HEAD_REPO: 'owner/talos-app',
    }
    expect(outputs(s.run('plan', pr).out).sha).toBe('b'.repeat(40))
    expect(outputs(s.run('plan', { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: 'main' }).out).sha).toBe(s.real)
    expect(s.run('plan', { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: 'no-such-branch' }).code).toBe(1)
  })
})

// Titan's runner hung 4 h 23 m in a fetch that waited on a credential prompt. A fake git that, for a fetch or ls-remote, asks
// (a terminal prompt or stdin) or never answers; everything else is the real git.
const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
const askingGit = `real=${realGit}
sub="" i=1
while [ $i -le $# ]; do a="\${!i}"; case "$a" in -C | -c) i=$((i + 2)) ;; -*) i=$((i + 1)) ;; *) sub="$a"; break ;; esac; done
case "$sub:\${GIT_FAKE_NET:-}" in
  fetch:prompt | ls-remote:prompt)
    [ "\${GIT_TERMINAL_PROMPT:-}" != 0 ] || { echo "fatal: could not read Username: terminal prompts disabled" >&2; exit 128; }
    read -r _ ; exit 128 ;;
  fetch:stdin | ls-remote:stdin) read -r _ ; exit 128 ;;
  fetch:hang | ls-remote:hang) exec sleep 300 ;;
  # stops on TERM only after a while (slow cleanup), or never; has a child; leaves a lock file of the call behind
  fetch:slow-term | ls-remote:slow-term | fetch:no-term | ls-remote:no-term)
    : > "$GIT_FAKE_LOCK"
    # the trap first: the child then ignores TERM too, so only a KILL of the whole group stops it
    if [ "\${GIT_FAKE_NET}" = slow-term ]; then trap 'echo term > "$GIT_FAKE_PIDS.term"; sleep 2; exit 143' TERM; else trap '' TERM; fi
    sleep 300 &
    echo "$$ $!" > "$GIT_FAKE_PIDS"
    while :; do sleep 1; done ;;
esac
exec "$real" "$@"`

describe('ci-runner.sh: git never waits for a person', () => {
  const runAsync = (s: ReturnType<typeof setup>, sub: string, env: Record<string, string>) =>
    new Promise<{ code: number | string; out: string; err: string }>((res) => {
      const c = spawn('bash', [join(s.clone, 'scripts/ci-runner.sh'), sub], {
        cwd: s.clone,
        env: {
          PATH: `${join(s.T, 'bin')}:${process.env.PATH}`,
          HOME: join(s.T, 'home'),
          TMPDIR: s.T,
          CI_LOCAL_SCRIPT: join(s.T, 'fake-ci-local.sh'),
          GH_TOKEN: 't',
          GITHUB_REPOSITORY: 'owner/talos-app',
          CI_GIT_LIMIT: '2',
          ...env,
        },
      })
      let out = ''
      let err = ''
      c.stdout.on('data', (d) => (out += d))
      c.stderr.on('data', (d) => (err += d))
      const t = setTimeout(() => {
        c.kill('SIGKILL')
        res({ code: 'hung', out, err })
      }, 30_000)
      c.on('exit', (code) => {
        clearTimeout(t)
        res({ code: code ?? -1, out, err })
      })
    })

  it.each(['prompt', 'stdin', 'hang'])(
    'plan of a dispatch whose fetch would %s: plans from what it has, and says why',
    async (how) => {
      const s = setup({ git: askingGit })
      const r = await runAsync(s, 'plan', {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        INPUT_REF: 'main',
        GIT_FAKE_NET: how,
      })
      expect(r.code, r.err).toBe(0)
      expect(outputs(r.out).sha).toBe(s.real)
      expect(r.err).toMatch(/ci-runner: git fetch of \S*origin\.git (stopped after 2s|failed)/)
      expect(r.err).toContain('no credential?')
    },
  )

  const dead = (pids: string) =>
    readFileSync(pids, 'utf8')
      .trim()
      .split(' ')
      .map(Number)
      .every((p) => {
        try {
          process.kill(p, 0)
          return false
        } catch {
          return true
        }
      })

  // Five runs, each a fetch that would hang 300 s, stopped at 1 s. Each takes about 1.4 s alone, and up to 6 s on a machine
  // under heavy load (a --full gate beside CI), so the five get 120 s together. A stop that missed still fails: runAsync ends
  // a run at 30 s as 'hung', not 0.
  it('a limit of 1 s still stops a fetch that never answers (no window before the group exists)', {
    timeout: 120_000,
  }, async () => {
    const s = setup({ git: askingGit })
    for (let i = 0; i < 5; i++) {
      const r = await runAsync(s, 'plan', {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        INPUT_REF: 'main',
        GIT_FAKE_NET: 'hang',
        CI_GIT_LIMIT: '1',
      })
      expect(r.code, `${i}: ${r.err}`).toBe(0)
    }
  })

  it('ci-runner.sh killed while git waits: the git group is still stopped at the limit', async () => {
    const s = setup({ git: askingGit })
    const pids = join(s.T, 'git.pids')
    const c = spawn('bash', [join(s.clone, 'scripts/ci-runner.sh'), 'plan'], {
      cwd: s.clone,
      env: {
        PATH: `${join(s.T, 'bin')}:${process.env.PATH}`,
        HOME: join(s.T, 'home'),
        TMPDIR: s.T,
        GH_TOKEN: 't',
        GITHUB_REPOSITORY: 'owner/talos-app',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        INPUT_REF: 'main',
        GIT_FAKE_NET: 'no-term',
        GIT_FAKE_PIDS: pids,
        GIT_FAKE_LOCK: join(s.T, 'x.lock'),
        CI_GIT_LIMIT: '2',
      },
    })
    await vi.waitUntil(() => existsSync(pids), { timeout: 10_000, interval: 50 })
    c.kill('SIGKILL') // the shell only: its git is in a group of its own
    await new Promise((res) => c.on('exit', res))
    // limit 2 s, then TERM ignored for 5 s, then KILL
    await vi.waitUntil(() => dead(pids), { timeout: 15_000, interval: 200 })
  })

  it('in a linked worktree the lock left in the common git dir is found', async () => {
    const s = setup({ git: askingGit })
    const wt = join(s.T, 'wt')
    execFileSync(realGit, ['-C', s.clone, 'worktree', 'add', '-q', '--detach', wt])
    mkdirSync(join(wt, 'scripts'), { recursive: true })
    writeFileSync(join(wt, 'scripts/ci-runner.sh'), readFileSync(join(s.clone, 'scripts/ci-runner.sh'), 'utf8'))
    const lock = join(s.clone, '.git', 'packed-refs.lock')
    const r = await new Promise<{ code: number | null; err: string }>((res) => {
      const c = spawn('bash', [join(wt, 'scripts/ci-runner.sh'), 'plan'], {
        cwd: wt,
        env: {
          PATH: `${join(s.T, 'bin')}:${process.env.PATH}`,
          HOME: join(s.T, 'home'),
          TMPDIR: s.T,
          GH_TOKEN: 't',
          GITHUB_REPOSITORY: 'owner/talos-app',
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          INPUT_REF: 'main',
          GIT_FAKE_NET: 'no-term',
          GIT_FAKE_PIDS: join(s.T, 'wt.pids'),
          GIT_FAKE_LOCK: lock,
          CI_GIT_LIMIT: '1',
        },
      })
      let err = ''
      c.stderr.on('data', (d) => (err += d))
      c.on('exit', (code) => res({ code, err }))
    })
    expect(r.code, r.err).toBe(0)
    expect(r.err).toMatch(/it left \S*packed-refs\.lock \(not removed/)
    expect(existsSync(lock)).toBe(true)
  })

  it('a fetch stopped at the limit that ignores TERM: its whole process group goes; a lock it left is named, not removed', async () => {
    const s = setup({ git: askingGit })
    const pids = join(s.T, 'git.pids')
    const lock = join(s.clone, '.git', 'shallow.lock')
    const r = await runAsync(s, 'plan', {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      INPUT_REF: 'main',
      GIT_FAKE_NET: 'no-term',
      GIT_FAKE_PIDS: pids,
      GIT_FAKE_LOCK: lock,
    })
    expect(r.code, r.err).toBe(0)
    expect(dead(pids)).toBe(true)
    expect(r.err).toContain('stopped after 2s')
    expect(r.err).toMatch(/it left \S*\.git\/shallow\.lock \(not removed/)
    expect(existsSync(lock)).toBe(true)
  })

  it.each(['prompt', 'hang'])(
    'run of a PR whose ls-remote would %s: goes on to test the head it was given',
    async (how) => {
      const s = setup({ git: askingGit })
      const r = await runAsync(s, 'run', {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_NUMBER: '12',
        PR_HEAD_SHA: s.real,
        PR_HEAD_REPO: 'owner/talos-app',
        GIT_FAKE_NET: how,
      })
      expect(r.code, r.err).toBe(0)
      expect(s.called()).toContain('args: --pr 12')
      expect(r.err).toMatch(/ci-runner: git ls-remote of \S*origin\.git (stopped after 2s|failed)/)
    },
  )
})

// Phase B (docs/CI-MACHINES.md): Titan runs `image`. CI_TITAN_IMAGE=shadow: Titan posts report-ci/image and Lemnos still runs
// local-ci/image; on: Titan's local-ci/image is the one, Lemnos leaves image out and takes it over if Titan does not answer.
// CI_TITAN_BROWSER is phase C: it changes nothing yet.
// docs/CI-MACHINES.md, "Tools a test file needs": the plan says which tools each shard's machine has, so every machine deals the
// same piles. Lemnos has tmux; Delphi and Cyclops have what CI_TOOLS_DELPHI / CI_TOOLS_CYCLOPS say (unset: nothing).
describe('ci-runner.sh plan: shard_tools, the tools of the machine that runs each bridge shard', () => {
  it('every switch off: no shard_tools (Lemnos runs every rest file itself, as today)', () => {
    const s = setup()
    expect(outputs(s.run('plan', push(s.real)).out).shard_tools).toBe('')
  })
  it("a shard on a machine takes that machine's tools; a shard left on Lemnos takes tmux; unknown tools are dropped", () => {
    const s = setup()
    const p = (env: Record<string, string>) => outputs(s.run('plan', { ...push(s.real), ...env }).out).shard_tools
    expect(p({ CI_DELPHI: 'on', CI_CYCLOPS: 'on', CI_TOOLS_DELPHI: 'tmux' })).toBe('tmux|')
    expect(p({ CI_DELPHI: 'on', CI_CYCLOPS: 'on' })).toBe('|')
    expect(p({ CI_CYCLOPS: 'on' })).toBe('tmux|') // shard 1 stays on Lemnos
    expect(p({ CI_DELPHI: 'shadow', CI_TOOLS_DELPHI: 'tmux' })).toBe('tmux|tmux')
    // all shadow: each pile takes its machine's tools (the shadow runs preview what on would do)
    expect(p({ CI_DELPHI: 'shadow', CI_CYCLOPS: 'shadow' })).toBe('|')
    // mixed: a shadow machine's pile is the one Lemnos gates, so it takes Lemnos's tools
    expect(p({ CI_DELPHI: 'on', CI_CYCLOPS: 'shadow' })).toBe('|tmux')
    expect(p({ CI_DELPHI: 'on', CI_TOOLS_DELPHI: 'tmux,docker x', CI_CYCLOPS: 'on', CI_TOOLS_CYCLOPS: 'tmux' })).toBe(
      'tmux|tmux',
    )
  })
})

describe('ci-runner.sh plan: Titan runs image (phase B)', () => {
  it('CI_TITAN_IMAGE=on: image goes to Titan under local-ci/, Lemnos leaves it out and falls back to it', () => {
    const s = setup()
    const o = outputs(s.run('plan', { ...push(s.real), CI_TITAN_IMAGE: 'on' }).out)
    expect(o).toMatchObject({ titan: 'image', titan_prefix: 'local-ci', remote_jobs: 'image', fallback: 'titan:image' })
  })

  it('CI_TITAN_IMAGE=shadow: Titan runs it too, as report-ci/image; Lemnos keeps its own and takes nothing over', () => {
    const s = setup()
    const o = outputs(s.run('plan', { ...push(s.real), CI_TITAN_IMAGE: 'shadow' }).out)
    expect(o).toMatchObject({ titan: 'image', titan_prefix: 'report-ci', remote_jobs: '', fallback: '' })
  })

  it('any other value is off', () => {
    const s = setup()
    for (const v of ['', 'ON', 'yes', 'shadow ']) {
      const o = outputs(s.run('plan', { ...push(s.real), CI_TITAN_IMAGE: v }).out)
      expect(o, JSON.stringify(v)).toMatchObject({ titan: '', titan_prefix: '', remote_jobs: '', fallback: '' })
    }
  })

  it('a dispatch: image goes to Titan only when its job list has image (or is empty)', () => {
    const s = setup()
    const d = (jobs: string) =>
      outputs(
        s.run('plan', {
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          INPUT_REF: 'main',
          INPUT_JOBS: jobs,
          CI_TITAN_IMAGE: 'on',
        }).out,
      )
    expect(d('mod')).toMatchObject({ titan: '', remote_jobs: '', fallback: '' })
    expect(d('mod,image')).toMatchObject({ titan: 'image', remote_jobs: 'image', fallback: 'titan:image' })
    expect(d('')).toMatchObject({ titan: 'image', remote_jobs: 'image' })
  })
})

describe('ci-runner.sh plan: the e2e packages on Titan (phase C revised, CI_TITAN_BROWSER)', () => {
  const plan = (s: { real: string; run: ReturnType<typeof setup>['run'] }, env: Record<string, string>) => {
    const r = s.run('plan', { ...push(s.real), ...env })
    return { o: outputs(r.out), err: r.err, code: r.code }
  }
  it("off (unset or 'off'): today's plan exactly, with or without image on Titan", () => {
    const s = setup()
    for (const v of [undefined, 'off']) {
      const env = v === undefined ? {} : { CI_TITAN_BROWSER: v }
      expect(plan(s, env).o).toEqual(plan(s, {}).o)
      expect(plan(s, env).o).toMatchObject({ titan: '', remote_jobs: '', fallback: '', browser_e2e: '', e2e_wait: '' })
      expect(plan(s, { ...env, CI_TITAN_IMAGE: 'on' }).o).toMatchObject({
        titan: 'image',
        titan_prefix: 'local-ci',
        remote_jobs: 'image',
        fallback: 'titan:image',
        browser_e2e: '',
      })
      expect(plan(s, env).err).not.toContain('CI_TITAN_BROWSER')
      // a wait alone moves nothing
      expect(plan(s, { ...env, CI_BROWSER_E2E_WAIT: '300' }).o).toEqual(plan(s, {}).o)
    }
  })

  it('e2e-shadow: the part runs as report-ci/browser-e2e; Lemnos keeps its whole browser, folds nothing, takes nothing over', () => {
    const s = setup()
    for (const w of [undefined, '300']) {
      const r = plan(s, { CI_TITAN_BROWSER: 'e2e-shadow', ...(w ? { CI_BROWSER_E2E_WAIT: w } : {}) })
      expect(r.o).toMatchObject({ titan: '', browser_e2e: 'report-ci', e2e_wait: '', remote_jobs: '', fallback: '' })
      expect(r.err).toBe('')
    }
    // beside image on Titan: each keeps its own mode, and the fallback is image's alone
    expect(plan(s, { CI_TITAN_BROWSER: 'e2e-shadow', CI_TITAN_IMAGE: 'on' }).o).toMatchObject({
      titan: 'image',
      titan_prefix: 'local-ci',
      browser_e2e: 'report-ci',
      remote_jobs: 'image',
      fallback: 'titan:image',
    })
  })

  it("e2e with a positive wait: the part is ci-part/browser-e2e and Lemnos folds it; never in remote_jobs or the fallback (ci-local's take-back is the only one)", () => {
    const s = setup()
    for (const [w, n] of [
      ['300', '300'],
      ['090', '90'],
      ['1', '1'],
    ]) {
      const r = plan(s, { CI_TITAN_BROWSER: 'e2e', CI_BROWSER_E2E_WAIT: w as string })
      expect(r.o, w).toMatchObject({
        browser_e2e: 'ci-part',
        e2e_wait: n,
        remote_jobs: '',
        fallback: '',
        remote_parts: '',
      })
      expect(r.err, w).toBe('')
    }
    expect(plan(s, { CI_TITAN_BROWSER: 'e2e', CI_BROWSER_E2E_WAIT: '300', CI_TITAN_IMAGE: 'on' }).o).toMatchObject({
      titan: 'image',
      browser_e2e: 'ci-part',
      remote_jobs: 'image',
      fallback: 'titan:image',
    })
  })

  it('e2e without a positive CI_BROWSER_E2E_WAIT: browser runs everything on Lemnos (off), and one plain line says so', () => {
    const s = setup()
    const off = plan(s, {}).o
    const r = plan(s, { CI_TITAN_BROWSER: 'e2e' })
    expect(r.code).toBe(0)
    expect(r.o).toEqual(off)
    expect(r.err).toContain(
      'CI_TITAN_BROWSER=e2e but CI_BROWSER_E2E_WAIT is not set; browser runs everything on Lemnos\n',
    )
    for (const w of ['0', '000', 'x', '15m', '-5', ' 300', '1234567']) {
      const b = plan(s, { CI_TITAN_BROWSER: 'e2e', CI_BROWSER_E2E_WAIT: w })
      expect(b.code, w).toBe(0)
      expect(b.o, w).toEqual(off)
      expect(b.err, w).toContain('browser runs everything on Lemnos')
    }
    expect(plan(s, { CI_TITAN_BROWSER: 'e2e', CI_TITAN_IMAGE: 'on' }).o).toEqual(plan(s, { CI_TITAN_IMAGE: 'on' }).o)
  })

  it("an unknown value is off, and the log says so; step 6's whole-browser values (shadow, on) are unknown now", () => {
    const s = setup()
    const off = plan(s, {}).o
    for (const v of ['shadow', 'on', 'ON', 'yes', 'e2e ', 'E2E', 'true']) {
      const r = plan(s, { CI_TITAN_BROWSER: v, CI_BROWSER_E2E_WAIT: '300', CI_TITAN_BROWSER_DEADLINE: '1500' })
      expect(r.code, v).toBe(0)
      expect(r.o, v).toEqual(off)
      expect(r.err, v).toContain(`CI_TITAN_BROWSER '${v}' is not off, e2e-shadow or e2e; taken as off`)
    }
  })

  it('a dispatch: the part runs only when its job list has browser (or is empty)', () => {
    const s = setup()
    const d = (jobs: string, mode: string) =>
      outputs(
        s.run('plan', {
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          INPUT_REF: 'main',
          INPUT_JOBS: jobs,
          CI_TITAN_BROWSER: mode,
          CI_BROWSER_E2E_WAIT: '300',
        }).out,
      )
    for (const mode of ['e2e', 'e2e-shadow']) {
      expect(d('mod', mode), mode).toMatchObject({ browser_e2e: '', e2e_wait: '' })
      expect(d('mod,browser', mode).browser_e2e, mode).not.toBe('')
      expect(d('', mode).browser_e2e, mode).not.toBe('')
    }
  })
})

describe('ci-runner.sh run on Titan, and Lemnos when image is on Titan', () => {
  const titan = (s: { real: string }, prefix: string, extra: Record<string, string> = {}) => ({
    ...push(s.real),
    CI_PLAN_SHA: s.real,
    CI_RUN_JOBS: 'image',
    CI_RUN_PREFIX: prefix,
    CI_ATTEMPT_URL: ATTEMPT,
    CI_STATUS_URL: `${ATTEMPT}titan`,
    ...extra,
  })

  it('on: Titan runs image under local-ci/ on the planned commit', () => {
    const s = setup()
    const r = s.run('run', titan(s, 'local-ci'))
    expect(r.code, r.err).toBe(0)
    expect(s.called()).toContain(`args: --ref ${s.real} --sha ${s.real} --jobs image\n`)
    expect(s.called()).toContain('CI_STATUS_PREFIX=local-ci\n')
  })

  it('shadow: Titan runs image under report-ci/', () => {
    const s = setup()
    s.run('run', titan(s, 'report-ci'))
    expect(s.called()).toContain('CI_STATUS_PREFIX=report-ci\n')
  })

  it('a prefix that is neither, or none, is refused before anything runs', () => {
    const s = setup()
    for (const bad of ['', 'ci-part', 'x']) expect(s.run('run', titan(s, bad)).code, JSON.stringify(bad)).toBe(1)
    expect(s.called()).toBe('')
  })

  it("shadow, after Lemnos's own local-ci/image: still runs (its report is what shadow records)", () => {
    const s = setup()
    s.rows([`local-ci/image\tsuccess\t${ATTEMPT}lemnos\tpassed on ci-runner in 30s`])
    s.run('run', titan(s, 'report-ci'))
    expect(s.called()).toContain('--jobs image\n')
  })

  it('on, starting after Lemnos took image over in this attempt: tests nothing', () => {
    const s = setup()
    s.rows([`local-ci/image\tsuccess\t${ATTEMPT}lemnos\tpassed on ci-runner in 30s (fallback: titan did not answer)`])
    const r = s.run('run', titan(s, 'local-ci'))
    expect(r.code).toBe(0)
    expect(r.out).toContain('image is already answered in this attempt')
    expect(s.called()).toBe('')
  })

  it('Lemnos is told which jobs another machine runs (CI_REMOTE_JOBS); anything but image, or no planned commit, is refused', () => {
    const s = setup()
    s.run('run', { ...push(s.real), CI_PLAN_SHA: s.real, CI_REMOTE_JOBS: 'image' })
    expect(s.called()).toContain('CI_REMOTE_JOBS=image\n')
    expect(s.called()).toContain(`args: --ref ${s.real} --sha ${s.real}\n`) // no --jobs: Lemnos still plans its own skips
    // browser never goes to another machine whole any more (step 6's on is gone): only its e2e packages, folded by ci-local.sh
    for (const bad of ['image,check', 'browser,image', 'x', 'browser-mac', 'browser', 'image,browser', 'browser-e2e'])
      expect(s.run('run', { ...push(s.real), CI_PLAN_SHA: s.real, CI_REMOTE_JOBS: bad }).code, bad).toBe(1)
    expect(s.run('run', { ...push(s.real), CI_REMOTE_JOBS: 'image' }).code).toBe(1)
  })
})

describe("ci-runner.sh run: Titan's browser-e2e part, and Lemnos's browser with it (phase C revised)", () => {
  const part = (s: { real: string }, prefix: string, extra: Record<string, string> = {}) => ({
    ...push(s.real),
    CI_PLAN_SHA: s.real,
    CI_RUN_JOBS: 'browser-e2e',
    CI_RUN_PREFIX: prefix,
    CI_ATTEMPT_URL: ATTEMPT,
    CI_STATUS_URL: `${ATTEMPT}browser-e2e`,
    CI_PART_E2E_WORKERS: '8',
    ...extra,
  })
  const lemnos = (s: { real: string }, extra: Record<string, string> = {}) => ({
    ...push(s.real),
    CI_PLAN_SHA: s.real,
    CI_ATTEMPT_URL: ATTEMPT,
    CI_STATUS_URL: `${ATTEMPT}lemnos`,
    ...extra,
  })

  it("the part runs with --jobs (so ci-local.sh plans no skips for it), under plan's prefix, with its workers", () => {
    const s = setup()
    for (const prefix of ['ci-part', 'report-ci']) {
      const r = s.run('run', part(s, prefix))
      expect(r.code, r.err).toBe(0)
      expect(s.called()).toContain(`args: --ref ${s.real} --sha ${s.real} --jobs browser-e2e\n`)
      expect(s.called()).toContain(`CI_STATUS_PREFIX=${prefix}\n`)
      expect(s.called()).toContain('CI_PART_E2E_WORKERS=8\n')
    }
    // a PR and the nightly too: always --jobs browser-e2e, never a plain run that ci-affected.sh could skip
    const pr = {
      GITHUB_EVENT_NAME: 'pull_request',
      PR_NUMBER: '12',
      PR_HEAD_SHA: s.real,
      PR_HEAD_REPO: 'owner/talos-app',
    }
    for (const ev of [pr, { ...push(s.real), GITHUB_EVENT_NAME: 'schedule' }]) {
      expect(s.run('run', { ...part(s, 'ci-part'), ...ev }).code).toBe(0)
      expect(s.called(), ev.GITHUB_EVENT_NAME).toMatch(/ --jobs browser-e2e\n/)
    }
    for (const bad of ['', 'local-ci', 'x']) expect(s.run('run', part(s, bad)).code, bad).toBe(1)
  })

  it("e2e: a part that starts after Lemnos's browser was answered in this attempt tests nothing; in shadow it still runs", () => {
    const s = setup()
    s.rows([
      `local-ci/browser\tsuccess\t${ATTEMPT}lemnos\tpassed on ci-runner (e2e packages here: browser-e2e did not answer)`,
    ])
    const r = s.run('run', part(s, 'ci-part'))
    expect(r.out).toContain('browser is already answered in this attempt')
    expect(s.called()).toBe('')
    expect(s.run('run', part(s, 'report-ci')).code).toBe(0)
    expect(s.called()).toContain('--jobs browser-e2e\n')
  })

  it("Lemnos's own run gets CI_BROWSER_E2E_PART, its wait and the shadow switch; no other run does", () => {
    const s = setup()
    const knobs = { CI_BROWSER_E2E_PART: 'browser-e2e', CI_BROWSER_E2E_WAIT: '300', CI_BROWSER_E2E_SHADOW: '1' }
    expect(s.run('run', lemnos(s, knobs)).code).toBe(0)
    expect(s.called()).toContain('CI_BROWSER_E2E_PART=browser-e2e\nCI_BROWSER_E2E_WAIT=300\nCI_BROWSER_E2E_SHADOW=1\n')
    expect(s.called()).toContain('CI_PART_E2E_WORKERS=\n')
    for (const env of [
      part(s, 'ci-part'),
      part(s, 'report-ci'),
      {
        ...push(s.real),
        CI_PLAN_SHA: s.real,
        CI_RUN_JOBS: 'image',
        CI_RUN_PREFIX: 'local-ci',
        CI_ATTEMPT_URL: ATTEMPT,
      },
      { ...push(s.real), CI_PLAN_SHA: s.real, CI_RUN_JOBS: 'vitest', CI_ATTEMPT_URL: ATTEMPT },
    ]) {
      expect(s.run('run', { ...env, ...knobs }).code, env.CI_RUN_JOBS).toBe(0)
      expect(s.called(), env.CI_RUN_JOBS).toContain(
        'CI_BROWSER_E2E_PART=\nCI_BROWSER_E2E_WAIT=\nCI_BROWSER_E2E_SHADOW=\n',
      )
    }
  })

  it('never CI_BROWSER_E2E_PART and CI_BROWSER_MAC_PART together: no run gets the browser-mac part any more', () => {
    const s = setup()
    const both = { CI_BROWSER_E2E_PART: 'browser-e2e', CI_BROWSER_E2E_WAIT: '300', CI_BROWSER_MAC_PART: 'browser-mac' }
    expect(s.run('run', lemnos(s, both)).code).toBe(0)
    expect(s.called()).toContain('CI_BROWSER_MAC_PART=\n')
    expect(s.called()).toContain('CI_BROWSER_E2E_PART=browser-e2e\n')
    expect(s.run('run', part(s, 'ci-part', both)).code).toBe(0)
    expect(s.called()).toContain('CI_BROWSER_MAC_PART=\n')
    expect(s.called()).toContain('CI_PUSH_BEFORE=\n')
  })
})

describe('ci-runner.sh plan: check on Titan (CI_TITAN_CHECK)', () => {
  const plan = (s: { real: string; run: ReturnType<typeof setup>['run'] }, env: Record<string, string>) => {
    const r = s.run('plan', { ...push(s.real), ...env })
    return { o: outputs(r.out), err: r.err, code: r.code }
  }
  it("off (unset or 'off'): today's plan exactly; a wait alone moves nothing", () => {
    const s = setup()
    const today = plan(s, {}).o
    expect(today).toMatchObject({ check_titan: '', check_wait: '' })
    for (const env of [
      { CI_TITAN_CHECK: 'off' },
      { CI_CHECK_WAIT: '300' },
      { CI_TITAN_CHECK: 'off', CI_CHECK_WAIT: '300' },
    ]) {
      const r = plan(s, env)
      expect(r.o).toEqual(today)
      expect(r.err).toBe('')
    }
  })

  it("shadow: Titan's check-titan posts report-ci/check; Lemnos runs its whole check, folds nothing", () => {
    const s = setup()
    for (const w of [undefined, '300']) {
      const r = plan(s, { CI_TITAN_CHECK: 'shadow', ...(w ? { CI_CHECK_WAIT: w } : {}) })
      expect(r.o).toMatchObject({
        check_titan: 'report-ci',
        check_wait: '',
        remote_jobs: '',
        fallback: '',
        remote_parts: '',
      })
      expect(r.err).toBe('')
    }
  })

  it('on with a positive wait: ci-part/check, folded by Lemnos with that wait; never in remote_jobs or the fallback', () => {
    const s = setup()
    for (const [w, n] of [
      ['300', '300'],
      ['090', '90'],
    ]) {
      const r = plan(s, { CI_TITAN_CHECK: 'on', CI_CHECK_WAIT: w as string })
      expect(r.o, w).toMatchObject({ check_titan: 'ci-part', check_wait: n, remote_jobs: '', fallback: '' })
      expect(r.err, w).toBe('')
    }
    // beside image on Titan: each keeps its own mode
    expect(plan(s, { CI_TITAN_CHECK: 'on', CI_CHECK_WAIT: '300', CI_TITAN_IMAGE: 'on' }).o).toMatchObject({
      titan: 'image',
      check_titan: 'ci-part',
      remote_jobs: 'image',
      fallback: 'titan:image',
    })
  })

  it('on: the newest check-shadow row with tests that run nowhere in `on` is a warning line, never a block', () => {
    const s = setup()
    const tsv = join(s.T, 'home/.cache/talos-ci/logs/check-shadow.tsv')
    mkdirSync(dirname(tsv), { recursive: true })
    const on = { CI_TITAN_CHECK: 'on', CI_CHECK_WAIT: '300' }
    const want = plan(s, on).o
    const write = (header: string, ...rows: string[]) => writeFileSync(tsv, `${[header, ...rows].join('\n')}\n`)
    const H = 'date\tsha\tdetail\truns_nowhere_in_on'
    write(H, 'd1\ts1\t/x/old.txt\t0', 'd2\ts2\t/x/new.txt\t3')
    const r = plan(s, on)
    expect(r.code).toBe(0)
    expect(r.o).toEqual(want)
    expect(r.err).toMatch(/::warning::plan: .*3 test\(s\) .*run nowhere.*\/x\/new\.txt/)
    // the newest row is what counts; shadow mode, an older file without the column, or no file: no line
    write(H, 'd1\ts1\t/x/old.txt\t3', 'd2\ts2\t/x/new.txt\t0')
    expect(plan(s, on).err).toBe('')
    write(H, 'd2\ts2\t/x/new.txt\t3')
    expect(plan(s, { CI_TITAN_CHECK: 'shadow' }).err).toBe('')
    write('date\tsha\tdetail', 'd2\ts2\t/x/new.txt')
    expect(plan(s, on).err).toBe('')
    write(H, 'd2\ts2\t/x/new.txt\t-')
    expect(plan(s, on).err).toBe('')
  })

  it('on without a positive CI_CHECK_WAIT is off, and one plain line says so', () => {
    const s = setup()
    const off = plan(s, {}).o
    const r = plan(s, { CI_TITAN_CHECK: 'on' })
    expect(r.o).toEqual(off)
    expect(r.err).toContain('CI_TITAN_CHECK=on but CI_CHECK_WAIT is not set; check runs on Lemnos\n')
    for (const w of ['0', 'x', '15m', '-5', '1234567']) {
      const b = plan(s, { CI_TITAN_CHECK: 'on', CI_CHECK_WAIT: w })
      expect(b.code, w).toBe(0)
      expect(b.o, w).toEqual(off)
      expect(b.err, w).toContain('check runs on Lemnos')
    }
  })

  it('an unknown value is off, and the log says so', () => {
    const s = setup()
    const off = plan(s, {}).o
    for (const v of ['ON', 'yes', 'e2e', 'on ', 'true']) {
      const r = plan(s, { CI_TITAN_CHECK: v, CI_CHECK_WAIT: '300' })
      expect(r.code, v).toBe(0)
      expect(r.o, v).toEqual(off)
      expect(r.err, v).toContain(`CI_TITAN_CHECK '${v}' is not off, shadow or on; taken as off`)
    }
  })

  it("on: Delphi's and Cyclops's gating parts are not folded (Titan has the whole check); a dispatch without check plans nothing", () => {
    const s = setup()
    for (const sw of [{ CI_DELPHI: 'on' }, { CI_DELPHI: 'shadow', CI_CYCLOPS: 'on' }]) {
      const o = plan(s, { CI_TITAN_CHECK: 'on', CI_CHECK_WAIT: '300', ...sw }).o
      expect(o, JSON.stringify(sw)).toMatchObject({
        check_titan: 'ci-part',
        remote_parts: '',
        delphi: '',
        cyclops: '',
        shard_tools: '',
      })
    }
    // shadow leaves them as they are
    expect(plan(s, { CI_TITAN_CHECK: 'shadow', CI_DELPHI: 'on' }).o.delphi).toBe('bridge-shard-1,vitest')
    const r = plan(s, { CI_TITAN_CHECK: 'on', CI_CHECK_WAIT: '300', CI_DELPHI: 'on' })
    expect(r.err).toContain('CI_TITAN_CHECK=on')
    const d = (jobs: string) =>
      outputs(
        s.run('plan', {
          GITHUB_EVENT_NAME: 'workflow_dispatch',
          INPUT_REF: 'main',
          INPUT_JOBS: jobs,
          CI_TITAN_CHECK: 'on',
          CI_CHECK_WAIT: '300',
        }).out,
      )
    expect(d('mod')).toMatchObject({ check_titan: '', check_wait: '' })
    expect(d('mod,check').check_titan).toBe('ci-part')
    expect(d('').check_titan).toBe('ci-part')
  })
})

describe("ci-runner.sh run: Titan's check-titan part, and Lemnos's check with it", () => {
  const part = (s: { real: string }, prefix: string, extra: Record<string, string> = {}) => ({
    ...push(s.real),
    CI_PLAN_SHA: s.real,
    CI_RUN_JOBS: 'check',
    CI_RUN_PREFIX: prefix,
    CI_ATTEMPT_URL: ATTEMPT,
    CI_STATUS_URL: `${ATTEMPT}check-titan`,
    ...extra,
  })
  it("the part runs --jobs check under plan's prefix; anything else is refused", () => {
    const s = setup()
    for (const prefix of ['ci-part', 'report-ci']) {
      const r = s.run('run', part(s, prefix))
      expect(r.code, r.err).toBe(0)
      expect(s.called()).toContain(`args: --ref ${s.real} --sha ${s.real} --jobs check\n`)
      expect(s.called()).toContain(`CI_STATUS_PREFIX=${prefix}\n`)
    }
    for (const bad of ['', 'local-ci', 'x']) expect(s.run('run', part(s, bad)).code, bad).toBe(1)
  })

  it("on: a part that starts after Lemnos's check was answered in this attempt tests nothing; in shadow it still runs", () => {
    const s = setup()
    s.rows([`local-ci/check\tsuccess\t${ATTEMPT}lemnos\tpassed on ci-runner (check here: check-titan did not answer)`])
    const r = s.run('run', part(s, 'ci-part'))
    expect(r.out).toContain('check is already answered in this attempt')
    expect(s.called()).toBe('')
    expect(s.run('run', part(s, 'report-ci')).code).toBe(0)
    expect(s.called()).toContain('--jobs check\n')
  })

  it("Lemnos's own run gets CI_CHECK_PART and CI_CHECK_WAIT; a part's run and the fallback do not", () => {
    const s = setup()
    const knobs = { CI_CHECK_PART: 'check-titan', CI_CHECK_WAIT: '300' }
    const lemnos = { ...push(s.real), CI_PLAN_SHA: s.real, CI_ATTEMPT_URL: ATTEMPT, CI_STATUS_URL: `${ATTEMPT}lemnos` }
    expect(s.run('run', { ...lemnos, ...knobs }).code).toBe(0)
    expect(s.called()).toContain('CI_CHECK_PART=check-titan\nCI_CHECK_WAIT=300\n')
    expect(s.run('run', { ...part(s, 'ci-part'), ...knobs }).code).toBe(0)
    expect(s.called()).toContain('CI_CHECK_PART=\nCI_CHECK_WAIT=\n')
    expect(
      s.run('fallback', { ...lemnos, ...knobs, CI_FALLBACK: 'titan:image', CI_RUN_STARTED: '2000-01-01T00:00:00Z' })
        .code,
    ).toBe(0)
    expect(s.called()).toContain('--jobs image\n')
    expect(s.called()).toContain('CI_CHECK_PART=\nCI_CHECK_WAIT=\n')
  })
})

describe('ci-runner.sh run on a part or report-only machine', () => {
  it('a part machine runs its parts under ci-part/, on the planned commit', () => {
    const s = setup()
    const r = s.run('run', { ...push(s.real), CI_PLAN_SHA: s.real, CI_RUN_JOBS: 'bridge-shard-1,vitest' })
    expect(r.code, r.err).toBe(0)
    expect(s.called()).toContain(`args: --ref ${s.real} --sha ${s.real} --jobs bridge-shard-1,vitest\n`)
    expect(s.called()).toContain('CI_STATUS_PREFIX=ci-part\n')
  })

  it('the Linux job posts under report-ci/', () => {
    const s = setup()
    s.run('run', { ...push(s.real), CI_PLAN_SHA: s.real, CI_RUN_JOBS: 'linux' })
    expect(s.called()).toContain('CI_STATUS_PREFIX=report-ci\n')
  })

  it("on the nightly and a dispatch a part runs --full, as check's own Vitest does there", () => {
    const s = setup()
    s.run('run', {
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: s.real,
      CI_PLAN_SHA: s.real,
      CI_RUN_JOBS: 'vitest',
    })
    expect(s.called()).toContain(`args: --ref ${s.real} --sha ${s.real} --full --jobs vitest\n`)
  })

  it('a part machine that starts after check was answered in this attempt tests nothing', () => {
    const s = setup()
    s.rows([`local-ci/check\tsuccess\t${ATTEMPT}lemnos\tpassed on ci-runner in 400s`])
    const r = s.run('run', {
      ...push(s.real),
      CI_PLAN_SHA: s.real,
      CI_RUN_JOBS: 'vitest',
      CI_ATTEMPT_URL: ATTEMPT,
      CI_STATUS_URL: `${ATTEMPT}delphi`,
    })
    expect(r.code).toBe(0)
    expect(r.out).toContain('check is already answered in this attempt')
    expect(s.called()).toBe('')
  })

  it('Lemnos gets the planned commit and the parts to fold in; GITHUB_RUN_ID becomes CI_RUN_ID', () => {
    const s = setup()
    s.run('run', {
      ...push(s.real),
      CI_PLAN_SHA: s.real,
      CI_REMOTE_PARTS: 'bridge-shard-2:cyclops',
      GITHUB_RUN_ID: '9',
    })
    expect(s.called()).toContain(`args: --ref ${s.real} --sha ${s.real}\n`)
    expect(s.called()).toContain('CI_REMOTE_PARTS=bridge-shard-2:cyclops\n')
    expect(s.called()).toContain('CI_RUN_ID=9\n')
  })

  it('a planned commit that is not a full sha is refused', () => {
    const s = setup()
    expect(s.run('run', { ...push(s.real), CI_PLAN_SHA: 'abc1234' }).code).toBe(1)
  })
})

describe('ci-runner.sh run: the planned commit is the one tested, and nothing is guessed', () => {
  it('a dispatch tests the planned commit, not the branch name, which may have moved since plan', () => {
    const s = setup()
    s.run('run', { GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: 'main', CI_PLAN_SHA: s.real })
    expect(s.called()).toContain(`args: --ref ${s.real} --sha ${s.real} --full\n`)
  })

  it("a planned commit that is not the event's own is refused (a wiring mistake would test nothing)", () => {
    const s = setup()
    const r = s.run('run', { ...push(s.real), CI_PLAN_SHA: 'b'.repeat(40) })
    expect(r.code).toBe(1)
    expect(r.err).toContain('is not the pushed commit')
    expect(s.called()).toBe('')
  })

  it('a part machine and fallback need the planned commit', () => {
    const s = setup()
    expect(s.run('run', { ...push(s.real), CI_RUN_JOBS: 'vitest' }).code).toBe(1)
    expect(s.run('fallback', { ...push(s.real), CI_FALLBACK: 'titan:image', CI_ATTEMPT_URL: ATTEMPT }).code).toBe(1)
    expect(s.called()).toBe('')
  })

  it('an attempt link that does not end in # is refused (attempts/1 would also match attempts/10)', () => {
    const s = setup()
    const r = s.run('run', {
      ...push(s.real),
      CI_PLAN_SHA: s.real,
      CI_RUN_JOBS: 'vitest',
      CI_ATTEMPT_URL: 'https://example.test/r/runs/9/attempts/1',
    })
    expect(r.code).toBe(1)
  })

  it('a PR part machine still does the PR checks, then runs on the planned commit', () => {
    const s = setup()
    const pr = {
      GITHUB_EVENT_NAME: 'pull_request',
      PR_NUMBER: '12',
      PR_HEAD_SHA: s.real,
      PR_HEAD_REPO: 'owner/talos-app',
    }
    expect(s.run('run', { ...pr, CI_PLAN_SHA: s.real, CI_RUN_JOBS: 'bridge-shard-2' }).code).toBe(0)
    expect(s.called()).toContain(`args: --pr 12 --sha ${s.real} --jobs bridge-shard-2\n`)
  })
})

describe('ci-runner.sh fallback: Lemnos takes a gating job another machine did not answer', () => {
  const env = (s: { real: string }, extra: Record<string, string> = {}) => ({
    ...push(s.real),
    CI_PLAN_SHA: s.real,
    CI_ATTEMPT_URL: ATTEMPT,
    CI_STATUS_URL: `${ATTEMPT}lemnos`,
    GITHUB_RUN_ID: '9',
    CI_FALLBACK: 'titan:image,browser',
    CI_FALLBACK_POLL: '1',
    ...extra,
  })

  it('nothing handed to another machine: nothing to take', () => {
    const s = setup()
    const r = s.run('fallback', env(s, { CI_FALLBACK: '' }))
    expect(r.code).toBe(0)
    expect(s.called()).toBe('')
  })

  it('every context it owes is final in this attempt: nothing taken, whatever its job says', () => {
    const s = setup()
    s.rows([
      `local-ci/image\tsuccess\t${ATTEMPT}titan\tpassed on titan`,
      `local-ci/browser\tfailure\t${ATTEMPT}titan\tfailed on titan`,
    ])
    s.jobs(['titan\tqueued'])
    expect(s.run('fallback', env(s)).code).toBe(0)
    expect(s.called()).toBe('')
  })

  it('its job never picked up: taken now, every unanswered context in one ci-local.sh call', () => {
    const s = setup()
    s.rows([`local-ci/image\tsuccess\t${ATTEMPT}titan\tpassed on titan`])
    s.jobs(['titan\tqueued'])
    expect(s.run('fallback', env(s)).code).toBe(0)
    expect(s.called()).toContain(`args: --ref ${s.real} --sha ${s.real} --jobs browser\n`)
  })

  // A PR's run step tests nothing when the PR moved on or was closed while the run waited; Titan's run does the same, so it ends
  // with no answer. The fallback must not post over a head nobody tests any more.
  describe('on a PR', () => {
    const pr = (s: { real: string }, extra: Record<string, string> = {}) =>
      env(s, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_NUMBER: '12',
        PR_HEAD_SHA: s.real,
        PR_HEAD_REPO: 'owner/talos-app',
        CI_FALLBACK: 'titan:image',
        ...extra,
      })
    it('open: it takes image over as a PR run of the planned head (--pr, so the head is fetched and pinned)', () => {
      const s = setup()
      s.jobs(['titan\tcompleted'])
      expect(s.run('fallback', pr(s)).code).toBe(0)
      expect(s.called()).toContain(`args: --pr 12 --sha ${s.real} --jobs image\n`)
    })
    it('closed: nothing taken, nothing posted', () => {
      const s = setup()
      s.jobs(['titan\tcompleted'])
      const r = s.run('fallback', pr(s, { GH_PR_STATE: 'closed' }))
      expect(r.code).toBe(0)
      expect(r.out).toContain('is closed')
      expect(s.called()).toBe('')
    })
    it('moved on: nothing taken (the newer push has its own run)', () => {
      const s = setup()
      s.jobs(['titan\tcompleted'])
      execFileSync('git', ['-C', s.clone, 'push', '-q', 'origin', `${s.real}:refs/pull/12/head`])
      const r = s.run('fallback', pr(s, { PR_HEAD_SHA: 'f'.repeat(40), CI_PLAN_SHA: 'f'.repeat(40) }))
      expect(r.code).toBe(0)
      expect(r.out).toContain('moved on')
      expect(s.called()).toBe('')
    })
  })

  // A Titan stopped (cancelled, timed out, its runner stopped) closes its pending as `error` on its way out: that is no answer, and
  // Lemnos takes the job over so a verdict still lands. A `failure` is an answer (a red). Lemnos's own `error` stands.
  it("another machine's error in this attempt is no answer: taken over; its failure is, and Lemnos's own error stands", () => {
    const cases: [string, string, boolean][] = [
      [
        'Titan stopped (error, its own link)',
        `local-ci/image\terror\t${ATTEMPT}titan\trun on titan ended before this job reported`,
        true,
      ],
      [
        'Titan cancelled (an error that says "not tested:")',
        `local-ci/image\terror\t${ATTEMPT}titan\tnot tested: run cancelled before this job reported (on titan); re-run`,
        true,
      ],
      ['Titan red (failure)', `local-ci/image\tfailure\t${ATTEMPT}titan\tfailed on titan`, false],
      [
        "Lemnos's own error",
        `local-ci/image\terror\t${ATTEMPT}lemnos\trun on ci-runner ended before this job reported`,
        false,
      ],
    ]
    for (const [name, row, taken] of cases) {
      const s = setup()
      s.rows([row])
      s.jobs(['titan\tcompleted'])
      expect(s.run('fallback', env(s, { CI_FALLBACK: 'titan:image' })).code, name).toBe(0)
      if (taken) expect(s.called(), name).toContain('--jobs image\n')
      else expect(s.called(), name).toBe('')
    }
  })

  it("the job it takes over is not left out again: the fallback's ci-local.sh gets no CI_REMOTE_JOBS", () => {
    const s = setup()
    s.jobs(['titan\tqueued'])
    s.run('fallback', env(s, { CI_FALLBACK: 'titan:image', CI_REMOTE_JOBS: 'image' }))
    expect(s.called()).toContain('--jobs image\n')
    expect(s.called()).toContain('CI_REMOTE_JOBS=\n')
  })

  it("the fallback's run never folds or splits browser: no CI_BROWSER_E2E_*, CI_BROWSER_MAC_PART or CI_PUSH_BEFORE", () => {
    const s = setup()
    s.jobs(['titan\tqueued'])
    s.run(
      'fallback',
      env(s, {
        CI_BROWSER_MAC_PART: 'browser-mac',
        CI_PUSH_BEFORE: 'b'.repeat(40),
        CI_BROWSER_E2E_PART: 'browser-e2e',
        CI_BROWSER_E2E_WAIT: '300',
        CI_BROWSER_E2E_SHADOW: '1',
      }),
    )
    expect(s.called()).toContain('--jobs image,browser\n')
    expect(s.called()).toContain('CI_BROWSER_MAC_PART=\n')
    expect(s.called()).toContain('CI_PUSH_BEFORE=\n')
    expect(s.called()).toContain('CI_BROWSER_E2E_PART=\nCI_BROWSER_E2E_WAIT=\nCI_BROWSER_E2E_SHADOW=\n')
  })

  it('its job completed without answering (it died, or refused): taken now', () => {
    const s = setup()
    s.jobs(['titan\tcompleted'])
    s.run('fallback', env(s))
    expect(s.called()).toContain('--jobs image,browser\n')
  })

  it('its job working past CI_REMOTE_DEADLINE: taken', () => {
    const s = setup()
    s.jobs(['titan\tin_progress'])
    s.run('fallback', env(s, { CI_REMOTE_DEADLINE: '0', CI_RUN_STARTED: '2000-01-01T00:00:00Z' }))
    expect(s.called()).toContain('--jobs image,browser\n')
  })

  // the job's status says why Lemnos answered it (ci-local.sh appends the note): its machine errored, never answered, or was
  // still working at the deadline
  it('each job it takes carries why, for its status text (CI_FALLBACK_NOTES)', () => {
    const cases: [string, string[], string, Record<string, string>, string][] = [
      ['never picked up', [], 'titan\tqueued', {}, 'image=titan did not answer;browser=titan did not answer'],
      [
        'its machine errored on one',
        [`local-ci/image\terror\t${ATTEMPT}titan\trun on titan ended before this job reported`],
        'titan\tcompleted',
        {},
        'image=titan errored;browser=titan did not answer',
      ],
      [
        'still working at the deadline',
        [],
        'titan\tin_progress',
        { CI_REMOTE_DEADLINE: '0', CI_RUN_STARTED: '2000-01-01T00:00:00Z' },
        'image=titan did not answer in time;browser=titan did not answer in time',
      ],
    ]
    for (const [name, rows, job, extra, notes] of cases) {
      const s = setup()
      s.rows(rows)
      s.jobs([job])
      expect(s.run('fallback', env(s, extra)).code, name).toBe(0)
      expect(s.called(), name).toContain(`CI_FALLBACK_NOTES=${notes}\n`)
    }
  })

  it("an earlier attempt's statuses are not this attempt's answer", () => {
    const s = setup()
    s.rows(['local-ci/image\tsuccess\thttps://example.test/r/runs/9/attempts/0#titan\tpassed'])
    s.jobs(['titan\tqueued'])
    s.run('fallback', env(s))
    expect(s.called()).toContain('--jobs image,browser\n')
  })

  it('a pending status of this attempt is no answer: the job is taken', () => {
    const s = setup()
    s.rows([`local-ci/image\tpending\t${ATTEMPT}titan\trunning`, `local-ci/browser\terror\t${ATTEMPT}titan\tcancelled`])
    s.jobs(['titan\tcompleted'])
    s.run('fallback', env(s))
    // and browser's error from Titan is no answer either (Titan was stopped): both are taken
    expect(s.called()).toContain('--jobs image,browser\n')
  })

  it('its job working, answered before the deadline: nothing taken (the loop waits, then reads again)', () => {
    const s = setup({
      gh: `case "$*" in
  *"/statuses?"*) n=$(cat "$HOME/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$HOME/n"
    if [ "$n" -ge 2 ]; then printf 'local-ci/image\\tsuccess\\t${ATTEMPT}titan\\nlocal-ci/browser\\tsuccess\\t${ATTEMPT}titan\\n'; fi ;;
  *"/jobs"*) printf 'titan\\tin_progress\\n' ;;
esac
exit 0`,
    })
    const r = s.run(
      'fallback',
      env(s, { CI_REMOTE_DEADLINE: '600', CI_RUN_STARTED: new Date().toISOString().slice(0, 19) + 'Z' }),
    )
    expect(r.code, r.err).toBe(0)
    expect(s.called()).toBe('')
    expect(r.out).toContain('every job handed elsewhere is answered')
  })

  it('on the nightly and a dispatch a taken job runs --full, and the nightly keeps its long fuzz', () => {
    const s = setup()
    s.jobs(['titan\tqueued'])
    s.run('fallback', env(s, { GITHUB_EVENT_NAME: 'schedule' }))
    expect(s.called()).toContain(`--sha ${s.real} --full --jobs image,browser\n`)
    expect(s.called()).toContain('TALOS_FUZZ_MS=60000\n')
  })

  it('a bad CI_REMOTE_DEADLINE or CI_FALLBACK_POLL is refused before any read', () => {
    const s = setup()
    for (const bad of [{ CI_REMOTE_DEADLINE: 'HOME[$(id)]' }, { CI_FALLBACK_POLL: 'soon' }, { CI_FALLBACK_POLL: '0' }])
      expect(s.run('fallback', env(s, bad)).code, JSON.stringify(bad)).toBe(1)
  })

  it('a malformed CI_FALLBACK is refused', () => {
    const s = setup()
    for (const bad of ['titan', 'titan:check;x', ':image', 'titan:image,'])
      expect(s.run('fallback', env(s, { CI_FALLBACK: bad })).code, bad).toBe(1)
  })
})

describe("ci-runner.sh preflight: the owner's Mac, before anything of the run is set up", () => {
  const wall = (T: string) => {
    const home = join(T, 'owner-home')
    const tmux = join(T, 'tmux-x')
    mkdirSync(home)
    mkdirSync(tmux)
    chmodSync(home, 0o000)
    chmodSync(tmux, 0o000)
    return {
      CI_OWNER_MACHINE: '1',
      CI_LIVE_OWNER: userInfo().username,
      CI_LIVE_HOME: home,
      CI_LIVE_TMUX: tmux,
      // the system's tools minus claude and chronos: a machine with /usr/bin/claude (Titan's WSL) must not trip the wall here
      PATH: `${join(T, 'bin')}:${systemPathWithout(T, ['claude', 'chronos'])}`,
    }
  }
  it('the wall is there: exit 0', () => {
    const s = setup({ dseditgroup: 'exit 67' })
    const r = s.run('preflight', { ...wall(s.T), CI_LOCAL_SCRIPT: s.local })
    expect(r.code, r.err).toBe(0)
  })
  it('any one condition broken: exit 1 with its reason (the same checks as ci-local.sh)', () => {
    const s = setup({ dseditgroup: 'exit 0' })
    const r = s.run('preflight', { ...wall(s.T), CI_LOCAL_SCRIPT: s.local })
    expect(r.code).toBe(1)
    expect(r.err).toContain('this user is in the admin group')
  })
  it('not the owner machine (no CI_OWNER_MACHINE=1): nothing to check', () => {
    const s = setup({ dseditgroup: 'exit 0' })
    expect(s.run('preflight', { CI_LOCAL_SCRIPT: s.local }).code).toBe(0)
  })
})
