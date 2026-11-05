/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// Re-check of PR #44 after the review fixes (a1a62ee): fresh bypass attempts against open-then-verify. Real bridge (live,
// in process) + FakeRelay + FakeApp on synthetic temp folders.
import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import type { MemoryBrowser } from '../src/memory/service.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness | undefined
const kids: Array<ReturnType<typeof Bun.spawn>> = []
const cleanup: string[] = []
afterEach(async () => {
  for (const k of kids.splice(0)) k.kill()
  await h?.stop()
  h = undefined
  delete process.env.TALOS_APP_MEMORY_WATCH
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SECRET = 'zzSECRETzz'
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  cleanup.push(d)
  return realpathSync(d)
}
const put = (root: string, rel: string, body: string) => {
  const f = join(root, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, body)
}

async function start(agent: string) {
  const home = tempHome()
  cleanup.push(home)
  writeFileSync(
    join(home, 'memory.json'),
    JSON.stringify({
      version: 1,
      enabled: true,
      agent_dir: agent,
      roots: [{ id: 'notes', label: 'Notes', path: 'notes', include: ['**/*.md'], exclude: [] }],
      max_file_kb: 512,
    }),
    { mode: 0o600 },
  )
  h = await startHarness({ home })
  await (h.bridge.ctx.memory as unknown as MemoryBrowser).idle()
  return h
}

async function read(x: Harness, path: string) {
  const f = await x.app.sign({ ...mkFrame('memory.read'), request_id: newUlid(), root_id: 'notes', path, offset: 0 })
  x.app.send(f)
  const find = () =>
    x.app.rec.frames.find(
      (r) =>
        r.direction === 'in' &&
        ((r.raw.type === 'memory.file' && r.raw.request_id === f.request_id) ||
          (r.raw.type === 'error' && r.raw.ref === f.id)),
    )
  await waitFor(() => find() !== undefined, 10_000, 'answer to memory.read')
  return (find() as { raw: Record<string, any> }).raw
}

describe('re-check: fresh bypasses', () => {
  test('FAILS ON a1a62ee (passes on 50dee90, a regression): a FIFO named like a note does not block the bridge: open() happens before the regular-file check', async () => {
    const agent = tmp('talos-rc-fifo-')
    const n = join(agent, 'notes')
    put(n, 'Overview.md', '# Overview\n')
    const x = await start(agent)
    execFileSync('mkfifo', [join(n, 'pipe.md')])
    // A rescuer opens the FIFO for writing, which is what would let a blocked open() return. It leaves a marker file the
    // moment it does. It waits long enough that a bridge that answers properly is done long before: the bridge must answer
    // with nobody on the other end of the pipe, and the marker proves nobody was. (A bridge that blocks sits frozen until the
    // rescuer arrives, so a wait on the answer could not tell; the marker can.)
    const marker = join(agent, 'rescuer-opened-the-pipe')
    kids.push(
      Bun.spawn(
        [
          process.execPath,
          '-e',
          `setTimeout(()=>{const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},'1');fs.writeFileSync(${JSON.stringify(join(n, 'pipe.md'))},'x')},12000)`,
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      ),
    )
    const r = await read(x, 'pipe.md')
    expect(r.code).toBe('memory_not_found')
    // the whole bridge process (every thread, every other read) was frozen while open() waited for a writer
    expect(existsSync(marker)).toBe(false)
  }, 40_000)

  // guard: 3,534 tries, no leak on a1a62ee. A triple flip between realpath(again) and stat(again) is possible in theory.
  test('flipping an intermediate FOLDER (open sees the outside dir, realpath the real one, stat the outside one) never leaks', async () => {
    process.env.TALOS_APP_MEMORY_WATCH = '0'
    const agent = tmp('talos-rc-dir-')
    const n = join(agent, 'notes')
    put(n, 'sub/race.md', '# race\ninside\n')
    put(agent, 'outdir/race.md', `# Outside\n${SECRET}\n`)
    const x = await start(agent)
    expect((await read(x, 'sub/race.md')).type).toBe('memory.file')
    // notes/sub flips between the real folder and a symlink to agent/outdir, as fast as rename allows
    kids.push(
      Bun.spawn(
        [
          process.execPath,
          '-e',
          `const fs=require('fs');const n=${JSON.stringify(n)};const o=${JSON.stringify(join(agent, 'outdir'))};
           try{fs.symlinkSync(o,n+'/.l')}catch{}
           for(;;){try{fs.renameSync(n+'/sub',n+'/.real');fs.renameSync(n+'/.l',n+'/sub');
                       fs.renameSync(n+'/sub',n+'/.l');fs.renameSync(n+'/.real',n+'/sub')}catch{}}`,
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      ),
    )
    let leaked = 0
    let served = 0
    let tries = 0
    const deadline = Date.now() + 25_000
    for (let i = 0; i < 50_000 && Date.now() < deadline && leaked === 0; i++) {
      tries++
      const r = await read(x, 'sub/race.md')
      if (r.type === 'memory.file') served++
      if (String(r.text ?? '').includes(SECRET)) leaked++
    }
    console.log(`dir flip: ${tries} tries, ${served} served, leaked=${leaked}`)
    expect(served).toBeGreaterThan(0)
    expect(leaked).toBe(0)
  }, 40_000)
})
