import type { SetupSpecT } from '@talos-app/protocol'

export const gcalSetup: SetupSpecT = {
  id: 'gcal',
  name: 'Google Calendar',
  category: 'personal',
  icon: 'calendar',
  blurb: 'Invites, changes and meetings starting soon.',
  default_thread: 'inbox',
  filters: [
    { key: 'invites', label: 'New invites', default: true },
    { key: 'changes', label: 'Changes to events', default: true },
    { key: 'cancellations', label: 'Cancellations', default: true },
    { key: 'starting', label: 'Meetings starting in 15 minutes', default: true },
  ],
  connect: [
    {
      type: 'text',
      md: 'About 3 minutes. **1.** Open Google Apps Script and choose **New project**. **2.** Delete what is there and paste the script below. It holds a one-time code, not your secret, and stops working after the first run. **3.** Choose `install` and tap **Run**. Google asks for permission: tap **Allow**. **4.** Done. Changes show up within 5 minutes.',
    },
    {
      type: 'link',
      label: 'Open Google Apps Script',
      href_template: 'https://script.google.com/home/projects/create',
    },
    { type: 'script', template_id: 'gcal' },
  ],
  test_hint: 'Invite yourself to an event from another account, or move one of your events.',
}
