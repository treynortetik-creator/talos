// Registers every module with the services. Seam: frozen after WP0 (WP8 may edit).

import { isTestAuthInstalled } from './auth/contract.ts'
import * as auth from './auth/index.ts'
import * as core from './core/index.ts'
import * as hooks from './hooks/index.ts'
import type { RelayServices } from './services.ts'
import * as session from './session/index.ts'
import * as voice from './voice/index.ts'

export async function registerModules(services: RelayServices): Promise<void> {
  // The relay refuses to boot with a test hook registered outside NODE_ENV=test (spec 5.4).
  if (services.env.NODE_ENV !== 'test' && isTestAuthInstalled()) {
    throw new Error('test auth hook is registered but NODE_ENV is not "test"; refusing to boot')
  }
  await core.register(services)
  await auth.register(services)
  await hooks.register(services)
  await voice.register(services)
  await session.register(services)
}
