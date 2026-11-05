import { SetupSpec, type SetupSpecT } from '@talos-app/protocol'
import { genericSetup } from '../generic/setup.ts'

export const n8nSetup: SetupSpecT = SetupSpec.parse(
  genericSetup({
    id: 'n8n',
    name: 'n8n',
    icon: 'workflow',
    blurb: 'Send a note to your Inbox from an n8n workflow.',
    steps:
      'In n8n add an **HTTP Request** node, method **POST**, send the body as **JSON**, and add the header below under **Send Headers**.',
  }),
)
