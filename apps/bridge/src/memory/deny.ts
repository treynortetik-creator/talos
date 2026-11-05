// The memory browser's hard denylist (docs/V2-FEATURES.md V5.1). Config cannot override it. A path is denied when ANY of
// its segments is denied, case-insensitively, so a folder called `venv` hides everything under it.

/** Files over this are never exposed, whatever `max_file_kb` says. */
export const MAX_EXPOSED_BYTES = 5 * 1024 * 1024
export const PRIVATE_MARKER = '.talos-private'

/** Case and Unicode-form folding (APFS ignores both): `Ｄ`, `ſ` and NFD spellings land on the name that is on disk. */
export const fold = (s: string) => s.normalize('NFKC').toLowerCase()

const EXACT = new Set(['node_modules', '__pycache__', 'venv', '.mcp.json'])
const SUFFIX = ['.pem', '.key', '.p12', '.db', '.env', '.kdbx']
const PREFIX = ['id_rsa', 'id_ed25519', 'credentials']

/** One path segment (a file or folder name). */
export function segmentDenied(segment: string): boolean {
  const s = fold(segment)
  if (s.startsWith('.')) return true // `.*`: .git, .env, .ssh, the private marker itself
  if (EXACT.has(s)) return true
  if (SUFFIX.some((x) => s.endsWith(x))) return true
  if (PREFIX.some((x) => s.startsWith(x))) return true
  if (s.includes('.keychain')) return true // *.keychain*
  if (s.includes('.sqlite')) return true // *.sqlite*
  if (s.startsWith('settings') && s.endsWith('.json')) return true // settings*.json
  return false
}

/** `a/b/c.md`: true when any segment is denied. */
export function pathDenied(rel: string): boolean {
  return rel.split('/').some(segmentDenied)
}
