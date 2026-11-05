// Claude Code fixtures (docs/CLAUDE-CODE.md C10 "Tests"): permission_request params shaped by the channels reference
// rules, one per rule. See fixtures/claude-code/README.md.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PermissionHiddenReason, PermissionRequestT } from '@talos-app/protocol'

const here = dirname(fileURLToPath(import.meta.url))
export const CLAUDE_CODE_FIXTURE_DIR = join(here, '..', 'fixtures', 'claude-code')

export type PermissionFixture = {
  name: string
  /** The documented rule the case exercises. */
  rule: string
  params: PermissionRequestT
  /** Hidden reasons the protocol must find. */
  hidden: PermissionHiddenReason[]
  /** Whether the card may show Allow. */
  allow: boolean
  /** The bridge already saw this id in the session. */
  repeated?: boolean
}

export const permissionFixtures: readonly PermissionFixture[] = Object.freeze(
  (
    JSON.parse(readFileSync(join(CLAUDE_CODE_FIXTURE_DIR, 'permission-requests.json'), 'utf8')) as {
      cases: PermissionFixture[]
    }
  ).cases,
)

export function permissionFixture(name: string): PermissionFixture {
  const f = permissionFixtures.find((x) => x.name === name)
  if (!f) throw new Error(`no permission fixture named ${name}`)
  return structuredClone(f)
}
