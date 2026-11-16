// The update check's report (update-check.ts): its six states, an output of thread ids, states and one count only, its exit
// statuses, and a run that changes nothing in the Talos home. The planner's own part (the instructions digest, specWith) is in
// workers-wiring.test.ts.
import { afterAll, describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkerEntryT } from '@talos-app/protocol'
import type { BridgeEnv } from '../../src/config.ts'
import {
  AGENT_FOLDER_NOTE,
  classifyUpdate,
  cmdUpdateCheck,
  LAUNCH_SETTINGS_UNREADABLE,
  UPDATE_CHECK_HELP,
  UPDATE_CHECK_STATES,
  updateCheckLines,
  updateCheckRows,
} from '../../src/supervisor/update-check.ts'
import { foldsCase } from '../../src/supervisor/worker-policy.ts'
import type { WorkerPlan, WorkerThread } from '../../src/supervisor/worker-types.ts'
import { cleanupReleases, sealedRelease } from './kit-release-fixture.ts'

const H = (c: string) => `sha256:${c.repeat(64)}`
/** A Mac's temp folder folds case, and the planner's fence refuses a start in it (workers-wiring.test.ts onCaseExactTmp). */
const TMP_FOLDS = foldsCase(realpathSync(tmpdir()))
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  cleanupReleases()
})
const tmp = () => {
  const r = mkdtempSync(join(tmpdir(), 'update-check-'))
  roots.push(r)
  return r
}
/** A dry plan whose spec is `spec`, its instructions digest `instructions`, and specWith giving `withWas` for any digest. */
const planOf = (spec: string, instructions?: string, withWas?: string): WorkerPlan => ({
  launch: { session: 't-x', argv: ['claude'], cwd: '/x', env: {} },
  settingsJSON: '{}',
  cwd: '/x',
  specHash: spec,
  ...(instructions ? { instructionsHash: instructions } : {}),
  specWith: () => withWas,
})
const launched = (o: Record<string, string> = {}) =>
  ({ cwd: '/home/alex/trip', model: 'inherit', mcp_allow: [], ...o }) as WorkerEntryT['launched']

describe('classifyUpdate (UpdateCheck.classify, the Mac’s rules)', () => {
  it('each state', () => {
    const rec = launched({ spec_hash: H('a'), instructions_hash: H('1') })
    expect(classifyUpdate(planOf(H('a')), rec, true, false)).toBe('unchanged') // busy or not: nothing to do
    expect(
      classifyUpdate(planOf(H('b')), launched({ spec_hash: H('a'), update_tried_hash: H('b') }), false, false),
    ).toBe(
      'unchanged', // the spec was tried once: the update check never tries it again
    )
    expect(classifyUpdate(planOf(H('b')), launched(), false, false)).toBe('no record')
    expect(classifyUpdate(planOf(H('b')), undefined, false, false)).toBe('no record')
    expect(classifyUpdate(planOf(H('b'), H('2'), H('a')), rec, true, false)).toBe('busy (would wait)')
    expect(classifyUpdate(planOf(H('b'), H('2'), H('a')), rec, false, false)).toBe('instructions changed')
    expect(classifyUpdate(planOf(H('b'), H('2'), H('c')), rec, false, false)).toBe('spec changed') // more than the instructions
    expect(classifyUpdate(planOf(H('b'), H('1'), H('a')), rec, false, false)).toBe('spec changed') // same instructions
    expect(classifyUpdate(planOf(H('b')), rec, false, false)).toBe('spec changed') // no digest now (the agent folder)
    expect(classifyUpdate({ refused: { code: 'start_failed', detail: 'no' } }, rec, false, false)).toBe(
      'unknown (dry plan refused)',
    )
    expect(classifyUpdate(null, rec, false, false)).toBe('unknown (dry plan refused)')
    const noHash = { ...planOf(H('b')), specHash: undefined }
    expect(classifyUpdate(noHash, rec, false, false)).toBe('unknown (dry plan refused)')
  })
  it('started in the agent folder: never "instructions changed" (Pantheon: that folder’s files are not hashed)', () => {
    const rec = launched({ spec_hash: H('a'), instructions_hash: H('1') })
    expect(classifyUpdate(planOf(H('b'), H('2'), H('a')), rec, false, true)).toBe('spec changed')
  })
})

