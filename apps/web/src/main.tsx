import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { useSession } from './features/auth/session.ts'
import { armCard } from './features/cards/arm.tsx'
import { getDrive } from './features/drive/instance.ts'
import { attachShell } from './features/native/attach.ts'
import { startNativeBadge } from './features/native/badge.ts'
import { installProblems } from './features/problems/controller.ts'
import { startReadSync } from './features/pwa/readSync.ts'
import { installNativePlatform } from './lib/capacitorPlatform.ts'
import { createFakeClient } from './lib/fakeClient.ts'
import { installShell } from './lib/native/shell.ts'
import { onNativePushAction } from './lib/nativePush.ts'
import { getPlatform } from './lib/platform.ts'
import { createSocketClient } from './lib/socketClient.ts'
import { createIdbStorage } from './lib/storage.ts'
import { applyTheme, resetThemeFromUrl } from './lib/theme.ts'
import './theme/app.css'

// The iPhone shell swaps in its adapter before anything reads the platform (haptics, audio session, install state).
installNativePlatform()
// The Mac app swaps in its adapter (null in a browser and in the iPhone shell).
const shell = installShell()

document.documentElement.dataset.brand = import.meta.env.VITE_BRAND || 'talos'
// `?theme=default` is the way back from a theme the owner cannot read, before anything is drawn.
resetThemeFromUrl()
applyTheme()

// CC-C3: `?fake_mod=offline|absent` starts the fake Claude Code session without a live mod (screenshots, e2e).
// Agents panel: `?fake_agents=demo|empty` makes the fake mod send a scripted roster or an empty snapshot.
function fakeMod(): { mod?: 'offline' | 'absent'; agents?: 'demo' | 'empty' } {
  const q = new URLSearchParams(location.search)
  const m = q.get('fake_mod')
  const a = q.get('fake_agents')
  return {
    ...(m === 'offline' || m === 'absent' ? { mod: m } : {}),
    ...(a === 'demo' || a === 'empty' ? { agents: a } : {}),
  }
}

const storage = createIdbStorage()
const client =
  import.meta.env.VITE_FAKE === '1'
    ? createFakeClient({ replyDelayMs: 200, ...fakeMod() })
    : createSocketClient({
        storage,
        clientInfo: {
          version: import.meta.env.VITE_APP_VERSION ?? '0.0.0',
          standalone: getPlatform().installState() === 'installed',
          platform: getPlatform().isIos() ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop',
        },
      })

// Test hook for the fake client (Playwright reads `sent` and flips the fake session).
if (import.meta.env.VITE_FAKE === '1') {
  ;(window as unknown as { __talos: unknown }).__talos = client
  ;(window as unknown as { __talosSession: unknown }).__talosSession = useSession // so a spec can say what /api/me said
}

if (shell) attachShell(shell, client)

// Errors become problem reports: queued on this device, sent when there is a connection (docs/ERRORS.md).
installProblems({ storage, client })

// iPhone app: a tap on a notification (or its Open / Approve button) opens the path the relay put in it. Approve opens
// the card armed (in memory, not in the URL): a high-risk card starts its normal flow and asks for Face ID first; nothing approves by itself.
startNativeBadge(client)
// Read state follows the notifications: a read thread or a decided card leaves the tray, and the web app badge follows the open cards.
startReadSync(client)
onNativePushAction((path, opts) => {
  if (opts?.arm) armCard(opts.arm)
  history.pushState(null, '', path)
  dispatchEvent(new PopStateEvent('popstate'))
})

// Driving mode (V4.1): the controller follows the config from app start, so a relaunch mid-drive still speaks.
getDrive(client)

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App client={client} storage={storage} />
    </StrictMode>,
  )
}
