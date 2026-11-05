// Right-hand detail panel (desktop >= 1024). Content is whatever opens it; it collapses when empty. On phones and
// tablets the same content opens in a sheet instead.
import { createContext, type ReactNode, useContext } from 'react'

export type DetailPanelApi = {
  open(node: ReactNode, title?: string): void
  close(): void
}
export const DetailPanelContext = createContext<DetailPanelApi>({ open() {}, close() {} })
export const useDetailPanel = () => useContext(DetailPanelContext)
