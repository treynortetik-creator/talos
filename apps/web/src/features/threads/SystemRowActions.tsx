// The buttons a system row offers (protocol MessageAction): client-side only, no signature, nothing sent anywhere. An action this client
// cannot carry out (no terminal screen on the phone or in a browser) draws nothing, so the row is its text alone.
import type { MessageActionT } from '@talos-app/protocol'
import { useNavigate } from 'react-router'
import { Button } from '../../ui/button.tsx'
import { canOpenTerminal, openTerminal } from '../terminal/openTerminal.ts'
import { MESSAGE_ACTION_LABEL } from './messageActionWords.ts'

export function SystemRowActions({ actions }: { actions: readonly MessageActionT[] }) {
  const navigate = useNavigate()
  // one button per distinct action (the same action twice is one button), so a key made of the action itself is unique
  const seen = new Set<string>()
  const shown = actions.filter((a) => {
    const k = `${a.kind}:${a.thread}`
    if (a.kind !== 'open_terminal' || !canOpenTerminal() || seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (shown.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap justify-center gap-2" data-testid="msg-actions">
      {shown.map((a) => (
        <Button
          key={`${a.kind}:${a.thread}`}
          type="button"
          onClick={() => openTerminal(a.thread, navigate)}
          data-testid="msg-action-open-terminal"
        >
          {MESSAGE_ACTION_LABEL[a.kind]}
        </Button>
      ))}
    </div>
  )
}
