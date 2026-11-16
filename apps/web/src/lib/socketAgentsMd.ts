// The socket AgentsMdClient: one signed `agents_md.read` or `agents_md.write`, the answer routed back by `request_id`. A
// refusal from the relay or the Mac is an `error{ref}` and rejects with `TalosClientError` (askRead in socket-requests.ts).
//
// The relay carries the answer and can write anything into it, so the app checks it against what it asked: it must be for
// the thread asked, the text must fit the cap, and its sha must be the sha256 of that text. A relay that slipped lines into
// the text under the file's real sha would otherwise have the owner sign them in their next save. A save's answer must be
// the text that was sent, saved. Anything else is refused, never shown or saved over.
import { AGENTS_MD_DIFF_MAX, AGENTS_MD_MAX_BYTES, AGENTS_MD_WORDING, newUlid } from '@talos-app/protocol'
import { TalosClientError } from './client.ts'
import type { AgentsMdClient, AgentsMdFile } from './v2Client.ts'

export type SocketAgentsMdDeps = {
  /** Signs and sends `frame`, resolves with the `agents_md.file` that carries its `request_id`. */
  ask(frame: Record<string, unknown>): Promise<Record<string, unknown>>
}

const SHA = /^[0-9a-f]{64}$/
const refuse = (): never => {
  throw new TalosClientError('bad_frame', AGENTS_MD_WORDING.refused)
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function toAgentsMdFile(
  f: Record<string, unknown>,
  threadId: string,
  sent?: { text: string },
): Promise<AgentsMdFile> {
  if (f.thread_id !== threadId || typeof f.exists !== 'boolean') refuse()
  if (f.sha !== null && !(typeof f.sha === 'string' && SHA.test(f.sha))) refuse()
  if (f.text !== undefined && (typeof f.text !== 'string' || f.text.length > AGENTS_MD_MAX_BYTES)) refuse()
  const tooLarge = f.too_large === true
  // an editor needs a sha to save over a file that is there, and text to show
  if (f.exists === true && !tooLarge && (f.sha === null || typeof f.text !== 'string')) refuse()
  if (f.exists === true && !tooLarge && (await sha256(f.text as string)) !== f.sha) refuse()
  if (sent && (f.saved !== true || f.exists !== true || tooLarge || f.text !== sent.text)) refuse()
  return {
    threadId,
    exists: f.exists as boolean,
    sha: f.exists === true && !tooLarge ? (f.sha as string) : null,
    ...(typeof f.text === 'string' && !tooLarge ? { text: f.text } : {}),
    tooLarge,
    ...(typeof f.outside_diff === 'string' && f.outside_diff !== ''
      ? { outsideDiff: f.outside_diff.slice(0, AGENTS_MD_DIFF_MAX + 200) }
      : {}),
    saved: f.saved === true,
  }
}

export function createSocketAgentsMd(d: SocketAgentsMdDeps): AgentsMdClient {
  return {
    async read(threadId) {
      return await toAgentsMdFile(
        await d.ask({ type: 'agents_md.read', request_id: newUlid(), thread_id: threadId }),
        threadId,
      )
    },
    async write(threadId, text, baseSha) {
      const f = await d.ask({
        type: 'agents_md.write',
        request_id: newUlid(),
        thread_id: threadId,
        text,
        base_sha: baseSha,
      })
      return await toAgentsMdFile(f, threadId, { text })
    },
  }
}
