import { SetupSpec, type SetupSpecT } from '@talos-app/protocol'
import { genericSetup } from '../generic/setup.ts'

export const makeSetup: SetupSpecT = SetupSpec.parse(
  genericSetup({
    id: 'make',
    name: 'Make',
    icon: 'workflow',
    blurb: 'Send a note to your Inbox from a Make scenario.',
    steps:
      'In Make add an **HTTP > Make a request** module, method **POST**, body type **Raw**, content type **JSON (application/json)**, and add the header below.',
  }),
)
