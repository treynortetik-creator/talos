// The kit's Python copy of the web-address check (kit/scripts/_addr.py) must answer exactly like the TypeScript original
// (packages/protocol/src/address.ts), on a broad generated set, not only on the shared corpus. The corpus catches a missing
// address; this catches a narrowed range, a changed parse rule or a different reading of an odd spelling.
// Run both over the same cases, compare every answer.
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import corpus from '../packages/protocol/fixtures/address-corpus.json' with { type: 'json' }
import {
  isBlockedAddress,
  isBlockedHost,
  isLoopbackHost,
  normalizeHost,
  parseIPv4,
  parseIPv6,
} from '../packages/protocol/src/address.ts'
import { ROOT } from './size-report.ts'

/** Small seeded generator: the same cases on every run, so a failure is reproducible. */
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dotted = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
const numeric = (a: string): number => a.split('.').reduce((acc, o) => acc * 256 + Number(o), 0)
const hex = (n: number): string => n.toString(16)

/** Compresses the longest run of zero groups to `::` (RFC 5952), so both spellings of an address are covered. */
function compress(groups: number[]): string {
  let best = { at: -1, len: 0 }
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > best.len) best = { at: i, len: j - i }
    i = j
  }
  if (best.len < 2) return groups.map(hex).join(':')
  const head = groups.slice(0, best.at).map(hex).join(':')
  const tail = groups
    .slice(best.at + best.len)
    .map(hex)
    .join(':')
  return `${head}::${tail}`
}

const ODD = [
  '',
  '::',
  '::1',
  '[::1]',
  '::1%lo0',
  '[fe80::1%25en0]',
  '1::',
  '::1:',
  '1:::2',
  '1::2::3',
  '01.2.3.4',
  '1.2.3.04',
  '1.2.3.4.',
  '1.2.3',
  '256.1.1.1',
  '0x1.2.3.4',
  '1.2.3.4 ',
  '\t1.2.3.4',
  '::ffff:1.2.3',
  '::ffff:1.2.3.4.5',
  '1:2:3:4:5:6:1.2.3.4',
  '1:2:3:4:5:6:7:1.2.3.4',
  '::1.2.3.4:5',
  '[::1]]',
  '[[::1]',
  '00000::1',
  '0000::1',
  '12345::',
  'g::1',
  '::ffff:٠.0.0.1',
  '١٢٧.0.0.1',
  '１２７.0.0.1',
  '1.2.3.4\n',
  '::1\n',
  '[::1]\n',
  '8.8.8.8\u0000',
  'fe80::1%',
  'fe80::%1',
  '%1',
  '::ffff:127.0.0.1%x',
  '1.2.3.4%x',
  '[1.2.3.4]',
  '[]',
  '[::]',
  '::ffff:0:0',
  '::0:0:0:0:0:1',
  '0::0:1',
  '::0.0.0.0',
  '::0.0.0.1',
  '::1.0.0.0',
  'ffff::',
  '::ffff',
  '::ffff:0',
  '::ffff:1:2',
  '1:2:3:4:5:6:7::',
  '::2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7:8',
  'İ::1',
  'K::1',
  'ſ::1',
  'localhost',
  'LOCALHOST.',
  'localhost..',
  '127.0.0.1.',
  '127.0.0.1.nip.io',
  '2130706433',
  '0x7f.1',
  '0177.0.0.1',
  '127.1',
  'example.com',
  'Example.COM.',
]

/** The ways one IPv4 address is carried inside an IPv6 address, plus the plain address. */
function wrappers(v4: string): string[] {
  const [p, q, r, s] = v4.split('.').map(Number) as [number, number, number, number]
  const hi = (p << 8) | q
  const lo = (r << 8) | s
  return [
    v4,
    `::ffff:${v4}`,
    `::ffff:${hex(hi)}:${hex(lo)}`,
    `::${hex(hi)}:${hex(lo)}`,
    `::${v4}`,
    `64:ff9b::${hex(hi)}:${hex(lo)}`,
    `64:ff9b::${v4}`,
    `2002:${hex(hi)}:${hex(lo)}::1`,
    `::ffff:0:${hex(hi)}:${hex(lo)}`,
    `2001:0:4136:e378:8000:63bf:${hex((hi ^ 0xffff) & 0xffff)}:${hex((lo ^ 0xffff) & 0xffff)}`,
    `[::ffff:${v4}]`,
    `::FFFF:${v4}`,
    `0:0:0:0:0:ffff:${v4}`,
  ]
}

