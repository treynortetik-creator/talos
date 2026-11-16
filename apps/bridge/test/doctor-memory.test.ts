// talos-app doctor's memory search row: warns, with the setup command, until both the memory venv and this agent's index
// exist; says nothing for a folder that is not a Talos agent.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memorySearchCheck } from '../src/doctor-memory.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const dir = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  made.push(d)
  return d
}
const touch = (root: string, rel: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true })
  writeFileSync(join(root, rel), '')
}

describe('doctor: memory search', () => {
  test('not a Talos agent folder: no row at all', () => {
    expect(memorySearchCheck(dir('talos-doc-mem-plain-'), dir('talos-doc-mem-data-'))).toBeUndefined()
  })

  test('an agent from before the default (never asked for search): ok, off, with the command to add it; no warning', () => {
    const agent = dir('talos-doc-mem-agent-')
    touch(agent, 'scripts/memory/mem_index.py')
    const c = memorySearchCheck(agent, dir('talos-doc-mem-data-'))
    expect(c?.level).toBe('ok')
    expect(c?.detail).toContain('semantic search is off; to add it: bash')
  })

  test('the setup failed (no venv): a warning that names the exact command to try again', () => {
    const agent = dir('talos-doc-mem-agent-')
    touch(agent, 'scripts/memory/mem_index.py')
    touch(agent, '.index/.wanted')
    const c = memorySearchCheck(agent, dir('talos-doc-mem-data-'))
    expect(c?.level).toBe('warn')
    expect(c?.detail).toContain('grep and links only')
    expect(c?.detail).toContain(`bash ${join(agent, 'scripts', 'memory', 'setup.sh')}`)
  })

  test('a venv from another agent but no index here: still a warning, saying it is this agent that lacks it', () => {
    const agent = dir('talos-doc-mem-agent-')
    touch(agent, 'scripts/memory/mem_index.py')
    touch(agent, '.index/.wanted')
    const data = dir('talos-doc-mem-data-')
    touch(data, 'talos/venv/.talos-memory-ok')
    const c = memorySearchCheck(agent, data)
    expect(c?.level).toBe('warn')
    expect(c?.detail).toContain('for this agent (no index yet)')
  })

  test('a venv with only voice packages (no memory marker) does not count as set up', () => {
    const agent = dir('talos-doc-mem-agent-')
    touch(agent, 'scripts/memory/mem_index.py')
    touch(agent, '.index/memory.db')
    touch(agent, '.index/.wanted')
    const data = dir('talos-doc-mem-data-')
    touch(data, 'talos/venv/bin/python')
    expect(memorySearchCheck(agent, data)?.level).toBe('warn')
  })

  test('venv marker and index both there: ok', () => {
    const agent = dir('talos-doc-mem-agent-')
    touch(agent, 'scripts/memory/mem_index.py')
    touch(agent, '.index/memory.db')
    const data = dir('talos-doc-mem-data-')
    touch(data, 'talos/venv/.talos-memory-ok')
    expect(memorySearchCheck(agent, data)?.level).toBe('ok')
  })

  const MODEL = 'talos/models/bge-reranker-v2-m3-int8'
  const indexed = () => {
    const agent = dir('talos-doc-mem-agent-')
    touch(agent, 'scripts/memory/mem_index.py')
    touch(agent, '.index/memory.db')
    const data = dir('talos-doc-mem-data-')
    touch(data, 'talos/venv/.talos-memory-ok')
    return { agent, data }
  }

  test('the reranker was wanted but its model is not downloaded: a warning with the retry command; search still works', () => {
    const { agent, data } = indexed()
    touch(agent, '.index/.rerank-wanted')
    const c = memorySearchCheck(agent, data)
    expect(c?.level).toBe('warn')
    expect(c?.detail).toContain('the reranker model is not downloaded')
    expect(c?.detail).toContain('search works without it')
    expect(c?.detail).toContain(`bash ${join(agent, 'scripts', 'memory', 'fetch-reranker.sh')}`)
  })

  test('the reranker was wanted and its model files are there: the usual ok row', () => {
    const { agent, data } = indexed()
    touch(agent, '.index/.rerank-wanted')
    touch(data, `${MODEL}/tokenizer.json`)
    touch(data, `${MODEL}/onnx/model_int8.onnx`)
    const c = memorySearchCheck(agent, data)
    expect(c?.level).toBe('ok')
    expect(c?.detail).toBe('semantic search is set up (grep and meaning)')
  })

  test('the model folder can be given (TALOS_RERANK_MODEL_DIR): files there make the usual ok row', () => {
    const { agent, data } = indexed()
    touch(agent, '.index/.rerank-wanted')
    const mdir = dir('talos-doc-mem-model-')
    touch(mdir, 'tokenizer.json')
    touch(mdir, 'onnx/model_int8.onnx')
    expect(memorySearchCheck(agent, data, mdir)?.level).toBe('ok')
  })

  test('no reranker marker and no model: the usual ok row', () => {
    const { agent, data } = indexed()
    const c = memorySearchCheck(agent, data)
    expect(c?.level).toBe('ok')
    expect(c?.detail).toBe('semantic search is set up (grep and meaning)')
  })
})
