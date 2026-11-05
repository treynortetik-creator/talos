// The avatar on an inbox row: the integration's own icon (the `icon` key of its catalog spec), or the first two letters of
// the source when the catalog has not loaded, has no entry, or names a key this app has no drawing for.
import { useEffect, useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'

/** 24px stroke paths, one per icon key the integration catalog uses. */
const PATHS: Record<string, string> = {
  zap: 'M13 3L5 14h6l-1 7 8-11h-6z',
  rss: 'M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8M6 19h.01',
  ticket: 'M4 8a2 2 0 0 0 0 4v0a2 2 0 0 0 0 4v2h16v-2a2 2 0 0 1 0-4v0a2 2 0 0 1 0-4V6H4zM14 6v12',
  calendar: 'M5 6h14v14H5zM5 10h14M9 4v4M15 4v4',
  video: 'M4 7h11v10H4zM15 11l5-3v8l-5-3',
  workflow: 'M5 5h5v5H5zM14 14h5v5h-5zM10 7.5h4a2 2 0 0 1 2 2V14',
  cloud: 'M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 8.5 4.8 4.8 0 0 1 17 18z',
  github:
    'M9 19c-4 1-4-2-6-2M15 21v-3a3 3 0 0 0-1-2c3 0 6-1.5 6-6a4.5 4.5 0 0 0-1-3 4 4 0 0 0 0-3s-1 0-3 1.5a10 10 0 0 0-6 0C7 4 6 4 6 4a4 4 0 0 0 0 3 4.5 4.5 0 0 0-1 3c0 4.5 3 6 6 6a3 3 0 0 0-1 2v3',
  webhook:
    'M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8',
  slack: 'M9 4L7 20M17 4l-2 16M4 9h16M3 15h16',
  'credit-card': 'M3 6h18v12H3zM3 10h18M7 15h4',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  'mail-forward': 'M3 6h13v9H3zM3 7l6.5 5L16 7M18 15l3 3-3 3M21 18h-6',
}

type IconMap = ReadonlyMap<string, string>
const NONE: IconMap = new Map()
// One catalog fetch per client, shared by every avatar on every surface (Inbox list, thread timelines, item sheet).
const loads = new WeakMap<object, Promise<IconMap>>()

function iconsFor(client: ReturnType<typeof useTalosClient>): Promise<IconMap> {
  let p = loads.get(client)
  if (!p) {
    p = client.api.catalog().then(
      (specs) => new Map(specs.map((s) => [s.id as string, s.icon as string])),
      () => {
        loads.delete(client) // let a later avatar retry
        return NONE
      },
    )
    loads.set(client, p)
  }
  return p
}

function useSourceIcons(): IconMap {
  const client = useTalosClient()
  const [icons, setIcons] = useState<IconMap>(NONE)
  useEffect(() => {
    let live = true
    void iconsFor(client).then((m) => live && setIcons(m))
    return () => {
      live = false
    }
  }, [client])
  return icons
}

export function hasIconPath(key: string | undefined): boolean {
  return key !== undefined && Object.hasOwn(PATHS, key)
}

export function SourceAvatar({ source }: { source: string }) {
  const key = useSourceIcons().get(source)
  return (
    <span
      aria-hidden
      data-source-avatar={hasIconPath(key) ? 'icon' : 'initials'}
      className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-pill bg-surface-2 font-mono text-xs uppercase text-text"
    >
      {key !== undefined && hasIconPath(key) ? (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={PATHS[key]} />
        </svg>
      ) : (
        source.slice(0, 2)
      )}
    </span>
  )
}
