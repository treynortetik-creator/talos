// talos-app doctor's row for the opt-in OS sandbox ("Extra lock on protected files", guards/os-sandbox.ts): off, or on with every
// protected file as it must be. A file with another name (a hard link) or a symlink in its place makes the next start refuse.

import { homedir } from 'node:os'
import type { Check } from './doctor-checks.ts'
import { defaultClaudeDir, osSandboxPreflight, readOsSandboxSwitch } from './guards/os-sandbox.ts'
import { folderLaunchProblem } from './guards/os-sandbox-folder.ts'

export function osSandboxCheck(home: string, folder?: string): Check {
  const name = 'OS sandbox'
  if (!readOsSandboxSwitch(home))
    return { level: 'ok', name, detail: 'off (the extra lock on protected files is not turned on)' }
  const bad =
    osSandboxPreflight(home) ??
    (folder ? folderLaunchProblem(folder, defaultClaudeDir(homedir()), true, { talosHome: home }) : null)
  return bad
    ? { level: 'FAIL', name, detail: `on, and a start is refused: ${bad}` }
    : {
        level: 'ok',
        name,
        detail:
          'on; the protected files each have one name and the folder settings leave the lock alone, so a start goes ahead inside the sandbox',
      }
}
