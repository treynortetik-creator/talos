// A lead (a thread's own session) must not run the owner-level mailbox commands from its shell: `digest`, `post` and
// `inbox*` read or write across threads. The supervisor sets TALOS_APP_WORKER_THREAD and TALOS_SESSION_ROLE=worker, and
// a `.talos-lead` marker in the current folder or any parent refuses too, so unsetting the variables does not help.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
// a folder with no marker in it or above it (a fresh temp folder)
function plain() {
  const d = mkdtempSync(join(realpathSync(tmpdir()), 'wc-cwd-'))
  made.push(d)
  return d
}
function run(argv: string[], env: Record<string, string>, cwd = plain()) {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'wc-'))
  made.push(home)
  const err: string[] = []
  const io = {
    out: () => {},
    err: (l: string) => err.push(l),
    prompt: async () => 'n',
    sleep: async () => {},
    now: () => Date.now(),
  }
  return runCli(argv, io, { TALOS_APP_HOME: home, ...env }, { cwd }).then((code) => ({ code, err: err.join('\n') }))
}

describe('digest, post and inbox from a worker thread', () => {
  for (const argv of [['digest'], ['post', 'general', 'hi'], ['inbox'], ['inbox-list']])
    test(`talos-app ${argv[0]} is refused when TALOS_APP_WORKER_THREAD is set`, async () => {
      const r = await run(argv, { TALOS_APP_WORKER_THREAD: 'trip' })
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/thread session|worker/i)
    })
  test('the worker role alone is enough', async () => {
    const r = await run(['digest'], { TALOS_SESSION_ROLE: 'worker' })
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/worker|thread session/i)
  })
  test('the same commands are not refused for that reason in the main session', async () => {
    const r = await run(['digest'], {})
    expect(r.err).not.toMatch(/thread session|worker/i)
  })
  test('other commands still run for a worker', async () => {
    const r = await run(['lead', 'check', '/nonexistent'], { TALOS_APP_WORKER_THREAD: 'trip' })
    expect(r.err).not.toMatch(/thread session/i)
  })

  describe('a .talos-lead marker in the current folder or a parent', () => {
    const lead = (depth: number) => {
      const root = plain()
      writeFileSync(join(root, '.talos-lead'), '{}')
      let cwd = root
      for (let i = 0; i < depth; i++) {
        cwd = join(cwd, `d${i}`)
        mkdirSync(cwd)
      }
      return cwd
    }
    for (const argv of [['digest'], ['post', 'general', 'hi'], ['inbox'], ['inbox-list']])
      for (const depth of [0, 3])
        test(`talos-app ${argv[0]} is refused ${depth ? 'from a subfolder' : 'in the lead folder'} with no env vars set`, async () => {
          const r = await run(argv, {}, lead(depth))
          expect(r.code).toBe(1)
          expect(r.err).toMatch(/lead|thread session/i)
        })
    test('other commands still run there', async () => {
      const r = await run(['lead', 'check', '/nonexistent'], {}, lead(1))
      expect(r.err).not.toMatch(/thread session|lead folder/i)
    })
    test('no marker and no env vars: not refused', async () => {
      for (const argv of [['digest'], ['inbox']]) {
        const r = await run(argv, {})
        expect(r.err).not.toMatch(/thread session|worker|lead folder/i)
      }
    })
  })
})
