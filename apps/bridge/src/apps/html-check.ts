// The static check of an app's HTML (M5.1). Bun's HTMLRewriter, no new dependency. Every executable thing must be
// pinned: inline scripts by hash, remote files by SRI plus exact URL. Anything else is refused. Never a text search.
import { createHash } from 'node:crypto'
import { type AppCspT, PinnedUrl } from '@talos-app/protocol'

export type HtmlCheck =
  | {
      ok: true
      script_hashes: string[]
      script_urls: string[]
      style_urls: string[]
    }
  | { ok: false; reason: string }

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href'])
const SRI = /^(sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/

/** Browsers drop leading C0/space and tab/newline inside the scheme before reading it; do the same, then look at the scheme. */
function isJavascriptUrl(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers strip leading control characters from a URL; so must we
  const v = value.replace(/^[\x00-\x20]+/, '').replace(/[\t\n\r]/g, '')
  return /^javascript:/i.test(v)
}

/** Does `host` sit under one of the declared resource entries (`https://host` or `https://*.host`)? */
function hostDeclared(url: URL, resourceDomains: string[]): boolean {
  const host = url.hostname.toLowerCase()
  for (const entry of resourceDomains) {
    let u: URL
    try {
      u = new URL(entry.replace('//*.', '//wildcard.'))
    } catch {
      continue
    }
    if (u.protocol !== url.protocol) continue
    const wildcard = entry.includes('//*.')
    const base = u.hostname.toLowerCase().replace(/^wildcard\./, '')
    if (entry.includes(':', 8) && u.port !== url.port) continue
    if (wildcard ? host.endsWith(`.${base}`) : host === base) return true
  }
  return false
}

export async function checkHtml(html: string, csp: Pick<AppCspT, 'resource_domains'>): Promise<HtmlCheck> {
  const hashes: string[] = []
  const scriptUrls: string[] = []
  const styleUrls: string[] = []
  let problem: string | undefined
  const refuse = (m: string) => {
    problem ??= m
  }

  // text arrives in chunks per element; collect per script, in document order
  const inline: string[] = []
  let current: string | undefined

  const pinRemote = (
    url: string | null | undefined,
    el: { getAttribute(n: string): string | null; hasAttribute(n: string): boolean },
    into: string[],
  ) => {
    if (!url) return refuse('Code not pinned: loads a file without a usable address.')
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return refuse(`Code not pinned: loads ${url.slice(0, 120)} without an absolute https address.`)
    }
    if (u.protocol !== 'https:' || url.startsWith('//'))
      return refuse(`Code not pinned: loads ${url.slice(0, 120)} without an https address.`)
    const integrity = (el.getAttribute('integrity') ?? '').trim()
    const tokens = integrity.split(/\s+/).filter(Boolean)
    if (tokens.length === 0 || !tokens.every((t) => SRI.test(t)) || !el.hasAttribute('crossorigin'))
      return refuse(`Code not pinned: loads ${url.slice(0, 120)} without an integrity hash.`)
    if (!hostDeclared(u, csp.resource_domains))
      return refuse(`Code not pinned: ${u.hostname} is not one of the declared resource domains.`)
    if (!PinnedUrl.safeParse(url).success)
      return refuse(`Code not pinned: ${url.slice(0, 120)} is not an exact file address (no query, no odd characters).`)
    if (!into.includes(url)) into.push(url)
  }

  const rewriter = new HTMLRewriter()
    .on('*', {
      element(el) {
        for (const [name, value] of el.attributes) {
          const n = name.toLowerCase()
          if (/^on[a-z]/.test(n)) return refuse('This app uses inline handlers, which the hash-pinned CSP blocks.')
          if (URL_ATTRS.has(n) && isJavascriptUrl(value))
            return refuse('This app uses inline handlers, which the hash-pinned CSP blocks.')
        }
      },
    })
    .on('script', {
      element(el) {
        const src = el.getAttribute('src')
        if (src !== null) {
          current = undefined
          pinRemote(src, el, scriptUrls)
        } else {
          current = ''
        }
      },
      text(t) {
        if (current === undefined) return
        current += t.text
        if (t.lastInTextNode) {
          inline.push(current)
          current = undefined
        }
      },
    })
    .on('link', {
      element(el) {
        const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/)
        const href = el.getAttribute('href')
        if (rel.includes('modulepreload')) pinRemote(href, el, scriptUrls)
        else if (rel.includes('stylesheet')) pinRemote(href, el, styleUrls)
      },
    })
  try {
    await rewriter.transform(new Response(html)).text()
  } catch {
    return { ok: false, reason: 'The HTML could not be read.' }
  }
  // an empty inline script emits no text chunk with lastInTextNode set to true in some cases; nothing to hash
  for (const body of inline) {
    if (body === '') continue
    const h = `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`
    if (!hashes.includes(h)) hashes.push(h)
  }
  if (problem) return { ok: false, reason: problem }
  if (hashes.length > 64) return { ok: false, reason: 'More than 64 inline scripts.' }
  if (scriptUrls.length > 16 || styleUrls.length > 16) return { ok: false, reason: 'More than 16 remote files.' }
  return { ok: true, script_hashes: hashes, script_urls: scriptUrls, style_urls: styleUrls }
}
