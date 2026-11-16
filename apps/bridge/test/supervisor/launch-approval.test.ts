// The launch the owner approved (supervisor/launch-approval.ts): the fingerprint both this supervisor and the Windows tray's root
// side compute (held to the shared vectors in packages/protocol/fixtures/launch-fingerprint.json), and the root-owned file that
// is its only seal. The ownership checks run against the test's own uid as "root", plus a real one where the test is not root.
import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  approvableLaunch,
  type LaunchInputs,
  launchApproved,
  launchFingerprint,
  launchParts,
  readApproved,
} from '../../src/supervisor/launch-approval.ts'

const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-approve-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const ME = process.getuid?.() ?? 0
const inputsOf = (s: { agent_dir: string; claude_path: string; args?: string[]; env?: Record<string, string> }) =>
  ({ agentDir: s.agent_dir, claudePath: s.claude_path, args: s.args ?? [], env: s.env ?? {} }) satisfies LaunchInputs
const WSL: LaunchInputs = {
  agentDir: '/home/talos/talos-agent',
  claudePath: '/home/talos/.local/bin/claude',
  args: [
    '--plugin-dir',
    '/home/talos/talos-app/plugins/talos-app-mod',
    '--dangerously-load-development-channels',
    'server:talos-app',
  ],
  env: {},
}

describe('the fingerprint: the shared vectors (the tray’s root side is held to the same file)', () => {
  const vectors = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../../packages/protocol/fixtures/launch-fingerprint.json'), 'utf8'),
  ) as {
    cases: Array<{
      name: string
      supervisor: Parameters<typeof inputsOf>[0]
      fingerprint?: string
      parts?: Record<string, string>
      approvable: boolean
    }>
  }
  it('every case, its fingerprint and its parts', () => {
    expect(vectors.cases.filter((c) => c.fingerprint).length).toBeGreaterThanOrEqual(5)
    for (const c of vectors.cases) {
      if (!c.fingerprint) continue
      expect(launchFingerprint(inputsOf(c.supervisor)), c.name).toBe(c.fingerprint)
      expect(launchParts(inputsOf(c.supervisor)), c.name).toEqual(c.parts as never)
    }
  })
  it('every case, approvable or not under the strict schema (each path its own real path here)', () => {
    expect(vectors.cases.filter((c) => !c.approvable).length).toBeGreaterThanOrEqual(7)
    for (const c of vectors.cases)
      expect('refused' in approvableLaunch(c.supervisor, (p) => p), c.name).toBe(!c.approvable)
  })
  it('no claude_path: no fingerprint, so no launch is ever approved', () => {
    expect(launchFingerprint({ ...WSL, claudePath: null })).toBeNull()
    expect(launchApproved({ ...WSL, claudePath: null }, { fingerprint: 'a'.repeat(64), parts: {} })).toEqual({
      ok: false,
      why: 'supervisor.json names no claude_path',
    })
  })
})

describe('the approval file: root’s, and nobody else’s', () => {
  const approve = (dir: string, l: LaunchInputs) => {
    writeFileSync(
      join(dir, 'launch-approved'),
      JSON.stringify({ v: 1, fingerprint: launchFingerprint(l), parts: launchParts(l) }),
    )
    chmodSync(join(dir, 'launch-approved'), 0o644)
    return join(dir, 'launch-approved')
  }
  const folder = () => {
    const d = join(tmp(), 'etc-talos')
    mkdirSync(d, { mode: 0o755 })
    chmodSync(d, 0o755)
    return d
  }
  it('the approved launch is approved; a changed flag, env value or folder is not, naming the piece', () => {
    const path = approve(folder(), WSL)
    const a = readApproved(path, ME)
    expect(launchApproved(WSL, a)).toEqual({ ok: true })
    expect(launchApproved({ ...WSL, args: [...WSL.args, '--verbose'] }, a)).toEqual({
      ok: false,
      why: 'the launch changed since it was approved (flags)',
    })
    expect(launchApproved({ ...WSL, env: { LD_PRELOAD: '/x' } }, a)).toMatchObject({
      why: expect.stringContaining('(env)'),
    })
    expect(launchApproved({ ...WSL, agentDir: '/elsewhere' }, a)).toMatchObject({
      why: expect.stringContaining('(folder)'),
    })
  })
  it('no file, a link, a file or folder others can write, the wrong owner, too big, not JSON: never trusted', () => {
    const none = folder()
    expect(readApproved(join(none, 'launch-approved'), ME)).toEqual({ refused: 'no launch has been approved' })
    const link = folder()
    const real = approve(folder(), WSL)
    symlinkSync(real, join(link, 'launch-approved'))
    expect(readApproved(join(link, 'launch-approved'), ME)).toMatchObject({
      refused: expect.stringContaining('cannot be opened'),
    })
    const loose = folder()
    const p = approve(loose, WSL)
    chmodSync(p, 0o666)
    expect(readApproved(p, ME)).toMatchObject({
      refused: expect.stringContaining('can be written by someone other than root'),
    })
    const looseDir = folder()
    const q = approve(looseDir, WSL)
    chmodSync(looseDir, 0o777)
    expect(readApproved(q, ME)).toMatchObject({
      refused: expect.stringContaining('can be written by someone other than root'),
    })
    // the owner must be root (here: a uid that is not this test's)
    expect(readApproved(approve(folder(), WSL), ME + 1)).toMatchObject({
      refused: expect.stringContaining('someone other than root'),
    })
    const big = folder()
    writeFileSync(join(big, 'launch-approved'), 'x'.repeat(5000))
    expect(readApproved(join(big, 'launch-approved'), ME)).toMatchObject({
      refused: expect.stringContaining('larger than 4 KB'),
    })
    const empty = folder()
    writeFileSync(join(empty, 'launch-approved'), '')
    chmodSync(join(empty, 'launch-approved'), 0o644)
    expect(readApproved(join(empty, 'launch-approved'), ME)).toHaveProperty('refused')
    const junk = folder()
    writeFileSync(join(junk, 'launch-approved'), '{"v":1,"fingerprint":"nothex"}')
    expect(readApproved(join(junk, 'launch-approved'), ME)).toMatchObject({
      refused: expect.stringContaining('not an approval'),
    })
  })
  it.skipIf(ME === 0)('as the real check runs it: a file this user owns is not root’s, so it is never trusted', () => {
    // the test's own files are owned by this (non-root) user: with root = 0 they can never pass
    expect(readApproved(approve(folder(), WSL))).toMatchObject({
      refused: expect.stringContaining('someone other than root'),
    })
  })
})
