// `talos-app supervise` deciding whether this start's launch is root-approved (cli.ts launchIsApproved): supervisor.json as
// written, read again and still the settings the start used, against the approval file (launch-approval.ts). "root" here is the
// test's own uid; launch-approval.test.ts holds the real-root case.
import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSupervisorConfig, SUPERVISOR_FILES } from '../../src/supervisor/cli.ts'
import {
  approvableLaunch,
  launchIsApproved as approvedAt,
  isTalosFolder,
  launchFingerprint,
  launchParts,
} from '../../src/supervisor/launch-approval.ts'

const launchIsApproved = (
  home: string,
  userHome: string,
  ...rest: [Parameters<typeof approvedAt>[2], string, number]
) =>
  // the paths here are not on this machine: each is its own real path (the link case below uses the real one)
  approvedAt(
    join(home, SUPERVISOR_FILES.config),
    () => readSupervisorConfig(home, userHome),
    ...rest,
    (p) => p,
  )

const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-approved-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const ME = process.getuid?.() ?? 0
const ARGS = ['--plugin-dir', '/opt/talos/mod', '--dangerously-load-development-channels', 'server:talos-app']

function install(written: Record<string, unknown>, approve: Record<string, unknown> = written) {
  const home = tmp()
  writeFileSync(join(home, SUPERVISOR_FILES.config), JSON.stringify(written))
  const etc = join(tmp(), 'etc-talos')
  mkdirSync(etc)
  chmodSync(etc, 0o755)
  const l = {
    agentDir: approve.agent_dir as string,
    claudePath: (approve.claude_path as string | undefined) ?? null,
    args: (approve.args as string[] | undefined) ?? [],
    env: (approve.env as Record<string, string> | undefined) ?? {},
  }
  writeFileSync(
    join(etc, 'launch-approved'),
    JSON.stringify({ v: 1, fingerprint: launchFingerprint(l), parts: launchParts(l) }),
  )
  chmodSync(join(etc, 'launch-approved'), 0o644)
  const cfg = readSupervisorConfig(home, '/home/talos')
  if ('error' in cfg) throw new Error(cfg.error)
  return { home, cfg, file: join(etc, 'launch-approved') }
}
const WRITTEN = { agent_dir: '/home/talos/talos-agent', claude_path: '/home/talos/.local/bin/claude', args: ARGS }

describe('launchIsApproved', () => {
  it('the launch root approved, as written: approved', () => {
    const x = install(WRITTEN)
    expect(launchIsApproved(x.home, '/home/talos', x.cfg, x.file, ME)).toEqual({ ok: true })
  })
  it('a file swapped between reads: the approved bytes never pair with the flags or env the start launched (Fable)', () => {
    const x = install(WRITTEN)
    // the start (and the second read) saw a supervisor.json with the same folder and program but its own flags or env;
    // the read this check hashes saw the approved one
    for (const evil of [
      { ...x.cfg, args: [...x.cfg.args, '--settings=/home/talos/x.json'] },
      { ...x.cfg, env: { LD_PRELOAD: '/x.so' } },
    ])
      expect(
        approvedAt(
          join(x.home, SUPERVISOR_FILES.config),
          () => evil,
          evil,
          x.file,
          ME,
          (p) => p,
        ),
        JSON.stringify(evil.args),
      ).toEqual({ ok: false, why: 'the launch is not supervisor.json as written' })
  })
  it('a flag added after the approval: not approved', () => {
    const x = install({ ...WRITTEN, args: [...ARGS, '--verbose'] }, WRITTEN)
    expect(launchIsApproved(x.home, '/home/talos', x.cfg, x.file, ME)).toMatchObject({ ok: false })
  })
  it('supervisor.json changed between the start and the check: not approved', () => {
    const x = install(WRITTEN)
    writeFileSync(join(x.home, SUPERVISOR_FILES.config), JSON.stringify({ ...WRITTEN, env: { LD_PRELOAD: '/x' } }))
    expect(launchIsApproved(x.home, '/home/talos', x.cfg, x.file, ME)).toEqual({
      ok: false,
      why: 'supervisor.json changed since the start read it',
    })
  })
  it('no claude_path, a relative or ~ one, or no args written: never approved (the program or flags would be guessed)', () => {
    for (const w of [
      { agent_dir: WRITTEN.agent_dir, args: ARGS },
      { ...WRITTEN, claude_path: 'claude' },
      { ...WRITTEN, claude_path: '~/.local/bin/claude' },
      { agent_dir: WRITTEN.agent_dir, claude_path: WRITTEN.claude_path },
    ]) {
      const x = install(w)
      expect(launchIsApproved(x.home, '/home/talos', x.cfg, x.file, ME), JSON.stringify(w)).toMatchObject({ ok: false })
    }
  })
  it('the approval file owned by someone else: not approved', () => {
    const x = install(WRITTEN)
    expect(launchIsApproved(x.home, '/home/talos', x.cfg, x.file, ME + 1)).toMatchObject({ ok: false })
  })
})

describe('isTalosFolder', () => {
  it('a plain .talos-version file, never a link or a folder', () => {
    const a = tmp()
    expect(isTalosFolder(a)).toBe(false)
    writeFileSync(join(a, '.talos-version'), '1\n')
    expect(isTalosFolder(a)).toBe(true)
    const b = tmp()
    symlinkSync(join(a, '.talos-version'), join(b, '.talos-version'))
    expect(isTalosFolder(b)).toBe(false)
    const c = tmp()
    mkdirSync(join(c, '.talos-version'))
    expect(isTalosFolder(c)).toBe(false)
  })
})

describe('approvableLaunch: the strict schema (no defaults on either side)', () => {
  const ok = { agent_dir: '/a', claude_path: '/c', args: [] }
  const id = (p: string) => p
  it('as written, env absent is {}', () => {
    expect(approvableLaunch(ok, id)).toEqual({ agentDir: '/a', claudePath: '/c', args: [], env: {} })
  })
  it('a missing args, an env that is not an object of strings, a ~ or relative path: not approvable', () => {
    for (const bad of [
      { agent_dir: '/a', claude_path: '/c' },
      { ...ok, args: 'x' },
      { ...ok, args: [1] },
      { ...ok, env: false },
      { ...ok, env: 0 },
      { ...ok, env: '' },
      { ...ok, env: [] },
      { ...ok, env: null },
      { ...ok, env: { A: 1 } },
      { ...ok, agent_dir: '~/agent' },
      { ...ok, claude_path: 'claude' },
      { ...ok, claude_path: '~/.local/bin/claude' },
      { ...ok, session: { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\n' } },
      {
        ...ok,
        session: {
          id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
          previous_ids: ['bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb\n'],
        },
      },
      null,
      [],
    ])
      expect(approvableLaunch(bad, id), JSON.stringify(bad)).toHaveProperty('refused')
  })
  it('claude_path through a link, or not there: not approvable (the real one is)', () => {
    const d = tmp()
    writeFileSync(join(d, 'claude'), '')
    symlinkSync(join(d, 'claude'), join(d, 'link'))
    expect(approvableLaunch({ ...ok, claude_path: join(d, 'claude') })).not.toHaveProperty('refused')
    expect(approvableLaunch({ ...ok, claude_path: join(d, 'link') })).toHaveProperty('refused')
    expect(approvableLaunch({ ...ok, claude_path: join(d, 'gone') })).toHaveProperty('refused')
  })
})
