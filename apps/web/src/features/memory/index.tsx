// `/memory`: Nyx. Talos does not browse memory itself: this screen only saves where the owner's Nyx lives (`memory.nyx_url`) and
// links out to it. "Connected" means the address is saved: Talos cannot see a Nyx sign-in, and holds no Nyx credentials.
import { nyxHost, nyxOpenUrl } from '@talos-app/protocol'
import { useState } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { getPlatform } from '../../lib/platform.ts'
import { Button, buttonVariants } from '../../ui/index.ts'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import type { MemoryScreenProps } from '../contracts.ts'
import { useWriteBlock } from '../settings/offline.ts'
import { NyxAgents } from './NyxAgents.tsx'
import { NyxForm } from './NyxForm.tsx'
import { NYX_TEXT } from './nyxText.ts'

const link = `${buttonVariants()} no-underline`

/** An outside link: opened through the platform (so the iPhone app hands it to the system), a plain link if that is refused. */
function OutLink({ href, className, children }: { href: string; className: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={(e) => {
        if (getPlatform().openExternal(href)) e.preventDefault()
      }}
    >
      {children}
    </a>
  )
}

export function MemoryScreen(_props: MemoryScreenProps) {
  // `?af=<thread>` was a thread's folder when it sat under Memory: it is Thread files now (features/files/ThreadFiles.tsx)
  const [sp] = useSearchParams()
  const af = sp.get('af')
  if (af) return <Navigate to={`/files?t=${encodeURIComponent(af)}`} replace />
  return <NyxScreen />
}

function NyxScreen() {
  const config = useTalos((s) => s.config)
  const block = useWriteBlock()
  const saved = config?.memory?.nyx_url
  const [changing, setChanging] = useState(false)
  const [after, setAfter] = useState<{ signIn: string } | null>(null)

  const open = saved ? nyxOpenUrl(saved) : null
  const host = saved ? nyxHost(saved) : null
  const connected = open !== null && host !== null

  let body: React.ReactNode
  if (!config)
    body = (
      <p role="status" className="m-0 text-text-2">
        {NYX_TEXT.loading}
      </p>
    )
  else if (!connected || changing)
    body = (
      <NyxForm
        key={changing ? 'change' : 'connect'}
        initial={changing && saved ? saved : ''}
        block={block}
        {...(changing ? { onCancel: () => setChanging(false) } : {})}
        onSaved={(r) => {
          setAfter(r)
          setChanging(false)
        }}
      />
    )
  else
    body = (
      <>
        <p className="m-0 font-medium" data-testid="nyx-connected">
          {NYX_TEXT.connectedTo(host)}
        </p>
        {after && (
          <p role="status" className="m-0 text-sm text-text-2" data-testid="nyx-after">
            {NYX_TEXT.saved}{' '}
            <OutLink href={after.signIn} className="text-accent-text underline">
              {NYX_TEXT.signIn}
            </OutLink>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <OutLink href={open} className={link}>
            {NYX_TEXT.open}
          </OutLink>
          <Button
            variant="outline"
            onClick={() => {
              setAfter(null)
              setChanging(true)
            }}
          >
            {NYX_TEXT.change}
          </Button>
        </div>
        <NyxAgents />
      </>
    )

  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="memory-screen">
      <header className="flex flex-col gap-1 border-b border-line/60 p-4">
        <h1 className="m-0 font-display text-2xl font-semibold">{NYX_TEXT.title}</h1>
        {!connected && <p className="m-0 text-sm text-text-2">{NYX_TEXT.intro}</p>}
      </header>
      <ScrollRegion label={NYX_TEXT.title} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-4" data-testid="nyx-body">
          {body}
        </div>
      </ScrollRegion>
    </section>
  )
}
