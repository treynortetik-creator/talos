// The secret an agent run of `peer create` / `peer rotate` is not allowed to see travels in a file: `<home>/peer-secrets/<name>.secret`
// (file 0600, folder 0700, never through a symlink). `peer add --secret-file` reads one the same strict way and deletes it once the
// secret is stored; the bridge deletes the creator's copy when the first message of that connection arrives (inbound-peer.ts).
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { PeerName } from '@talos-app/protocol'

export const PEER_SECRETS_DIR = 'peer-secrets'
/** The file for `name`; throws for anything that is not a PeerName, so a name from a hand-edited record never becomes another path. */
export function peerSecretFile(home: string, name: string): string {
  if (!PeerName.safeParse(name).success) throw new Error(`"${name}" is not a peer name`)
  return join(home, PEER_SECRETS_DIR, `${name}.secret`)
}

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** Throws why a secret can't be written for `name` (a symlink in the way), before anything is made. */
export function checkPeerSecretPath(home: string, name: string): void {
  const dir = join(home, PEER_SECRETS_DIR)
  const path = peerSecretFile(home, name)
  if (isLink(dir)) throw new Error(`${dir} is a symlink, so no secret is written there.`)
  if (isLink(path)) throw new Error(`${path} is a symlink, so no secret is written there.`)
}

/** Writes `secret` to the file for `name` (replacing an earlier one) and returns its path; throws an Error saying why it refused. */
export function writePeerSecretFile(home: string, name: string, secret: string): string {
  const dir = join(home, PEER_SECRETS_DIR)
  const path = peerSecretFile(home, name)
  checkPeerSecretPath(home, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  // a new file made with O_EXCL (never an existing one, never through a link), then moved over the old one
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeSync(fd, `${secret}\n`)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, path)
  } catch (e) {
    unlinkSync(tmp)
    throw e
  }
  return path
}

/** Which file was read: the device and inode of the handle, so a later delete can tell it is still the same file. */
export type FileId = { dev: number; ino: number }

/** Reads a secret file a person handed over: a regular file (not a symlink), this user's own, mode 0600 or stricter. Else throws why. */
export function readSecretFile(path: string): { secret: string; id: FileId } {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new Error(
      code === 'ELOOP'
        ? `${path} is a symlink; a secret file must be a regular file.`
        : `${path} can't be read (${code ?? (e as Error).message}).`,
    )
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) throw new Error(`${path} is not a regular file.`)
    if (typeof process.getuid === 'function' && st.uid !== process.getuid())
      throw new Error(`${path} is not owned by this user.`)
    if ((st.mode & 0o077) !== 0) throw new Error(`${path} must be mode 0600 or stricter (chmod 600 it).`)
    return { secret: readFileSync(fd, 'utf8').trim(), id: { dev: st.dev, ino: st.ino } }
  } finally {
    closeSync(fd)
  }
}

/** Deletes `path` only if it is still the file `id` names: 'changed' keeps a file that was swapped in after the read. */
export function deleteIfSame(path: string, id: FileId): 'deleted' | 'changed' | 'gone' {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
    throw e
  }
  if (st.isSymbolicLink() || st.dev !== id.dev || st.ino !== id.ino) return 'changed'
  return deleteFile(path) ? 'deleted' : 'gone'
}

/** Deletes the file for `name` and any `<name>.secret.*.tmp` a failed write left; true when anything was there. */
export function deletePeerSecretFile(home: string, name: string): boolean {
  let any = deleteFile(peerSecretFile(home, name))
  const dir = join(home, PEER_SECRETS_DIR)
  let left: string[] = []
  try {
    left = readdirSync(dir)
  } catch {
    // no folder: nothing left
  }
  for (const f of left)
    if (f.startsWith(`${name}.secret.`) && f.endsWith('.tmp') && deleteFile(join(dir, f))) any = true
  return any
}

export function deleteFile(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}
