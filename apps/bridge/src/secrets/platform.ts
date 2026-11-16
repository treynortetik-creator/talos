// The small platform facts the secret store needs (PlatformFacts in @talos-app/protocol): is this WSL, and can a path hold a
// secret. The supervisor's full PlatformFacts builds on these.
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { WSL_WINDOWS_FS_TYPES, WSL_WINDOWS_MOUNTS } from '@talos-app/protocol'

/** WSL 1 or 2: the kernel says so in /proc/version ("microsoft"), and WSL sets WSL_DISTRO_NAME for its processes. */
export function isWsl(env: NodeJS.ProcessEnv = process.env, procVersion = readProcVersion()): boolean {
  if (process.platform !== 'linux') return false
  return Boolean(env.WSL_DISTRO_NAME) || /microsoft/i.test(procVersion)
}

function readProcVersion(): string {
  try {
    return readFileSync('/proc/version', 'utf8')
  } catch {
    return ''
  }
}

/** One mount from /proc/self/mountinfo: where it is mounted and its filesystem type. */
export type Mount = { at: string; fsType: string }

/** Fields: id parent dev root MOUNTPOINT opts [optional...] - FSTYPE source superopts. Octal escapes (\040) are decoded. */
export function parseMountinfo(text: string): Mount[] {
  const out: Mount[] = []
  for (const line of text.split('\n')) {
    const f = line.split(' ')
    const dash = f.indexOf('-')
    if (f.length < 5 || dash < 6 || dash + 1 >= f.length) continue
    out.push({ at: unescapeMount(f[4] as string), fsType: f[dash + 1] as string })
  }
  return out
}

const unescapeMount = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(Number.parseInt(o, 8)))

function readMountinfo(): Mount[] | null {
  try {
    return parseMountinfo(readFileSync('/proc/self/mountinfo', 'utf8'))
  } catch {
    return null
  }
}

/** The mount a real path is on: the longest mount point that is the path or one of its parents (the last such, if stacked). */
export function mountOf(real: string, mounts: Mount[]): Mount | undefined {
  let best: Mount | undefined
  for (const m of mounts) {
    const under = m.at === '/' || real === m.at || real.startsWith(`${m.at}/`)
    if (under && (!best || m.at.length >= best.at.length)) best = m
  }
  return best
}

/**
 * Why `path` cannot hold a secret, the agent or the Talos config, or null. On WSL a path on a Windows drive is refused: modes
 * are not enforced there (a 0600 file is readable by anything). A Windows drive is a mount whose filesystem type is one of
 * WSL_WINDOWS_FS_TYPES (drvfs, 9p, virtiofs), wherever /etc/wsl.conf `automount.root` puts it, and anything under the
 * default /mnt/<drive> root whatever its type. The real path is checked (a link on the Linux disk that leads to a drive
 * counts as the drive); a path that does not exist yet is judged by its nearest existing parent.
 */
export function pathIssue(
  path: string,
  wsl = isWsl(),
  mounts: Mount[] | null = wsl ? readMountinfo() : null,
): 'windows_drive' | null {
  if (!wsl) return null
  const real = realOrParent(resolve(path))
  // both rules refuse: the default root catches a drive whose filesystem type is new to this list, or a mountinfo that
  // reads but says nothing usable; the type catches a drive that automount.root put somewhere else
  if (WSL_WINDOWS_MOUNTS.test(real)) return 'windows_drive'
  if (!mounts?.length) return null
  const m = mountOf(real, mounts)
  return m && WSL_WINDOWS_FS_TYPES.includes(m.fsType) ? 'windows_drive' : null
}

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
function realOrParent(path: string): string {
  for (let p = path; ; p = dirname(p)) {
    try {
      const real = realpathSync(p)
      return p === path ? real : `${real}${path.slice(p.length)}`
    } catch {
      if (dirname(p) === p) return path
    }
  }
}
