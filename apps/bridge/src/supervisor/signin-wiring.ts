// The supervisor's own sign-in, wired to Main and the thread sessions (signin.ts has the flow; cli.ts calls this once).
import { existsSync } from 'node:fs'
import type { MainSupervisor } from './main.ts'
import { bunLoginPty, claudeAuthStatus, SignInDriver } from './signin.ts'
import type { WorkerManager } from './workers.ts'

export function signInDriverFor(a: {
  env: () => Record<string, string>
  claude: (env: Record<string, string>) => string | null
  main: Pick<MainSupervisor, 'signedOut' | 'status' | 'stop' | 'start'>
  stoppedFlag: string
  threads: () => { id: string }[] | null
  workers: Pick<WorkerManager, 'entry' | 'restart'>
  audit: (event: string, fields?: Record<string, string>) => void
  /** Default false: nothing can feed a login its code until the phone has a code field (signin.ts `startLogins`). */
  startLogins?: boolean
}): SignInDriver {
  return new SignInDriver({
    spawn: () => {
      const env = a.env()
      const claude = a.claude(env)
      if (!claude) throw new Error('no claude')
      return bunLoginPty(claude, env)
    },
    status: async () => {
      const env = a.env()
      const claude = a.claude(env)
      return claude ? claudeAuthStatus(claude, env) : 'unknown'
    },
    signedOut: () => a.main.signedOut(),
    // the thread sessions whose pane waits on a sign-in prompt
    signedOutThreads: () =>
      (a.threads() ?? []).filter((t) => a.workers.entry(t.id)?.needs_you?.kind === 'sign in').map((t) => t.id),
    ownerStopped: () => existsSync(a.stoppedFlag),
    // Main starts again quietly (the owner is not told it stopped), the way a new token restarts it (oauth-token.ts TokenRestart)
    restartMain: async () => {
      if (a.main.status().phase !== 'stopped') await a.main.stop({ quiet: true })
      if (!existsSync(a.stoppedFlag)) await a.main.start()
    },
    restartThread: (id) => a.workers.restart(id),
    audit: a.audit,
    // the owner sees the thread line and the tray's `main=signin`; this records why no restart followed
    tell: (what) => a.audit(what),
    startLogins: a.startLogins ?? false,
  })
}
