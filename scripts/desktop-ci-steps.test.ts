// apps/desktop/scripts/ci.sh stops at its first red step, but says every step it left out: one `NOT RUN: <step> (<red one> failed)`
// line each, so a report never reads as if guards-test.sh and the rest had passed. Every script it calls is a stub here.
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** ci.sh in a scratch desktop folder, every script it names a stub that writes its name down and fails when told to. */
function run(failing: string, extra: Record<string, string> = {}) {
  // extra goes into ci.sh's environment; CI_NOTRUN_FILE (a path under the scratch folder) is the file ci-local reads the lines from
  const T = mkdtempSync(join(tmpdir(), 'dcs-'))
  dirs.push(T)
  const d = join(T, 'apps/desktop/scripts')
  mkdirSync(d, { recursive: true })
  mkdirSync(join(T, 'scripts'), { recursive: true })
  cpSync(join(here, '../apps/desktop/scripts/ci.sh'), join(d, 'ci.sh'))
  chmodSync(join(d, 'ci.sh'), 0o755)
  const calls = join(T, 'calls')
  const stub = `#!/bin/sh\necho "$(basename "$0") $*" >> "${calls}"\ncase "$(basename "$0")" in ${failing || 'none'}) echo "stub: $(basename "$0") is red"; exit 1 ;; esac\nexit 0\n`
  const names = readFileSync(join(d, 'ci.sh'), 'utf8').match(/scripts\/[a-z0-9-]+\.sh/g) ?? []
  for (const n of new Set(names)) {
    const p = n.startsWith('scripts/ci-swift') ? join(T, n) : join(T, 'apps/desktop', n)
    // the two wrappers run what they are given, as the real ones do: test.sh is the command a red run is about
    const wrapper = /(pty-watch|ci-swift-retry)\.sh$/.test(n)
    if (!existsSync(p)) writeFileSync(p, wrapper ? '#!/bin/sh\nexec "$@"\n' : stub, { mode: 0o755 })
  }
  const r = spawnSync('bash', [join(d, 'ci.sh'), 'out'], {
    env: { PATH: process.env.PATH ?? '', HOME: T, TALOS_CI_SLOT_RUN: '1', ...extra }, // no lock: not inside a CI job's slot otherwise
    encoding: 'utf8',
  })
  const ran = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []
  const notRun = r.stdout.split('\n').filter((l) => l.startsWith('NOT RUN: '))
  return { r, ran, notRun, T }
}

describe('desktop ci.sh: a red step and the steps after it', () => {
  it('a green run runs every step and says none NOT RUN', () => {
    const { r, ran, notRun } = run('')
    expect(r.status, r.stderr).toBe(0)
    expect(notRun).toEqual([])
    expect(ran.some((l) => l.startsWith('guards-test.sh'))).toBe(true)
  })

  it('a red test.sh fails the job, runs nothing after it, and names each step it left out, guards-test.sh among them', () => {
    const { r, ran, notRun } = run('test.sh')
    expect(r.status).not.toBe(0)
    expect(ran.filter((l) => !l.startsWith('tests-green-stamp.sh') && !l.startsWith('test.sh'))).toEqual([])
    expect(
      notRun.some(
        (l) => l.startsWith('NOT RUN: guards-test.sh(auto-update-apply-test.sh,') && l.endsWith(' (test.sh failed)'),
      ),
    ).toBe(true)
    expect(notRun).toContain('NOT RUN: build-app.sh (test.sh failed)')
    expect(notRun).toContain('NOT RUN: relay-wait-test.sh (test.sh failed)')
    expect(notRun).not.toContain('NOT RUN: test.sh (test.sh failed)')
    expect(notRun.length).toBeGreaterThan(10)
  })

  it('a red step in the middle: the ones before it ran, the ones after are NOT RUN, and the exit is not 0', () => {
    const { r, ran, notRun } = run('build-app.sh')
    expect(r.status).not.toBe(0)
    expect(ran.some((l) => l.startsWith('starvation-tests.sh'))).toBe(true)
    expect(ran.some((l) => l.startsWith('guards-test.sh'))).toBe(false)
    expect(notRun[0]).toBe('NOT RUN: test.sh(BuiltAppArt) (build-app.sh failed)')
    expect(notRun.some((l) => l.startsWith('NOT RUN: guards-test.sh(') && l.endsWith(' (build-app.sh failed)'))).toBe(
      true,
    )
    expect(notRun.some((l) => l.includes('starvation-tests.sh'))).toBe(false)
  })
  it('every NOT RUN line is also written to CI_NOTRUN_FILE, the file a report reads, when ci-local gives one', () => {
    const file = join(tmpdir(), `dcs-notrun-${process.pid}`)
    dirs.push(file)
    const { notRun } = run('test.sh', { CI_NOTRUN_FILE: file })
    expect(notRun.length).toBeGreaterThan(10)
    expect(readFileSync(file, 'utf8')).toBe(`${notRun.join('\n')}\n`)
    const none = run('test.sh') // no file asked for: only the log line
    expect(none.notRun.length).toBe(notRun.length)
  })

  it('the list a desktop job that never started ci.sh names (DESKTOP_STEPS in jobs-swift.sh) is the steps ci.sh always runs, by their names', () => {
    const listed = /DESKTOP_STEPS="([^"]+)"/.exec(readFileSync(join(here, 'ci-local/jobs-swift.sh'), 'utf8'))?.[1]
    expect(listed).toBeTruthy()
    const names = [
      ...readFileSync(join(here, '../apps/desktop/scripts/ci.sh'), 'utf8').matchAll(/^step "?([^" ]+)"? /gm),
    ].map((m) => m[1])
    // test.sh is run inside the GUI-tests branch; every other unconditional step starts a line
    expect((listed as string).split(/\s+/).filter(Boolean)).toEqual([
      'test.sh',
      ...(names as string[]).filter((n) => n !== 'test.sh'),
    ])
  })
})
