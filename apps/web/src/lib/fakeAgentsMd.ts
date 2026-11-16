// The thread settings' AGENTS.md on a fake Mac (VITE_FAKE=1 and the web tests): the real Mac's rules in small. A thread with
// a folder of its own has one; any other thread is refused with the Mac's sentence. A save over a file that changed since it
// was loaded is refused. A change made "at the Mac" (`changeOnMac`) shows as a diff against the last save from Settings.
import { AGENTS_MD_MAX_BYTES, AGENTS_MD_WORDING, lineDiff } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { AgentsMdClient, AgentsMdFile } from './v2Client.ts'

export type FakeAgentsMdSeed = {
  /** AGENTS.md of the threads that have one already, by thread id. */
  files?: Record<string, string>
}

export type FakeAgentsMd = AgentsMdClient & {
  /** The file changes on the Mac, as when the agent edits its own instructions. */
  changeOnMac(threadId: string, text: string | null): void
  /** The next call rejects with this sentence, then behaves again. */
  failNextWith(message: string): void
  /** What the fake Mac holds now, for tests. */
  onMac(threadId: string): string | null | undefined
  readonly calls: Array<{ op: 'read' | 'write'; threadId: string; text?: string; baseSha?: string | null }>
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createFakeAgentsMd(
  deps: {
    macOnline: () => boolean
    /** The thread has a folder of its own (a dedicated thread with a folder set), by the config the fake Mac holds. */
    ownFolder: (threadId: string) => boolean
  },
  seed: FakeAgentsMdSeed = {},
): FakeAgentsMd {
  const files = new Map<string, string | null>(Object.entries(seed.files ?? {}))
  const saved = new Map<string, string>()
  const calls: FakeAgentsMd['calls'] = []
  let failNext: string | null = null
  const gate = (threadId: string) => {
    if (!deps.macOnline()) throw new TalosClientError('mac_offline')
    if (failNext !== null) {
      const message = failNext
      failNext = null
      throw new TalosClientError('bad_frame', message)
    }
    if (!deps.ownFolder(threadId)) throw new TalosClientError('bad_frame', AGENTS_MD_WORDING.shared)
  }
  const answer = async (threadId: string, isSave: boolean): Promise<AgentsMdFile> => {
    const text = files.get(threadId) ?? null
    const last = saved.get(threadId)
    const diff = last !== undefined ? lineDiff(last, text ?? '') : ''
    return {
      threadId,
      exists: text !== null,
      sha: text === null ? null : await sha256(text),
      ...(text !== null ? { text } : {}),
      tooLarge: false,
      ...(diff ? { outsideDiff: diff } : {}),
      saved: isSave,
    }
  }
  return {
    calls,
    changeOnMac(threadId, text) {
      files.set(threadId, text)
    },
    failNextWith(message) {
      failNext = message
    },
    onMac: (threadId) => files.get(threadId),
    async read(threadId) {
      calls.push({ op: 'read', threadId })
      gate(threadId)
      return answer(threadId, false)
    },
    async write(threadId, text, baseSha) {
      calls.push({ op: 'write', threadId, text, baseSha })
      gate(threadId)
      if (new TextEncoder().encode(text).length > AGENTS_MD_MAX_BYTES)
        throw new TalosClientError('too_large', AGENTS_MD_WORDING.tooLarge)
      const now = files.get(threadId) ?? null
      if ((now === null ? null : await sha256(now)) !== baseSha)
        throw new TalosClientError('stale', AGENTS_MD_WORDING.conflict)
      files.set(threadId, text)
      saved.set(threadId, text)
      return answer(threadId, true)
    },
  }
}
