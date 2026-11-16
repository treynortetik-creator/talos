// A direct upload of a voice note (the fallback when it could not be saved on the device) with a deadline, like the flush's.
import type { AttachmentRefT } from '@talos-app/protocol'
import type { TalosClient, UploadMeta } from './client.ts'
import { voiceUploadDeadlineMs } from './socket-constants.ts'

/** `uploadMedia` that gives up at the voice-upload deadline (it grows with the size). Raced as well as signalled: an upload
 * that never answers, and ignores its signal, must not hold the caller. */
export async function uploadVoiceWithDeadline(
  client: Pick<TalosClient, 'uploadMedia'>,
  blob: Blob,
  meta: Omit<UploadMeta, 'signal'>,
): Promise<AttachmentRefT> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), voiceUploadDeadlineMs(blob.size))
  try {
    return await new Promise<AttachmentRefT>((resolve, reject) => {
      ctl.signal.addEventListener('abort', () => reject(new Error('Upload timed out')), { once: true })
      client.uploadMedia(blob, { ...meta, signal: ctl.signal }).then(resolve, reject)
    })
  } finally {
    clearTimeout(timer)
  }
}
