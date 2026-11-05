// `/card/:id` (push target): finds the card and renders it highlighted. WP6's router can mount this directly, or open the
// card's thread and pass `highlighted` to CardView itself.
import { useParams } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { useArmedCard } from './arm.tsx'
import { CardView } from './CardView.tsx'

export function CardDeepLink() {
  const { id } = useParams()
  const arm = useArmedCard() === id
  const card = useTalos((s) => s.cards.find((c) => c.id === id))
  const threadName = useTalos((s) => s.threads.find((t) => t.id === card?.thread_id)?.name ?? card?.thread_id ?? '')
  if (!card) return <p className="p-4 text-text-2">This card is no longer here. It may have been replaced.</p>
  return (
    <div className="p-4">
      <CardView card={card} threadName={threadName} highlighted armPrimary={arm} />
    </div>
  )
}
