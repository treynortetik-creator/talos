/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// Replays captured memory frames as the Mac (no node APIs, so the browser harness shares it).
import { TalosClientError } from '../../src/lib/client.ts'

export type Step = { asked: string; frame?: Record<string, any>; error?: { code: string } }

/** An ask() that answers from captured frames by what is asked (type, root, path, offset, cursor, query). */
export function macFrom(steps: Step[]) {
  const asked: Array<Record<string, unknown>> = []
  const ask = async (frame: Record<string, unknown>, answer: string): Promise<Record<string, any>> => {
    asked.push(frame)
    const hit = steps.find((s) => {
      const f = s.frame
      if (!f || f.type !== answer) return false
      if (answer === 'memory.listing')
        return (
          (f.root_id ?? null) === frame.root_id &&
          (f.path ?? '') === (frame.path ?? '') &&
          (frame.cursor
            ? f.next_cursor !== undefined && matchesCursor(steps, s, String(frame.cursor))
            : !isLaterPage(steps, s))
        )
      if (answer === 'memory.file') return f.path === frame.path && f.offset === frame.offset
      return true
    })
    if (!hit?.frame) {
      const err = steps.find((s) => s.error && s.asked === answer.replace('listing', 'tree').replace('file', 'read'))
      throw new TalosClientError((err?.error?.code ?? 'memory_not_found') as never, 'refused')
    }
    return hit.frame
  }
  return { ask, asked }
}

function isLaterPage(steps: Step[], s: Step) {
  const same = steps.filter(
    (x) => x.frame?.type === 'memory.listing' && x.frame.root_id === s.frame?.root_id && x.frame.path === s.frame?.path,
  )
  return same[0] !== s
}
function matchesCursor(steps: Step[], s: Step, cursor: string) {
  const same = steps.filter(
    (x) => x.frame?.type === 'memory.listing' && x.frame.root_id === s.frame?.root_id && x.frame.path === s.frame?.path,
  )
  const i = same.indexOf(s)
  return i > 0 && same[i - 1]?.frame?.next_cursor === cursor
}
