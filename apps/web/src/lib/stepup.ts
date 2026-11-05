// Trust mode and the passkey step (docs/SECURITY.md "Trust mode"). With trust mode on, the relay no longer asks for a fresh
// passkey tap for work integrations, the permission relay or revoking a device. The app does not decide that alone: it tries
// the change without a token first, and only taps the passkey if the relay still asks (an older relay, or trust mode off
// since the app last synced). Without trust mode the old order stays: tap, then send.
import { trustOn } from '@talos-app/protocol'
import { type TalosClient, TalosClientError } from './client.ts'
import { HttpError } from './http.ts'

/** True when a refusal means "this needs a passkey step-up", from the socket (`error{code}`) or the HTTP route (403). */
export function needsStepup(e: unknown): boolean {
  if (e instanceof TalosClientError) return e.code === 'stepup_required' || e.code === 'stepup_invalid'
  if (e instanceof HttpError && e.status === 403) {
    const err = (e.body as { error?: unknown } | undefined)?.error
    return err === 'stepup_invalid' || err === 'stepup_required'
  }
  return false
}

export async function withStepup<T>(
  client: Pick<TalosClient, 'stepup'>,
  config: Parameters<typeof trustOn>[0],
  purpose: string,
  run: (token: string | undefined) => Promise<T>,
): Promise<T> {
  if (trustOn(config)) {
    try {
      return await run(undefined)
    } catch (e) {
      if (!needsStepup(e)) throw e
    }
  }
  return run(await client.stepup(purpose))
}
