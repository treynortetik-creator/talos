import type { SetupSpecT } from '@talos-app/protocol'

export const calendlySetup: SetupSpecT = {
  id: 'calendly',
  name: 'Calendly',
  category: 'personal',
  icon: 'calendar',
  blurb: 'A note when someone books or cancels. Needs a paid Calendly plan.',
  default_thread: 'inbox',
  filters: [
    { key: 'booked', label: 'New bookings', default: true },
    { key: 'canceled', label: 'Cancellations', default: true },
  ],
  connect: [
    {
      type: 'text',
      md: '**1.** Create a personal access token in Calendly (Integrations, API & webhooks). Webhooks need a paid plan. **2.** Paste it below. {agent} keeps the token until setup finishes.',
    },
    {
      type: 'link',
      label: 'Open Calendly integrations',
      href_template: 'https://calendly.com/integrations/api_webhooks',
    },
    { type: 'field', key: 'token', label: 'Personal access token', secret: true },
  ],
  test_hint: 'Book a slot on your own Calendly page.',
}
