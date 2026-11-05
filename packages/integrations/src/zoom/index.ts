// Zoom (work): Marketplace app webhook. Verifier and URL validation are built; setup says admin approval is likely.
import { isRecord, type ModuleExtras, parseJson } from '../generic/common.ts'
import type { IntegrationModule } from '../types.ts'
import { normalizeZoom } from './normalize.ts'
import { zoomSetup } from './setup.ts'
import { verifyZoom, zoomHandshake } from './verify.ts'

export const integration: IntegrationModule & ModuleExtras = {
  id: 'zoom',
  setup: zoomSetup,
  verify: verifyZoom,
  normalize: normalizeZoom,
  // Spec 7.1 step 2: only a finished recording is worth storing.
  prefilter: (raw) => {
    const j = parseJson(raw)
    return isRecord(j) && j.event === 'recording.completed'
  },
  verifySecretField: 'secret_token',
  handshake: (raw, conn) => zoomHandshake(raw, conn),
  toggle: (key, enabled, event) => (key === 'recordings' && event.kind === 'zoom.recording_ready' ? enabled : true),
}
