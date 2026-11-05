import { beforeAll, describe, expect, it, vi } from 'vitest'
import { __loadMathForTests, renderMarkdown, sanitizeMarkdownHtml } from '../src/lib/markdown.ts'

const dom = (html: string) => new DOMParser().parseFromString(html, 'text/html')

// Audit D34: task lists and math render instead of printing raw.
describe('D34: task lists', () => {
  it('draw a glyph and the text, never an input', () => {
    const html = renderMarkdown('- [ ] write the brief\n- [x] book the room\n- [X] send it\n- plain')
    const d = dom(html)
    expect(d.querySelectorAll('input')).toHaveLength(0)
    const items = [...d.querySelectorAll('li')]
    expect(items.map((li) => li.textContent?.trim())).toEqual([
      '\u2610 write the brief',
      '\u2611 book the room',
      '\u2611 send it',
      'plain',
    ])
    expect(items[0]?.className).toContain('md-task-open')
    expect(items[1]?.className).toContain('md-task-done')
    expect(items[3]?.className).toBe('')
    expect(html).not.toContain('[ ]')
    expect(html).not.toContain('[x]')
  })

  it('leave brackets that are not a checkbox alone', () => {
    const d = dom(renderMarkdown('- [link](https://example.com)\n- [x]no space\n- [ ]\n- a [ ] in the middle'))
    const text = [...d.querySelectorAll('li')].map((li) => li.textContent?.trim())
    expect(text[0]).toBe('link')
    expect(text[1]).toBe('[x]no space')
    expect(text[3]).toBe('a [ ] in the middle')
  })

  it('work in a loose list and keep inline formatting', () => {
    const d = dom(renderMarkdown('- [x] **bold** step\n\n- [ ] `code` step'))
    expect(d.querySelectorAll('li.md-task')).toHaveLength(2)
    expect(d.querySelector('li strong')?.textContent).toBe('bold')
    expect(d.querySelector('li code')?.textContent).toBe('code')
  })
})

