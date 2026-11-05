import type { SetupSpecT } from '@talos-app/protocol'

export const githubSetup: SetupSpecT = {
  id: 'github',
  name: 'GitHub',
  category: 'personal',
  icon: 'github',
  blurb: 'Mentions, review requests and failed builds.',
  default_thread: 'inbox',
  filters: [
    { key: 'mentions', label: 'Mentions', default: true },
    { key: 'review_requests', label: 'Review requests', default: true },
    { key: 'assigned', label: 'Assigned to you', default: true },
    { key: 'ci_failed', label: 'Failed builds', default: true },
    { key: 'other', label: 'Everything else', default: false },
  ],
  connect: [
    {
      type: 'text',
      md: '**1.** Create a **classic** token with **notifications** ticked (it covers mentions and review requests in every repo). **2.** Paste it below. {agent} checks GitHub about once a minute and only reads your notifications.',
    },
    {
      type: 'link',
      label: 'Create a classic token',
      href_template: 'https://github.com/settings/tokens/new?scopes=notifications&description=Talos',
    },
    {
      type: 'field',
      key: 'token',
      label: 'Classic token',
      secret: true,
      pattern: '^(ghp_[A-Za-z0-9]{20,}|[0-9a-f]{40})$',
      help: 'Starts with ghp_',
    },
  ],
  test_hint: 'Mention yourself in an issue, or ask someone to request your review.',
  poll: { every_s: 60 },
}
