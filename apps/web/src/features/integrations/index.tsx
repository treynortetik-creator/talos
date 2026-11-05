import type { ConnectionDetailProps, IntegrationsScreenProps } from '../contracts.ts'
import { ConnectionDetail as ConnectionDetailImpl, IntegrationsHub } from './IntegrationsHub.tsx'

export { IntegrationWizard } from './Wizard.tsx'

/** The Integrations screen. `readOnly` is for tests; the hub itself follows the Mac's presence (audit U11). */
export function IntegrationsScreen({ readOnly }: IntegrationsScreenProps) {
  return <IntegrationsHub {...(readOnly !== undefined ? { readOnly } : {})} />
}

export function ConnectionDetail({ connectionId }: ConnectionDetailProps) {
  return <ConnectionDetailImpl connectionId={connectionId} />
}
