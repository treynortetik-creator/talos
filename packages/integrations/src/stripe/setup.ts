import type { SetupSpecT } from '@talos-app/protocol'

export const stripeSetup: SetupSpecT = {
  id: 'stripe',
  name: 'Stripe',
  category: 'personal',
  icon: 'credit-card',
  blurb: 'Payments, disputes and cancelled subscriptions.',
  default_thread: 'inbox',
  filters: [
    { key: 'payments', label: 'Payments', default: true },
    { key: 'disputes', label: 'Disputes', default: true },
    { key: 'other', label: 'Cancelled subscriptions and the rest', default: true },
  ],
  connect: [
    {
      type: 'text',
      md: '**1.** In the Stripe dashboard add a webhook endpoint with the address below and these events: checkout.session.completed, invoice.paid, charge.dispute.created, customer.subscription.deleted. **2.** Paste its signing secret (starts with `whsec_`).',
    },
    { type: 'copy', label: 'Endpoint URL', value_template: '{{HOOK_URL}}', secret: false },
    {
      type: 'field',
      key: 'signing_secret',
      label: 'Signing secret',
      secret: true,
      pattern: '^whsec_[A-Za-z0-9+/=_-]{16,}$',
    },
  ],
  test_hint: 'Send a test event from the Stripe dashboard.',
}
