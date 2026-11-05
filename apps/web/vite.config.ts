// Vite + Tailwind + the PWA plugin (injectManifest: the service worker is src/sw.ts). The manifest is
// public/manifest.webmanifest, linked from index.html.
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { brandPlugin } from './vite.brand.ts'

// Playwright's relay-backed server proxies the API, media and the socket to the test harness.
const relay = process.env.TALOS_E2E_RELAY

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    brandPlugin(process.env.VITE_BRAND),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,woff2,webmanifest}'],
        globIgnores: ['**/talos-icon-1024.png'],
        maximumFileSizeToCacheInBytes: 4_000_000,
      },
      devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
    }),
  ],
  server: {
    port: 5173,
    ...(relay
      ? {
          proxy: {
            '/api': relay,
            '/media': relay,
            '/__test': relay,
            '/ws': { target: relay.replace(/^http/, 'ws'), ws: true },
          },
        }
      : {}),
  },
  // assetsInlineLimit 0: no `data:` fonts (the spec CSP is font-src 'self').
  // In fake mode (the Playwright build) the WP4/WP7 harness pages are built too, so every spec runs against one
  // production server: no dev-server dependency optimisation, no cold-start flake.
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    // Maps are built so a fixer can read a minified stack, but carry no link from the bundle and are never served (the relay refuses .map).
    sourcemap: 'hidden',
    ...(process.env.VITE_FAKE === '1'
      ? {
          rollupOptions: {
            input: {
              main: fileURLToPath(new URL('index.html', import.meta.url)),
              voiceHarness: fileURLToPath(new URL('test/voice/harness/index.html', import.meta.url)),
              cardsHarness: fileURLToPath(new URL('test/cards/harness/index.html', import.meta.url)),
              schedulesHarness: fileURLToPath(new URL('test/schedules/harness/index.html', import.meta.url)),
              memoryHarness: fileURLToPath(new URL('test/memory/harness/index.html', import.meta.url)),
              searchHarness: fileURLToPath(new URL('test/search/harness/index.html', import.meta.url)),
            },
          },
        }
      : {}),
  },
})
