// Small hand-written markdown to readable plain text converter for spoken replies
// (docs/V2-FEATURES.md V4.1). Not a full CommonMark parser: it covers what agent replies use (emphasis, lists, code,
// links, images, headings, tables).

const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const FENCE = /^\s*(```|~~~)/

function stripEmphasis(s: string): string {
  return s
    .replace(/\*\*\*(?=\S)(.+?)(?<=\S)\*\*\*/g, '$1')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1')
    .replace(/(?<![\w_])__(?=\S)(.+?)(?<=\S)__(?![\w_])/g, '$1')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*/g, '$1')
    .replace(/(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/g, '$1')
}

function inline(line: string): string {
  const stash: string[] = []
  const hold = (v: string): string => `\u0000${stash.push(v) - 1}\u0000`
  let s = line.replace(/`+([^`\n]+?)`+/g, (_m, code: string) => hold(code))
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]*)[^)]*\)/g, (_m, alt: string) => hold(`[image: ${alt}]`))
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)[^)]*\)/g, (_m, text: string, url: string) => {
    const t = stripEmphasis(text)
    return hold(t === url ? url : `${t} (${url})`)
  })
  s = stripEmphasis(s)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: placeholder delimiters
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => stash[Number(i)] ?? '')
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => inline(c.trim()))
}

export function markdownToPlain(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let fenced = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (FENCE.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      out.push(line)
      continue
    }
    const next = lines[i + 1]
    if (line.includes('|') && next?.includes('|') && TABLE_SEP.test(next)) {
      out.push(cells(line).join(' · '))
      i++ // skip the separator row
      while (i + 1 < lines.length && (lines[i + 1] as string).includes('|') && (lines[i + 1] as string).trim()) {
        i++
        out.push(cells(lines[i] as string).join(' · '))
      }
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue // horizontal rule
    let l = line.replace(/^(\s*)#{1,6}\s+(.*?)(\s+#+)?\s*$/, '$1$2')
    l = l.replace(/^(\s*)(?:>\s?)+/, '$1')
    l = l.replace(/^(\s*)[-*+]\s+/, '$1- ')
    out.push(inline(l))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}
