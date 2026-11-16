// For a test file whose point is durability (a kill or a crash mid-write, then reopen and assert what survived): the product's
// syncing (FULL with fullfsync, src/sqlite-sync.ts), for that file only (src/sqlite-test-seam.ts; the preload sets NORMAL for every other file).
import { afterAll, beforeAll } from 'bun:test'
import { SQLITE_TEST } from '../src/sqlite-test-seam.ts'

export function durableSqlite(): void {
  let was: typeof SQLITE_TEST.synchronous = null
  beforeAll(() => {
    was = SQLITE_TEST.synchronous
    SQLITE_TEST.synchronous = null
  })
  afterAll(() => {
    SQLITE_TEST.synchronous = was
  })
}
