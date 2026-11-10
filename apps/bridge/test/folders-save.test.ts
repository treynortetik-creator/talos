// The save path refuses what the picker refuses: a thread's own-session folder may not be a refused root (~/.ssh, ~/Library, the
// Claude folder, ...) or inside one, whether the owner typed it, chose it in the app's browser, or the Mac's open panel returned
// it. One list (folderRefusedRoots), one sentence (FOLDER_WORDING.refused). Temp home, made-up folders.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentConfigT, FOLDER_WORDING } from '@talos-app/protocol'
import { loadExampleConfig } from '@talos-app/testkit'
import { checkWorkerFolder, optionCPatchIssue, type WorkerRoots } from '../src/worker/patch-check.ts'

let top: string
let home: string
let roots: WorkerRoots
beforeEach(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), 'talos-folder-save-')))
  home = join(top, 'home')
  mkdirSync(home)
  roots = {
    home,
    talosHome: join(home, '.config', 'talos', 'app'),
    claudeDir: join(home, '.claude'),
    agentDir: join(home, 'agents', 'main'),
  }
  for (const d of [
    'Projects/alpha',
    '.ssh/keys',
    'Library/Application Support/x',
    '.aws',
    '.docker',
    'agents/main/sub',
  ])
    mkdirSync(join(home, d), { recursive: true })
})
afterEach(() => rmSync(top, { recursive: true, force: true }))

describe('a thread folder may not be a refused root', () => {
  test('an ordinary folder is fine', () => {
    expect(checkWorkerFolder(join(home, 'Projects', 'alpha'), roots)).toBeNull()
  })

  test('typing ~/.ssh or ~/Library/x (as the full path) is refused with the picker sentence', () => {
    for (const bad of [
      join(home, '.ssh'),
      join(home, '.ssh', 'keys'),
      join(home, 'Library'),
      join(home, 'Library', 'Application Support', 'x'),
    ])
      expect(checkWorkerFolder(bad, roots), bad).toBe(FOLDER_WORDING.refused)
  })

  test('a panel result inside any other refused root is refused too, the new roots and the agent folder included', () => {
    for (const bad of [join(home, '.aws'), join(home, '.docker'), join(home, 'agents', 'main', 'sub')])
      expect(checkWorkerFolder(bad, roots), bad).toBe(FOLDER_WORDING.refused)
  })

  test('a spelling in another case, or a link that leads into a refused root, is refused', () => {
    symlinkSync(join(home, '.ssh'), join(home, 'Projects', 'shortcut'))
    expect(checkWorkerFolder(join(home, '.SSH', 'keys'), roots)).toBe(FOLDER_WORDING.refused)
    expect(checkWorkerFolder(join(home, 'Projects', 'shortcut', 'keys'), roots)).toBe(FOLDER_WORDING.refused)
  })

  test('the patch the owner signed is refused before anything is written', () => {
    const cur = loadExampleConfig('default') as AgentConfigT
    const trip = {
      id: 'trip',
      name: 'Trip',
      kind: 'fixed',
      order: 9,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
      session: 'dedicated',
      session_opts: { cwd: join(home, '.ssh') },
    }
    const next = {
      ...cur,
      dedicated: { ...(cur.dedicated ?? {}), enabled: true },
      threads: [...cur.threads, trip],
    } as unknown as AgentConfigT
    const why = optionCPatchIssue({ ...cur, dedicated: next.dedicated } as AgentConfigT, next, roots)
    expect(why).toContain(FOLDER_WORDING.refused)
  })
})
