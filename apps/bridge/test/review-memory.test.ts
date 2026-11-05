/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// Adversarial review of WP-V5 (PR #44, the memory browser). Real bridge (live, in process) + FakeRelay + FakeApp, on
// synthetic agent folders in temp dirs. Every test here is something the owner's denylist, excludes or private markers
// must survive. Tests marked FAILS ON PR HEAD are the findings; the others are guards that hold today.
import { afterEach, describe, expect, test } from 'bun:test'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import type { MemoryBrowser } from '../src/memory/service.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness | undefined
let swapper: ReturnType<typeof Bun.spawn> | undefined
const cleanup: string[] = []
afterEach(async () => {
  swapper?.kill()
  swapper = undefined
  await h?.stop()
  h = undefined
  delete process.env.TALOS_APP_MEMORY_WATCH
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  cleanup.push(d)
  return realpathSync(d)
}
const put = (root: string, rel: string, body: string | Buffer = `# ${rel}\n`) => {
  const f = join(root, rel)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, body)
}

const SECRET = 'zzSECRETzz'

/** notes/ root with a good note, an excluded folder, a private folder, secrets, and a secret outside the root. */
function makeAgent() {
  const agent = tmp('talos-rev-mem-')
  const n = join(agent, 'notes')
  put(n, 'Overview.md', '# Overview\nhello\n')
  put(n, 'drafts/Drafty.md', `# Drafty\n${SECRET} draft\n`)
  put(n, 'private/Secret plan.md', `# Secret plan\n${SECRET} private\n`)
  put(n, 'private/sub/deep.md', `# Deep\n${SECRET} deep private\n`)
  put(n, 'private/.talos-private', '')
  put(n, '.env', `KEY=${SECRET}\n`)
  put(n, 'prod.env', `KEY=${SECRET}\n`)
  put(n, 'credentials.json', `{"k":"${SECRET}"}\n`)
  put(n, 'config.yaml', `token: ${SECRET}\n`)
  put(agent, 'outside.md', `# Outside\n${SECRET} outside\n`)
  return { agent, n }
}

const memJson = (agent: string, rootOver: Record<string, unknown> = {}) => ({
  version: 1,
  enabled: true,
  agent_dir: agent,
  roots: [{ id: 'notes', label: 'Notes', path: 'notes', include: ['**/*.md'], exclude: ['drafts/**'], ...rootOver }],
  max_file_kb: 512,
})

async function start(agent: string, rootOver: Record<string, unknown> = {}) {
  const home = tempHome()
  cleanup.push(home)
  writeFileSync(join(home, 'memory.json'), JSON.stringify(memJson(agent, rootOver)), { mode: 0o600 })
  h = await startHarness({ home })
  await (h.bridge.ctx.memory as unknown as MemoryBrowser).idle()
  return h
}

const RESP = {
  'memory.tree': 'memory.listing',
  'memory.read': 'memory.file',
  'memory.search': 'memory.results',
} as const
type Q = keyof typeof RESP
async function call(x: Harness, type: Q, fields: Record<string, unknown>) {
  const f = await x.app.sign({ ...mkFrame(type), request_id: newUlid(), ...fields })
  x.app.send(f)
  const find = () =>
    x.app.rec.frames.find(
      (r) =>
        r.direction === 'in' &&
        ((r.raw.type === RESP[type] && r.raw.request_id === f.request_id) ||
          (r.raw.type === 'error' && r.raw.ref === f.id)),
    )
  await waitFor(() => find() !== undefined, 5000, `answer to ${type}`)
  return (find() as { raw: Record<string, any> }).raw
}
const read = (x: Harness, path: string, offset = 0) => call(x, 'memory.read', { root_id: 'notes', path, offset })
const tree = (x: Harness, path = '') => call(x, 'memory.tree', { root_id: 'notes', path, cursor: null })
const search = (x: Harness, q: string) => call(x, 'memory.search', { q, root_ids: [], cursor: null, limit: 50 })

/** Every path the tree shows, walked from the top. */
async function allPaths(x: Harness): Promise<string[]> {
  const out: string[] = []
  const walk = async (p: string) => {
    const t = await tree(x, p)
    for (const e of t.entries ?? []) {
      out.push(e.path)
      if (e.type === 'dir') await walk(e.path)
    }
  }
  await walk('')
  return out.sort()
}

// ---- 1. exclude globs vs the case-insensitive, normalisation-insensitive Mac file system --------------------------

