// The live session's Claude Code version, from the MCP `initialize` clientInfo (P-observed `claude-code` / 2.1.312), kept in
// `apps/live-cc-version` so a scan on another version stops and `app_show` can warn (MCP-APPS-SPEC M5.1 step 1).

import { writeFileAtomic } from '../fsutil.ts'
import type { Logger } from '../log.ts'
import { appPaths } from './paths.ts'

export function recordLiveVersion(home: string, version: string | undefined, log?: Logger): void {
  if (!version || !/^[0-9][0-9A-Za-z.+-]{0,39}$/.test(version)) return
  try {
    writeFileAtomic(appPaths(home).liveVersion, `${version}\n`, 0o600)
  } catch (e) {
    log?.warn('live version not recorded', { error: (e as Error).message })
  }
}
