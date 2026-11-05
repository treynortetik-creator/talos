import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CapacitorConfig } from '@capacitor/cli'

// The shell loads ONE origin, the relay, fixed at build time from TALOS_RELAY_URL (environment, or apps/mobile/.env.local
// for local builds). There is deliberately no default: an unset variable yields a config with no server.url, so the shell
// shows www/index.html, an "unconfigured build" page. The URL never comes from page content, a deep link or a runtime
// setting (IOS-SPEC rev 2, security item 1).

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Returns the bare origin of a relay URL, or throws. https only; plain http only for loopback dev builds. A path,
 * query, fragment or credentials are errors, never silently dropped.
 */
export function relayOrigin(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('TALOS_RELAY_URL is not a valid URL')
  }
  const loopbackHttp = u.protocol === 'http:' && LOOPBACK.has(u.hostname)
  if (u.protocol !== 'https:' && !loopbackHttp)
    throw new Error('TALOS_RELAY_URL must be https (http only for localhost)')
  if (u.username || u.password) throw new Error('TALOS_RELAY_URL must not carry credentials')
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
    throw new Error('TALOS_RELAY_URL must be an origin only: no path, query or fragment')
  return u.origin
}

export function buildConfig(env: Record<string, string | undefined>): CapacitorConfig {
  const raw = env.TALOS_RELAY_URL?.trim()
  const origin = raw ? relayOrigin(raw) : undefined
  return {
    appId: 'app.talos.shell', // placeholder; the real bundle id is set when the Apple program decision is made
    appName: 'Talos',
    webDir: 'www',
    // Capacitor's debug bridge console.dir()s every plugin call's options; TalosShare.setToken carries the share secret.
    loggingBehavior: 'none',
    ...(origin
      ? {
          server: {
            url: origin,
            // Android-only in Capacitor and ATS has no exceptions on iOS; kept off unless a dev build asks for it.
            ...(env.TALOS_DEV_CLEARTEXT === '1' && origin.startsWith('http:') ? { cleartext: true } : {}),
            allowNavigation: [new URL(origin).host],
            // Bundled page shown when the relay is unreachable (instead of a blank view).
            errorPath: 'offline.html',
          },
        }
      : {}),
    ios: {
      contentInset: 'never',
      // Brand black (matches the launch screen and offline page): no white or stock-black flash while the relay answers.
      backgroundColor: '#141110',
      // The app's own TalosPushCenter is the notification delegate. Left on (the default), Capacitor takes the delegate
      // when its bridge is built, and every tap and foreground banner is dropped (no stock push plugin handles them).
      handleApplicationNotifications: false,
    },
    plugins: {
      // Stock @capacitor/keyboard, native resize: the web view shrinks to what the keyboard leaves, so the page needs no
      // pan handling. Never change the mode from the page (upstream #79: a hand-rolled resize broke dismissal).
      Keyboard: { resize: 'native', autoBackdropColor: 'dom' },
    },
  }
}

// Local builds: apps/mobile/.env.local (gitignored; see .env.local.example). A real environment variable wins.
// No `import.meta` here: the Capacitor CLI compiles this file to CommonJS under "type": "module", and any import.meta
// makes Node load it as ESM ("exports is not defined in ES module scope"), which breaks `cap sync`. The CLI provides
// __dirname (CJS) and so does Vitest; the cwd fallback is the CLI's own project root.
const envFile = join(typeof __dirname === 'string' ? __dirname : process.cwd(), '.env.local')
if (existsSync(envFile)) process.loadEnvFile(envFile)

export default buildConfig(process.env)
