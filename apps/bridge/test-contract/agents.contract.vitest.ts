// defineAgentsBridgeContract (docs/SUBAGENTS.md 5.3) against the REAL bridge half: ModLink (MAC, seq, live window, lapse
// timer) + ModAgents (validate, hold, throttle, beat, trim) + frames-out's sessionAgentsFrame, on a fake clock. Every
// sync is a real signed `talos_mod_sync` body; a mod that lapsed says hello again first, as the real mod must.
//
// `endSession` is what the mod does on `session.end` (plugins/talos-app-mod hooks/lib/agents.ts AgentsCollector): its
// next sync carries an empty snapshot for the ending session. `durableText` is every file the bridge half wrote under its
// home (the log, the key file). The history store is bun:sqlite, so the "never in history.sqlite or the outbox" half is
// apps/bridge/test/agents.test.ts (bun), against the live Bridge.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentsSnapshotT, emptyAgentsSnapshot, parseFrame } from '@talos-app/protocol'
import { defineAgentsBridgeContract, fakeClock } from '@talos-app/testkit'
import { sessionAgentsFrame } from '../src/frames-out.ts'
import { createLogger } from '../src/log.ts'
import { fileKeyStore, ModLink } from '../src/mod/link.ts'
import { helloArgs, signedSync } from '../test/mod-sign.ts'

function filesText(dir: string): string {
  let out = ''
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    out += statSync(p).isDirectory() ? filesText(p) : readFileSync(p, 'utf8')
  }
  return out
}

defineAgentsBridgeContract('real ModLink + frames-out', () => {
  const clock = fakeClock('2026-10-30T12:00:00.000Z')
  const home = mkdtempSync(join(tmpdir(), 'talos-agents-contract-'))
  const keyPath = join(home, 'mod.key')
  const frames: Array<{ at: number; frame: Record<string, unknown> }> = []
  const link = new ModLink({
    clock,
    log: createLogger(home, 'debug'),
    keys: fileKeyStore(keyPath),
    sink: {
      state: () => {},
      inventory: () => {},
      agents: (a) => frames.push({ at: clock.now(), frame: sessionAgentsFrame(clock.now(), a) }),
    },
  })
  let seq = 0
  let lastSession = 'sess_contract'
  const key = () => readFileSync(keyPath, 'utf8').trim()
  const sync = (agents?: unknown) => {
    if (!link.live) {
      const h = link.hello(helloArgs(key(), clock.now()))
      if (!h.ok) throw new Error(`hello refused: ${h.message}`)
      seq = 0
    }
    const body: Record<string, unknown> = agents === undefined ? {} : { agents }
    const r = link.sync(signedSync(key(), ++seq, body))
    if (!r.ok) throw new Error(`sync refused: ${r.message}`)
    const sid = (agents as { session_id?: unknown } | undefined)?.session_id
    if (typeof sid === 'string') lastSession = sid
  }
  return {
    clock,
    sync,
    endSession: () => sync(emptyAgentsSnapshot(lastSession, new Date(clock.now()).toISOString())),
    emitted: () =>
      frames.map(({ at, frame }) => {
        const p = parseFrame(frame, { direction: 'bridge_to_relay' })
        if (!p.ok || p.frame.type !== 'session.agents')
          throw new Error('the bridge built a session.agents that does not parse')
        return { at, agents: p.frame.agents as AgentsSnapshotT }
      }),
    durableText: () => filesText(home),
    stop: () => {
      link.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
})