describe('the output: thread ids, states and one count, nothing else', () => {
  it('by id, the count line with every group, and only ids that are thread ids', () => {
    const lines = updateCheckLines([
      { id: 'trip', state: 'spec changed' },
      { id: 'garden', state: 'unchanged' },
      { id: 'b2', state: 'busy (would wait)' },
      { id: 'c3', state: 'instructions changed' },
      { id: 'd4', state: 'no record' },
      { id: 'e5', state: 'unknown (dry plan refused)' },
      { id: '../etc/passwd', state: 'unchanged' },
      { id: 'a b', state: 'unchanged' },
    ])
    expect(lines).toEqual([
      'b2  busy (would wait)',
      'c3  instructions changed',
      'd4  no record',
      'e5  unknown (dry plan refused)',
      'garden  unchanged',
      'trip  spec changed',
      '6 sessions: 1 unchanged, 3 to restart, 1 no record, 1 unknown',
    ])
    expect(updateCheckLines([])).toEqual(['0 sessions: 0 unchanged, 0 to restart, 0 no record, 0 unknown'])
  })
  it('the help names every state and holds Pantheon’s sentence', () => {
    for (const s of UPDATE_CHECK_STATES) expect(UPDATE_CHECK_HELP).toContain(`  ${s}`)
    expect(UPDATE_CHECK_HELP).toContain(`Note: ${AGENT_FOLDER_NOTE}`)
    expect(AGENT_FOLDER_NOTE).toBe(
      "a session started in the agent folder picks up an edit to that folder's instruction files at its next restart; restart it to apply the edit now.",
    )
  })
})

describe('updateCheckRows: which sessions, and what each is given', () => {
  const T = (id: string, cwd = `/home/alex/${id}`): WorkerThread =>
    ({ id, cwd, model: 'inherit', effort: null, parentCwd: null }) as WorkerThread
  const entry = (o: Partial<WorkerEntryT> & Record<string, unknown>) =>
    ({ state: 'live', session_id: '11111111-2222-3333-4444-555555555555', ...o }) as WorkerEntryT
  it('running sessions only; a thread not configured, no environment or a plan that throws is unknown; a turn is busy', () => {
    const asked: Array<{ id: string; dry: boolean | undefined; resume: boolean }> = []
    const rows = updateCheckRows({
      entries: {
        trip: entry({ launched: launched({ spec_hash: H('a') }) }),
        busy: entry({
          state: 'live',
          turn_started_at: '2026-11-14T10:00:00Z',
          launched: launched({ spec_hash: H('a') }),
        }),
        parked: entry({ state: 'parked', launched: launched({ spec_hash: H('a') }) }),
        nosession: entry({ session_id: null }),
        gone: entry({ launched: launched({ spec_hash: H('a') }) }),
        boom: entry({ launched: launched({ spec_hash: H('a') }) }),
      },
      threads: [T('trip'), T('busy'), T('parked'), T('nosession'), T('boom')],
      agentDir: '/home/alex/agent',
      baseEnv: { PATH: '/usr/bin' },
      plan: (p) => {
        asked.push({ id: p.thread.id, dry: p.dry, resume: p.resume })
        if (p.thread.id === 'boom') throw new Error('no')
        return planOf(H('b'))
      },
    })
    expect(Object.fromEntries(rows.map((r) => [r.id, r.state]))).toEqual({
      trip: 'spec changed',
      busy: 'busy (would wait)',
      gone: 'unknown (dry plan refused)',
      boom: 'unknown (dry plan refused)',
    })
    // every plan dry, resuming its conversation
    for (const a of asked) expect(a).toMatchObject({ dry: true, resume: true })
    const none = updateCheckRows({
      entries: { trip: entry({ launched: launched({ spec_hash: H('a') }) }) },
      threads: [T('trip')],
      agentDir: null,
      baseEnv: null,
      plan: () => planOf(H('a')),
    })
    expect(none).toEqual([{ id: 'trip', state: 'unknown (dry plan refused)' }])
  })
  it('a session whose record is in the agent folder is never "instructions changed"', () => {
    const root = tmp()
    const agentDir = join(root, 'agent')
    mkdirSync(agentDir)
    const rec = launched({ spec_hash: H('a'), instructions_hash: H('1') }) as Record<string, unknown>
    const rows = updateCheckRows({
      entries: {
        inagent: entry({ launched: { ...rec, cwd: agentDir } as WorkerEntryT['launched'] }),
        outside: entry({ launched: rec as WorkerEntryT['launched'] }),
      },
      threads: [T('inagent', agentDir), T('outside')],
      agentDir,
      baseEnv: {},
      plan: () => planOf(H('b'), H('2'), H('a')),
    })
    expect(Object.fromEntries(rows.map((r) => [r.id, r.state]))).toEqual({
      inagent: 'spec changed',
      outside: 'instructions changed',
    })
  })
})