describe('exclude bypass through APFS name folding (FAILS ON PR HEAD)', () => {
  test('a case variant of an excluded folder is read: DRAFTS/Drafty.md must be memory_not_found', async () => {
    const { agent } = makeAgent()
    const x = await start(agent)
    expect((await read(x, 'drafts/Drafty.md')).code).toBe('memory_not_found') // the canonical spelling is refused
    for (const p of ['DRAFTS/Drafty.md', 'Drafts/Drafty.md', 'drafts/DRAFTY.MD', 'dRaFtS/drafty.md']) {
      const r = await read(x, p)
      expect(r.text ?? '').not.toContain(SECRET)
      expect(r.code).toBe('memory_not_found')
    }
  })

  test('an NFD spelling of an excluded NFC folder is read: café/** must hold for cafe\\u0301/', async () => {
    const { agent, n } = makeAgent()
    put(n, 'caf\u00e9/menu.md', `# Menu\n${SECRET} cafe\n`)
    const x = await start(agent, { exclude: ['caf\u00e9/**'] })
    expect((await read(x, 'caf\u00e9/menu.md')).code).toBe('memory_not_found')
    const r = await read(x, 'cafe\u0301/menu.md')
    expect(r.text ?? '').not.toContain(SECRET)
    expect(r.code).toBe('memory_not_found')
  })

  test('[Ask] refs use the same check: a ref to DRAFTS/Drafty.md must not hand the agent the excluded file', async () => {
    const { agent } = makeAgent()
    const x = await start(agent)
    await x.app.sendMessage('general', 'look', {
      refs: [{ kind: 'memory', root_id: 'notes', path: 'DRAFTS/Drafty.md', sha256: 'a'.repeat(64) }],
    })
    await x.waitNotes(1)
    const meta = (x.notes[0]?.meta ?? {}) as Record<string, string>
    expect(meta.memory_path).toBeUndefined()
    expect(x.notes[0]?.content).toContain("That note isn't shared any more.")
  })
})

// ---- 2. symlinks that stay inside the root but land on something the rules hide ------------------------------------

describe('symlinks inside the root (FAILS ON PR HEAD)', () => {
  test('a link named like a note that points at an EXCLUDED note is hidden from tree and read', async () => {
    const { agent, n } = makeAgent()
    symlinkSync(join(n, 'drafts/Drafty.md'), join(n, 'innocent.md'))
    const x = await start(agent)
    const r = await read(x, 'innocent.md')
    expect(r.text ?? '').not.toContain(SECRET)
    expect(r.code).toBe('memory_not_found')
    expect(await allPaths(x)).not.toContain('innocent.md')
  })

  test('a .md link that points at a NON-INCLUDED file (config.yaml) is hidden: include is an allowlist', async () => {
    const { agent, n } = makeAgent()
    symlinkSync(join(n, 'config.yaml'), join(n, 'readme.md'))
    const x = await start(agent)
    const r = await read(x, 'readme.md')
    expect(r.text ?? '').not.toContain(SECRET)
    expect(r.code).toBe('memory_not_found')
  })

  test('search never finds an excluded note through a link alias', async () => {
    const { agent, n } = makeAgent()
    symlinkSync(join(n, 'drafts/Drafty.md'), join(n, 'alias.md'))
    const x = await start(agent)
    const s = await search(x, SECRET)
    expect(JSON.stringify(s.hits ?? [])).not.toContain(SECRET)
    expect((s.hits ?? []).length).toBe(0)
  })
})

// ---- 3. hard links -------------------------------------------------------------------------------------------------

describe('hard links (FAILS ON PR HEAD)', () => {
  test('a hard link to the root .env, named innocent.md, does not serve the secret', async () => {
    const { agent, n } = makeAgent()
    linkSync(join(n, '.env'), join(n, 'innocent.md'))
    const x = await start(agent)
    const r = await read(x, 'innocent.md')
    expect(r.text ?? '').not.toContain(SECRET)
    expect(r.code).toBe('memory_not_found')
  })

  test('a hard link to a file OUTSIDE the root does not serve it (realpath cannot see hard links)', async () => {
    const { agent, n } = makeAgent()
    linkSync(join(agent, 'outside.md'), join(n, 'out.md'))
    const x = await start(agent)
    const r = await read(x, 'out.md')
    expect(r.text ?? '').not.toContain(SECRET)
    const s = await search(x, SECRET)
    expect((s.hits ?? []).length).toBe(0)
  })
})

// ---- 4. TOCTOU: a symlink swapped in between the scope check and the read -----------------------------------------

