// The addresses a token or a lookup goes to are fixed in code. An environment variable (which any agent shell can set) never
// changes them: the only way to move them is a test seam, set from test code.
import { describe, expect, test } from 'bun:test'
import { loadEnv } from '../../src/config.ts'
import { RAILWAY_ENDPOINT, Railway, railwayTestSeam } from '../../src/relay/railway.ts'
import { feedDeps, RELEASE_FEED_URL, releaseFeedTestSeam } from '../../src/release-feed.ts'
import { cli, connectProject, useWorldCleanup, world } from './helpers.ts'

useWorldCleanup()

/** A listener standing in for an attacker's: it records every request that reaches it. */
function listener() {
  const hits: string[] = []
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      hits.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get('project-access-token') ?? ''}`)
      return Response.json({ errors: [{ message: 'no' }] })
    },
  })
  return { hits, url: `http://127.0.0.1:${srv.port}`, stop: () => srv.stop(true) }
}

describe('no address from the environment', () => {
  test('the fixed endpoints are what a client uses with no seam set, whatever the environment says', () => {
    const evil = listener()
    try {
      railwayTestSeam.url = undefined
      releaseFeedTestSeam.url = undefined
      const env = { TALOS_RAILWAY_API_URL: evil.url, TALOS_RELEASE_FEED_URL: evil.url }
      const loaded = loadEnv({ TALOS_APP_HOME: '/home/alex/t', ...env })
      expect(Object.keys(loaded)).not.toContain('railwayUrl')
      expect(Object.keys(loaded)).not.toContain('releaseFeedUrl')
      expect((new Railway({ kind: 'project', token: 'rw_FAKE_x_0123456789' }) as unknown as { url: string }).url).toBe(
        RAILWAY_ENDPOINT,
      )
      expect(feedDeps({ home: '/home/alex/t' }, Date.now).url).toBeUndefined()
      expect(RELEASE_FEED_URL).toMatch(/^https:\/\/api\.github\.com\//)
    } finally {
      evil.stop()
    }
  })
  test('relay update, doctor, status and the bridge look never reach a listener named in the environment; the token stays home', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    const evil = listener()
    try {
      const env = { TALOS_RAILWAY_API_URL: evil.url, TALOS_RELEASE_FEED_URL: evil.url }
      const w2 = { ...w, env: { ...w.env, ...env } }
      const before = w.railway.redeploys().length
      const r = await cli(w2, ['relay', 'update'])
      expect(r.all).not.toContain('rw_FAKE')
      // the real (fake) Railway got the one redeploy; the listener got nothing
      expect(w.railway.redeploys().length).toBe(before + 1)
      await cli(w2, ['doctor', '--json', '--agent-dir', `${w.home}/none`])
      await cli(w2, ['status'])
      expect(evil.hits).toEqual([])
      expect(w.feed.hits).toBeGreaterThan(0)
    } finally {
      evil.stop()
    }
  })
})
