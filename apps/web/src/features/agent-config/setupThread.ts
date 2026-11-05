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
    await client.patchConfig({ threads: wireThreads(apply(client.store.getState().threads), false) })
  } catch (e) {
    // Another device made it at the same moment: the thread is there now, which is all that was wanted.
    // Not created by this client, so the kickoff goes only if the other device's has not been sent.
    const there = find(client)
    if (!(e instanceof TalosClientError && e.code === 'config_conflict' && there && !there.archived)) throw e
    return false
  }
  return !existing
}

let running: Promise<SetupStart> | null = null

export function startSetup(client: TalosClient): Promise<SetupStart> {
  if (running) return running
  const run = (async () => {
    const created = await ensureThread(client)
    const asked = created || !kickoffPending(client)
    if (asked) await client.sendMessage({ threadId: SETUP_THREAD_ID, text: SETUP_KICKOFF })
    return { threadId: SETUP_THREAD_ID, created, asked } as SetupStart
  })()
  running = run
  const clear = () => {
    if (running === run) running = null
  }
  run.then(clear, clear)
  return run
}
