// publish_page: an org page (docs/ORG-PAGES-SPEC.md, phase 1). The agent publishes a thread's HTML page to the relay, or a
// new version of a page it published from the same thread; the relay keeps it past the 7-day media buffer and serves it to the
// owner's own signed-in devices, sandboxed. The agent can never share a page: share, unshare, restore and delete are the
// owner's, signed by a device key. The page runs in an opaque origin with no network, so everything must be inline.
import { createHash } from 'node:crypto'
import { type MessageT, newId, PAGE_LIMITS, PAGES_FULL, PageId, PagePublished, PageTitle } from '@talos-app/protocol'
import { fail, needStr, ok, postThreadArg, str, ToolError, threadProps } from './common.ts'
import { OWN_THREAD, type ToolRecord } from './define.ts'
import { deliverAgentMessage } from './send.ts'

export const publishPage: ToolRecord = {
  name: 'publish_page',
  group: 'pages',
  headless: true,
  ...OWN_THREAD,
  instructions: null,
  told: [],
  description:
    'Publish an HTML page the owner can open from their devices (a report, a dashboard, a one-pager), kept longer than a thread attachment and versioned. Pass page_id to publish a new version of a page you published from this thread. The page runs sandboxed with no network: put every script, style, image (data: URL) and font inline, and fetch nothing. You cannot share a page; the owner shares it. Returns page_id, version and owner_url.',
  inputSchema: {
    type: 'object',
    properties: {
      ...threadProps,
      title: { type: 'string', description: `One line, ${PAGE_LIMITS.titleChars} characters at most.` },
      html: { type: 'string', description: 'The whole page, self-contained, 10 MB at most.' },
      page_id: { type: 'string', description: 'A page you published from this thread: adds a version to it.' },
    },
    required: ['title', 'html'],
  },
  async handler(ctx, args) {
    try {
      const threadId = postThreadArg(ctx, args)
      const title = needStr(args, 'title')
      if (!PageTitle.safeParse(title).success)
        throw new ToolError(`title must be one line of 1 to ${PAGE_LIMITS.titleChars} characters`)
      const pageId = str(args.page_id)
      if (pageId !== undefined && !PageId.safeParse(pageId).success)
        throw new ToolError('page_id is not a page id (it looks like pg_ followed by 26 letters and digits)')
      const html = new TextEncoder().encode(needStr(args, 'html'))
      if (html.length === 0) throw new ToolError('html is empty')
      if (html.length > PAGE_LIMITS.versionBytes) throw new ToolError('html is over 10 MB')
      const q = new URLSearchParams({ thread_id: threadId, title, ...(pageId ? { page_id: pageId } : {}) })
      const res = await ctx.http.request(
        'POST',
        `/bridge/pages?${q}`,
        html,
        {
          'content-type': 'text/html; charset=utf-8',
          'x-talos-sha256': createHash('sha256').update(html).digest('hex'),
        },
        { timeoutMs: 15_000 + 2_000 * Math.ceil(html.length / (1024 * 1024)) },
      )
      if (res.status === 404)
        throw new ToolError(
          `No page ${pageId} was published from this thread. Publish without page_id to make a new page.`,
        )
      if (res.status === 507) throw new ToolError(PAGES_FULL.message)
      if (res.status === 413) throw new ToolError('html is over 10 MB')
      if (res.status === 400)
        throw new ToolError('The relay refused the page: the title or the HTML is not valid UTF-8 text.')
      if (res.status !== 200 && res.status !== 201)
        throw new ToolError(`The relay did not take the page (HTTP ${res.status}). Try again.`)
      const out = PagePublished.safeParse(await res.json().catch(() => null))
      if (!out.success) throw new ToolError('The relay answered with something that is not a published page.')
      // the page in the chat: one agent message per new page or version (the same bytes again post nothing); an app that
      // knows pages shows it as a page card and reads the live state (versions, share) from the relay when it shows it
      if (!out.data.unchanged) {
        const message: MessageT = {
          id: newId('m'),
          thread_id: threadId,
          author: 'agent',
          kind: 'text',
          text: pageId ? `Updated the page “${title}”.` : `Published a page: “${title}”.`,
          format: 'plain',
          attachments: [],
          via: ctx.mode === 'live' ? 'app' : 'headless',
          created_at: new Date(ctx.clock.now()).toISOString(),
          page: { page_id: out.data.page_id, title, version: out.data.version },
        }
        try {
          await deliverAgentMessage(ctx, message, {})
        } catch (e) {
          // the page is published either way: say so, so the agent does not publish it again
          return ok(
            JSON.stringify({ ...out.data, thread_message: `not posted: ${(e as Error).message}`.slice(0, 300) }),
          )
        }
      }
      return ok(JSON.stringify(out.data))
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}
