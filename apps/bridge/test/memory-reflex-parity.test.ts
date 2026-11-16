// The TypeScript name matcher (memory/reflex.ts) must give exactly what the kit hook (kit/hooks/memory-reflex.py) gives, for
// the same gazetteer and the same words: the same notes in the same order, and no note that is not named (zero wrong
// pointers). Each case runs BOTH: the python hook as a subprocess (the way kit/scripts/test-memory-reflex.sh runs it) and
// `matchNames`. The wiki is made up (test/fixtures/reflex); the gazetteer is built by the kit's own builder.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gazetteerPath, loadGazetteer, MAX_POINTERS, matchNames } from '../src/memory/reflex.ts'

type Case = { label: string; text: string; expect: string[] }
const REPO = join(import.meta.dir, '..', '..', '..')
const KIT = join(REPO, 'kit')
const cases = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'reflex', 'cases.json'), 'utf8')) as Case[]

let tmp = ''
let agent = ''
let env: Record<string, string> = {}
let gazFile = ''

function py(args: string[], opts: { input?: string; cwd?: string } = {}) {
  const r = spawnSync('python3', args, {
    env,
    cwd: opts.cwd ?? agent,
    input: opts.input,
    encoding: 'utf8',
    timeout: 20_000,
  })
  if (r.error) throw new Error(`python3 is required for this test (the kit hook is python): ${r.error.message}`)
  return r
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'reflex-parity-')))
  agent = join(tmp, 'agent')
  cpSync(join(import.meta.dir, 'fixtures', 'reflex', 'agent'), agent, { recursive: true })
  mkdirSync(join(agent, 'hooks'))
  mkdirSync(join(agent, 'scripts'))
  for (const f of readdirSync(join(KIT, 'hooks')))
    if (f.endsWith('.py')) cpSync(join(KIT, 'hooks', f), join(agent, 'hooks', f))
  for (const f of ['wiki-gazetteer.py', '_agent_root.py']) cpSync(join(KIT, 'scripts', f), join(agent, 'scripts', f))
  writeFileSync(join(agent, '.talos-version'), '0\n')
  env = {
    PATH: process.env.PATH ?? '',
    HOME: join(tmp, 'home'),
    XDG_STATE_HOME: join(tmp, 'state'),
    XDG_CONFIG_HOME: join(tmp, 'cfg'),
    CLAUDE_PROJECT_DIR: agent,
    PYTHONDONTWRITEBYTECODE: '1',
  }
  mkdirSync(env.HOME as string)
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0)
    throw new Error('python3 is required for this test (CI has it); install it and run again')
  const built = py([join(agent, 'scripts', 'wiki-gazetteer.py')])
  if (built.status !== 0 || !built.stdout.includes('wiki-gazetteer:'))
    throw new Error(`gazetteer build failed: ${built.stdout} ${built.stderr}`)
  gazFile = gazetteerPath(agent, env)
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const hookPaths = (text: string, sid: string): string[] => {
  const r = py([join(agent, 'hooks', 'memory-reflex.py')], {
    input: JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: text }),
  })
  if (r.status !== 0 || r.stderr.trim()) throw new Error(`hook crashed: ${r.status} ${r.stderr}`)
  const out = r.stdout.trim()
  if (!out) return []
  const ctx = (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext
  return ctx
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => /(wiki\/\S+?\.md)\b/.exec(l)?.[1] ?? `?${l}`)
}

describe('gazetteerPath', () => {
  test('is the folder the python hooks use for this agent folder', () => {
    const r = py(['-c', "import sys; sys.path.insert(0,'hooks'); import _talos_common as C; print(C.state_dir())"])
    expect(r.status).toBe(0)
    expect(gazetteerPath(agent, env)).toBe(join(r.stdout.trim(), 'gazetteer.json'))
    expect(existsSync(gazetteerPath(agent, env))).toBe(true)
  })
  test('with no XDG_STATE_HOME it is under HOME/.local/state', () => {
    expect(gazetteerPath('/srv/some-agent', { HOME: '/h' })).toMatch(
      /^\/h\/\.local\/state\/talos\/some-agent-[0-9a-f]{8}\/gazetteer\.json$/,
    )
  })
})

describe('the matcher gives what the hook gives', () => {
  test('the gazetteer loads, and a missing, bad or old-version file loads as null', () => {
    expect(loadGazetteer(gazFile)?.notes.length).toBeGreaterThan(8)
    expect(loadGazetteer(join(tmp, 'nope.json'))).toBeNull()
    writeFileSync(join(tmp, 'bad.json'), '{not json')
    expect(loadGazetteer(join(tmp, 'bad.json'))).toBeNull()
    writeFileSync(join(tmp, 'v2.json'), JSON.stringify({ version: 2, notes: [] }))
    expect(loadGazetteer(join(tmp, 'v2.json'))).toBeNull()
  })
  test('the fixture covers what it should', () => {
    expect(cases.length).toBeGreaterThanOrEqual(25)
    const gaz = loadGazetteer(gazFile)
    const paths = new Set(gaz?.notes.map((n) => n.p))
    for (const gone of ['wiki/people/zed-hidden.md', 'wiki/people/olaf-obsolete.md', 'wiki/archive/oldco-vendor.md'])
      expect(paths.has(gone), gone).toBe(false)
    // the owner's own name is in the file but on the ignore list, so it is never matched
    expect(gaz?.ignore.has('riley quinn')).toBe(true)
  })
  cases.forEach((c, i) => {
    test(c.label, () => {
      const gaz = loadGazetteer(gazFile)
      if (!gaz) throw new Error('no gazetteer')
      const fromPython = hookPaths(c.text, `s-${i}`)
      const fromTs = matchNames(c.text, gaz)
        .map((idx) => (gaz.notes[idx] as { p: string }).p)
        .slice(0, MAX_POINTERS)
      expect(fromPython, 'the python hook').toEqual(c.expect)
      expect(fromTs, 'matchNames').toEqual(fromPython)
    })
  })
})
