// A kit test script that runs under `set -o pipefail` must not feed a reader that quits early (`grep -q`, `head`) from `printf`/`echo`.
// The reader exits at its first match; `printf` builtin writes a long string in several chunks, so when the reader is quick
// the next chunk meets a closed pipe: bash prints "printf: write error: Broken pipe", the writer fails, and pipefail turns that
// into a failed check on a correct install. Whether it happens is a matter of who is scheduled first, so it shows up on a busy
// machine (CI runs many suites at once) and almost never on a quiet one. A here-string (`<<<"$out" grep -q ...`) has no pipe.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './size-report.ts'

const KIT_SCRIPTS = join(ROOT, 'kit/scripts')

/** `printf '%s' "..." |` or `echo "..." |` straight into a reader that stops early. */
const EARLY_READER = /(?:printf\s+'%s(?:\\n)?'|echo)\s+"(?:[^"\\]|\\.)*"\s*\|\s*(?:head\b|grep\s+-\w*q)/g

/** `file:line` of every such pipe in a script that sets pipefail. */
function pipefailHazards(name: string, text: string): string[] {
  if (!/pipefail/.test(text)) return []
  const hits: string[] = []
  text.split('\n').forEach((line, i) => {
    if (/^\s*#/.test(line)) return
    for (const _m of line.matchAll(EARLY_READER)) hits.push(`${name}:${i + 1}`)
  })
  return hits
}

describe('kit test scripts under pipefail', () => {
  it('flags the hazard and leaves the safe forms alone', () => {
    const bad = `set -uo pipefail\nprintf '%s' "$out" | grep -q 'x'\necho "$out" | head -1 | grep -q y\n`
    expect(pipefailHazards('t.sh', bad)).toEqual(['t.sh:2', 't.sh:3'])
    const safe = `set -uo pipefail\n<<<"$out" grep -q 'x'\nprintf '%s' "$out" | grep -c x\n# printf '%s' "$out" | grep -q x\n`
    expect(pipefailHazards('t.sh', safe)).toEqual([])
    expect(pipefailHazards('t.sh', `printf '%s' "$out" | grep -q 'x'\n`)).toEqual([])
  })

  it('a printf pipe into a reader that has already quit fails under pipefail; a here-string does not', () => {
    // `exit 0` stands for a grep -q that matched and left before printf wrote its next chunk: the losing side of the race, made certain.
    const run = (body: string) =>
      spawnSync('bash', ['-c', `set -uo pipefail; out="$(head -c 200000 /dev/zero | tr '\\0' x)"; ${body}`], {
        encoding: 'utf8',
      })
    const piped = run(`printf '%s' "$out" | { exit 0; }`)
    expect(piped.status, piped.stderr).not.toBe(0)
    const here = run(`{ exit 0; } <<<"$out"`)
    expect(here.status, here.stderr).toBe(0)
  })

  it('test-bsd-sed-guard.sh does not depend on the hook reading its input before it exits', () => {
    // The kill-switch check pipes a payload into a hook that exits at import, before it reads stdin. When the writer is slower than
    // the hook, the writer gets EPIPE and pipefail reports the hook as failed. Delaying every `python3 -c` writer makes the hook always win.
    const dir = mkdtempSync(join(tmpdir(), 'slow-writer-'))
    try {
      const real = execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim()
      writeFileSync(join(dir, 'python3'), `#!/bin/bash\n[ "\${1:-}" = -c ] && sleep 0.3\nexec ${real} "$@"\n`, {
        mode: 0o755,
      })
      const r = spawnSync('bash', [join(KIT_SCRIPTS, 'test-bsd-sed-guard.sh')], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      })
      expect(r.stdout + r.stderr).not.toMatch(/^ +FAIL /m)
      expect(r.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('no test script feeds grep -q or head from printf/echo while pipefail is on', () => {
    const hazards = readdirSync(KIT_SCRIPTS)
      .filter((f) => /^test-.*\.sh$/.test(f))
      .flatMap((f) => pipefailHazards(f, readFileSync(join(KIT_SCRIPTS, f), 'utf8')))
    expect(hazards.length, `${hazards.length} sites, e.g. ${hazards.slice(0, 8).join(' ')}`).toBe(0)
  })
})
