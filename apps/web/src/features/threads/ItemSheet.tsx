// Inbox item sheet (8.2 `/t/inbox`): title, summary, source link (only if it passes HttpsUrl), related card and the
// actions. All hook-origin text is rendered as plain text.
import { HttpsUrl, type InboxItemT } from '@talos-app/protocol'
import { Suspense } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { getPlatform } from '../../lib/platform.ts'
import { Button, Sheet, SheetContent, SheetDescription, SheetTitle } from '../../ui/index.ts'
import { prefillComposer } from '../composer/composerStore.ts'
import { snoozeUntil } from '../inbox/logic.ts'
import { offerUndo } from '../inbox/undo.tsx'
import { CardView } from '../registry.ts'
import { useAgentName } from './useThreads.ts'

export function ItemSheet({ item, onClose }: { item: InboxItemT | null; onClose: () => void }) {
  const client = useTalosClient()
  const agent = useAgentName()
  const config = useTalos((s) => s.config)
  const card = useTalos((s) => (item?.card_id ? s.cards.find((c) => c.id === item.card_id) : undefined))
  const safeUrl = item?.url && HttpsUrl.safeParse(item.url).success ? item.url : null
  return (
    <Sheet open={item !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby={undefined}>
        {item && (
          <div className="flex flex-col gap-3">
            <SheetTitle className="m-0 text-lg font-semibold [overflow-wrap:anywhere]">{item.title}</SheetTitle>
            <SheetDescription className="m-0 text-text-2 [overflow-wrap:anywhere]">{item.summary}</SheetDescription>
            {item.agent_summary && <p className="m-0 [overflow-wrap:anywhere]">{item.agent_summary}</p>}
            {safeUrl && (
              <Button variant="outline" onClick={() => getPlatform().openExternal(safeUrl)}>
                Open source
              </Button>
            )}
            {card && (
              <Suspense fallback={null}>
                <CardView card={card} threadName={card.thread_id} inline />
              </Suspense>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  void client.updateInbox(item.id, { state: 'done' })
                  offerUndo(item, 'done')
                  onClose()
                }}
              >
                Done
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  void client.updateInbox(item.id, {
                    state: 'snoozed',
                    snoozeUntil: snoozeUntil(
                      new Date(),
                      config?.timezone ?? 'UTC',
                      config?.quiet_window ?? null,
                    ).toISOString(),
                  })
                  offerUndo(item, 'snoozed')
                  onClose()
                }}
              >
                Snooze
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  prefillComposer('inbox', `re: ${item.title}`)
                  onClose()
                }}
              >
                Ask {agent}
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
