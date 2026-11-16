// The supervisor's wiring for Main's first start with nobody at the pane (first-start.ts), split out of cli.ts's runSupervisor:
// the status and one-line state it publishes, root's launch approval read at each start, the security notes kept for the
// owner, the tray's token handed to each launch, and the restart a new token makes.
import { existsSync } from 'node:fs'
import type { MainLaunchConfig, MainStatus, PtyHost } from '@talos-app/protocol'
import { isTalosFolder, launchIsApproved } from './launch-approval.ts'
import type { MainSupervisor } from './main.ts'
import { type MainStateExtras, mainStateText, writeFirstStartNotes, writeMainState } from './main-state.ts'
import {
  readOAuthToken,
  type TokenRead,
  TokenRestart,
  tokenIdentity,
  tokenStamp,
  withOAuthToken,
} from './oauth-token.ts'

type Audit = (event: string, fields?: Record<string, string>) => void

export function firstStartWiring(
  home: string,
  userHome: string,
  audit: Audit,
  deps: {
    readConfig: (home: string, userHome: string) => MainLaunchConfig | { error: string }
    configPath: string
    statusPath: string
    writePrivate: (path: string, text: string) => void
  },
) {
  // the tray's token file: read when a start needs it; only why a file was refused is audited, once per version of it
  let tokenSaid = ''
  const token = (): TokenRead => {
    const r = readOAuthToken(home)
    if ('refused' in r && tokenSaid !== r.stamp) audit('oauth_token_refused', { why: r.refused })
    tokenSaid = tokenStamp(r)
    return r
  }
  return {
    /** `env` naming the token's file for the launch to read (never the token itself). */
    withToken: (env: Record<string, string>) => withOAuthToken(env, token(), home),
    publish: (s: MainStatus, extras?: MainStateExtras) => {
      deps.writePrivate(
        deps.statusPath,
        `${JSON.stringify({ ...s, supervisor: { pid: process.pid, updated: new Date().toISOString() } })}\n`,
      )
      // the one line the Windows tray reads (main-state.ts), from the same status
      writeMainState(home, mainStateText(s, extras))
    },
    firstStart: {
      approved: (cfg: Parameters<typeof launchIsApproved>[2]) => {
        const r = launchIsApproved(deps.configPath, () => deps.readConfig(home, userHome), cfg)
        if (!r.ok) audit('launch_not_approved', { why: r.why })
        return r.ok
      },
      talosFolder: (dir: string) => isTalosFolder(dir),
    },
    notesShown: (text: string[]) => {
      try {
        writeFirstStartNotes(home, text)
        audit('first_start_notes', { file: 'run/first-start-notes' })
        return true
      } catch (e) {
        audit('first_start_notes_failed', { error: String((e as Error)?.message ?? e) })
        return false
      }
    },
    /** A new token from the tray while Main shows it is signed out: Main starts again with it (oauth-token.ts TokenRestart). */
    tokenRestart: (main: MainSupervisor, host: Pick<PtyHost, 'clientActivities'>, stoppedFlag: string) =>
      new TokenRestart({
        identity: () => tokenIdentity(readOAuthToken(home)),
        eligible: () => {
          const st = main.status()
          return main.signedOut() || (st.phase === 'stopped' && st.stopReason !== 'user' && !existsSync(stoppedFlag))
        },
        clients: () => host.clientActivities(),
        phase: () => main.status().phase,
        stopped: () => existsSync(stoppedFlag),
        stop: () => main.stop({ quiet: true }),
        start: () => main.start(),
        audit,
      }),
  }
}
