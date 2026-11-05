import type { SetupSpecT } from '@talos-app/protocol'
import { gmailSetup } from '../gmail/setup.ts'

export const WORK_ASK_NOTE = 'Ask your IT team before connecting these.'

const base = gmailSetup({
  id: 'gmail_work',
  name: 'Gmail (work)',
  blurb: `New work mail, via a small Google script. Off until you turn it on. ${WORK_ASK_NOTE}`,
  category: 'work',
})

export const gmailWorkSetup: SetupSpecT = {
  ...base,
  // The work account's admin may restrict Apps Script and external requests: say so before anything else.
  connect: [
    {
      type: 'text',
      md: `**${WORK_ASK_NOTE}** The script runs inside your work Google account and sends a short preview of each new message to your own relay. Some workplaces block Apps Script or outside requests; if Google refuses, stop here.`,
    },
    ...base.connect,
  ],
}
