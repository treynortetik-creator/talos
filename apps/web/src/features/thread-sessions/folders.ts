// The logic behind the Folder field of a thread's own session: which words it says, the last five folders used on this device,
// and what the Mac says about its home and the agent folder. No screens here (FolderField.tsx and FolderBrowser.tsx draw them).
import { FOLDER_RECENT_MAX, FOLDERS_FEATURE, tildePath } from '@talos-app/protocol'
import { useEffect, useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'

/** Every word the Folder field and its browser say, in one place. The Mac's own refusals are shown as the Mac wrote them. */
export const FOLDER_TEXT = {
  label: 'Folder',
  choose: 'Choose…',
  useThis: 'Use this folder',
  cancel: 'Cancel',
  showHidden: 'Show hidden',
  loading: 'Loading…',
  pathLabel: 'Folder path',
  empty: 'No folders in here.',
  recent: 'Recent',
  placeholderUnknown: 'The agent folder',
  hint: 'Leave empty to use the agent folder. Your Mac checks that it exists.',
  badPath: 'Use a full folder path that starts with /, like /Users/you/project.',
  notNow: "The Mac app can't show the folder panel right now. Try again in a moment.",
  badName: "That folder's name has a character Talos can't use, so it can't be chosen. Pick another folder.",
  noHome: "Your Mac hasn't said where your home folder is yet, so ~ can't be used. Type the full path.",
  current: (shown: string | null, agent: boolean) =>
    shown === null
      ? 'Working in the agent folder.'
      : agent
        ? `Working in ${shown}, the agent folder.`
        : `Working in ${shown}.`,
} as const

/** Where the recent folders are kept. Per device (this browser or this phone), not in the Mac's config: a different device has its own. */
export const RECENT_KEY = 'talos.recent-folders'

const isPath = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && v.length <= 512

export function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter(isPath).slice(0, FOLDER_RECENT_MAX) : []
  } catch {
    return []
  }
}

/** The list after `path` was used: newest first, no repeats, five at most. */
export function withRecent(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, FOLDER_RECENT_MAX)
}

export function saveRecent(list: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // private window or blocked storage: the chips just do not survive a reload
  }
}

/** `~/…` back to the full path. `~` alone is home. Anything else is returned as it is. Null when `~` is used and home is unknown. */
export function expandTilde(value: string, home: string | undefined): string | null {
  if (value !== '~' && !value.startsWith('~/')) return value
  if (!home) return null
  return value === '~' ? home : `${home.replace(/\/+$/, '')}${value.slice(1)}`
}

export { tildePath }

export type FolderInfo = { home?: string; agentDir?: string }

/** Where home and the agent folder are, asked of the Mac once while the Folder field is on screen. Empty until it answers (or when the Mac cannot say). */
export function useFolderInfo(): FolderInfo {
  const client = useTalosClient()
  const on = useFeature(FOLDERS_FEATURE) === 'on'
  const [info, setInfo] = useState<FolderInfo>({})
  useEffect(() => {
    const folders = client.folders
    if (!on || !folders) return
    let live = true
    folders.list(null, false).then(
      (r) => {
        if (live) setInfo({ ...(r.home ? { home: r.home } : {}), ...(r.agentDir ? { agentDir: r.agentDir } : {}) })
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [client, on])
  return info
}
