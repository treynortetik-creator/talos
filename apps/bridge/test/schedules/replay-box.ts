// A stand-in for the `chronos` binary that PRINTS RECORDED ANSWERS: the real `chronos api` output captured in
// packages/testkit/fixtures/chronos-0.4/ (and chronos-0.3/). It is a replay, not a model: it knows no state, so a test that
// needs Chronos to decide something (a claim race, a window) uses the real CLI instead. What it is good for is the bridge's
// handling of answers Chronos 0.4 really prints. It refuses what the real CLI refuses at the door: an unknown verb is the
// real error shape and exit 1. Every call (verb, args, stdin) is logged for the test to read back.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChronosBox } from './chronos-box.ts'

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'testkit', 'fixtures')

// biome-ignore lint/suspicious/noExplicitAny: fixtures are free-form recorded JSON that tests index into
export const fixture = <T = Record<string, any>>(set: 'chronos-0.3' | 'chronos-0.4', name: string): T =>
  JSON.parse(readFileSync(join(FIX, set, `${name}.json`), 'utf8')) as T

export class ReplayBox extends ChronosBox {
  readonly answers: string
  constructor(now: string) {
    super(now)
    this.answers = join(this.dir, 'answers')
    mkdirSync(this.answers, { recursive: true })
    writeFileSync(
      this.bin,
      `#!/bin/sh
d='${this.answers}'
[ "$1" = api ] || { echo "replay: only 'api' is answered" >&2; exit 2; }
shift
verb="$1"
body=$(cat)
printf '%s\\t%s\\n' "$*" "$body" >> "$d/calls.log"
if [ -f "$d/$verb.json" ]; then cat "$d/$verb.json"; exit 0; fi
printf '%s' '{"error":{"code":"unknown_verb","message":"replay has no answer for this verb","fields":[]}}'
exit 1
`,
    )
    chmodSync(this.bin, 0o755)
  }

  /** The next answer for a verb (`snapshot`, `due`, `claim`, `session-prompt`, ...): a value, or a fixture. */
  answer(verb: string, value: unknown) {
    writeFileSync(join(this.answers, `${verb}.json`), typeof value === 'string' ? value : JSON.stringify(value))
  }
  /** Every call so far: `{args: 'claim check-in', stdin: '{...}'}`. */
  calls(): Array<{ args: string; stdin: string }> {
    const f = join(this.answers, 'calls.log')
    if (!existsSync(f)) return []
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [args = '', ...rest] = l.split('\t')
        return { args, stdin: rest.join('\t') }
      })
  }
  callsOf(verb: string) {
    return this.calls().filter((c) => c.args.split(' ')[0] === verb)
  }

  /** A box that answers like Chronos 0.4 on Monday 2026-10-05 09:50: the session job set, healthy, nothing due. */
  static times(now = '2026-10-05T13:50:00Z'): ReplayBox {
    const b = new ReplayBox(now)
    b.answer('version', fixture('chronos-0.4', 'version'))
    b.answer('snapshot', fixture('chronos-0.4', 'snapshot-times-slot-waiting'))
    b.answer('health', fixture('chronos-0.3', 'health'))
    b.answer('due', { due: [], beat: '2026-10-05T09:50:00-04:00' })
    b.answer('orphans', { orphans: [] })
    return b
  }
}
