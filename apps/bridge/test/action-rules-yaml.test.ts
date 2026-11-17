// The shipped action rules (kit/hooks/action-rules.yaml) must read the same through a strict YAML parser and through the
// hook's own built-in reader. A machine with PyYAML uses the strict one, a stock Mac the built-in one; a quote only one of them
// reads (a bare ' inside a single-quoted value) turned every rule off on Linux while the Mac passed (main red at 486299bf).
import { expect, test } from 'bun:test'
import { join } from 'node:path'

const KIT = join(import.meta.dir, '..', '..', '..', 'kit', 'hooks')

test('the shipped rule file reads the same through strict YAML and the hook’s built-in reader', async () => {
  const strict = Bun.YAML.parse(await Bun.file(join(KIT, 'action-rules.yaml')).text()) as
    | { rules?: Array<Record<string, unknown>> }
    | Array<Record<string, unknown>>
  const rules = Array.isArray(strict) ? strict : (strict.rules ?? [])
  expect(rules.length).toBeGreaterThanOrEqual(10)
  const py = Bun.spawnSync([
    'python3',
    '-c',
    'import importlib.util,json,sys;s=importlib.util.spec_from_file_location("ar",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.parse_rules(open(m.SHIPPED).read())))',
    join(KIT, 'action-rules.py'),
  ])
  expect(py.exitCode).toBe(0)
  const hand = JSON.parse(py.stdout.toString()) as Array<Record<string, unknown>>
  const pick = (r: Record<string, unknown>) => ({
    id: r.id,
    decision: r.decision,
    tool: r.tool ?? null,
    command: r.command ?? null,
    path: r.path ?? null,
  })
  expect(hand.map(pick)).toEqual(rules.map(pick))
})
