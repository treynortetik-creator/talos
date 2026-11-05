// A failed lazy chunk after a deploy ("Importing a module script failed"). Kept apart from the boundaries so the problem
// reporter can recognise it without importing them.
const CHUNK_RE = /dynamically imported module|Loading chunk|Importing a module script failed/i

export function isChunkError(error: Error): boolean {
  return CHUNK_RE.test(error.message)
}