describe('TOCTOU (FAILS ON PR HEAD, leaks within a handful of reads)', () => {
  test('swapping race.md between a regular file and a symlink to a file outside the root never leaks it', async () => {
    process.env.TALOS_APP_MEMORY_WATCH = '0'
    const { agent, n } = makeAgent()
    put(n, 'race.md', '# race\n')
    const x = await start(agent)
    expect((await read(x, 'race.md')).type).toBe('memory.file')
    const target = join(agent, 'outside.md')
    // an independent process (the agent, or anything with write access to the notes folder) flips the name atomically
    swapper = Bun.spawn(
      [
        process.execPath,
        '-e',
        `const fs=require('fs');const d=${JSON.stringify(n)};const t=${JSON.stringify(target)};let i=0;
         for(;;){fs.writeFileSync(d+'/.f','# race '+(i++)+'\\n');fs.renameSync(d+'/.f',d+'/race.md');
         try{fs.unlinkSync(d+'/.l')}catch{};fs.symlinkSync(t,d+'/.l');fs.renameSync(d+'/.l',d+'/race.md')}`,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    let leaked = 0
    let served = 0
    const deadline = Date.now() + 12_000
    for (let i = 0; i < 4000 && Date.now() < deadline && leaked === 0; i++) {
      const r = await read(x, 'race.md')
      if (r.type === 'memory.file') served++
      if (String(r.text ?? '').includes(SECRET)) leaked++
    }
    console.log(`TOCTOU: ${served} served before the first leak`)
    expect(served).toBeGreaterThan(0) // the race was actually run
    expect(leaked).toBe(0)
  }, 30_000)
})

// ---- 5. .talos-private ---------------------------------------------------------------------------------------------

describe('.talos-private', () => {
  test('inherits to every depth, and a symlinked alias of a private subfolder is hidden too', async () => {
    const { agent, n } = makeAgent()
    symlinkSync(join(n, 'private/sub'), join(n, 'alias'))
    const x = await start(agent)
    for (const p of ['private/Secret plan.md', 'private/sub/deep.md', 'alias/deep.md', 'PRIVATE/sub/deep.md'])
      expect((await read(x, p)).code).toBe('memory_not_found')
    const paths = await allPaths(x)
    expect(paths.some((p) => p.startsWith('private') || p.startsWith('alias'))).toBe(false)
    expect(((await search(x, SECRET)).hits ?? []).length).toBe(0)
  })

  test('a marker dropped in later hides the folder at once, before any re-index', async () => {
    process.env.TALOS_APP_MEMORY_WATCH = '0'
    const { agent, n } = makeAgent()
    put(n, 'later/note.md', `# Later\n${SECRET} later\n`)
    const x = await start(agent)
    expect((await read(x, 'later/note.md')).type).toBe('memory.file')
    writeFileSync(join(n, 'later/.talos-private'), '')
    expect((await read(x, 'later/note.md')).code).toBe('memory_not_found')
    expect(((await search(x, SECRET)).hits ?? []).length).toBe(0)
  })

  test('FAILS ON PR HEAD: a marker in a folder ABOVE the root ("everything under it") hides the root', async () => {
    const { agent, n } = makeAgent()
    // agent/notes is the root; agent/notes is under agent/, and agent/ is marked private
    writeFileSync(join(agent, '.talos-private'), '')
    const x = await start(agent)
    const r = await read(x, 'Overview.md')
    expect(r.code).toBe('memory_not_found')
    void n
  })
})

// ---- 6. denylist spellings (guards; these hold on PR head) -----------------------------------------------------------

describe('denylist spellings', () => {
  test('case, trailing dot/space, long-s and nested spellings of secrets are all memory_not_found', async () => {
    const { agent, n } = makeAgent()
    put(n, 'a/b/c/.env', `KEY=${SECRET}\n`)
    put(n, 'a/b/id_rsa.md', `${SECRET}\n`)
    put(n, 'credentials.md', `${SECRET}\n`)
    const x = await start(agent, { include: ['**/*'] })
    for (const p of [
      '.env',
      '.ENV',
      'PROD.ENV',
      'prod.env.',
      'prod.env ',
      'Prod.Env',
      'credentials.json',
      'CREDENTIALS.JSON',
      'credential\u017f.json', // long s: APFS folds it to `s`
      'credential\u017f.md',
      'a/b/c/.env',
      'A/B/C/.Env',
      'a/b/ID_RSA.md',
      '%2e%2e/outside.md',
      '../outside.md', // refused by the MemoryPath schema before the service sees it
      `${'..'}/notes/../outside.md`,
      '/etc/hosts',
      './.env',
      'a//.env',
    ]) {
      const r = await read(x, p)
      expect(String(r.text ?? '')).not.toContain(SECRET)
      expect(['memory_not_found', 'bad_frame', 'sig_invalid'].includes(r.code)).toBe(true)
    }
  })
})

// ---- 7. size and encoding ------------------------------------------------------------------------------------------

describe('size and encoding', () => {
  test('a 6 MB note and a NUL-bearing note are memory_not_found', async () => {
    const { agent, n } = makeAgent()
    put(n, 'huge.md', Buffer.alloc(6 * 1024 * 1024, 0x61))
    put(n, 'bin.md', Buffer.from([0x23, 0x20, 0x00, 0x01, 0x02]))
    const x = await start(agent)
    expect((await read(x, 'huge.md')).code).toBe('memory_not_found')
    expect((await read(x, 'bin.md')).code).toBe('memory_not_found')
  })

  test('FAILS ON PR HEAD: a note of invalid UTF-8 is refused or served whole, never with a silent gap', async () => {
    const { agent, n } = makeAgent()
    // a Latin-1-ish file with a long run of stray continuation bytes, then real text the owner wrote
    put(
      n,
      'bad.md',
      Buffer.concat([Buffer.from('# bad\n'), Buffer.alloc(300 * 1024, 0x80), Buffer.from('\nTAIL zzTAILzz\n')]),
    )
    const x = await start(agent)
    let r = await read(x, 'bad.md')
    if (r.type === 'error') return expect(r.code).toBe('memory_not_found')
    // chunks must be contiguous: each chunk starts where the last one said the next one would
    let expected = 0
    let text = ''
    for (;;) {
      expect(r.offset).toBe(expected)
      text += r.text
      if (r.next_offset === null) break
      expected = r.next_offset
      r = await read(x, 'bad.md', r.next_offset)
    }
    expect(text).toContain('zzTAILzz')
  })

  test('max_file_kb is a per-file cap (V5.2): a note over it is not served in full', async () => {
    const { agent, n } = makeAgent()
    const big = `# Big\n${'word '.repeat(60_000)}`
    put(n, 'big.md', big)
    const home = tempHome()
    cleanup.push(home)
    writeFileSync(join(home, 'memory.json'), JSON.stringify({ ...memJson(agent), max_file_kb: 16 }), { mode: 0o600 })
    h = await startHarness({ home })
    await (h.bridge.ctx.memory as unknown as MemoryBrowser).idle()
    let offset: number | null = 0
    let got = 0
    while (offset !== null) {
      const r = await read(h, 'big.md', offset)
      if (r.type !== 'memory.file') break
      got += Buffer.byteLength(r.text)
      offset = r.next_offset
    }
    expect(got).toBeLessThanOrEqual(16 * 1024)
  })
})

// ---- 8. signatures ---------------------------------------------------------------------------------------------------

describe('signed reads (guards)', () => {
  test('a replayed read (same signed frame twice) is answered once', async () => {
    const { agent } = makeAgent()
    const x = await start(agent)
    const f = await x.app.sign({
      ...mkFrame('memory.read'),
      request_id: newUlid(),
      root_id: 'notes',
      path: 'Overview.md',
      offset: 0,
    })
    x.app.send(f)
    x.app.send(f)
    await waitFor(
      () => x.app.rec.frames.some((r) => r.direction === 'in' && r.raw.request_id === f.request_id),
      5000,
      'first answer',
    )
    await (x.bridge as any).inbound?.readsIdle?.()
    await new Promise((r) => setTimeout(r, 300))
    const answers = x.app.rec.frames.filter((r) => r.direction === 'in' && r.raw.request_id === f.request_id)
    expect(answers.length).toBe(1)
  })

  test('a signed read whose path was changed after signing is refused, never answered', async () => {
    const { agent } = makeAgent()
    const x = await start(agent)
    const f = await x.app.sign({
      ...mkFrame('memory.read'),
      request_id: newUlid(),
      root_id: 'notes',
      path: 'Overview.md',
      offset: 0,
    })
    const forged = { ...f, path: 'drafts/Drafty.md' }
    x.app.send(forged)
    await new Promise((r) => setTimeout(r, 500))
    const answers = x.app.rec.frames.filter(
      (r) => r.direction === 'in' && r.raw.type === 'memory.file' && r.raw.request_id === f.request_id,
    )
    expect(answers.length).toBe(0)
  })
})
