import type { SetupSpecT } from '@talos-app/protocol'

export const rssSetup: SetupSpecT = {
  id: 'rss',
  name: 'RSS feed',
  category: 'personal',
  icon: 'rss',
  blurb: 'New posts from a feed, checked every 30 minutes.',
  default_thread: 'inbox',
  filters: [],
  connect: [
    {
      type: 'text',
      md: 'Paste the address of an RSS or Atom feed. {agent} checks it every 30 minutes. Posts already there are not sent; only new ones are.',
    },
    {
      type: 'field',
      key: 'feed_url',
      label: 'Feed address',
      secret: false,
      pattern: '^https?://\\S+$',
      help: 'For example https://example.com/feed.xml',
    },
  ],
  test_hint: 'Nothing to do: new posts show up on their own.',
  poll: { every_s: 1800 },
}