describe('D34: math', () => {
  beforeAll(async () => {
    // First sight of a formula starts the lazy load; wait for it so the rest of the file sees MathML.
    renderMarkdown('$x$')
    await __loadMathForTests()
  })

  it('shows the formula as its own source until Temml has loaded (no blank, no crash)', async () => {
    // a fresh module instance has not loaded Temml yet
    vi.resetModules()
    const fresh = await import('../src/lib/markdown.ts')
    const html = fresh.renderMarkdown('so $a+b$ here')
    expect(html).toContain('<code class="md-math-src">$a+b$</code>')
  })

  it('renders inline and display formulas as MathML', () => {
    const d = dom(renderMarkdown('Area is $\\pi r^2$ and\n\n$$\\frac{a}{b} = \\sqrt{2}$$\n\ndone'))
    const maths = d.querySelectorAll('math')
    expect(maths).toHaveLength(2)
    expect(maths[0]?.getAttribute('display')).not.toBe('block')
    expect(maths[1]?.getAttribute('display')).toBe('block')
    expect(d.querySelectorAll('mfrac, msqrt, msup').length).toBeGreaterThanOrEqual(3)
    expect(d.body.textContent).not.toContain('\\frac')
  })

  it('handles a multi-line display block', () => {
    const d = dom(renderMarkdown('$$\n\\sum_{i=1}^{n} i\n$$\n\nafter'))
    expect(d.querySelector('math[display="block"] munderover, math[display="block"] msubsup')).not.toBeNull()
    expect(d.querySelector('p')?.textContent).toBe('after')
  })

  it('leaves money and escaped dollars alone', () => {
    const d = dom(renderMarkdown('It costs $5 and $10 today, or \\$x\\$ literally.'))
    expect(d.querySelectorAll('math')).toHaveLength(0)
    expect(d.body.textContent).toContain('$5 and $10')
    expect(d.body.textContent).toContain('$x$')
  })

  it('does not touch code spans or fences', () => {
    const d = dom(renderMarkdown('`$x$`\n\n```\n$$y$$\n```'))
    expect(d.querySelectorAll('math')).toHaveLength(0)
    expect(d.body.textContent).toContain('$x$')
    expect(d.body.textContent).toContain('$$y$$')
  })

  it('shows source for a formula that does not parse or is too big, never an error span with a style', () => {
    const bad = renderMarkdown('$\\frac{$')
    expect(bad).toContain('md-math-src')
    expect(dom(bad).querySelectorAll('math, [style]')).toHaveLength(0)
    // past 2000 characters it is not a formula at all: plain text, and no work for Temml
    const huge = dom(renderMarkdown(`$${'x+'.repeat(1500)}x$`))
    expect(huge.querySelectorAll('math')).toHaveLength(0)
    expect(huge.body.textContent?.startsWith('$x+x+')).toBe(true)
  })

  it('carries no style attribute, no href and no element outside the MathML allow-list, whatever TeX asks for', () => {
    const hostile = [
      '$\\href{javascript:alert(1)}{x}$',
      '$\\url{https://evil.example}$',
      '$\\includegraphics{https://evil.example/a.png}$',
      '$\\htmlClass{x}{y}$',
      '$\\htmlStyle{color:red}{y}$',
      '$\\htmlId{x}{y}$',
      '$\\htmlData{a=b}{y}$',
      '$\\color{red}{x} \\textcolor{blue}{y} \\colorbox{red}{z} \\fcolorbox{red}{blue}{z}$',
      '$$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\\boxed{x}\\cancel{y}$$',
      '$\\rule{9999em}{9999em}$',
      '$\\mathchoice{a}{b}{c}{d}\\unicode{x41}\\char"41$',
      '$\\def\\a{\\a\\a}\\a$',
    ]
    for (const src of hostile) {
      const html = renderMarkdown(src)
      const d = dom(html)
      for (const el of d.body.querySelectorAll('*')) {
        const tag = el.tagName.toLowerCase()
        expect(['p', 'code', 'a', 'span', 'math'].includes(tag) || /^m[a-z]+$/.test(tag), `${src} -> <${tag}>`).toBe(
          true,
        )
        // style survives only on MathML, and only as plain box properties
        const style = el.getAttribute('style') ?? ''
        if (style) expect(/^m/.test(tag), `${src} style on <${tag}>`).toBe(true)
        expect(style, `${src} style value`).toMatch(/^(?:(?:padding|border)[a-z-]*:[0-9a-z.\s#+-]+;?)*$/i)
        if (tag !== 'a') expect(el.hasAttribute('href'), `${src} href on <${tag}>`).toBe(false)
        for (const a of el.getAttributeNames()) expect(a.startsWith('on') || a.includes(':'), `${src} ${a}`).toBe(false)
      }
      expect(d.querySelectorAll('img, script, style, svg, iframe, a[href^="javascript"]')).toHaveLength(0)
      // the TeX of a refused formula may show as text; it must never be an attribute value
      expect(html).not.toMatch(/(?:href|src|action|xlink:href)=["']?(?:javascript:|https?:\/\/evil)/i)
    }
  })
})

describe('D34: the allow-list itself, fed hostile HTML directly', () => {
  const hostile = [
    '<math><mi href="https://evil.example">x</mi></math>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<math><maction actiontype="statusline" xlink:href="javascript:alert(1)">x<mtext>y</mtext></maction></math>',
    '<math><mglyph src="https://evil.example/a.png"></mglyph></math>',
    '<math><mi style="background:url(https://evil.example)">x</mi></math>',
    '<math onload="alert(1)"><mi onclick="alert(2)">x</mi></math>',
    '<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>',
    '<math><semantics><annotation encoding="application/x-tex">x</annotation></semantics></math>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<math><mtext><style><img title="</style><img src=x onerror=alert(1)>">',
    '<math><mi><svg onload=alert(1)></svg></mi></math>',
    '<math><mi><script>alert(1)</script></mi></math>',
    '<math><mi><a href="javascript:alert(1)">x</a></mi></math>',
    '<math><mi><iframe src="//evil.example"></iframe></mi></math>',
    '<math><mo form=prefix lspace="1em" data-x="y" id="gone">(</mo></math>',
  ]
  for (const src of hostile) {
    it(`is inert: ${src.slice(0, 70)}`, () => {
      const out = sanitizeMarkdownHtml(src)
      const d = dom(out)
      expect(
        d.querySelectorAll('script, iframe, svg, style, img, maction, mglyph, annotation, annotation-xml, semantics'),
      ).toHaveLength(0)
      for (const el of d.body.querySelectorAll('*')) {
        expect(el.getAttribute('style') ?? '').toBe('')
        if (el.tagName !== 'A') expect(el.hasAttribute('href')).toBe(false)
        for (const a of el.getAttributeNames())
          expect(a.startsWith('on') || a.includes(':') || a === 'id' || a.startsWith('data-'), a).toBe(false)
      }
      expect(out).not.toMatch(/javascript:|evil\.example|onerror|onload/i)
    })
  }

  it('keeps box styles on MathML, drops everything else, and refuses huge or negative-huge lengths', () => {
    const out = sanitizeMarkdownHtml(
      '<p style="padding:3pt">no</p>' +
        '<math><mrow style="padding:3pt;border:1px solid;background:url(https://evil.example/x);position:fixed;top:0"><mi>x</mi></mrow>' +
        '<mpadded voffset="-300em" height="-300em" depth="+300em" width="2em" style="padding:0 0 300em 0"><mi>y</mi></mpadded>' +
        '<mpadded voffset="-3em" style="padding:0 0 3em 0"><mi>z</mi></mpadded></math>',
    )
    const d = dom(out)
    expect(d.querySelector('p')?.hasAttribute('style')).toBe(false)
    expect(d.querySelector('mrow')?.getAttribute('style')).toBe('padding:3pt;border:1px solid')
    const [big, ok] = [...d.querySelectorAll('mpadded')]
    for (const a of ['voffset', 'height', 'depth']) expect(big?.hasAttribute(a), a).toBe(false)
    expect(big?.getAttribute('width')).toBe('2em')
    expect(big?.hasAttribute('style')).toBe(false)
    expect(ok?.getAttribute('voffset')).toBe('-3em')
    expect(ok?.getAttribute('style')).toBe('padding:0 0 3em 0')
    expect(out).not.toMatch(/evil|fixed|position/)
  })

  it('keeps legitimate MathML', () => {
    const out = sanitizeMarkdownHtml(
      '<math display="block"><mfrac><mi>a</mi><mn>2</mn></mfrac><mo form="prefix" stretchy="true">(</mo></math>',
    )
    const d = dom(out)
    expect(d.querySelector('math')?.getAttribute('display')).toBe('block')
    expect(d.querySelector('mfrac')).not.toBeNull()
    expect(d.querySelector('mo')?.getAttribute('stretchy')).toBe('true')
  })
})

describe('D34: display formulas, shell variables and what TeX may draw', () => {
  beforeAll(async () => {
    renderMarkdown('$x$')
    await __loadMathForTests()
  })
  const mathCount = (src: string) => dom(renderMarkdown(src)).querySelectorAll('math').length

  it('a $$ block right after a line of text is a formula, not raw dollars', () => {
    const d = dom(renderMarkdown('The formula is:\n$$\nE = mc^2\n$$\nand more'))
    expect(d.querySelectorAll('math[display="block"]')).toHaveLength(1)
    expect(d.body.textContent).not.toContain('$$')
    expect(d.body.textContent).toContain('The formula is:')
    expect(d.body.textContent).toContain('and more')
    // a block of its own between two paragraphs, not a formula squeezed into one with line breaks around it
    expect(d.querySelector('math')?.closest('p')).toBeNull()
    expect([...d.querySelectorAll('p')].map((p) => p.textContent?.trim())).toEqual(['The formula is:', 'and more'])
  })

  it('does the same inside a list item and a quote', () => {
    expect(mathCount('- item\n  $$\n  x^2\n  $$')).toBe(1)
    expect(mathCount('> see\n> $$\n> x^2\n> $$')).toBe(1)
    expect(dom(renderMarkdown('- item\n  $$\n  x^2\n  $$')).body.textContent).not.toContain('$$')
  })

  it('an unclosed $$ after text stays text', () => {
    expect(mathCount('costs:\n$$\nnot closed')).toBe(0)
  })

  it('$$ with blanks just inside, in a sentence, is a formula', () => {
    const d = dom(renderMarkdown('Therefore $$ E = mc^2 $$ done'))
    expect(d.querySelectorAll('math')).toHaveLength(1)
    expect(d.body.textContent).not.toContain('$$')
  })

  it('shell variables are not maths', () => {
    for (const src of ['run $HOME/$USER now', 'PATH=$HOME/bin:$PATH', 'echo "$A and $B"']) {
      const d = dom(renderMarkdown(src))
      expect(d.querySelectorAll('math'), src).toHaveLength(0)
      expect(d.body.textContent?.trim(), src).toBe(src)
    }
    // a real formula next to one still works
    expect(mathCount('use $HOME/$USER where $x^2$ holds')).toBe(1)
  })

  it('wraps each formula in a box that scrolls on its own', () => {
    const d = dom(renderMarkdown('inline $a+b$ and\n\n$$c+d$$'))
    const boxes = [...d.querySelectorAll('span.md-math')]
    expect(boxes).toHaveLength(2)
    expect(boxes[0]?.classList.contains('md-math-display')).toBe(false)
    expect(boxes[1]?.classList.contains('md-math-display')).toBe(true)
    expect(boxes.every((b) => b.querySelector('math'))).toBe(true)
  })

  it('keeps what the formula needs to mean the same thing', () => {
    const d = dom(
      renderMarkdown(
        '$\\begin{aligned}a&=b\\\\c&=d\\end{aligned}$ $\\boxed{x}$ $\\overline{y}$ $\\prescript{a}{b}{X}$ $\\begin{array}{c|c}a&b\\\\\\hline c&d\\end{array}$',
      ),
    )
    expect(d.querySelector('mtd.tml-right')).not.toBeNull()
    expect(d.querySelector('mtd.tml-left')).not.toBeNull()
    expect(d.querySelector('menclose.tml-overline')).not.toBeNull()
    expect(d.querySelector('mmultiscripts mprescripts')).not.toBeNull()
    expect(d.querySelector('mrow[style*="border:1px solid"]')).not.toBeNull()
    expect(d.querySelector('mtd[style*="border-bottom"]')).not.toBeNull()
  })

  it('TeX cannot paint outside its message', () => {
    for (const src of [
      '$\\raisebox{-300em}{PAINTED}$',
      '$\\rule[-300em]{1em}{1em}$',
      '$\\raisebox{300em}{UP}$',
      '$\\vphantom{\\rule{1em}{-500em}}$',
    ]) {
      const html = renderMarkdown(src)
      for (const m of html.matchAll(/(?:voffset|height|depth|padding[a-z-]*)[=:]"?([^";]+)/g)) {
        for (const n of (m[1] ?? '').matchAll(/(-?[\d.]+)em/g))
          expect(Math.abs(Number(n[1])), `${src} ${m[0]}`).toBeLessThanOrEqual(20)
      }
    }
    // a small raise still works
    expect(renderMarkdown('$\\raisebox{-2em}{ok}$')).toContain('voffset="-2em"')
  })
})

describe('D34: raw HTML in the text is still escaped, not parsed', () => {
  it('a typed <math> tag is text', () => {
    const d = dom(renderMarkdown('<math><mi onclick=alert(1)>x</mi></math>'))
    expect(d.querySelectorAll('math, mi')).toHaveLength(0)
  })
})
