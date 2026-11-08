// Gmail on a work account (work): the Gmail module with category `work`. Ships disabled; routes to the work thread.
import { isRecord, type ModuleExtras, parseJson } from '../generic/common.ts'
import { gmailToggle, normalizeGmail } from '../gmail/normalize.ts'
import { verifyGmail } from '../gmail/verify.ts'
import type { IntegrationModule } from '../types.ts'
import { gmailWorkSetup } from './setup.ts'

export const integration: IntegrationModule & ModuleExtras = {
  claim: true,
  id: 'gmail_work',
  setup: gmailWorkSetup,
  verify: verifyGmail,
  // Spec 7.1 step 2: an empty batch is not stored.
  prefilter: (raw) => {
    const j = parseJson(raw)
    return isRecord(j) && Array.isArray(j.items) && j.items.length > 0
  },
  normalize: (raw, conn) => normalizeGmail('gmail_work', raw, conn),
  toggle: gmailToggle,
}
