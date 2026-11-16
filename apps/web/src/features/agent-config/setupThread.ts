// "Set up my agent": starts or resumes the optional setup interview in one Setup thread. The thread id is fixed, so
// there is one per agent however many times Start is tapped, and two taps at once share one run. The interview itself is
// the kit's talos-interview skill; this only makes the thread and sends the one message that asks the agent to begin.
import type { ThreadT } from '@talos-app/protocol'
import { type TalosClient, TalosClientError } from '../../lib/client.ts'
import { wireThreads } from '../threads/manage/useThreadPatch.ts'

// A thread id no thread name can slug to (slugThreadId never emits a double underscore at this length), so a thread the
// owner called "Setup" can never be mistaken for this one, and a thread with this id is the Setup thread whatever the owner
// has renamed it to.
export const SETUP_THREAD_ID = 'talos__setup'
const SETUP_THREAD_NAME = 'Setup'
export const SETUP_KICKOFF = 'Set up my agent. Start the setup interview, or pick it up where we left off.'

export type SetupStart = { threadId: typeof SETUP_THREAD_ID; created: boolean; asked: boolean }

const find = (client: TalosClient) => client.store.getState().threads.find((t) => t.id === SETUP_THREAD_ID)

/** The agent has not answered the last Start yet, so another Start would only ask twice. */
function kickoffPending(client: TalosClient): boolean {
  const last = client.store.getState().messages[SETUP_THREAD_ID]?.at(-1)
  return last?.author === 'owner' && last.text === SETUP_KICKOFF
}

async function ensureThread(client: TalosClient): Promise<boolean> {
  const existing = find(client)
  if (existing && !existing.archived) return false
  const apply = (latest: ThreadT[]): ThreadT[] =>
    existing
      ? latest.map((t) => (t.id === SETUP_THREAD_ID ? { ...t, archived: false } : t))
      : [
          ...latest,
          {
            id: SETUP_THREAD_ID,
            name: SETUP_THREAD_NAME,
            kind: 'fixed',
            order: latest.length,
            notify: 'all',
            voice_context: 'recent',
            archived: false,
            created_at: new Date().toISOString(),
          },
        ]
  try {
    const base = client.store.getState().threads
    await client.patchConfig({ threads: wireThreads(apply(base), false, { base }) })
  } catch (e) {
    // Another device made it at the same moment: the thread is there now, which is all that was wanted.
    // Not created by this client, so the kickoff goes only if the other device's has not been sent.
    const there = find(client)
    if (!(e instanceof TalosClientError && e.code === 'config_conflict' && there && !there.archived)) throw e
    return false
  }
  return !existing
}

// One run in flight per client (per agent connection), never one for the whole page: a run still finishing for one client
// must not be handed to another, which would then return without its own thread or kickoff.
const running = new WeakMap<TalosClient, Promise<SetupStart>>()

export function startSetup(client: TalosClient): Promise<SetupStart> {
  const inFlight = running.get(client)
  if (inFlight) return inFlight
  const run = (async () => {
    const created = await ensureThread(client)
    const asked = created || !kickoffPending(client)
    if (asked) await client.sendMessage({ threadId: SETUP_THREAD_ID, text: SETUP_KICKOFF })
    return { threadId: SETUP_THREAD_ID, created, asked } as SetupStart
  })()
  running.set(client, run)
  const clear = () => {
    if (running.get(client) === run) running.delete(client)
  }
  run.then(clear, clear)
  return run
}

export const SETUP_SKIP = 'Skip the setup interview for now. I can start it later from Settings → Agent.'

/**
 * The first-run card's Skip: the Setup thread is archived (it stays, so first run never starts again: any Setup thread,
 * archived or not, means this agent was offered setup) and the agent is told, so it does not carry on asking.
 * Settings → Agent → "Set up my agent" brings the thread back and picks up the interview.
 */
export async function skipSetup(client: TalosClient): Promise<void> {
  // told first: a question the agent is posting now still lands in the Setup thread, not the default one. Once: a retry
  // after a failed archive does not tell it twice.
  const msgs = client.store.getState().messages[SETUP_THREAD_ID] ?? []
  const kickoff = msgs.findLastIndex((m) => m.author === 'owner' && m.text === SETUP_KICKOFF)
  if (!msgs.slice(kickoff + 1).some((m) => m.author === 'owner' && m.text === SETUP_SKIP))
    await client.sendMessage({ threadId: SETUP_THREAD_ID, text: SETUP_SKIP })
  const base = client.store.getState().threads
  const there = base.find((t) => t.id === SETUP_THREAD_ID)
  if (there && !there.archived)
    await client.patchConfig({
      threads: wireThreads(
        base.map((t) => (t.id === SETUP_THREAD_ID ? { ...t, archived: true } : t)),
        false,
        { base },
      ),
    })
}
