import { SetupSpec, type SetupSpecT } from '@talos-app/protocol'
import { genericSetup } from '../generic/setup.ts'

export const zapierSetup: SetupSpecT = SetupSpec.parse(
  genericSetup({
    id: 'zapier',
    name: 'Zapier',
    icon: 'zap',
    blurb: 'Send a note to your Inbox from a Zap.',
    steps:
      'In Zapier add a **Webhooks by Zapier** action, choose **POST**, set Payload Type to **json**, and add the header below under **Headers**.',
  }),
)
