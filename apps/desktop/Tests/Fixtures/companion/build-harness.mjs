// Bundles harness.ts into one script for the GUI test: node build-harness.mjs <out.js>
// Uses the repo's own vite (rolldown), resolved from apps/web, so there is nothing extra to install.
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const web = resolve(here, '../../../../web')
const out = process.argv[2]
if (!out) {
  console.error('usage: node build-harness.mjs <out.js>')
  process.exit(64)
}
let vite
try {
  vite = createRequire(join(web, 'package.json')).resolve('vite')
} catch {
  // A checkout that never ran `pnpm install` (a fresh CI worktree) has no apps/web/node_modules: say so, not a stack trace.
  console.error(`vite not found from ${web}: run \`pnpm install\` at the repo root first`)
  process.exit(65)
}
const { build } = await import(vite)
await build({
  root: web,
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': '"test"' },
  build: {
    write: true,
    minify: false,
    emptyOutDir: false,
    outDir: dirname(resolve(out)),
    lib: {
      entry: join(here, 'harness.ts'),
      formats: ['iife'],
      name: 'TalosHarness',
      fileName: () => resolve(out).split('/').pop(),
    },
  },
})
