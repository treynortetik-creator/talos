# RSS and Atom

The relay checks the feed every 30 minutes with a conditional request (`If-None-Match` / `If-Modified-Since`), so an
unchanged feed costs almost nothing.

- **First check:** everything already in the feed is marked as seen. Only posts that appear afterwards reach the Inbox.
- **Identity:** a post is its `guid`; without one, the SHA-256 of its link and title.
- **Priority:** low. Posts show under **Other** and never trigger a push.
- **Limits:** feeds over 2 MB are refused. Up to 3 redirects are followed.
- **Safety:** the relay will not fetch loopback, private-range, link-local or `.internal` / `.local` hosts, nor follow a
  redirect to one. (A hostname that resolves to a private address is not caught; see the PR notes.)
- **Failures:** ten failed checks in a row pause the connection and leave a note in the Inbox.
