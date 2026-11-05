import type { IntegrationIdT, SetupSpecT } from '@talos-app/protocol'

export function gmailSetup(args: {
  id: IntegrationIdT
  name: string
  blurb: string
  category: 'personal' | 'work'
}): SetupSpecT {
  return {
    id: args.id,
    name: args.name,
    category: args.category,
    icon: 'mail',
    blurb: args.blurb,
    default_thread: args.category === 'work' ? 'work' : 'inbox',
    filters: [
      { key: 'primary', label: 'Mail in your Primary inbox', default: true },
      { key: 'vips', label: 'Mail from your VIPs', default: true },
      { key: 'forwarded', label: 'Mail you forward to {agent}', default: true },
    ],
    connect: [
      {
        type: 'text',
        md: 'About 3 minutes. **1.** Open Google Apps Script and choose **New project**. **2.** Delete what is there and paste the script below. It holds a one-time code, not your secret, and stops working after the first run. **3.** Choose `install` and tap **Run**. Google asks for permission: tap **Allow**. **4.** Done. New mail shows up within 5 minutes.',
      },
      {
        type: 'link',
        label: 'Open Google Apps Script',
        href_template: 'https://script.google.com/home/projects/create',
      },
      { type: 'script', template_id: 'gmail' },
      {
        type: 'field',
        key: 'vips',
        label: 'VIP addresses (optional)',
        secret: false,
        help: 'Optional. Comma-separated email addresses whose mail always reaches you.',
      },
      {
        type: 'field',
        key: 'query',
        label: 'Gmail search (optional)',
        secret: false,
        help: 'Optional. Default: in:inbox category:primary',
      },
      {
        type: 'field',
        key: 'forward_label',
        label: 'Forward label (optional)',
        secret: false,
        help: 'Optional. Default: Talos/Inbound. Mail with this label arrives in full.',
      },
    ],
    test_hint: 'Send yourself an email. It should show up within 5 minutes.',
  }
}

export const gmailPersonalSetup: SetupSpecT = gmailSetup({
  id: 'gmail',
  name: 'Gmail',
  blurb: 'New mail in your Primary inbox, within 5 minutes.',
  category: 'personal',
})
