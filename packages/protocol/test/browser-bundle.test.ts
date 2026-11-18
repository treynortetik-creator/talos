// The package's entry (src/index.ts) is what the web app and the browser specs bundle: it must build for a browser, so no
// module it reaches may import node:* (release-manifest.ts is Node-only and is imported by its own path). This runs in the
// fast gate; the browser specs (test-browser/) only run in CI's browser job, where a641326 first showed the break.
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('src/index.ts bundles for the browser', async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  }).catch((e: { errors?: { text: string }[] }) => ({ errors: e.errors ?? [{ text: String(e) }] }))
  expect(out.errors.map((e) => e.text)).toEqual([])
}, 30_000)
