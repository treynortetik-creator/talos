// Forwarded email (personal): a Gmail filter applies the label `Talos/Inbound`; this connection's own Apps Script sends
// ONLY labelled mail, with the full body (up to 4,000 characters), as `email.forwarded` at high priority. It is the Gmail
// script with the inbox query step removed, so the transport, signing and claim flow are the ones the Gmail module owns.
import type { ModuleExtras } from '../generic/common.ts'
import { normalizeGmail } from '../gmail/normalize.ts'
import { verifyStandard } from '../standard-webhooks.ts'
import type { IntegrationModule } from '../types.ts'
import { renderForwardScript } from './apps-script.ts'
import { forwardSetup } from './setup.ts'

export { renderForwardScript }

export const integration: IntegrationModule & ModuleExtras = {
  id: 'forward',
  setup: forwardSetup,
  verify: verifyStandard,
  claim: true,
  normalize: (raw, conn) =>
    normalizeGmail('forward', raw, conn).map((e) =>
      e.kind === 'gmail.message'
        ? {
            ...e,
            kind: 'email.forwarded',
            priority: 'high' as const,
            dedup_key: e.dedup_key.replace(/^gmail:/, 'forward:'),
          }
        : { ...e, dedup_key: e.dedup_key.replace(/^gmail:/, 'forward:') },
    ),
  toggle: (key, enabled, event) => (key === 'forwarded' && event.kind === 'email.forwarded' ? enabled : true),
  sample: () => ({
    v: 1,
    account: 'owner@example.com',
    truncated: false,
    items: [
      {
        message_id: `test_${Date.now()}`,
        thread_id: 'test_thread',
        from: 'Talos Test <test@example.com>',
        to: 'owner+talos@example.com',
        subject: 'Test forward from Talos',
        date: new Date().toISOString(),
        unread: true,
        starred: false,
        labels: ['Talos/Inbound'],
        forwarded: true,
        text: 'If you can read this in your Inbox, forwarding works.',
        link: 'https://mail.google.com/mail/u/0/#all/test_thread',
      },
    ],
  }),
}
