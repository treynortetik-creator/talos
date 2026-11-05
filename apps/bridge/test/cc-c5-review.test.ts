// Review of WP-C5 (PR #37). Each test here FAILS on feat/cc-c5 and names a real hole. Same fake `codex` as
// cc-c5-codex.test.ts, replaying the REAL codex-cli 0.147.0 sample (codex-exec-ok.jsonl). No test calls the real codex.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCli } from '../src/cli.ts'
import { type Harness, startHarness } from './helpers.ts'

const FIX = resolve(import.meta.dir, 'fixtures')
const SKILL = resolve(import.meta.dir, '../../../plugins/talos-app-mod/skills/codex-delegate/SKILL.md')
const FAKE = `#!/bin/bash
log="\${FAKE_ARGV_LOG:-/dev/null}"
if [ "$1" = "--version" ]; then echo "codex-cli 0.147.0"; exit 0; fi
if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi
printf '%s\\n' "$@" >> "$log"
dir=""; outf=""
while [ $# -gt 0 ]; do case "$1" in -C) dir="$2"; shift;; -o) outf="$2"; shift;; --) shift; break;; esac; shift; done
[ -n "$FAKE_WRITE" ] && echo data > "$dir/$FAKE_WRITE"
[ -n "$FAKE_LAST" ] && printf '%s' "$FAKE_LAST" > "$outf"
cat "$FAKE_FIXTURE"
exit 0
`
const KEYS = ['PATH', 'CODEX_HOME', 'FAKE_FIXTURE', 'FAKE_ARGV_LOG', 'FAKE_LAST', 'FAKE_WRITE']
let saved: Record<string, string | undefined>
let root: string
let h: Harness | undefined
const set = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  root = mkdtempSync(join(tmpdir(), 'cc-c5-review-'))
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'codex'), FAKE)
  chmodSync(join(root, 'bin', 'codex'), 0o755)
  set('PATH', `${join(root, 'bin')}:${process.env.PATH}`)
  set('CODEX_HOME', join(root, 'codex-home'))
  set('FAKE_ARGV_LOG', join(root, 'argv.log'))
  set('FAKE_LAST', undefined)
  set('FAKE_WRITE', undefined)
  set('FAKE_FIXTURE', join(FIX, 'codex-exec-ok.jsonl'))
})
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) set(k, v)
  await h?.stop()
  h = undefined
})
const env = (hh: Harness) => ({ TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl })
const io = () => ({
  out() {},
  err() {},
  prompt: async () => '',
  sleep: async () => {},
  now: () => Date.now(),
})

describe('CC-C5 review', () => {
  // R1: the CLI runs a headless bridge, and set_status in headless mode returns "status ignored". Every progress label
  // the wrapper sends is dropped, so the thread never shows Codex working. The unit tests miss it (they spy on call()).
  test('R1: progress from `talos-app codex run` reaches the thread (silent message; headless drops status)', async () => {
    h = await startHarness({ startBridge: false })
    expect(await runCli(['codex', 'run', '--thread', 'general', '--', 'print the word ok'], io(), env(h))).toBe(0)
    const f = await h.relay.expectFrame('reply', (r) => String(r.message.text).startsWith('Codex: starting'), {
      direction: 'from_bridge',
      timeoutMs: 1500,
    })
    expect(f.silent).toBe(true)
    expect(f.message.thread_id).toBe('general')
  })

  // R2: the reply tool caps text at 32,000 characters. A long Codex answer is posted uncapped, the reply is refused,
  // runCodex throws, and neither the owner (thread) nor the agent (summary JSON) gets anything back.
  test('R2: a Codex answer over 32k characters still lands in the thread', async () => {
    h = await startHarness({ startBridge: false })
    set('FAKE_LAST', `long answer ${'x'.repeat(40_000)}`)
    expect(await runCli(['codex', 'run', '--thread', 'general', '--', 'review this repo'], io(), env(h))).toBe(0)
    await h.relay.expectFrame('reply', (r) => String(r.message.text).startsWith('Codex: long answer'), {
      direction: 'from_bridge',
      timeoutMs: 1500,
    })
  })

  // R3: produced files go straight into reply.files. The media layer refuses any .env / .env.* file and the whole reply
  // fails with it. A routine scaffold task that writes .env.example loses its entire result.
  test('R3: a produced .env.example does not sink the whole result', async () => {
    h = await startHarness({ startBridge: false })
    const dir = mkdtempSync(join(root, 'repo-'))
    Bun.spawnSync(['git', '-C', dir, 'init', '-q'])
    set('FAKE_WRITE', '.env.example')
    const code = await runCli(
      ['codex', 'run', '--thread', 'general', '--dir', dir, '--sandbox', 'workspace-write', '--', 'scaffold an app'],
      io(),
      env(h),
    )
    expect(code).toBe(0)
    await h.relay.expectFrame('reply', (r) => String(r.message.text).startsWith('Codex: ok'), {
      direction: 'from_bridge',
      timeoutMs: 1500,
    })
  })

  // R4: the skill's own template is `-- "<prompt>"` and its image advice is "Use $imagegen to draw ...". Typed into a
  // shell, double quotes expand `$imagegen` to nothing (and `$(...)` / backticks in a thread message would execute).
  // Run the documented form through bash and check the prompt Codex receives.
  test('R4: the skill-documented command form passes $imagegen through to codex intact', () => {
    const skill = readFileSync(SKILL, 'utf8')
    const template = /talos-app codex run --thread <thread_id>.*-- (.)<prompt>\1/.exec(skill)
    expect(template).not.toBeNull()
    const q = template?.[1] as string
    const imagePrompt = /\((['"])(Use \$imagegen to draw)/.exec(skill)?.[2] as string
    const cmd = `printf '%s' ${q}${imagePrompt} a cat${q}`
    const out = Bun.spawnSync(['bash', '-c', cmd], { env: { PATH: process.env.PATH ?? '' } }).stdout.toString()
    expect(out).toContain('$imagegen')
  })
})
