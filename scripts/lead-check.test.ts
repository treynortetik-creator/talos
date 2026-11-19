// scripts/lead-check.sh: main's verdict + the lead inbox in one line and an exit code, against a fake gh and a fake inbox
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'lead-check.sh')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const JOBS = ['browser', 'check', 'desktop', 'image', 'mobile', 'mod']
type Commit = { sha: string; states: Record<string, string> }
const all = (state: string) => Object.fromEntries(JOBS.map((j) => [j, state]))

/** A box: commits newest first, each with its local-ci states; an inbox printing `inbox` (exit `inboxRc`). */
function box() {
  const d = mkdtempSync(join(tmpdir(), 'talos-lead-check-'))
  dirs.push(d)
  const bin = join(d, 'bin')
  mkdirSync(bin)
  // gh api <path> --jq <filter>: commits?sha=main lists data/commits; commits/<sha>/status prints data/<sha> as the jq output
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
[ -f "${d}/gh-fails" ] && exit 1
case "$2" in
  *commits\\?sha=main*) cat "${d}/commits" ;;
  */status*) s="\${2#*/commits/}"; s="\${s%%/status*}"; cat "${d}/st-$s" 2>/dev/null ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  )
  const set = (commits: Commit[], inbox = '', inboxRc = 0) => {
    writeFileSync(join(d, 'commits'), `${commits.map((c) => c.sha).join('\n')}\n`)
    for (const c of commits) {
      const rows = Object.entries(c.states).map(([j, s]) => `${j} ${s}`)
      writeFileSync(join(d, `st-${c.sha}`), `${rows.join('\n')}\n`)
    }
    writeFileSync(join(d, 'inbox.sh'), `#!/bin/sh\nprintf '%s' '${inbox}'\nexit ${inboxRc}\n`, { mode: 0o755 })
  }
  const run = () => {
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TALOS_LEAD_CHECK_HOME: join(d, 'home'),
        LEAD_CHECK_INBOX: `sh ${join(d, 'inbox.sh')}`,
        GH_TOKEN: 't', // the account itself: ci-gh-account.test.ts
      },
    })
    return {
      code: r.status,
      out: r.stdout.trim(),
      err: r.stderr,
      state: () => readFileSync(join(d, 'home', 'state'), 'utf8'),
    }
  }
  return { d, set, run }
}

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('lead-check.sh', () => {
  it('all six green and an empty inbox: exit 0, one line, written to the state file', () => {
    const b = box()
    b.set([{ sha: A, states: all('success') }])
    const r = b.run()
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^\S+Z main=green sha=aaaaaaa failing=- inbox=0 new, 0 red$/)
    expect(r.state().trim()).toBe(r.out)
  })

  it('a red job on the newest finished commit: exit 1 once, then 3 while nothing changes', () => {
    const b = box()
    b.set([{ sha: A, states: { ...all('success'), desktop: 'failure', image: 'error' } }])
    const r = b.run()
    expect(r.code).toBe(1)
    expect(r.out).toContain('main=red sha=aaaaaaa failing=desktop,image')
    expect(b.run().code).toBe(3)
  })

  it('a pending head is skipped: the verdict is the newest commit with all six final', () => {
    const b = box()
    b.set([
      { sha: A, states: { ...all('success'), browser: 'pending' } },
      { sha: B, states: all('success') },
    ])
    const r = b.run()
    expect(r.code).toBe(0)
    expect(r.out).toContain('main=green sha=bbbbbbb')
  })

  it('a missing context is not final; nothing final in the window is pending, exit 0', () => {
    const b = box()
    const { mod: _mod, ...five } = all('success')
    b.set([{ sha: A, states: five }])
    const r = b.run()
    expect(r.code).toBe(0)
    expect(r.out).toContain('main=pending sha=aaaaaaa failing=-')
  })

  it('new red alerts in the inbox are a hit; the line counts them; reading never marks', () => {
    const b = box()
    b.set([{ sha: A, states: all('success') }], 'x-red\ntext\nlead-inbox: 3 new (2 red)\n')
    const r = b.run()
    expect(r.code).toBe(1)
    expect(r.out).toContain('inbox=3 new, 2 red')
  })

  it('new alerts with no red are not a hit', () => {
    const b = box()
    b.set([{ sha: A, states: all('success') }], 'x-green\ntext\nlead-inbox: 1 new (0 red)\n')
    expect(b.run().code).toBe(0)
  })

  it('an unreadable inbox or GitHub: exit 2', () => {
    const b = box()
    b.set([{ sha: A, states: all('success') }], '', 2)
    const r = b.run()
    expect(r.code).toBe(2)
    expect(r.out).toContain('inbox=unreadable')
    writeFileSync(join(b.d, 'gh-fails'), '')
    const g = b.run()
    expect(g.code).toBe(2)
    expect(g.err).toContain('lead-check: cannot read')
  })
})
