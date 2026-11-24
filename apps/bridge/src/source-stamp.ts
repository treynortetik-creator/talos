// `.talos-source.json`: what a checkout set up from a release's own source tarball says it is. That checkout has no .git (the
// Mac app's first setup unpacks the tarball whose sha256 and commit are stamped into the signed app), so git cannot tell its
// version, and `talos-app update` / `rollback` cannot move it: the Talos app updates it from the next release's tarball.
// The release build writes the file: {"v":1,"tag":"mac-v1.2.3","version":"1.2.3","gitSha":"<40 hex>"}; keys this build does not
// know are ignored. Node builtins only: rollback.ts loads this when the rest of the CLI cannot.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

export const SOURCE_STAMP = '.talos-source.json'

/**
 * The stamp when `repoDir` is a release checkout: no `.git` of its own (a folder, or a worktree's file) and a stamp that checks
 * out. Decided without running git: on a Mac without the developer tools /usr/bin/git is Apple's stub, and running it opens the
 * "install the command line developer tools?" dialog, at every bridge start. A clone always has its `.git`, so git still wins
 * there, whatever stamp lies in it; a tarball unpacked inside a clone has none at its own root and is a release checkout.
 */
export function releaseCheckout(repoDir: string): SourceStamp | undefined {
  if (lstatSync(join(repoDir, '.git'), { throwIfNoEntry: false })) return undefined
  return readSourceStamp(repoDir)
}

export type SourceStamp = { tag: string; version: string; gitSha: string }

/** Far more than the file needs; anything bigger is not ours. */
const MAX_BYTES = 64 * 1024

const SEMVER = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/

/**
 * The stamp in `repoDir`, or undefined when there is none or it does not check out: a regular file (never through a link), at
 * most 64 KiB, JSON with v 1, a semver version, a tag that is that version (bare, v<version>, or mac-v<version>, the tag the public repo gives a release) and a full commit id.
 */
export function readSourceStamp(repoDir: string): SourceStamp | undefined {
  let fd: number | undefined
  try {
    fd = openSync(join(repoDir, SOURCE_STAMP), constants.O_RDONLY | constants.O_NOFOLLOW)
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_BYTES) return undefined
    const buf = Buffer.alloc(st.size)
    let got = 0
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got)
      if (n <= 0) break
      got += n
    }
    const o = JSON.parse(buf.subarray(0, got).toString('utf8')) as Record<string, unknown>
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return undefined
    const { tag, version, gitSha } = o
    if (typeof version !== 'string' || !SEMVER.test(version)) return undefined
    if (typeof tag !== 'string' || (tag !== version && tag !== `v${version}` && tag !== `mac-v${version}`))
      return undefined
    if (typeof gitSha !== 'string' || !/^[0-9a-f]{40}$/.test(gitSha)) return undefined
    return { tag, version, gitSha }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
