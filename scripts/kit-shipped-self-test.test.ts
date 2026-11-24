// The kit's install self-test (kit/scripts/test-install.sh) ships INTO the agent folder and runs there: the 1.x `./install.sh --apply`
// gate runs it from an upgraded folder. Its checks about the repository around the kit ($KIT/../apps/chronos, $KIT/../install.sh)
// have nothing to look at there. This installs an agent folder for real and runs its own copy of the self-test, once through the
// folder and once from the plugin release the folder's scripts/ link leads to. It runs on Linux too (the self-test fakes launchd).
// gate-reads: kit/* scripts/*
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t } from '../packages/testkit/src/time-factor.ts'
import { REPO, refusingPath, run, sandbox } from './root-install-harness.ts'

// What a shipped copy cannot check and says so with a `skip   [shipped kit]` line: the root installer beside the kit (the shared-rule
// check), a move to the repository's apps/chronos (3h) and the default install from it (section 6). The self-test's other skips (a
// case-insensitive disk, a Python 3.10+ it cannot hide) are the same in the repository. A new shipped-form skip must be named here.
const SHIPPED_SKIPS = [3, 1, 1] // the kit 1.x folder; an installed agent folder and the plugin release, which are not a kit to install from

function selfTest(script: string, home: string) {
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      PATH: refusingPath(),
      HOME: home,
      GIT_CONFIG_GLOBAL: '/dev/null',
      PYTHONDONTWRITEBYTECODE: '1',
    },
    timeout: t(600_000),
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const skips = (out: string) => out.split('\n').filter((l) => /^ {2}skip +\[shipped kit\]/.test(l))
const fails = (out: string) => out.split('\n').filter((l) => /^ {2}FAIL /.test(l))

describe('the kit self-test, run where it ships', () => {
  it(
    'passes in a kit 1.x agent folder, an installed agent folder and the plugin release, skipping only the repository checks and saying so',
    () => {
      const sb = sandbox()
      const inst = run(sb, ['--no-app', '--yes'])
      expect(inst.code, inst.out).toBe(0)
      const release = join(sb.home, '.local', 'share', 'talos', 'kit', 'current', 'talos-kit')
      // the 1.x form (what the root installer's --apply gate runs in): scripts/ is a real folder, test doubles included
      const v1 = join(sb.home, 'my-agent')
      const made = spawnSync(
        'sh',
        [
          '-c',
          'mkdir -p "$2" && cd "$1" && tar --exclude=./.git -cf - . | (cd "$2" && tar -xf -)',
          'copy',
          join(REPO, 'kit'),
          v1,
        ],
        { encoding: 'utf8' },
      )
      expect(made.status, made.stderr).toBe(0)
      const forms = [
        join(v1, 'scripts', 'test-install.sh'),
        join(sb.agent, 'scripts', 'test-install.sh'),
        join(release, 'scripts', 'test-install.sh'),
      ]
      for (const [i, script] of forms.entries()) {
        const r = selfTest(script, sb.home)
        expect(fails(r.out).join('\n'), r.out.split('\n').slice(-40).join('\n')).toBe('')
        expect(r.code, r.out.split('\n').slice(-40).join('\n')).toBe(0)
        expect(skips(r.out).length, skips(r.out).join('\n')).toBe(SHIPPED_SKIPS[i])
        for (const s of skips(r.out)) expect(s).toMatch(/\(.+\)/) // every skip names its reason
      }
    },
    t(1_300_000),
  )
})