describe('talos-app update-check: exit statuses, and a run that changes nothing', () => {
  const io = () => {
    const out: string[] = []
    const err: string[] = []
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } }
  }
  /** Every path under `root` with its size and mtime: what a run must leave as it was. */
  const tree = (root: string): string[] => {
    const out: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d).sort()) {
        const p = join(d, n)
        const st = statSync(p)
        out.push(`${p} ${st.size} ${st.mtimeMs} ${st.mode}`)
        if (st.isDirectory()) walk(p)
      }
    }
    walk(root)
    return out
  }
  it('--help: 0; an argument it does not know: 2, never echoed; no saved sessions: 1', () => {
    const home = tmp()
    const env = { home } as BridgeEnv
    const h = io()
    expect(cmdUpdateCheck(env, ['--help'], h.io)).toBe(0)
    expect(h.out).toEqual([UPDATE_CHECK_HELP])
    const u = io()
    expect(cmdUpdateCheck(env, ['--secret-path=/etc/shadow'], u.io)).toBe(2)
    expect(u.err.join('\n')).not.toContain('shadow')
    const n = io()
    expect(cmdUpdateCheck(env, ['--dry'], n.io)).toBe(1)
    writeFileSync(join(home, 'workers.json'), 'not json')
    expect(cmdUpdateCheck(env, [], n.io)).toBe(1)
    expect(n.out).toEqual([])
  })
  it('a run writes nothing, audits nothing, and prints only ids, states and the count', () => {
    const home = tmp()
    writeFileSync(
      join(home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: '2026-11-14T10:00:00Z' },
        workers_supported: true,
        threads: {
          trip: {
            state: 'live',
            session_id: '11111111-2222-3333-4444-555555555555',
            tmux: 't-trip',
            cwd: '/home/alex/trip',
            launched: { cwd: '/home/alex/trip', mcp_allow: [], spec_hash: H('a') },
          },
        },
      }),
    )
    const before = tree(home)
    const r = io()
    expect(cmdUpdateCheck({ home } as BridgeEnv, ['--dry'], r.io)).toBe(0)
    // no supervisor.json here: no plan can be made, so the running session is unknown (and no login shell is read), said once
    expect(r.out).toEqual([
      'trip  unknown (dry plan refused)',
      '1 sessions: 0 unchanged, 0 to restart, 0 no record, 1 unknown',
    ])
    expect(r.err).toEqual([LAUNCH_SETTINGS_UNREADABLE])
    expect(tree(home)).toEqual(before)
  })
  // on a case-folding temp folder (a Mac's) the planner's fence refuses every start, so the row is unknown there; the home must
  // still be as it was, so the test runs everywhere and says which (Delphi's Mac gate)
  it('a full dry plan through the real planner: the row is said, and the home (thread folders included) is as it was', () => {
    const root = tmp()
    const userHome = join(root, 'home')
    const home = join(userHome, '.talos')
    const agentDir = join(userHome, 'agent')
    const trip = join(userHome, 'trip')
    for (const d of [home, agentDir, trip, join(userHome, '.claude')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(trip, 'CLAUDE.md'), 'the thread folder’s own instructions\n')
    writeFileSync(join(home, 'supervisor.json'), JSON.stringify({ agent_dir: agentDir, claude_path: '/usr/bin/env' }))
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        default_thread: 'general',
        dedicated: { enabled: true },
        threads: [
          { id: 'general', kind: 'fixed' },
          { id: 'trip', name: 'Trip', kind: 'user', session: 'dedicated', session_opts: { cwd: trip } },
        ],
      }),
    )
    writeFileSync(
      join(home, 'workers.json'),
      JSON.stringify({
        v: 1,
        supervisor: { pid: 1, heartbeat_at: '2026-11-14T10:00:00Z' },
        workers_supported: true,
        threads: {
          trip: {
            state: 'live',
            session_id: '11111111-2222-3333-4444-555555555555',
            tmux: 't-trip',
            cwd: trip,
            launched: { cwd: trip, mcp_allow: [], spec_hash: H('a') },
          },
        },
      }),
    )
    const before = tree(userHome)
    const was = process.env.TALOS_VENDOR_DIR
    // TALOS_VENDOR_DIR names the folder that holds `kit` (worker-hook.ts kitVendor): the sealed fixture linked in as that
    const vendorDir = join(root, 'vendor')
    mkdirSync(vendorDir)
    symlinkSync(sealedRelease(), join(vendorDir, 'kit'))
    process.env.TALOS_VENDOR_DIR = vendorDir
    const r = io()
    try {
      const code = cmdUpdateCheck({ home } as BridgeEnv, ['--dry'], r.io, {
        userHome,
        loginEnv: () => ({ PATH: '/usr/bin:/bin', HOME: userHome }),
      })
      expect(code).toBe(0)
    } finally {
      if (was === undefined) delete process.env.TALOS_VENDOR_DIR
      else process.env.TALOS_VENDOR_DIR = was
    }
    expect(r.err).toEqual([])
    if (TMP_FOLDS)
      // the fence refused this temp folder: no spec, and still nothing written
      expect(r.out).toEqual([
        'trip  unknown (dry plan refused)',
        '1 sessions: 0 unchanged, 0 to restart, 0 no record, 1 unknown',
      ])
    // a spec was worked out (not unknown): the planner ran the whole way, and it differs from the one recorded
    else expect(r.out).toEqual(['trip  spec changed', '1 sessions: 0 unchanged, 1 to restart, 0 no record, 0 unknown'])
    expect(tree(userHome)).toEqual(before)
  })
})
