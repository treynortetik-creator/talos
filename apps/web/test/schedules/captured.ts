// The real-bridge captures (packages/testkit/fixtures/captured, WP-S1) as data for the web specs: every frame the real
// bridge sent, in order, grouped by scenario. Nothing here is hand-written.
import type { CardT, ScheduleSnapshotT } from '@talos-app/protocol'

type Step = {
  step: number
  label: string
  received_by_bridge?: Array<Record<string, unknown>>
  sent_by_bridge?: Array<Record<string, unknown>>
}
type Scenario = { scenario: string; title: string; steps: Step[] }

const files = import.meta.glob('../../../../packages/testkit/fixtures/captured/[0-9]*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Scenario>

export const SCENARIOS: Record<string, Scenario> = Object.fromEntries(
  Object.entries(files).map(([path, v]) => [path.split('/').pop()?.replace('.json', '') as string, v]),
)

const frames = (name: string) =>
  (SCENARIOS[name]?.steps ?? []).flatMap((s) => s.sent_by_bridge ?? []) as Array<
    Record<string, unknown> & { type: string }
  >

export const snapshots = (name: string): ScheduleSnapshotT[] =>
  frames(name)
    .filter((f) => f.type === 'schedules.snapshot')
    .map((f) => f.snapshot as ScheduleSnapshotT)
export const cards = (name: string): CardT[] =>
  frames(name)
    .filter((f) => f.type === 'card.create')
    .map((f) => f.card as CardT)
export const allFrames = (): Array<{ scenario: string; frame: Record<string, unknown> & { type: string } }> =>
  Object.keys(SCENARIOS).flatMap((scenario) => frames(scenario).map((frame) => ({ scenario, frame })))
export const received = (): Array<{ scenario: string; frame: Record<string, unknown> & { type: string } }> =>
  Object.entries(SCENARIOS).flatMap(([scenario, v]) =>
    v.steps.flatMap((s) => (s.received_by_bridge ?? []).map((frame) => ({ scenario, frame: frame as never }))),
  )
export const cardUpdates = (name: string) => frames(name).filter((f) => f.type === 'card.update')
