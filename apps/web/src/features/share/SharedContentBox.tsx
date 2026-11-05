// The shared material, read-only (docs/V2-FEATURES.md V4.3, V4.4). It is DATA: plain text only, never a live link, never
// editable. Used on the /share page and under an Inbox row that came from a share.
import type { ShareContentT } from '@talos-app/protocol'
import { useEffect, useState } from 'react'
import type { SharedFile } from './material.ts'

function FilePreview({ file }: { file: SharedFile }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!file.type.startsWith('image/') || typeof URL.createObjectURL !== 'function') return
    const u = URL.createObjectURL(file.blob)
    setSrc(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return (
    <li className="flex items-center gap-2">
      {src && <img src={src} alt="" className="size-12 rounded-button object-cover" />}
      <span className="min-w-0 truncate">{file.name}</span>
      <span className="shrink-0 text-text-2">{Math.max(1, Math.round(file.size / 1024))} KB</span>
    </li>
  )
}

export function SharedContentBox({
  content,
  files = [],
  source,
  note,
}: {
  content: ShareContentT
  files?: SharedFile[]
  /** "Shared via iPhone" / "Shared page". */
  source?: string
  /** A note that came with a token share. It is the sender's text, so it sits inside the box as data. */
  note?: string | undefined
}) {
  return (
    <figure
      data-testid="shared-content"
      aria-label="Shared content"
      className="m-0 flex flex-col gap-2 rounded-card border border-line bg-surface-2 p-3 text-sm"
    >
      <figcaption className="text-xs font-semibold uppercase tracking-wide text-text-2">
        {source ?? 'Shared content'}
      </figcaption>
      {note && <p className="m-0 whitespace-pre-wrap break-words">{note}</p>}
      {content.title && <p className="m-0 break-words font-semibold">{content.title}</p>}
      {content.url && <p className="m-0 break-all font-mono text-xs text-text-2">{content.url}</p>}
      {content.text && <p className="m-0 max-h-60 overflow-y-auto whitespace-pre-wrap break-words">{content.text}</p>}
      {files.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {files.map((f) => (
            <FilePreview key={`${f.name}-${f.size}`} file={f} />
          ))}
        </ul>
      )}
    </figure>
  )
}
