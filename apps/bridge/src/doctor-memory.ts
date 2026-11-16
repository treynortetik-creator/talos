// talos-app doctor's memory search row: semantic search is on by default for a new agent, but its setup downloads a venv and
// a model and can fail (no network, no Python 3.10+). The install says so once; this row keeps saying it, with the one
// command that sets it up again, in the doctor and in the Windows tray's Check Talos. Search still works without it (grep).
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Check } from './doctor-checks.ts'

/**
 * The row for `agentDir`, or undefined when it is not a Talos agent folder (no kit memory scripts there). A warning only for
 * an agent that was meant to have semantic search (kit/install.sh --with-memory-search leaves `.index/.wanted`).
 */
export function memorySearchCheck(
  agentDir: string,
  data: string = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
  // where the reranker model really is: TALOS_RERANK_MODEL_DIR when set (the kit's scripts follow it), else under `data`
  modelDir: string = process.env.TALOS_RERANK_MODEL_DIR || join(data, 'talos', 'models', 'bge-reranker-v2-m3-int8'),
): Check | undefined {
  const setup = join(agentDir, 'scripts', 'memory', 'setup.sh')
  if (!existsSync(join(agentDir, 'scripts', 'memory', 'mem_index.py'))) return undefined
  // the shared venv is marked by setup.sh only when the memory packages import (a voice-only venv has none of them)
  const venv = existsSync(join(data, 'talos', 'venv', '.talos-memory-ok'))
  const index = existsSync(join(agentDir, '.index', 'memory.db'))
  if (venv && index) {
    // a new install also fetches the reranker model (kit/install.sh --reranker-auto leaves `.index/.rerank-wanted`); a failed
    // download never fails the install, so this row says it until the files are there
    const model = modelDir
    if (
      existsSync(join(agentDir, '.index', '.rerank-wanted')) &&
      !(existsSync(join(model, 'tokenizer.json')) && existsSync(join(model, 'onnx', 'model_int8.onnx')))
    )
      return {
        level: 'warn',
        name: 'memory search',
        detail: `semantic search is set up, but the reranker model is not downloaded (search works without it). Retry: bash ${join(agentDir, 'scripts', 'memory', 'fetch-reranker.sh')}`,
      }
    return { level: 'ok', name: 'memory search', detail: 'semantic search is set up (grep and meaning)' }
  }
  // an agent installed before search was the default never asked for it: off, said plainly, not a warning
  if (!existsSync(join(agentDir, '.index', '.wanted')))
    return {
      level: 'ok',
      name: 'memory search',
      detail: `grep and links (semantic search is off; to add it: bash ${setup})`,
    }
  return {
    level: 'warn',
    name: 'memory search',
    detail: `semantic search is not set up${venv ? ' for this agent (no index yet)' : ''}, so search is grep and links only. Set it up, or try again: bash ${setup}`,
  }
}
