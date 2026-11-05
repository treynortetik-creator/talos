// Search (docs/V2-FEATURES.md V3; WP-V2). The registry lazy-loads these three by name.
import type { SearchScreenProps } from '../contracts.ts'
import { SearchScreen as Screen } from './SearchScreen.tsx'

export function SearchScreen(_props: SearchScreenProps) {
  return <Screen />
}

export { ContextView } from './ContextView.tsx'
export { HitRow } from './HitRow.tsx'
