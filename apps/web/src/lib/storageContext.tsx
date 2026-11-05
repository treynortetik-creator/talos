import { createContext, type ReactNode, useContext } from 'react'
import { createMemoryStorage, type Storage } from './storage.ts'

const fallback = createMemoryStorage()
const StorageContext = createContext<Storage>(fallback)
export const StorageProvider = ({ storage, children }: { storage: Storage; children?: ReactNode }) => (
  <StorageContext.Provider value={storage}>{children}</StorageContext.Provider>
)
export const useStorage = () => useContext(StorageContext)
