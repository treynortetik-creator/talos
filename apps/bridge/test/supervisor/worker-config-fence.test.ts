// The hook's fence before a slot is taken (worker-config.ts): every configured dedicated thread's folder, read from config.json
// at each start, so a python3 one thread planted in its own folder is never what another thread's hook runs. Temp folders only.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { threadFolderReader, threadFolders, workerConfigReaders } from '../../src/supervisor/worker-config.ts'
import { PYTHON_RULES } from '../../src/supervisor/worker-hook.ts'
import { cleanupReleases, sealedRelease } from './kit-release-fixture.ts'

// The stand-in python3 files these tests build in temp folders are this user's own: the two trust rules (the system's folder
// first, nothing the session's user could change) are off here and back after each test; worker-hook.test.ts tests them.
const savedPythonRules = { ...PYTHON_RULES }
beforeEach(() => Object.assign(PYTHON_RULES, { preferredDir: null, trustedOwner: process.getuid?.() ?? 0 }))
afterEach(() => Object.assign(PYTHON_RULES, savedPythonRules))

afterAll(cleanupReleases)
const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-fence-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const dedicated = (id: string, cwd: string) => ({ id, kind: 'user', session: 'dedicated', session_opts: { cwd } })
const writeConfig = (home: string, threads: unknown[]) =>
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      default_thread: 'general',
      dedicated: { enabled: true },
      threads: [{ id: 'general', kind: 'fixed' }, ...threads],
    }),
  )

describe('every configured thread folder is fenced', () => {
  it('each dedicated thread’s folder; a config that cannot be read for a moment never narrows the fence', () => {
    const home = tmp()
    const read = threadFolderReader(home)
    expect(threadFolders(home, '/a')).toBeNull()
    expect(read('/a')).toBeNull() // never read yet: the start is refused, never fenced by none
    writeConfig(home, [dedicated('trip', '/w/trip'), dedicated('work', '/w/work'), { id: 'chat', kind: 'user' }])
    expect(threadFolders(home, '/a')).toEqual(['/w/trip', '/w/work'])
    expect(read('/a')).toEqual(['/w/trip', '/w/work'])
    writeFileSync(join(home, 'config.json'), '{not json')
    expect(threadFolders(home, '/a')).toBeNull()
    expect(read('/a')).toEqual(['/w/trip', '/w/work']) // the last read kept
    writeConfig(home, [dedicated('trip', '/w/trip')])
    expect(read('/a')).toEqual(['/w/trip']) // and read again at the next start
  })
  it('the preflight passes over a python3 in another thread’s folder, read again at each start', () => {
    const root = tmp()
    const home = join(root, '.talos')
    const agentDir = join(root, 'agent')
    const other = join(root, 'other')
    for (const d of [home, agentDir, join(other, 'bin')]) mkdirSync(d, { recursive: true })
    cpSync(realpathSync('/usr/bin/python3'), join(other, 'bin', 'python3'))
    const prev = process.env.TALOS_KIT_HOME
    process.env.TALOS_KIT_HOME = sealedRelease()
    try {
      const r = workerConfigReaders(
        home,
        root,
        () => ({ agentDir, args: [], workers: true }) as never,
        () => {},
        () => ({ PATH: '/usr/bin' }),
      )
      // HOME elsewhere: the home wall is not what this tests (worker-hook.test.ts does)
      const env = { PATH: join(other, 'bin'), HOME: '/nonexistent-home' }
      writeConfig(home, [dedicated('trip', agentDir)])
      // control: that interpreter is not in any configured thread's folder, so the hook can run
      expect(r.preflight('trip', env)).toBeNull()
      // the other thread is configured now: the next start sees it, and refuses
      writeConfig(home, [dedicated('trip', agentDir), dedicated('other', other)])
      expect(r.preflight('trip', env)).toMatchObject({
        hookMissing:
          "python3 is not on the thread session's PATH (outside its own folders), so its permission hook cannot run",
      })
    } finally {
      if (prev === undefined) delete process.env.TALOS_KIT_HOME
      else process.env.TALOS_KIT_HOME = prev
    }
  })
})
