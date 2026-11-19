// Whether the root ./install.sh has put the Talos kit into an agent folder. The bridge's own install
// (apps/bridge/scripts/install.sh) writes only .mcp.json, so a folder can have the bridge and none of Talos. A plain Claude
// Code folder is still a supported choice (SETUP.md step 3, `talos-app adopt`): `start --no-kit` and adopt record it in the
// bridge home, never in the folder (adopt promises to change only .mcp.json and the app hooks there).
import { realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readJsonFile, writeJsonAtomic } from './fsutil.ts'

const REPO = resolve(import.meta.dir, '..', '..', '..')

const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile() === true
const isDir = (p: string) => statSync(p, { throwIfNoEntry: false })?.isDirectory() === true

/**
 * The kit stamps .talos-version and its CLAUDE.md comes with it (install.sh); a stamp without a CLAUDE.md is not a kit. A
 * folder from kit 1.x has no stamp: it counts by the same shape install.sh's is_v1_kit reads (CLAUDE.md, memory/, hooks/ and
 * scripts/). Links are followed, as install.sh's -f and -d do.
 */
export function hasTalosKit(agentDir: string): boolean {
  if (!isFile(join(agentDir, 'CLAUDE.md'))) return false
  if (isFile(join(agentDir, '.talos-version'))) return true
  return ['memory', 'hooks', 'scripts'].every((d) => isDir(join(agentDir, d)))
}

/** What start refuses with and doctor fails on. ./install.sh refuses a non-empty folder, so the kit means a new folder. */
export const noKitMessage = (agentDir: string) =>
  `This folder has no Talos kit: run ${join(REPO, 'install.sh')} --agent-dir <a new folder> for an agent with the full Talos kit, or start with --no-kit to connect ${agentDir} as a plain Claude Code folder`

/** doctor for a plain folder on purpose (Pantheon 2026-11-19): a warning, not a failure. */
export const plainFolderWarning = (agentDir: string) =>
  `no Talos kit in ${agentDir} (a plain Claude Code folder, by --no-kit or talos-app adopt): replies rely only on the talos-app server's instructions, with no CLAUDE.md, memory or hooks from Talos`

/** The bridge home's list of agent folders connected without the kit on purpose. */
export const plainFoldersPath = (home: string) => join(home, 'plain-folders.json')

const real = (dir: string) => {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

function recorded(home: string): string[] {
  const f = readJsonFile<{ folders?: unknown }>(plainFoldersPath(home))
  return Array.isArray(f?.folders) ? f.folders.filter((x): x is string => typeof x === 'string') : []
}

/** Whether `start --no-kit` or `adopt` connected this folder as a plain Claude Code folder. */
export function isPlainFolder(home: string, agentDir: string): boolean {
  return recorded(home).includes(real(agentDir))
}

/** Remembers a folder connected without the kit on purpose, so doctor warns instead of failing and start needs no flag. */
export function recordPlainFolder(home: string, agentDir: string): void {
  const all = recorded(home)
  const dir = real(agentDir)
  if (all.includes(dir)) return
  writeJsonAtomic(plainFoldersPath(home), { folders: [...all, dir] })
}
