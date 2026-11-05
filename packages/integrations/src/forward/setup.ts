import type { SetupSpecT } from '@talos-app/protocol'

export const forwardSetup: SetupSpecT = {
  id: 'forward',
  name: 'Forwarded email',
  category: 'personal',
  icon: 'mail-forward',
  blurb: 'Forward any email to your agent with one Gmail filter.',
  default_thread: 'inbox',
  filters: [{ key: 'forwarded', label: 'Mail you forward to {agent}', default: true }],
  connect: [
    {
      type: 'text',
      md: '**1.** In Gmail open Settings, **Filters and Blocked Addresses**, **Create a new filter**. In **To** put your own address with `+talos` before the @ (for example `you+talos@example.com`). Tap **Create filter**, tick **Apply the label**, make a label called `Talos/Inbound`, and create the filter. Anything sent to that address, or any mail you label by hand, reaches {agent} in full. Already connected Gmail? It picks the same label up too, so you can skip this one.',
    },
    {
      type: 'link',
      label: 'Open Gmail filters',
      href_template: 'https://mail.google.com/mail/u/0/#settings/filters',
    },
    {
      type: 'text',
      md: '**2.** About 3 minutes. Open Google Apps Script, **New project**, paste the script below, choose `install` and tap **Run**. Google asks for permission: tap **Allow**.',
    },
    {
      type: 'link',
      label: 'Open Google Apps Script',
      href_template: 'https://script.google.com/home/projects/create',
    },
    { type: 'script', template_id: 'forward' },
  ],
  test_hint: 'Send an email to your +talos address. It should show up within 5 minutes.',
}
