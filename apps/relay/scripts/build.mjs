// Bundles the relay for production. Workspace packages (@talos-app/*) are TypeScript source, so they are BUNDLED;
// every other dependency stays external and is installed in the image (better-sqlite3 is native).
import { build } from 'esbuild'
import { buildVersion } from '../../../scripts/version.mjs'

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  define: { __TALOS_VERSION__: JSON.stringify(buildVersion()) },
  plugins: [
    {
      name: 'externalize-npm-deps',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@talos-app/') ? undefined : { path: args.path, external: true },
        )
      },
    },
  ],
})
