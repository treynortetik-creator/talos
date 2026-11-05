// `/help`: Talos Help. One page, rendered from `content.ts`, for the phone, the browser and the Mac app's Talos window.
// It lives outside the sign-in gate on purpose: someone locked out needs to read it. Only the Ask button needs a session.
import { useState } from 'react'
import { Link } from 'react-router'
import { useTalos } from '../../lib/client.ts'
import { IconBack } from '../../ui/icons.tsx'
import { Input } from '../../ui/index.ts'
import { Meander } from '../../ui/Meander.tsx'
import { ScrollRegion } from '../../ui/ScrollRegion.tsx'
import { type Block, blockText, HELP_SECTIONS, type Section } from './content.ts'
import { AboutBuild, AskAgent } from './HelpAbout.tsx'
import { BlockView, matches, narrowBlock } from './HelpBlocks.tsx'

/** A search is a few words. The cap also bounds what Ask can carry into a message. */
export const SEARCH_MAX = 200

/** What a search leaves of a section: all of it when the title matches, else only the parts that match. */
function visibleBlocks(s: Section, query: string): Block[] {
  if (query.trim() === '' || matches(s.title, query)) return s.blocks
  return s.blocks.flatMap((b) => narrowBlock(b, query) ?? [])
}

function jump(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ block: 'start' })
  el.focus({ preventScroll: true })
}

export function HelpScreen() {
  const [query, setQuery] = useState('')
  const agent = useTalos((s) => s.config?.agent.name) ?? 'Talos'
  const shown = HELP_SECTIONS.map((s) => ({ s, blocks: visibleBlocks(s, query) })).filter((x) => x.blocks.length > 0)
  const searching = query.trim() !== ''
  const count = shown.reduce((n, x) => n + x.blocks.length, 0)

  return (
    // `relative overflow-clip` like the Shell's root: screen-reader-only text inside the scroller is absolutely
    // positioned, and with no positioned ancestor it stretches the document instead of the scroll region.
    <div className="relative flex h-dvh min-h-0 flex-col overflow-clip bg-bg text-text">
      <div className="top-band">
        <header className="flex items-center gap-1 px-2 pt-[env(safe-area-inset-top)]">
          <Link
            to="/settings"
            aria-label="Back to settings"
            className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
          >
            <IconBack />
          </Link>
          <h1 className="m-0 py-3.5 pl-2 font-display text-2xl font-semibold">Talos Help</h1>
        </header>
        <Meander />
      </div>
      <ScrollRegion label="Help" className="min-h-0 flex-1 overflow-y-auto">
        <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-16" data-testid="help-page">
          <div className="flex flex-col gap-2">
            <label htmlFor="help-search" className="text-sm font-medium">
              Search Help
            </label>
            <Input
              id="help-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="For example: quiet hours"
              autoComplete="off"
              maxLength={SEARCH_MAX}
              enterKeyHint="search"
            />
            <p role="status" data-testid="help-count" className="m-0 text-sm text-text-2">
              {searching
                ? count === 0
                  ? 'Nothing matches.'
                  : `${count} matching ${count === 1 ? 'part' : 'parts'}.`
                : ''}
            </p>
          </div>

          {!searching && (
            <nav aria-label="Help contents" data-testid="help-contents">
              <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
                {HELP_SECTIONS.map((s) => (
                  <li key={s.id} className="m-0">
                    <a
                      href={`#help-${s.id}`}
                      onClick={(e) => {
                        e.preventDefault()
                        jump(`help-${s.id}`)
                      }}
                      className="inline-flex min-h-11 items-center text-accent-text underline"
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}

          {searching && count === 0 && (
            <div className="flex flex-col gap-3" data-testid="help-empty">
              <p className="m-0">Nothing in Help matches &ldquo;{query.trim()}&rdquo;. Try fewer or simpler words.</p>
            </div>
          )}

          {shown.map(({ s, blocks }) => (
            <section key={s.id} aria-labelledby={`help-${s.id}`} className="flex flex-col gap-3">
              <h2 id={`help-${s.id}`} tabIndex={-1} className="m-0 font-display text-xl font-semibold outline-none">
                {s.title}
              </h2>
              {blocks.map((b) => (
                <BlockView
                  key={blockText(b).slice(0, 60)}
                  block={b}
                  searching={searching && !matches(s.title, query)}
                />
              ))}
              {s.id === 'about' && <AboutBuild />}
            </section>
          ))}

          <section aria-labelledby="help-ask" className="flex flex-col gap-3">
            <h2 id="help-ask" className="m-0 font-display text-xl font-semibold">
              Ask {agent}
            </h2>
            <AskAgent agent={agent} query={query} />
          </section>
        </main>
      </ScrollRegion>
    </div>
  )
}
