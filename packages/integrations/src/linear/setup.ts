import type { SetupSpecT } from '@talos-app/protocol'

export const linearSetup: SetupSpecT = {
  id: 'linear',
  name: 'Linear',
  category: 'personal',
  icon: 'ticket',
  blurb: 'Issues and comments from Linear.',
  default_thread: 'inbox',
  filters: [
    { key: 'assigned', label: 'Issues assigned to you', default: true },
    { key: 'comments', label: 'Comments', default: true },
    { key: 'other', label: 'Every other issue change', default: false },
  ],
  connect: [
    {
      type: 'text',
      md: '**1.** Create a personal API key in Linear (Settings, Security & access). **2.** Paste it below and pick a team. You need to be a Linear workspace admin to create webhooks. {agent} keeps the key until setup finishes.',
    },
    { type: 'link', label: 'Open Linear API settings', href_template: 'https://linear.app/settings/account/security' },
    {
      type: 'field',
      key: 'api_key',
      label: 'API key',
      secret: true,
      pattern: '^lin_api_[A-Za-z0-9]{20,}$',
      help: 'Starts with lin_api_',
    },
    {
      type: 'field',
      key: 'team_id',
      label: 'Team id',
      secret: false,
      help: 'Optional. Leave empty for all public teams.',
    },
    {
      type: 'field',
      key: 'user_id',
      label: 'Your Linear user id',
      secret: false,
      help: 'Optional. Lets {agent} tell which issues are yours.',
    },
  ],
  test_hint: 'Assign yourself an issue.',
}
