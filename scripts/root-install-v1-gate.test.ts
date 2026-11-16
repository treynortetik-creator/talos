// The installer's real gate, run on a carried kit 1.x agent folder. The other root-install tests replace the gate with
// TALOS_INSTALL_GATE_CMD=true (it takes minutes), so none of them ever runs the kit's self-test where the owner's install
// runs it: in an upgraded folder, with the owner's own notes, memory and settings beside the kit's code. A kit test that
// assumes it runs in the kit repo (the weekly wiki check read $KIT/wiki, which in an agent folder is the owner's notes) passes
// there and fails here, and the gate failed for every kit 1.x carry without CI seeing it. This runs the whole gate once.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t } from '../packages/testkit/src/time-factor.ts'
import { REPO, run, type Sandbox, sandbox } from './root-install-harness.ts'

const KIT = join(REPO, 'kit')
// The owner's own files: every one must be byte-for-byte the same after --apply.
const OWNER = [
  'CLAUDE.md',
  'memory/STATE.md',
  'memory/HANDOFF.md',
  'memory/2026-08-30.md',
  'wiki/me.md',
  'wiki/_index.md',
  'wiki/concepts/alpha.md',
  '.learnings/LEARNINGS.md',
  '.env',
]

function v1Agent(sb: Sandbox): string {
  const dir = join(sb.home, 'my-agent')
  const r = spawnSync('bash', [join(REPO, 'scripts', 'v1-agent-fixture.sh'), KIT, dir], {
    encoding: 'utf8',
    env: { PATH: sb.bin, HOME: sb.home, GIT_CONFIG_GLOBAL: '/dev/null', PYTHONDONTWRITEBYTECODE: '1' },
  })
  expect(r.status, r.stderr).toBe(0)
  return dir
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const sums = (dir: string) => Object.fromEntries(OWNER.map((f) => [f, sha(join(dir, f))]))

// macOS only: the kit self-test has suites that fail on Linux even for the untouched kit, and the owner's carry runs on a Mac
describe.skipIf(process.platform !== 'darwin')(
  'root install.sh --apply on a kit 1.x folder, with the real gate',
  () => {
    it(
      'the kit self-test passes in the upgraded folder, and the owner files are byte-for-byte as they were',
      () => {
        const sb = sandbox()
        const dir = v1Agent(sb)
        const owner = sums(dir)
        // The harness PATH holds only the tools the installer uses; the kit's suites also call the owner's Mac tools (curl, mkfifo
        // and others), so the system folders follow it. The stubs and the real node, bun and git still come first.
        const PATH = `${sb.bin}:/usr/bin:/bin:/usr/sbin:/sbin`
        // a hung suite must not hang CI: the whole install's process group is killed a minute before the test's own limit
        const r = run(
          sb,
          ['--agent-dir', dir, '--no-app', '--apply', '--yes'],
          { PATH },
          { groupTimeoutMs: t(840_000) },
        )
        expect(r.code, r.out.split('\n').slice(-60).join('\n')).toBe(0)
        expect(r.out).toContain('CHECKS PASSED')
        expect(r.out).not.toContain('GATE FAILED')
        expect(r.out).toContain('== Carried onto this kit')
        expect(sums(dir)).toEqual(owner)
      },
      t(900_000),
    )
  },
)
