// Closing the fake worlds leaves no listener and no seam address behind for the next test.
import { expect, test } from 'bun:test'
import { railwayTestSeam } from '../../src/relay/railway.ts'
import { releaseFeedTestSeam } from '../../src/release-feed.ts'
import { closeWorlds, useWorldCleanup, world } from './helpers.ts'

useWorldCleanup()

const ask = (u: string) => fetch(u, { method: 'POST', body: '{}' }).catch(() => undefined)

test('closing the worlds refuses new connections to every fake and clears both seams', async () => {
  const w = world()
  const urls = [w.railway.url, w.relay.url, w.feed.url]
  expect(railwayTestSeam.url).toBe(w.railway.url)
  for (const u of urls) expect((await ask(u))?.status).toBeDefined()
  await closeWorlds()
  for (const u of urls) expect(await ask(u)).toBeUndefined()
  expect(railwayTestSeam.url).toBeUndefined()
  expect(releaseFeedTestSeam.url).toBeUndefined()
})
