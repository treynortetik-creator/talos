// Option C vs an OLDER web build, using the real protocol parser of the last commit before Option C landed (git archive
// into a temp folder), not a simulation. Pinned: origin/main knows these frames now, so it can't play the older app. Skips
// when there is no git or the commit isn't here (a source tarball, a shallow clone). docs/OPTION-C.md "Compatibility".
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BEFORE_OPTION_C = 'bf3dc57'
const here = join(import.meta.dirname, '..')
function oldProtocolDir(): string | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'oc-compat-'))
    const tar = execFileSync(
      'git',
      ['-C', join(here, '..', '..'), 'archive', BEFORE_OPTION_C, 'packages/protocol', 'tsconfig.base.json'],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      },
    )
    execFileSync('tar', ['-x', '-C', dir], { input: tar })
    symlinkSync(join(here, 'node_modules'), join(dir, 'packages', 'protocol', 'node_modules'))
    return join(dir, 'packages', 'protocol')
  } catch {
    return undefined
  }
}
const oldDir = oldProtocolDir()
const fx = (n: string) => JSON.parse(readFileSync(join(here, 'fixtures', 'frames', `${n}.json`), 'utf8'))
const at = '2026-10-30T00:00:00.000Z'

describe.skipIf(!oldDir)(
  'Option C frames and config against the parser from before Option C (an older app)',
  async () => {
    const old = oldDir ? await import(join(oldDir, 'src', 'index.ts')) : undefined
    it('a ready with workers_status and thread_session_states still parses; the new keys are dropped', () => {
      const ready = {
        ...fx('ready'),
        workers_status: fx('workers.status').status,
        thread_session_states: [
          { thread_id: 'trip', state: { session_id: 'w1', source: 'mod', scope: { thread_id: 'trip' }, at } },
        ],
      }
      const p = old.parseFrame(ready, { direction: 'relay_to_app' })
      expect(p.ok).toBe(true)
      expect('workers_status' in p.frame || 'thread_session_states' in p.frame).toBe(false)
    })
    it('a config.sync with a dedicated thread and the master switch still parses', () => {
      const cfg = fx('ready').agent_config
      const thread = {
        id: 'trip',
        name: 'Trip',
        kind: 'fixed',
        order: 3,
        notify: 'all',
        voice_context: 'recent',
        archived: false,
        created_at: at,
        session: 'dedicated',
        session_opts: { cwd: '/Users/example/p', model: 'inherit', idle_park_min: 30, worktree: true },
      }
      const config = { ...cfg, dedicated: { enabled: true, max_live: 3 }, threads: [...cfg.threads, thread] }
      expect(old.parseFrame({ ...fx('config.sync'), config, rev: config.rev }, { direction: 'relay_to_app' }).ok).toBe(
        true,
      )
    })
    it('the new frame types are an ordinary bad_frame to it, never a throw; main session.state still parses', () => {
      expect(old.parseFrame(fx('workers.status')).ok).toBe(false)
      expect(old.parseFrame(fx('thread.session.control')).ok).toBe(false)
      const state = { session_id: 'm1', source: 'mod', capabilities: [], rate_limits: [], surfaces: [], at }
      expect(old.parseFrame({ ...fx('session.state'), state }, { direction: 'relay_to_app' }).ok).toBe(true)
    })
  },
)
