// Settings -> Session: the same panel, inline.
import { useTalos } from '../../lib/client.ts'
import type { SettingsSectionProps } from '../contracts.ts'
import { OfferedModels } from './OfferedModels.tsx'
import { SessionPanel } from './SessionPanel.tsx'
import { useSessionSupported } from './SessionTrigger.tsx'

export function SessionSettingsSection({ readOnly }: SettingsSectionProps) {
  const supported = useSessionSupported()
  const threadId = useTalos((s) => s.threads[0]?.id ?? 'general')
  return (
    <section aria-labelledby="session-h" className="flex flex-col gap-4">
      <h2 id="session-h" className="m-0 font-display text-xl font-semibold">
        Session
      </h2>
      {supported ? (
        <SessionPanel threadId={threadId} inline />
      ) : (
        <p className="m-0 text-text-2">Your Mac needs a newer Talos to show the Claude Code session.</p>
      )}
      <OfferedModels readOnly={readOnly} />
    </section>
  )
}
