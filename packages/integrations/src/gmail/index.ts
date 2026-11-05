import type { ModuleExtras } from '../generic/common.ts'
import type { IntegrationModule } from '../types.ts'
import { gmailToggle, normalizeGmail } from './normalize.ts'
import { gmailPersonalSetup } from './setup.ts'
import { verifyGmail } from './verify.ts'

export { DEFAULT_FORWARD_LABEL, DEFAULT_QUERY, GMAIL_SCRIPT_TEMPLATE, renderGmailScript } from './apps-script.ts'

export const integration: IntegrationModule & ModuleExtras = {
  claim: true,
  id: 'gmail',
  setup: gmailPersonalSetup,
  verify: verifyGmail,
  normalize: (raw, conn) => normalizeGmail('gmail', raw, conn),
  toggle: gmailToggle,
  sample: () => ({
    v: 1,
    account: 'owner@example.com',
    truncated: false,
    items: [
      {
        message_id: `test_${Date.now()}`,
        thread_id: 'test_thread',
        from: 'Talos Test <test@example.com>',
        to: 'owner@example.com',
        subject: 'Test message from Talos',
        date: new Date().toISOString(),
        unread: true,
        starred: false,
        labels: [],
        forwarded: false,
        text: 'If you can read this in your Inbox, the Gmail connection works.',
        link: 'https://mail.google.com/mail/u/0/#all/test_thread',
      },
    ],
  }),
}
