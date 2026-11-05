import type { NormalizedEventT } from '@talos-app/protocol'
import { clean, isRecord, makeEvent, parseJson, toIso } from '../generic/common.ts'
import type { NormalizeConnection, RawDelivery } from '../types.ts'

/** `recording.completed` only (spec 7.5: `transcript_completed` is unreliable). Download tokens and file URLs are never kept. */
export function normalizeZoom(raw: RawDelivery, conn: NormalizeConnection): NormalizedEventT[] {
  const j = parseJson(raw)
  if (!isRecord(j) || j.event !== 'recording.completed') return []
  const obj = isRecord(j.payload) && isRecord(j.payload.object) ? j.payload.object : undefined
  if (!obj) return []
  const topic = clean(obj.topic, 160) || 'Untitled meeting'
  const uuid = clean(obj.uuid, 120)
  const files = Array.isArray(obj.recording_files) ? obj.recording_files.length : 0
  return [
    makeEvent(conn, 'zoom', {
      kind: 'zoom.recording_ready',
      title: `Recording ready: ${topic}`,
      summary: `The recording of "${topic}" is ready${files ? ` (${files} file${files === 1 ? '' : 's'})` : ''}.`,
      url: obj.share_url,
      actor: typeof obj.host_email === 'string' ? { email: obj.host_email } : {},
      ts: toIso(obj.start_time ?? (typeof j.event_ts === 'number' ? j.event_ts : undefined), raw.receivedAt),
      priority: 'low',
      dedup_key: `zoom:${j.event}:${uuid || topic}`,
    }),
  ]
}