function generate(): string[] {
  const out = new Set<string>(ODD)
  for (const list of Object.values(corpus))
    if (Array.isArray(list)) for (const a of list) if (typeof a === 'string') out.add(a)
  const rand = rng(7)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T

  // every range edge, one below and one above, and each of those in every wrapper
  for (const e of corpus.rangeEdges) {
    for (const edge of [e.first, e.last, e.before, e.after]) {
      if (!edge) continue
      out.add(edge)
      if (!edge.includes(':')) {
        const n = numeric(edge)
        for (const d of [-1, 1]) {
          const m = n + d
          if (m >= 0 && m <= 0xffffffff) for (const w of wrappers(dotted(m))) out.add(w)
        }
        for (const w of wrappers(edge)) out.add(w)
      }
    }
  }

  // random IPv4 addresses built from the numbers that sit on range edges, in every wrapper
  const firsts = [
    0, 1, 2, 8, 10, 16, 18, 19, 31, 32, 51, 63, 64, 93, 100, 113, 127, 128, 168, 169, 170, 172, 192, 198, 203, 223, 224,
    239, 240, 254, 255,
  ]
  const octet = () => (rand() < 0.8 ? pick(firsts) : Math.floor(rand() * 256))
  for (let i = 0; i < 6000; i++) for (const w of wrappers([octet(), octet(), octet(), octet()].join('.'))) out.add(w)

  // random IPv6 addresses whose first group sits on a range edge, written long, compressed and in upper case
  const first = [
    0, 1, 0x64, 0x100, 0x2001, 0x2002, 0x3fff, 0xfbff, 0xfc00, 0xfdff, 0xfe00, 0xfe7f, 0xfe80, 0xfebf, 0xfec0, 0xfeff,
    0xff00, 0xffff, 0x2000, 0x2606,
  ]
  const later = [0, 0, 0, 1, 2, 0xdb8, 0xff9b, 0xffff, 0x0fff, 0x1000]
  for (let i = 0; i < 6000; i++) {
    const g = [
      pick(first),
      ...Array.from({ length: 7 }, () => (rand() < 0.75 ? pick(later) : Math.floor(rand() * 65536))),
    ]
    const long = g.map(hex).join(':')
    out.add(long)
    out.add(compress(g))
    out.add(long.toUpperCase())
    out.add(`[${compress(g)}]`)
    out.add(`${compress(g)}%eth0`)
    out.add(g.map((x) => hex(x).padStart(4, '0')).join(':'))
  }
  return [...out]
}

/** What the Python copy answers for each case, as a JSON array parallel to `cases`. */
function pythonAnswers(cases: string[]): unknown[][] {
  const driver = [
    'import sys, json',
    'sys.dont_write_bytecode = True',
    'sys.path.insert(0, sys.argv[1])',
    'import _addr as a',
    'cases = json.loads(sys.stdin.buffer.read().decode("utf-8"))',
    'sys.stdout.write(json.dumps([[a.is_blocked_address(c), a.is_blocked_host(c), a.is_loopback_host(c), a.normalize_host(c), a.parse_ipv6(c), a.parse_ipv4(c)] for c in cases]))',
  ].join('\n')
  const out = execFileSync('python3', ['-I', '-B', '-c', driver, `${ROOT}/kit/scripts`], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  return JSON.parse(out) as unknown[][]
}

describe('the kit address check answers exactly like address.ts', () => {
  const cases = generate()
  it('the generated set is broad (every range edge, every wrapper, odd spellings)', () => {
    expect(cases.length).toBeGreaterThan(50_000)
    for (const c of ['169.254.170.2', '::ffff:a9fe:a9fe', '2002:a9fe:a9fe::1', '[::1]', '127.0.0.1.', '１２７.0.0.1']) {
      expect(cases, c).toContain(c)
    }
  })

  it('isBlockedAddress, isBlockedHost, isLoopbackHost, normalizeHost, parseIPv6 and parseIPv4 agree on every case', () => {
    const py = pythonAnswers(cases)
    expect(py).toHaveLength(cases.length)
    const drift: string[] = []
    cases.forEach((c, i) => {
      const ts = [
        isBlockedAddress(c),
        isBlockedHost(c),
        isLoopbackHost(c),
        normalizeHost(c),
        parseIPv6(c),
        parseIPv4(c),
      ]
      if (JSON.stringify(ts) !== JSON.stringify(py[i]))
        drift.push(`${JSON.stringify(c)}\n  ts ${JSON.stringify(ts)}\n  py ${JSON.stringify(py[i])}`)
    })
    expect(drift.slice(0, 10), `${drift.length} of ${cases.length} cases differ`).toEqual([])
  })
})
