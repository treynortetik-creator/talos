// POST /api/problems. Its own small fetch rather than `createHttp`: a 429 here is a status to keep the report for, not
// the fixed sentence `createHttp` turns it into.
import type { ProblemT } from '@talos-app/protocol'
import type { PostResult } from './queue.ts'

export async function postProblem(
  problem: ProblemT,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<PostResult> {
  let res: Response
  try {
    res = await fetchImpl('/api/problems', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Talos-CSRF': '1' },
      body: JSON.stringify(problem),
    })
  } catch {
    return { ok: false, network: true }
  }
  if (res.ok) return { ok: true }
  const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined
  return {
    ok: false,
    status: res.status,
    ...(typeof body?.error === 'string' ? { error: body.error } : {}),
  }
}
