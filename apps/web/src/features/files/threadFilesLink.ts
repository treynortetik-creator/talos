// Where Thread files lives, and whether to offer it. Kept apart from ThreadFiles.tsx so the nav and the thread sheet can link
// to it without pulling the folder browser into the first load (the screen itself is lazy).
import { FILES_FEATURE } from '@talos-app/protocol'
import { useTalos } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'

export const THREAD_FILES_TITLE = 'Thread files'

/** The path that opens one thread's folder. */
export const threadFilesPath = (threadId: string) => `/files?t=${encodeURIComponent(threadId)}`

/** Whether this Mac lists thread folders: the nav and the thread sheet offer Thread files only then. */
export function useThreadFilesOn(): boolean {
  return useFeature(FILES_FEATURE) !== 'off'
}

/** Whether the Mac's features are known yet: after a reload, presence is empty until the first `ready`, which is not "off". */
export function useFeaturesKnown(): boolean {
  return useTalos((s) => (s.readySeq ?? 0) > 0 || Boolean(s.presence.features_at))
}
