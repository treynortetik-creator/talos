// The real-bridge search captures (packages/testkit/fixtures/captured/search, WP-V2) as data for the web tests: every
// answer the real bridge sent for a signed `search.query` or a `history.request`. Nothing here is hand-written.
import type { FrameOf } from '@talos-app/protocol'

export type Step = { label: string; request: Record<string, unknown>; sent_by_bridge: Array<Record<string, unknown>> }
export type Scenario = { scenario: string; title: string; steps: Step[] }

const files = import.meta.glob('../../../../packages/testkit/fixtures/captured/search/[0-9]*.json', {
  eager: true,
  import: 'default',
}) as Record<string, Scenario>

export const SCENARIOS: Record<string, Scenario> = Object.fromEntries(
  Object.entries(files).map(([path, v]) => [path.split('/').pop()?.replace('.json', '') as string, v]),
)

export const step = (scenario: string, i: number): Step => {
  const s = SCENARIOS[scenario]?.steps[i]
  if (!s) throw new Error(`no step ${i} in ${scenario}`)
  return s
}
export const resultsOf = (scenario: string, i: number) =>
  step(scenario, i).sent_by_bridge[0] as FrameOf<'search.results'>
export const pageOf = (scenario: string, i: number) => step(scenario, i).sent_by_bridge[0] as FrameOf<'history.page'>
export const allSteps = (): Step[] => Object.values(SCENARIOS).flatMap((s) => s.steps)
